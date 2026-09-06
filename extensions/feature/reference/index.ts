import { resolve } from "node:path";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
	Text,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import {
	SESSION_REFERENCE_CUSTOM_TYPE,
	SESSION_REFERENCE_PREFIX,
	buildReferenceContentFromSections,
	extractSessionReferenceIds,
	formatReferenceSession,
	sessionTitle,
	type ReferenceSessionInfo,
	type ReferenceSource,
} from "./session.ts";

const MAX_SESSION_SUGGESTIONS = 3;
const MAX_FILE_SUGGESTIONS = 7;
const MAX_REFERENCED_SESSIONS = 5;
const MENTION_PATTERN = /(?:^|[\t ])@([^\s@]*)$/;
// ── In-process subagent record tracker ──────────────────────────────
// pi-subagents does not expose a global manager; we track records
// ourselves by listening to the events it emits.

type SubagentLiveRecord = {
	runId: string;
	sessionId: string;
	agent: string;
	cwd: string;
	startedAt: number;
	completedAt?: number;
};

type ReferenceDetails = {
	sessions: Array<{ id: string; title: string; cwd: string }>;
};

type SessionReference = {
	kind: "session" | "subagent";
	referenceIds: string[];
	info: ReferenceSessionInfo;
	path?: string;
	messages?: unknown[];
};

// Local subagent record tracking (pi-subagents does not expose a global manager).
const liveSubagentRecords = new Map<string, SubagentLiveRecord>();
/** Cap retained completed/live records so long-lived pi processes cannot grow unbounded. */
const MAX_LIVE_SUBAGENT_RECORDS = 200;

function pruneLiveSubagentRecords(): void {
	while (liveSubagentRecords.size > MAX_LIVE_SUBAGENT_RECORDS) {
		const oldest = liveSubagentRecords.keys().next().value;
		if (oldest === undefined) break;
		liveSubagentRecords.delete(oldest);
	}
}

function clearLiveSubagentRecords(): void {
	liveSubagentRecords.clear();
}

function trackSubagentFromEvent(data: unknown): void {
	if (!data || typeof data !== "object") return;
	const event = data as Record<string, unknown>;
	// subagent:async-started payload has "id" as the run ID
	// subagent:async-complete payload has "runId" as the run ID
	const runId =
		(typeof event.id === "string" ? event.id : undefined) ??
		(typeof event.runId === "string" ? event.runId : undefined);
	if (!runId) return;
	const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
	if (!sessionId) return;

	const existing = liveSubagentRecords.get(runId);
	if (existing) {
		// Completion event — mark completedAt
		if (typeof event.endedAt === "number" || typeof event.lastUpdate === "number") {
			existing.completedAt = (
				typeof event.endedAt === "number" ? event.endedAt : event.lastUpdate
			) as number;
		}
		// Refresh insertion order so completed-but-still-referenced runs stay recent.
		liveSubagentRecords.delete(runId);
		liveSubagentRecords.set(runId, existing);
		return;
	}
	// Started event — create new record
	const agent = typeof event.agent === "string" ? event.agent : "";
	const cwd = typeof event.cwd === "string" ? event.cwd : "";
	const startedAt = typeof event.startedAt === "number" ? event.startedAt : Date.now();
	liveSubagentRecords.set(runId, {
		runId,
		sessionId,
		agent,
		cwd,
		startedAt,
	});
	pruneLiveSubagentRecords();
}

function extractMentionQuery(textBeforeCursor: string): string | undefined {
	return textBeforeCursor.match(MENTION_PATTERN)?.[1];
}

function formatDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

/** Stable across keystrokes while getReferences returns the same reference objects. */
const sessionSearchTextCache = new WeakMap<SessionReference, string>();
const sessionItemCache = new WeakMap<
	SessionReference,
	{ cwd: string; named?: AutocompleteItem; stable?: AutocompleteItem }
>();

