/**
 * OMP keeps component state in ECMAScript private fields. Adapt its public
 * update/render methods and event payloads, without replacing tool execution
 * or reparenting the append-only transcript's children.
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	config,
	formatConfigStatus,
	updateConfig,
	type CompactStyleMode,
} from "../config/config.ts";
import { showCcstylePanel } from "../config/panel.ts";
import { installOmpThemes } from "../config/omp-themes.ts";
import {
	ThinkingPreviewBlock,
	type CompactThinkingConfig,
	type CompactThinkingController,
} from "../feature/compact-thinking.ts";
import { formatThoughtDuration, styleCompactThinkingText } from "./compact-mode.ts";
import { toolCallSummary } from "./tool/names.ts";
import { textFromResult } from "./tool/result.ts";
import { setToolTuiFullscreen, showMoreHintText } from "./tool/show-more-hint.ts";
import { enhanceMarkdown } from "./markdown-enhance.ts";

export function usesOmpComponents(): boolean {
	const prototype = ToolExecutionComponent.prototype as any;
	return (
		typeof prototype.getCallRenderer !== "function" &&
		typeof prototype.updateArgs === "function" &&
		typeof prototype.getTranscriptBlockVersion === "function"
	);
}

function isInteractive(ctx: any): boolean {
	return Boolean(ctx?.hasUI && (ctx.mode === undefined || ctx.mode === "tui"));
}

type ToolState = {
	name: string;
	args: any;
	result?: any;
	partial?: boolean;
	expanded?: boolean;
};
type AssistantState = {
	message: any;
	forwarded?: any;
	options?: any;
	expanded?: boolean;
	preserveNativeThinking?: boolean;
};
type MethodPatch = { prototype: any; name: string; original: any; installed: any };
const OWNER = Symbol.for("pi-cc-extensions.omp-rendering");

/** Exported independently so the OMP smoke suite can exercise real components. */
export function patchOmpComponents(
	tools: Map<string, ToolState>,
	getTheme: () => any,
	thinking?: CompactThinkingController,
): { refresh(): void; dispose(): void } {
	const globals = globalThis as any;
	globals[OWNER]?.dispose();
	const patches: MethodPatch[] = [];
	const assistants = new Map<any, AssistantState>();
	const toolStates = new WeakMap<object, ToolState>();
	const toolIds = new WeakMap<object, string>();
	const toolExpanded = new WeakMap<object, boolean>();
	const toolAllocations = new WeakMap<object, number>();
	const toolComponents = new Set<any>();
	let active = true;
	let displayVersion = 0;
	const patch = (prototype: any, name: string, wrap: (original: any) => any) => {
		if (typeof prototype[name] !== "function") return;
		const original = prototype[name];
		const installed = wrap(original);
		prototype[name] = installed;
		patches.push({ prototype, name, original, installed });
	};
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	for (const prototype of [assistantPrototype, ToolExecutionComponent.prototype]) {
		patch(
			prototype,
			"getTranscriptBlockVersion",
			(original) =>
				function (this: any) {
					return original.call(this) + displayVersion;
				},
		);
	}
	patch(
		assistantPrototype,
		"updateContent",
		(original) =>
			function (this: any, incoming: any, options: any) {
				const previous = assistants.get(this);
				const message =
					previous && incoming?.content === previous.forwarded?.content
						? { ...incoming, content: previous.message.content }
						: incoming;
				const state: AssistantState = { ...previous, message, options };
				// Published rows may already be in terminal scrollback. Never replace
				// their leading thinking prefix after expansion or an off→on switch.
				if (this.getTranscriptStableRows?.().length > 0) state.preserveNativeThinking = true;
				assistants.set(this, state);
				// Native rendering still owns prose, images, reactions, errors, and version
				// updates. Only the display copy's thinking is replaced by our preview.
				if (active && Array.isArray(message?.content)) {
					state.forwarded = {
						...message,
						content: message.content.map((block: any) => {
							if (
								block.type === "thinking" &&
								config.mode !== "off" &&
								!state.expanded &&
								!state.preserveNativeThinking
							)
								return { ...block, thinking: "", rawThinking: "" };
							if (block.type === "text")
								return {
									...block,
									text: enhanceMarkdown(block.text, {
										messageType: "assistant",
										isStreaming: options?.transient === true,
										availableWidth: Math.max(8, (process.stdout.columns || 80) - 2),
									}),
								};
							return block;
						}),
					};
				} else state.forwarded = message;
				// OMP native updateContent rebuilds Markdown through getMarkdownTheme(), which
				// reads the global `theme` singleton. Before OMP initializes the theme (early
				// session_start / resume, ctx.ui.theme === undefined) that rebuild throws
				// `undefined is not an object (evaluating 'theme.getColorMode')`; bubbling through
				// this patch, OMP surfaces it as an extension error banner. Swallow it only while
				// the theme is not ready — updateContent stored #lastMessage above, so OMP's
				// theme-init invalidate re-runs it and the display adaptation self-heals. A
				// failure with the theme ready is a real bug, so rethrow it.
				try {
					return original.call(this, state.forwarded, options);
				} catch (error) {
					if (getTheme()) throw error;
					return undefined;
				}
			},
	);
	patch(
		assistantPrototype,
		"setHideThinkingBlock",
		(original) =>
			function (this: any, hide: boolean) {
				const state = assistants.get(this);
				if (state) state.expanded = !hide;
				return original.call(this, hide);
			},
	);
	patch(
		assistantPrototype,
		"render",
		(original) =>
			function (this: any, width: number) {
				// Native render can hit the same uninitialized-theme throw as updateContent above.
				let native: any;
				try {
					native = original.call(this, width);
				} catch (error) {
					if (getTheme()) throw error;
					return [];
				}
				const state = assistants.get(this);
				if (
					!active ||
					config.mode === "off" ||
					!state ||
					state.expanded ||
					state.preserveNativeThinking
				)
					return native;
				const message = state.message;
				const blocks = message.content?.filter((block: any) => block.type === "thinking") ?? [];
				const body = blocks
					.map((block: any) => block.thinking ?? "")
					.filter(Boolean)
					.join("\n\n");
				const pending = thinking?.isMessageThinkingActive?.(message.timestamp);
				if (!body && !pending) return native;
				const duration = thinking?.getMessageThinkingDurationMs?.(message.timestamp);
				const heading = pending
					? "Thinking…"
					: duration
						? `Thought for ${formatThoughtDuration(duration)}`
						: "Thought";
				const theme = getTheme();
				const style = (text: string) => styleCompactThinkingText(text, theme);
				if (config.mode === "compact") {
					return [...new Text(style(heading), 1, 0).render(width), ...native];
				}
				const preview = new ThinkingPreviewBlock(
					style(heading),
					body,
					1,
					message.timestamp,
					style,
					theme,
				);
				return [...preview.render(width), ...native];
			},
	);

	const toolPrototype = ToolExecutionComponent.prototype as any;
	patch(
		assistantPrototype,
		"dispose",
		(original) =>
			function (this: any, ...args: any[]) {
				assistants.delete(this);
				return original.apply(this, args);
			},
	);
	patch(
		toolPrototype,
		"dispose",
		(original) =>
			function (this: any, ...args: any[]) {
				toolComponents.delete(this);
				toolStates.delete(this);
				toolIds.delete(this);
				return original.apply(this, args);
			},
	);
	patch(
		toolPrototype,
		"setTranscriptAllocation",
		(original) =>
			function (this: any, rows: number, frame: any) {
				toolAllocations.set(this, rows);
				return original.call(this, rows, frame);
			},
	);
	const bind = (component: object, id: unknown): ToolState | undefined => {
		if (typeof id === "string") toolIds.set(component, id);
		if (typeof id === "string" && tools.has(id)) {
			const state = tools.get(id)!;
			state.expanded = toolExpanded.get(component) ?? state.expanded;
			toolStates.set(component, state);
			toolComponents.add(component);
		}
		return toolStates.get(component);
	};
	patch(
		toolPrototype,
		"updateArgs",
		(original) =>
			function (this: any, args: any, id: string) {
				const state = bind(this, id);
				if (state) state.args = args;
				return original.call(this, args, id);
			},
	);
	for (const method of ["setArgsComplete", "setExecutionStarted"]) {
		patch(
			toolPrototype,
			method,
			(original) =>
				function (this: any, id: string) {
					bind(this, id);
					return original.call(this, id);
				},
		);
	}
	patch(
		toolPrototype,
		"updateResult",
		(original) =>
			function (this: any, result: any, partial: boolean, id: string) {
				const state = bind(this, id);
				if (state) {
					state.result = result;
					state.partial = partial;
				}
				return original.call(this, result, partial, id);
			},
	);
	patch(
		toolPrototype,
		"setExpanded",
		(original) =>
			function (this: any, expanded: boolean) {
				toolExpanded.set(this, expanded);
				const state = bind(this, toolIds.get(this));
				if (state) state.expanded = expanded;
				return original.call(this, expanded);
			},
	);
	patch(
		toolPrototype,
		"render",
		(original) =>
			function (this: any, width: number) {
				// Native render can hit the same uninitialized-theme throw as updateContent above.
				let native: any;
				try {
					native = original.call(this, width);
				} catch (error) {
					if (getTheme()) throw error;
					return [];
				}
				const state = bind(this, toolIds.get(this));
				if (native.length === 0) return native;
				// Keep native diff, interactive task cards, images, and explicit exclusions.
				if (
					!active ||
					config.mode === "off" ||
					!state ||
					state.expanded ||
					["edit", "write", "task", "Agent", "Agents"].includes(state.name) ||
					config.excludeRenderers.includes(state.name) ||
					state.result?.content?.some((item: any) => item.type !== "text")
				)
					return native;
				const theme = getTheme();
				const fg = (color: string, text: string) => (theme?.fg ? theme.fg(color, text) : text);
				const pending = !state.result || state.partial;
				const failed = state.result?.isError === true;
				const summary = toolCallSummary(state.name, state.args ?? {}, { variant: "default" });
				const icon = pending ? "●" : failed ? "✗" : "✓";
				const header = ` ${fg(failed ? "error" : pending ? "muted" : "success", icon)} ${fg("toolTitle", summary.main)}${fg("dim", summary.detail)}`;
				if (config.mode === "compact") return [truncateToWidth(header, width, "")];
				const text = textFromResult(state.result);
				const result = pending
					? "Pending…"
					: failed
						? text.split("\n")[0] || "Failed"
						: text
							? `${text.split("\n").length} lines returned`
							: "Done";
				return [
					truncateToWidth(header, width, ""),
					truncateToWidth(
						`   ↳ ${fg(failed ? "error" : "muted", result)}${text ? fg("dim", ` • ${showMoreHintText()}`) : ""}`,
						width,
						"",
					),
				].slice(0, Math.max(0, toolAllocations.get(this) ?? Number.POSITIVE_INFINITY));
			},
	);
	const controller = {
		refresh() {
			displayVersion++;
			for (const [component, state] of assistants)
				component.updateContent(state.message, state.options);
			for (const component of toolComponents) component.invalidate();
		},
		dispose() {
			if (!active) return;
			active = false;
			controller.refresh();
			for (const entry of patches.reverse()) {
				if (entry.prototype[entry.name] === entry.installed)
					entry.prototype[entry.name] = entry.original;
			}
			assistants.clear();
			toolComponents.clear();
			if (globals[OWNER] === controller) delete globals[OWNER];
		},
	};
	globals[OWNER] = controller;
	return controller;
}

