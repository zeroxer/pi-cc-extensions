import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import agentSummaryFeature, {
	AGENT_SUMMARY_ENTRY_TYPE,
} from "../extensions/feature/agent-summary/index.ts";
import {
	AgentRunSummary,
	bindAgentSummary,
	classifyTool,
	summaryMarkdown,
	type AgentSummaryData,
} from "../extensions/feature/agent-summary/core.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("OMP summary falls back to a widget without adding a model message", async () => {
	initTheme("dark");
	const events = new Map<string, Function>();
	const appended: { type: string; data: any }[] = [];
	const widgets: unknown[] = [];
	const pi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as any;
	const ctx = {
		hasUI: true,
		ui: { setWidget: (_name: string, widget: unknown) => widgets.push(widget) },
		sessionManager: {
			getBranch: () =>
				appended.map(({ type, data }) => ({ type: "custom", customType: type, data })),
		},
	};
	agentSummaryFeature(pi);
	await events.get("agent_start")!();
	for (const path of ["a.ts", "b.ts"]) {
		await events.get("tool_execution_start")!({ toolName: "read", args: { path } });
		await events.get("tool_execution_end")!({ isError: false });
	}
	await events.get("agent_end")!({}, ctx);
	assert.equal(appended.length, 1);
	assert.equal(typeof widgets.at(-1), "function");
	const factory = widgets.at(-1) as Function;
	const component = factory({}, { getFgAnsi: () => "" });
	assert.match(stripAnsi(component.render(100).join("\n")), /Read 2 files/);
	await events.get("session_start")!({}, ctx);
	assert.equal(typeof widgets.at(-1), "function");
	await events.get("session_shutdown")!({}, ctx);
	assert.equal(widgets.at(-1), undefined);
});

test("OMP summary clears or restores across session and tree changes and resets pending counts", async () => {
	const handlers = new Map<string, Function[]>();
	const appended: unknown[] = [];
	const widgets: unknown[] = [];
	let branch: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: { setWidget: (_name: string, value: unknown) => widgets.push(value) },
		sessionManager: { getBranch: () => branch },
	};
	const emit = async (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	agentSummaryFeature({
		on(event: string, handler: Function) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry: (_name: string, data: unknown) => appended.push(data),
	} as any);
	await emit("agent_start");
	await emit("tool_execution_start", { toolName: "read", args: { path: "a" } });
	await emit("tool_execution_start", { toolName: "read", args: { path: "b" } });
	await emit("session_switch");
	assert.equal(widgets.at(-1), undefined);
	await emit("agent_end");
	assert.equal(appended.length, 0);
	branch = [
		{
			type: "custom",
			customType: AGENT_SUMMARY_ENTRY_TYPE,
			data: { commands: 1, reads: 1, edits: 0, writes: 0, others: 0, failed: 0, durationMs: 100 },
		},
	];
	await emit("session_tree");
	assert.equal(typeof widgets.at(-1), "function");
	branch = [];
	await emit("session_tree");
	assert.equal(widgets.at(-1), undefined);
});

test("classifyTool：bash/read/edit/write/other", () => {
	assert.equal(classifyTool("bash"), "bash");
	assert.equal(classifyTool("powershell"), "bash");
	assert.equal(classifyTool("read"), "read");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "write");
	assert.equal(classifyTool("grep"), "other");
	// MCP 风格名不是精确工具名：归 other
	assert.equal(classifyTool("mcp__server__read"), "other");
});

test("AgentRunSummary：bash/powershell 计数；read/edit/write 按路径去重；other 计数", () => {
	const summary = new AgentRunSummary(1_000);
	summary.recordToolStart("bash", { command: "npm test" });
	summary.recordToolStart("powershell", { command: "Get-ChildItem" });
	summary.recordToolStart("bash", { command: "ls" });
	summary.recordToolStart("read", { path: "a.ts" });
	summary.recordToolStart("read", { path: "a.ts" }); // 去重
	summary.recordToolStart("read", { path: "b.ts" });
	summary.recordToolStart("edit", { file_path: "c.ts" }); // file_path 别名
	summary.recordToolStart("write", { path: "d.ts" });
	summary.recordToolStart("write", { path: "d.ts" }); // 去重
	summary.recordToolStart("grep", { pattern: "x" });
	summary.recordToolResult(true);
	summary.recordToolResult(false);

	assert.equal(summary.toolCount, 10);
	const data = summary.snapshot(61_000);
	assert.deepEqual(data, {
		commands: 3,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 1,
		failed: 1,
		durationMs: 60_000,
	} satisfies AgentSummaryData);
});

test("summaryMarkdown renders the agent summary entry", () => {
	const data: AgentSummaryData = {
		commands: 3,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 0,
		failed: 0,
		durationMs: 42_000,
	};
	assert.equal(
		summaryMarkdown(data),
		"> *Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · 42s*",
	);
	assert.equal(summaryMarkdown({ ...data, commands: 0, reads: 0, edits: 0, writes: 0 }), "");
});

test("bindAgentSummary 事件绑定：agent_start 重置、agent_end 回调", async () => {
	const handlers = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
	} as any;

	const calls: AgentSummaryData[] = [];
	bindAgentSummary(fakePi, (data) => calls.push(data));

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 0); // toolCount < 2

	await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await handlers.get("tool_execution_end")!({ isError: true });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].commands, 1);
	assert.equal(calls[0].failed, 1);
	assert.equal(calls[0].reads, 1);

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "bash", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("tool_execution_start")!({ toolName: "grep", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], {
		commands: 1,
		reads: 0,
		edits: 0,
		writes: 0,
		others: 1,
		failed: 0,
		durationMs: calls[1].durationMs,
	});
});

test("agent-summary 注册 renderer，agent_end 输出引用块", async () => {
	initTheme("dark");
	const renderers = new Map<string, Function>();
	const appended: unknown[] = [];
	const events = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		registerEntryRenderer: (type: string, renderer: Function) => renderers.set(type, renderer),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as any;

	agentSummaryFeature(fakePi);
	assert.ok(renderers.has(AGENT_SUMMARY_ENTRY_TYPE));

	await events.get("agent_start")!();
	await events.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("agent_end")!();

	assert.equal(appended.length, 1);
	const renderer = renderers.get(AGENT_SUMMARY_ENTRY_TYPE)!;
	const component = renderer(
		{ data: (appended[0] as any).data },
		{ expanded: false },
		{ getFgAnsi: (color: string) => (color === "success" ? "\x1b[32m" : "\x1b[31m") },
	);
	const plain = stripAnsi((component as any).render(120).map(String).join("\n"));
	assert.doesNotMatch(plain, /[┌├└]/);
	assert.doesNotMatch(plain, /TIP/);
	assert.match(plain, /Ran 1 command, read 1 file/);
	assert.equal(
		renderer(
			{
				data: {
					commands: 0,
					reads: 0,
					edits: 0,
					writes: 0,
					others: 0,
					failed: 0,
					durationMs: 0,
				},
			},
			{ expanded: false },
			{ getFgAnsi: () => "" },
		),
		undefined,
	);
});