function sessionSearchText(reference: SessionReference): string {
	const cached = sessionSearchTextCache.get(reference);
	if (cached !== undefined) return cached;
	// 会话只按显式 session name 匹配，避免 firstMessage、路径或 ID 产生噪声。
	const text = reference.info.name?.trim() ?? "";
	sessionSearchTextCache.set(reference, text);
	return text;
}

function sessionItem(
	reference: SessionReference,
	currentCwd: string,
	useStableId: boolean,
): AutocompleteItem {
	let cached = sessionItemCache.get(reference);
	const variant = useStableId ? "stable" : "named";
	if (cached?.cwd === currentCwd && cached[variant]) return cached[variant];

	const session = reference.info;
	const workspace = samePath(session.cwd, currentCwd)
		? "current workspace"
		: session.cwd || "unknown workspace";
	const label = reference.kind === "subagent" ? "[SubAgent]" : "[Session]";
	// 唯一名称保持短格式；同名或无名称时使用稳定 ID，避免引用歧义。
	const sessionName = session.name?.trim();
	const referenceId = useStableId
		? reference.referenceIds[0]
		: (sessionName ?? reference.referenceIds[0]);
	const item: AutocompleteItem = {
		value: `${SESSION_REFERENCE_PREFIX}[${referenceId}]`,
		label: `${label} ${sessionTitle(session)}`,
		description: `${workspace} · ${session.messageCount} messages · ${formatDate(session.modified)}`,
	};
	if (cached?.cwd !== currentCwd) cached = { cwd: currentCwd };
	cached[variant] = item;
	sessionItemCache.set(reference, cached);
	return item;
}

/** Sort cache: same array + cwd reuses order (getReferences returns a stable ordered array). */
const orderedReferencesCache = new WeakMap<
	SessionReference[],
	{ cwd: string; ordered: SessionReference[] }
>();

function orderSessionReferences(
	references: SessionReference[],
	currentCwd: string,
): SessionReference[] {
	const cached = orderedReferencesCache.get(references);
	if (cached && cached.cwd === currentCwd) return cached.ordered;

	const ordered = [...references].sort((left, right) => {
		const leftLocal = samePath(left.info.cwd, currentCwd) ? 1 : 0;
		const rightLocal = samePath(right.info.cwd, currentCwd) ? 1 : 0;
		return rightLocal - leftLocal || right.info.modified.getTime() - left.info.modified.getTime();
	});
	orderedReferencesCache.set(references, { cwd: currentCwd, ordered });
	// Point the ordered array at itself so subsequent keystrokes skip re-sorting.
	orderedReferencesCache.set(ordered, { cwd: currentCwd, ordered });
	return ordered;
}

function filterSessions(
	references: SessionReference[],
	query: string,
	currentCwd: string,
): AutocompleteItem[] {
	if (query.startsWith("session:")) return [];

	const ordered = orderSessionReferences(references, currentCwd);
	const nameCounts = new Map<string, number>();
	for (const reference of ordered) {
		const name = reference.info.name?.trim();
		if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}
	const trimmed = query.trim();
	// 模糊匹配只接受有 session name 的会话；subagent 按 agent name 匹配。
	const searchable = ordered.filter(
		(reference) => reference.kind === "subagent" || Boolean(reference.info.name?.trim()),
	);
	// Empty query: top-N already sorted — no fuzzy scan over the full list。
	const matches = trimmed
		? fuzzyFilter(searchable, trimmed, sessionSearchText)
		: ordered.slice(0, MAX_SESSION_SUGGESTIONS);
	return matches.slice(0, MAX_SESSION_SUGGESTIONS).map((reference) => {
		const name = reference.info.name?.trim();
		return sessionItem(reference, currentCwd, Boolean(name && (nameCounts.get(name) ?? 0) > 1));
	});
}