export function installOmpRendering(pi: ExtensionAPI, thinking?: CompactThinkingController): void {
	const tools = new Map<string, ToolState>();
	let currentContext: any;
	let controller: ReturnType<typeof patchOmpComponents> | undefined;
	const remember = (message: any) => {
		for (const item of message?.content ?? []) {
			if (item.type === "toolCall")
				tools.set(item.id, { ...tools.get(item.id), name: item.name, args: item.arguments });
		}
	};
	const refresh = (ctx: any) => {
		controller?.refresh();
		ctx?.ui?.requestRender?.();
	};
	const applyStyleMode = (mode: CompactStyleMode, ctx: any) => {
		updateConfig({ mode });
		refresh(ctx);
		ctx.ui.notify(`Claude Code style: ${mode}`, "info");
	};
	pi.registerCommand("ccstyle", {
		description: "Configure Claude Code style",
		handler: async (args, ctx) => {
			if (!isInteractive(ctx)) return ctx.ui.notify("/ccstyle requires TUI mode", "warning");
			const mode = args.trim().toLowerCase();
			if (mode === "themes") {
				const installed = await installOmpThemes();
				return ctx.ui.notify(
					installed.length
						? `Installed ${installed.join(", ")}. Select a theme in /settings. Existing theme files were preserved.`
						: "CC theme files already exist; existing files were preserved.",
					"info",
				);
			}
			if (mode === "status")
				return ctx.ui.notify(`Claude Code style: ${formatConfigStatus(config)}`, "info");
			if (["on", "off", "compact"].includes(mode))
				return applyStyleMode(mode as CompactStyleMode, ctx);
			if (!mode || mode === "panel") {
				await showCcstylePanel(
					ctx,
					{ applyStyleMode, refreshCurrentTranscript: refresh },
					undefined,
					thinking,
					{
						host: "omp",
						toolNames: pi
							.getAllTools()
							.map((tool) => tool.name)
							.filter((name) => !["edit", "write", "task", "Agent", "Agents"].includes(name)),
					},
				);
				return;
			}
			ctx.ui.notify("Usage: /ccstyle [on|compact|off|status|panel|themes]", "warning");
		},
	});
	const restore = (_event: any, ctx: any) => {
		if (!isInteractive(ctx)) return;
		currentContext = ctx;
		setToolTuiFullscreen(false);
		tools.clear();
		for (const entry of ctx.sessionManager.getBranch())
			if (entry.type === "message") remember(entry.message);
		controller ??= patchOmpComponents(tools, () => currentContext.ui.theme, thinking);
		refresh(ctx);
	};
	for (const name of ["session_start", "session_switch", "session_tree", "session_compact"]) {
		pi.on(name as any, restore);
	}
	pi.on("message_update", (event) => remember(event.message));
	pi.on("tool_execution_start", (event) => {
		tools.set(event.toolCallId, {
			...tools.get(event.toolCallId),
			name: event.toolName,
			args: event.args,
		});
	});
	pi.on("session_shutdown", () => {
		controller?.dispose();
		controller = undefined;
		tools.clear();
	});
}

