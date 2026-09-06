/**
 * Agent 回合摘要展示：agent_end 时把本回合工具统计写入会话条目，
 * 由 entry renderer 渲染为 markdown 引用块 `> [!TIP] *斜体内容*`。
 *
 * 统计复用 ./core.ts（bash|powershell/read/edit/write/other）。
 * appendEntry 不进 LLM 上下文，只显示在聊天区。
 * 引用块文字色取主题 mdQuote（cc 主题下为 muted 灰），内容用 *斜体* 语法。
 */

import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindAgentSummary, summaryMarkdown, type AgentSummaryData } from "./core.ts";

export const AGENT_SUMMARY_ENTRY_TYPE = "agent-summary";

function renderSummary(
	data: AgentSummaryData,
	theme: { getFgAnsi(name: "success" | "error"): string },
) {
	const line = summaryMarkdown(data, {
		success: theme.getFgAnsi("success"),
		failed: theme.getFgAnsi("error"),
	});
	return line ? new Markdown(line, 1, 0, getMarkdownTheme()) : undefined;
}

export default function (pi: ExtensionAPI): void {
	const canRenderEntries = typeof pi.registerEntryRenderer === "function";
	if (canRenderEntries) {
		pi.registerEntryRenderer(AGENT_SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
			return renderSummary(entry.data as AgentSummaryData, theme);
		});
	}

	const showWidget = (ctx: ExtensionContext | undefined, data?: AgentSummaryData): void => {
		if (canRenderEntries || !ctx?.hasUI) return;
		ctx.ui.setWidget(
			AGENT_SUMMARY_ENTRY_TYPE,
			data
				? (_tui, theme) => {
						return renderSummary(data, theme) ?? { render: () => [], invalidate() {} };
					}
				: undefined,
		);
	};

	bindAgentSummary(pi, (data, ctx) => {
		pi.appendEntry(AGENT_SUMMARY_ENTRY_TYPE, data);
		showWidget(ctx, data);
	});

	if (!canRenderEntries) {
		// OMP has no custom-entry renderer. Keep the latest summary in a widget;
		// appendEntry still persists it without adding UI text to model context.
		const restoreWidget = (_event: unknown, ctx: ExtensionContext) => {
			const entry = ctx.sessionManager
				.getBranch()
				.findLast(
					(entry) => entry.type === "custom" && entry.customType === AGENT_SUMMARY_ENTRY_TYPE,
				);
			showWidget(ctx, entry?.type === "custom" ? (entry.data as AgentSummaryData) : undefined);
		};
		pi.on("session_start", restoreWidget);
		(pi.on as (event: string, handler: typeof restoreWidget) => void)(
			"session_switch",
			restoreWidget,
		);
		pi.on("session_tree", restoreWidget);
		pi.on("session_shutdown", (_event, ctx) => showWidget(ctx));
	}
}
