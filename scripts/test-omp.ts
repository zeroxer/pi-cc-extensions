/** Integration smoke test against an installed OMP, without a model request. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = process.argv[2] ?? process.env.OMP_PACKAGE_DIR;
if (!packageDir) {
	throw new Error("Usage: bun scripts/test-omp.ts <installed @oh-my-pi/pi-coding-agent directory>");
}
const scratch = await mkdtemp(join(tmpdir(), "pi-cc-omp-test-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = await import(pathToFileURL(join(resolve(packageDir), "src/index.ts")).href);
const loader = await import(
	pathToFileURL(join(resolve(packageDir), "src/extensibility/extensions/loader.ts")).href
);
await host.initTheme();
const loaded = await loader.loadExtensions([join(repo, "extensions/index.ts")], scratch);
assert.deepEqual(loaded.errors, [], "OMP must import and initialize the complete extension");
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.ok(extension.commands.has("ccstyle"));
assert.ok(extension.commands.has("context"));

const notifications: string[] = [];
const rendered: string[][] = [];
const inputListeners = new Set<Function>();
let testingPanel = false;
const ui = {
	theme: host.theme,
	requestRender() {},
	setStatus() {},
	setWorkingMessage() {},
	setWidget(_name: string, content: unknown) {
		if (Array.isArray(content)) rendered.push(content);
	},
	setHeader(factory?: Function) {
		if (factory) {
			const component = factory(tui, host.theme);
			rendered.push(component.render(100));
		}
	},
	setAutocompleteProvider() {},
	addAutocompleteProvider() {},
	setFooter() {},
	setEditorComponent() {},
	notify(message: string) {
		notifications.push(message);
	},
	onTerminalInput(handler: Function) {
		inputListeners.add(handler);
		return () => inputListeners.delete(handler);
	},
	async custom(factory: Function) {
		const component = await factory(tui, host.theme, {}, () => {});
		for (const width of [48, 100, 160]) {
			const lines = component.render(width);
			assert.ok(lines.every((line: unknown) => typeof line === "string"));
			rendered.push(lines);
		}
		if (testingPanel) {
			component.handleInput("\t");
			component.handleInput(" ");
			assert.ok(component.render(100).length > 0, "OMP panel keyboard navigation must render");
		}
		component.dispose?.();
		return undefined;
	},
};
const tui = {
	children: [],
	terminal: { rows: 40, columns: 100, write() {} },
	requestRender() {},
	getSize: () => ({ rows: 40, columns: 100 }),
};
const sessionManager = host.SessionManager.inMemory(scratch);
loaded.runtime.getAllTools = () => [];
loaded.runtime.getActiveTools = () => [];
loaded.runtime.appendEntry = (type: string, data: unknown) =>
	sessionManager.appendCustomEntry(type, data);
loaded.runtime.getSessionName = () => "OMP compatibility smoke test";
loaded.runtime.getThinkingLevel = () => "off";
const ctx = {
	ui,
	mode: "tui",
	hasUI: true,
	cwd: scratch,
	sessionManager,
	model: undefined,
	modelRegistry: { getAll: () => [], getAvailable: () => [] },
	getSystemPrompt: () => ["OMP system prompt", "A second prompt block"],
	getContextUsage: () => undefined,
	isIdle: () => true,
	hasPendingMessages: () => false,
	getAsyncJobSnapshot: () => null,
};
async function emit(type: string, event: Record<string, unknown> = {}) {
	for (const handler of extension.handlers.get(type) ?? []) {
		await handler({ type, ...event }, ctx);
	}
}
const originalAssistantRender = host.AssistantMessageComponent.prototype.render;
const originalToolRender = host.ToolExecutionComponent.prototype.render;
const components: any[] = [];
try {
	await emit("session_start");
	await extension.commands.get("ccstyle").handler("themes", ctx);
	for (const name of ["cc-dark", "cc-light"]) {
		assert.ok(await host.getThemeByName(name), `OMP must validate ${name}`);
	}
	const themePath = join(host.getAgentDir(), "themes/cc-dark.json");
	const customTheme = `${await readFile(themePath, "utf8")}\n`;
	await writeFile(themePath, customTheme);
	await extension.commands.get("ccstyle").handler("themes", ctx);
	assert.equal(
		await readFile(themePath, "utf8"),
		customTheme,
		"Theme install preserves existing files",
	);
	assert.equal(extension.tools.has("write"), false, "OMP's native writer must remain registered");
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "A short reasoning preview." },
			{ type: "text", text: "Native assistant prose remains visible." },
			{ type: "toolCall", id: "render-bash", name: "bash", arguments: { command: "echo example" } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		timestamp: Date.now(),
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	await emit("message_update", {
		message,
		assistantMessageEvent: { type: "text_end", contentIndex: 1 },
	});
	const assistant = new host.AssistantMessageComponent(message, true);
	components.push(assistant);
	const assistantText = assistant.render(100).join("\n");
	assert.match(assistantText, /Native assistant prose remains visible/);
	assert.match(assistantText, /A short reasoning preview/);
	const tool = new host.ToolExecutionComponent(
		"bash",
		{ command: "echo example" },
		{},
		undefined,
		ui,
		scratch,
		"render-bash",
	);
	components.push(tool);
	tool.updateArgs({ command: "echo example" }, "render-bash");
	tool.setArgsComplete("render-bash");
	tool.setExecutionStarted("render-bash");
	tool.updateResult(
		{ content: [{ type: "text", text: "first line\nsecond line" }], details: {}, isError: false },
		false,
		"render-bash",
	);
	assert.match(tool.render(100).join("\n"), /2 lines returned/);
	await extension.commands.get("ccstyle").handler("compact", ctx);
	assert.equal(tool.render(100).length, 1, "OMP compact mode must render a single tool summary");
	tool.setExpanded(true);
	assert.match(tool.render(100).join("\n"), /second line/, "Expanded tools use native full output");
	tool.setExpanded(false);
	tool.setTranscriptAllocation(0, { now: Date.now(), delta: 0 });
	assert.deepEqual(tool.render(100), [], "OMP zero-row allocation must stay hidden");
	tool.setTranscriptAllocation(1, { now: Date.now(), delta: 0 });
	assert.ok(tool.render(100).length <= 1, "OMP row allocation must be respected");
	tool.setTranscriptAllocation(Infinity, { now: Date.now(), delta: 0 });
	tool.setToolActivityVisible(false);
	assert.deepEqual(tool.render(100), [], "OMP's hidden tool activity must stay hidden");
	tool.setToolActivityVisible(true);
	const expandedTool = new host.ToolExecutionComponent(
		"bash",
		{},
		{},
		undefined,
		ui,
		scratch,
		"render-bash",
	);
	components.push(expandedTool);
	expandedTool.setExpanded(true);
	expandedTool.updateArgs({ command: "echo example" }, "render-bash");
	expandedTool.updateResult(
		{
			content: [{ type: "text", text: "expanded before ID binding" }],
			details: {},
			isError: false,
		},
		false,
		"render-bash",
	);
	assert.match(expandedTool.render(100).join("\n"), /expanded before ID binding/);
	for (const mode of ["on", "compact", "off", "on"]) {
		await extension.commands.get("ccstyle").handler(mode, ctx);
	}
	await extension.commands.get("ccstyle").handler("status", ctx);
	await extension.commands.get("context").handler("", ctx);
	testingPanel = true;
	await extension.commands.get("ccstyle").handler("panel", ctx);
	testingPanel = false;
	await emit("session_compact");
	await emit("session_tree");
	await emit("session_switch", { reason: "new" });
	await emit("agent_start");
	await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await emit("tool_execution_start", {
		toolCallId: "smoke-read",
		toolName: "read",
		args: { path: "example.ts" },
	});
	await emit("tool_execution_end", {
		toolCallId: "smoke-read",
		toolName: "read",
		result: { content: [{ type: "text", text: "example" }], details: {} },
		isError: false,
	});
	await emit("turn_end", { turnIndex: 0, toolResults: [] });
	await emit("agent_end", { messages: [] });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(rendered.length > 0, "Header and command UI must render");
	console.log(
		`OMP ${host.VERSION}: loaded ${extension.commands.size} commands; lifecycle, context, panel, and native writer checks passed.`,
	);
} finally {
	await emit("session_shutdown");
	for (const component of components) component.dispose?.();
	assert.equal(host.AssistantMessageComponent.prototype.render, originalAssistantRender);
	assert.equal(host.ToolExecutionComponent.prototype.render, originalToolRender);
}
// Importing OMP also starts host workers; this standalone smoke process owns them.
process.exit(0);
