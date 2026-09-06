import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sessionReferenceExtension, {
	loadReferenceMessages,
} from "../extensions/feature/reference/index.ts";
import { appendSubagentPrompt } from "../extensions/feature/reference/subagent.ts";

test("OMP session references use the read-only loader without opening a writer", async () => {
	const entries = [
		{ type: "session", id: "header" },
		{ type: "message", id: "message", message: { role: "user", content: "hello" } },
	];
	const messages = await loadReferenceMessages("session.jsonl", {
		loadEntriesFromFile: async () => entries,
		buildSessionContext: (loaded) => {
			assert.deepEqual(loaded, entries.slice(1));
			return { messages: [entries[1].message] };
		},
		SessionManager: {
			open() {
				throw new Error("must not open a writer");
			},
		},
	});
	assert.deepEqual(messages, [entries[1].message]);
});

test("session references await asynchronous open and close hosts", async () => {
	let closed = false;
	const messages = [{ role: "user", content: "hello" }];
	assert.deepEqual(
		await loadReferenceMessages("session.jsonl", {
			SessionManager: {
				open: async () => ({
					buildSessionContext: () => ({ messages }),
					close: async () => {
						closed = true;
					},
				}),
			},
		}),
		messages,
	);
	assert.equal(closed, true);
});

test("subagent instructions preserve OMP prompt blocks and Pi string prompts", () => {
	const blocks = ["stable", "project"];
	assert.deepEqual(appendSubagentPrompt(blocks, "delegate"), ["stable", "project", "delegate"]);
	assert.deepEqual(blocks, ["stable", "project"]);
	assert.equal(appendSubagentPrompt("stable", "delegate"), "stable\n\ndelegate");
});

test("OMP session switches refresh reference candidates without stacking autocomplete providers", async (t) => {
	const sessions = ["first", "second"].map((id) => ({
		id,
		title: id,
		path: `/sessions/${id}.jsonl`,
		cwd: "/repo",
		modified: new Date(),
		messageCount: 1,
		firstMessage: id,
	}));
	t.mock.method(SessionManager, "listAll", async () => sessions as any);
	const handlers = new Map<string, Function>();
	let provider: any;
	let installations = 0;
	const ui = {
		notify() {},
		addAutocompleteProvider(factory: Function) {
			installations++;
			provider = factory({
				getSuggestions: async () => null,
				applyCompletion() {},
			});
		},
	};
	const ctx = (id: string) => ({
		cwd: "/repo",
		mode: "tui",
		hasUI: true,
		ui,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/sessions/${id}.jsonl`,
		},
	});
	sessionReferenceExtension({
		events: { on: () => () => {} },
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerMessageRenderer() {},
	} as any);
	const suggestions = () =>
		provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
	await handlers.get("session_start")!({}, ctx("first"));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(
		(await suggestions()).items.map((item: any) => item.value),
		["@session:[second]"],
	);
	await handlers.get("session_switch")!({}, ctx("second"));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(
		(await suggestions()).items.map((item: any) => item.value),
		["@session:[first]"],
	);
	await handlers.get("session_tree")!({}, ctx("second"));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(installations, 1);
	await handlers.get("session_shutdown")!();
});