function isPathLikeQuery(query: string): boolean {
	return /[\\/*?]/.test(query) || /\.[A-Za-z0-9_-]{1,12}$/.test(query);
}

function mergeSessionAndFileItems(
	sessionItems: AutocompleteItem[],
	fileItems: AutocompleteItem[],
	query: string,
): AutocompleteItem[] {
	const sessions = sessionItems.slice(0, MAX_SESSION_SUGGESTIONS);
	const files = fileItems.slice(0, MAX_FILE_SUGGESTIONS);
	if (isPathLikeQuery(query)) return [...files, ...sessions];

	const merged: AutocompleteItem[] = [];
	let sessionIndex = 0;
	let fileIndex = 0;
	while (sessionIndex < sessions.length || fileIndex < files.length) {
		for (let count = 0; count < 2 && fileIndex < files.length; count++) {
			merged.push(files[fileIndex++]!);
		}
		if (sessionIndex < sessions.length) merged.push(sessions[sessionIndex++]!);
	}
	return merged;
}

function liveSubagentReferences(
	agentIds: Set<string>,
	currentSessionId: string,
): SessionReference[] {
	const references: SessionReference[] = [];
	for (const agentId of agentIds) {
		const record = liveSubagentRecords.get(agentId);
		if (!record || record.sessionId === currentSessionId) continue;
		references.push({
			kind: "subagent",
			referenceIds: [record.sessionId, agentId],
			info: {
				id: record.sessionId,
				name: record.agent || undefined,
				cwd: record.cwd,
				firstMessage: "",
				messageCount: 0,
				modified: new Date(record.completedAt ?? record.startedAt),
			},
		});
	}
	return references;
}

function mergeReferences(
	sessions: SessionInfo[],
	subagents: SessionReference[],
): SessionReference[] {
	const bySessionId = new Map<string, SessionReference>();
	for (const session of sessions) {
		// Pi calls this field name; OMP persists and lists it as title.
		const title = (session as SessionInfo & { title?: string }).title;
		const info = !session.name && title ? { ...session, name: title } : session;
		bySessionId.set(session.id, {
			kind: "session",
			referenceIds: [session.id],
			info,
			path: session.path,
		});
	}
	for (const subagent of subagents) {
		// Prefer the live subagent context when a persisted subagent has the same ID.
		bySessionId.set(subagent.info.id, subagent);
	}
	return [...bySessionId.values()];
}

export function createAutocompleteProvider(
	current: AutocompleteProvider,
	getReferences: () => Promise<SessionReference[]>,
	currentCwd: string | (() => string),
): AutocompleteProvider {
	return {
		triggerCharacters: ["@"],
		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const query = extractMentionQuery(currentLine.slice(0, cursorCol));
			if (query === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const [baseSuggestions, references] = await Promise.all([
				current.getSuggestions(lines, cursorLine, cursorCol, options),
				getReferences(),
			]);
			if (options.signal.aborted) return null;

			const cwd = typeof currentCwd === "function" ? currentCwd() : currentCwd;
			const sessionItems = filterSessions(references, query, cwd);
			const fileItems = baseSuggestions?.prefix === `@${query}` ? baseSuggestions.items : [];
			const items = mergeSessionAndFileItems(sessionItems, fileItems, query);
			if (items.length === 0) return baseSuggestions;
			return { prefix: `@${query}`, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function samePath(left: string | undefined, right: string): boolean {
	if (!left) return false;
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

type ReferenceSessionHost = {
	loadEntriesFromFile?: (path: string) => unknown[] | Promise<unknown[]>;
	buildSessionContext?: (entries: unknown[]) => { messages: unknown[] };
	SessionManager: {
		open: (
			path: string,
		) =>
			| { buildSessionContext(): { messages: unknown[] }; close?: () => Promise<void> }
			| Promise<{ buildSessionContext(): { messages: unknown[] }; close?: () => Promise<void> }>;
	};
};

export async function loadReferenceMessages(
	path: string,
	host: ReferenceSessionHost = codingAgent as unknown as ReferenceSessionHost,
): Promise<unknown[]> {
	// OMP's open() acquires a writer. Prefer its read-only loader for references.
	if (host.loadEntriesFromFile && host.buildSessionContext) {
		const entries = await host.loadEntriesFromFile(path);
		return host.buildSessionContext(
			entries.filter((entry) => (entry as { type?: string }).type !== "session"),
		).messages;
	}
	const session = await host.SessionManager.open(path);
	try {
		return session.buildSessionContext().messages;
	} finally {
		await session.close?.();
	}
}

export default function sessionReferenceExtension(pi: ExtensionAPI): void {
	let getAvailableReferences: (() => Promise<SessionReference[]>) | undefined;
	let sessionGeneration = 0;
	let autocompleteCwd = "";
	const autocompleteUis = new WeakSet<object>();
	const subagentIds = new Set<string>();
	// pi-subagents emits "subagent:async-started" and "subagent:async-complete" events.
	// We track records locally so @[SubAgent] suggestions work even without a global manager.
	const subagentEventNames = ["subagent:async-started", "subagent:async-complete"];
	const unsubscribeSubagentEvents = subagentEventNames.map((eventName) =>
		pi.events.on(eventName, (data) => {
			trackSubagentFromEvent(data);
			if (!data || typeof data !== "object") return;
			const payload = data as Record<string, unknown>;
			// subagent:async-started uses "id", subagent:async-complete uses "runId"
			const id =
				(typeof payload.id === "string" ? payload.id : undefined) ??
				(typeof payload.runId === "string" ? payload.runId : undefined);
			if (typeof id === "string" && id) subagentIds.add(id);
		}),
	);

	pi.registerMessageRenderer(SESSION_REFERENCE_CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as ReferenceDetails | undefined;
		const sessions = details?.sessions ?? [];
		const labels = sessions.map((session) => session.title).join(", ");
		const summary =
			sessions.length === 1 ? "Referenced 1 session" : `Referenced ${sessions.length} sessions`;
		const text = labels ? `${theme.fg("accent", summary)}\n${theme.fg("dim", labels)}` : summary;
		return new Text(text, 1, 0);
	});

	const refreshSession = (_event: unknown, ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		// 会话替换/reload 会让 ctx 的 getter 抛 stale 错误，await 之后不能再读；
		// 这里在同步阶段一次性取出纯值。
		const currentCwd = ctx.cwd;
		autocompleteCwd = currentCwd;
		const ui = ctx.ui;
		subagentIds.clear();
		clearLiveSubagentRecords();
		let loadErrorShown = false;
		const currentSessionId = ctx.sessionManager.getSessionId();
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		let sessionsPromise: Promise<SessionInfo[]> | undefined;

		const getSessions = (): Promise<SessionInfo[]> => {
			sessionsPromise ||= SessionManager.listAll()
				.then((sessions) =>
					sessions.filter(
						(session) =>
							session.id !== currentSessionId && !samePath(currentSessionFile, session.path),
					),
				)
				.catch((error: unknown) => {
					if (!loadErrorShown) {
						loadErrorShown = true;
						const reason = error instanceof Error ? error.message : String(error);
						ui.notify(`session-reference: failed to load sessions: ${reason}`, "error");
					}
					return [];
				});
			return sessionsPromise;
		};

		// Pre-sort once per (sessions list, subagent id set) so @ keystrokes only fuzzy-filter.
		let referencesCache:
			| { sessions: SessionInfo[]; subagentKey: string; ordered: SessionReference[] }
			| undefined;
		const getReferences = async (): Promise<SessionReference[]> => {
			const sessions = await getSessions();
			// 会话替换/reload 后丢弃旧 generation 的结果，避免对失效状态继续工作。
			if (generation !== sessionGeneration) return [];
			const subagentKey = [...subagentIds].join("\0");
			if (
				referencesCache &&
				referencesCache.sessions === sessions &&
				referencesCache.subagentKey === subagentKey
			) {
				return referencesCache.ordered;
			}
			const ordered = orderSessionReferences(
				mergeReferences(sessions, liveSubagentReferences(subagentIds, currentSessionId)),
				currentCwd,
			);
			referencesCache = { sessions, subagentKey, ordered };
			return ordered;
		};

		getAvailableReferences = getReferences;
		if (ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI)) {
			// 预取是 detached 的，必须兜住 rejection，否则 stale 错误会变成
			// unhandled rejection 直接终止 Pi。
			void getReferences().catch(() => {});
			// Register after other session_start handlers. pi-fff claims every @
			// prefix, so a provider installed before it would never see session mentions.
			setTimeout(() => {
				if (generation !== sessionGeneration) return;
				if (autocompleteUis.has(ui)) return;
				ui.addAutocompleteProvider((current) =>
					createAutocompleteProvider(
						current,
						() => getAvailableReferences?.() ?? Promise.resolve([]),
						() => autocompleteCwd,
					),
				);
				autocompleteUis.add(ui);
			}, 0);
		}
	};
	pi.on("session_start", refreshSession);
	(pi.on as (event: string, handler: typeof refreshSession) => void)(
		"session_switch",
		refreshSession,
	);
	pi.on("session_tree", refreshSession);

	pi.on("before_agent_start", async (event, ctx) => {
		const referenceIds = extractSessionReferenceIds(event.prompt);
		if (referenceIds.length === 0) return;

		const currentSessionId = ctx.sessionManager.getSessionId();
		const references = await (getAvailableReferences?.() ??
			SessionManager.listAll().then((sessions) =>
				mergeReferences(
					sessions.filter((session) => session.id !== currentSessionId),
					liveSubagentReferences(subagentIds, currentSessionId),
				),
			));
		const referencesById = new Map<string, SessionReference>();
		const referencesByName = new Map<string, SessionReference>();
		const ambiguousNames = new Set<string>();
		for (const reference of references) {
			for (const id of reference.referenceIds) referencesById.set(id, reference);
			const name = reference.info.name?.trim();
			if (!name || ambiguousNames.has(name)) continue;
			if (referencesByName.has(name)) {
				referencesByName.delete(name);
				ambiguousNames.add(name);
			} else {
				referencesByName.set(name, reference);
			}
		}
		const seenReferences = new Set<SessionReference>();
		const matchingReferences = referenceIds
			.map((id) => referencesById.get(id) ?? referencesByName.get(id))
			.filter((reference): reference is SessionReference => {
				if (!reference || reference.info.id === currentSessionId || seenReferences.has(reference))
					return false;
				seenReferences.add(reference);
				return true;
			});
		const selected = matchingReferences.slice(0, MAX_REFERENCED_SESSIONS);

		if (selected.length === 0) {
			ctx.ui.notify("session-reference: referenced sessions were not found", "warning");
			return;
		}

		if (matchingReferences.length > MAX_REFERENCED_SESSIONS) {
			ctx.ui.notify(
				`session-reference: only the first ${MAX_REFERENCED_SESSIONS} sessions were included`,
				"warning",
			);
		}

		const sections: string[] = [];
		const referencedSessions: ReferenceDetails["sessions"] = [];
		for (const reference of selected) {
			try {
				const info = reference.info;
				const messages =
					reference.messages ??
					(reference.path
						? await loadReferenceMessages(reference.path)
						: (() => {
								throw new Error("reference session is no longer available");
							})());
				const source: ReferenceSource = { info, messages };
				sections.push(formatReferenceSession(source));
				referencedSessions.push({
					id: info.id,
					title: sessionTitle(info),
					cwd: info.cwd,
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`session-reference: failed to read ${reference.info.id}: ${reason}`,
					"warning",
				);
			}
		}
		if (sections.length === 0) return;

		const details: ReferenceDetails = { sessions: referencedSessions };
		return {
			message: {
				customType: SESSION_REFERENCE_CUSTOM_TYPE,
				content: buildReferenceContentFromSections(sections),
				display: true,
				details,
			},
		};
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		for (const unsubscribe of unsubscribeSubagentEvents) unsubscribe();
		subagentIds.clear();
		clearLiveSubagentRecords();
		getAvailableReferences = undefined;
	});
}
