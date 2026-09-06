import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { config } from "../extensions/config/config.ts";
import { showCcstylePanel } from "../extensions/config/panel.ts";
import { installOmpThinking, patchOmpComponents } from "../extensions/renderer/omp.ts";

initTheme("dark");

test("OMP settings show effective controls and explain native rendering", async () => {
	const rendered: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			async custom(factory: Function) {
				const panel = factory(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					() => {},
				);
				for (let section = 0; section < 4; section++) {
					rendered.push(panel.render(140).join("\n"));
					panel.handleInput("\t");
				}
			},
		},
	};
	await showCcstylePanel(
		ctx,
		{ applyStyleMode() {}, refreshCurrentTranscript() {} },
		undefined,
		undefined,
		{ host: "omp", toolNames: ["bash"] },
	);
	const text = rendered.join("\n");
	for (const label of [
		"Mode",
		"Exclude tools",
		"Preview lines",
		"Dim thinking text",
		"Input clip",
		"Startup header",
		"Session reference",
	])
		assert.ok(text.includes(label), label);
	for (const label of [
		"Diff layout",
		"Diff indicator",
		"Expanded input lines",
		"Expanded output lines",
		"Scroll step",
		"Summary title",
		"Animation interval ms",
	])
		assert.ok(!text.includes(label), label);
	assert.match(
		text,
		/OMP controls diffs, read groups, task cards, expanded output and mouse input/,
	);
});

test("OMP display adaptation preserves source messages through native metadata updates and disposal", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const message = {
		role: "assistant",
		timestamp: 23,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		content: [
			{ type: "thinking", thinking: "Original reasoning" },
			{ type: "text", text: "Answer" },
		],
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const source = JSON.stringify(message);
	const controller = patchOmpComponents(new Map(), () => undefined);
	try {
		const component = new AssistantMessageComponent(message as any, false) as any;
		assert.equal(
			JSON.stringify(message),
			source,
			"rendering must never alter persisted/model messages",
		);
		assert.match(component.render(100).join("\n"), /Thought/);
		// Native components can spread their last display copy to attach recovery metadata.
		component.updateContent({ ...component.lastMessage, retryRecovery: { reason: "test" } });
		config.mode = "off";
		controller.refresh();
		assert.match(component.render(100).join("\n"), /Original reasoning/);
		controller.dispose();
		assert.match(component.render(100).join("\n"), /Original reasoning/);
	} finally {
		controller.dispose();
		config.mode = previousMode;
	}
});

test("OMP thinking durations follow session switches and ignore headless sessions", () => {
	const handlers = new Map<string, Function[]>();
	const appended: any[] = [];
	const pi = {
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry(type: string, data: any) {
			appended.push({ type, data });
		},
	};
	const emit = (name: string, event: any, ctx?: any) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	const context = (timestamp: number, hasUI = true) => ({
		hasUI,
		sessionManager: {
			getBranch: () => [
				{
					type: "custom",
					customType: "compact-thinking-duration",
					data: { messageTimestamp: timestamp, durationMs: 123 },
				},
			],
		},
	});
	const controller = installOmpThinking(
		pi as any,
		{ previewLines: 3, animationIntervalMs: 90, useSummaryTitlesAsThinkingTitle: true },
		() => {},
	);
	emit("session_start", {}, context(1));
	assert.equal(controller.getMessageThinkingDurationMs?.(1), 123);
	emit("session_switch", {}, context(2));
	assert.equal(controller.getMessageThinkingDurationMs?.(1), undefined);
	assert.equal(controller.getMessageThinkingDurationMs?.(2), 123);
	const event = {
		message: { role: "assistant", timestamp: 3 },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	};
	emit("message_update", event);
	assert.equal(controller.isMessageThinkingActive?.(3), true);
	emit("message_update", { ...event, assistantMessageEvent: { type: "thinking_end" } });
	assert.equal(appended.length, 1);
	assert.equal(controller.isMessageThinkingActive?.(3), false);
	emit("session_start", {}, context(4, false));
	emit("message_update", event);
	assert.equal(controller.isMessageThinkingActive?.(3), false);
});

test("OMP native render failure before theme init is swallowed, not surfaced as an extension error", () => {
	// OMP's native updateContent/render dereference the global theme singleton via
	// getMarkdownTheme(); during early session_start / resume the theme can still be
	// undefined, and the native rebuild then throws "theme.getColorMode of undefined".
	// Our prototype patches must not let that bubble out as an extension error banner.
	const proto = AssistantMessageComponent.prototype as any;
	const realRender = proto.render;
	proto.render = function () {
		throw new TypeError("undefined is not an object (evaluating 'theme.getColorMode')");
	};
	const instance = Object.create(proto);
	try {
		// Theme not ready (getTheme() -> undefined): swallow and render nothing this frame.
		// OMP re-invalidates once the theme initializes, so the adaptation self-heals.
		const notReady = patchOmpComponents(new Map(), () => undefined);
		try {
			assert.deepEqual(instance.render(80), []);
		} finally {
			notReady.dispose();
		}
		// Theme ready: a native failure is a real bug and must propagate, never be hidden.
		const ready = patchOmpComponents(new Map(), () => ({ fg: (_c: string, t: string) => t }));
		try {
			assert.throws(() => instance.render(80), /getColorMode/);
		} finally {
			ready.dispose();
		}
	} finally {
		proto.render = realRender;
	}
});