export function installOmpThinking(
	pi: ExtensionAPI,
	initialConfig: CompactThinkingConfig,
	updatePreview: (next: CompactThinkingConfig) => void,
): CompactThinkingController {
	const durations = new Map<number, number>();
	let active: { timestamp: number; start: number; index: number } | undefined;
	let enabled = false;
	const finish = () => {
		if (!active) return;
		const durationMs = Math.max(1, Date.now() - active.start);
		durations.set(active.timestamp, (durations.get(active.timestamp) ?? 0) + durationMs);
		pi.appendEntry("compact-thinking-duration", {
			messageTimestamp: active.timestamp,
			contentIndex: active.index,
			durationMs,
		});
		active = undefined;
	};
	const restore = (_event: any, ctx: any) => {
		enabled = isInteractive(ctx);
		if (!enabled) return;
		durations.clear();
		active = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "compact-thinking-duration") continue;
			const data = entry.data as any;
			if (
				Number.isFinite(data?.messageTimestamp) &&
				Number.isFinite(data?.durationMs) &&
				data.durationMs > 0
			)
				durations.set(
					data.messageTimestamp,
					(durations.get(data.messageTimestamp) ?? 0) + data.durationMs,
				);
		}
	};
	for (const name of ["session_start", "session_switch", "session_tree", "session_compact"]) {
		pi.on(name as any, restore);
	}
	pi.on("message_update", (event) => {
		if (!enabled || event.message.role !== "assistant") return;
		const delta = event.assistantMessageEvent as any;
		if (delta?.type === "thinking_start") {
			finish();
			active = { timestamp: event.message.timestamp, start: Date.now(), index: delta.contentIndex };
		} else if (["thinking_end", "text_start", "toolcall_start"].includes(delta?.type)) finish();
	});
	pi.on("agent_end", finish);
	pi.on("session_shutdown", () => {
		finish();
		enabled = false;
	});
	return {
		updateConfig(next) {
			Object.assign(initialConfig, next);
			updatePreview(next);
		},
		getMessageThinkingDurationMs(timestamp) {
			const value =
				(durations.get(timestamp) ?? 0) +
				(active?.timestamp === timestamp ? Date.now() - active.start : 0);
			return value > 0 ? value : undefined;
		},
		isMessageThinkingActive(timestamp) {
			return active?.timestamp === timestamp;
		},
	};
}
