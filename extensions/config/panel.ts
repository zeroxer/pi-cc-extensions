/**
 * /ccstyle 配置面板 UI。
 *
 * 渲染副作用（applyStyleMode / refreshCurrentTranscript）由 renderer 经
 * CcstylePanelHooks 注入，避免 config → renderer 循环依赖。
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	SettingsList,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CompactThinkingController } from "../feature/compact-thinking.ts";
import { applyStartupHeader } from "../feature/shell/startup-header.ts";
import type { ToolGroupingHooks } from "../renderer/tool/grouping.ts";
import {
	config,
	DEFAULT_CONFIG,
	DIFF_COLLAPSED_LINES_VALUES,
	DIFF_INDICATOR_MODES,
	DIFF_SPLIT_MIN_WIDTH_VALUES,
	DIFF_VIEW_MODES,
	EXCLUDE_RENDERER_CANDIDATES,
	EXPANDED_INPUT_MAX_LINES_VALUES,
	EXPANDED_OUTPUT_MAX_LINES_VALUES,
	EXPANDED_PREVIEW_MAX_LINES_VALUES,
	formatExcludeRenderers,
	getCompactThinkingConfig,
	pickPositiveInt,
	pickPositiveNumber,
	SCROLL_STEP_LINES_VALUES,
	THINKING_ANIMATION_INTERVAL_VALUES,
	THINKING_PREVIEW_LINES_VALUES,
	INPUT_CLIP_VALUES,
	WRITE_DIFF_COLLAPSED_LINES_VALUES,
	updateConfig,
	type CompactStyleMode,
	type Config,
	type DiffIndicatorMode,
	type DiffViewMode,
} from "./config.ts";

/** renderer 注入的渲染副作用，面板自身不触碰渲染状态。 */
export type CcstylePanelHooks = {
	applyStyleMode: (mode: CompactStyleMode, ctx: any, toolGrouping?: ToolGroupingHooks) => void;
	refreshCurrentTranscript: (ctx?: any, toolGrouping?: ToolGroupingHooks) => void;
};

export type CcstylePanelOptions = {
	host?: "pi" | "omp";
	toolNames?: readonly string[];
};

function panelModeDescription(mode: CompactStyleMode, options: CcstylePanelOptions): string {
	if (options.host !== "omp") return modeSettingDescription(mode);
	if (mode === "compact")
		return "One line per tool card and thinking block. OMP keeps its read groups and task cards.";
	if (mode === "off")
		return "OMP native tool and thinking rendering. Markdown enhancements remain enabled.";
	return "Concise tool cards and thinking previews. Expanded tools use OMP's native view.";
}

function panelExcludeDescription(names: readonly string[], options: CcstylePanelOptions): string {
	if (options.host !== "omp") return excludeRenderersDescription(names);
	return names.length
		? `Use OMP's native rendering for: ${names.join(", ")}. Enter to change.`
		: "Choose tools that should use OMP's native rendering.";
}

function modeSettingDescription(mode: CompactStyleMode): string {
	if (mode === "compact") {
		return "(Experimental) One summary line per assistant round; edit/write reuse the same Diff preview settings as on.";
	}
	if (mode === "off") {
		return "Pi native tool rendering. Diff options below still apply independently.";
	}
	return "Claude Code style with rich edit/write diffs. Tune diff options below.";
}

function excludeRenderersDescription(names: readonly string[]): string {
	return names.length === 0
		? "No tools excluded. Agent always keeps its dedicated renderer. Enter to toggle common tools."
		: `Native renderer for: ${names.join(", ")}. Agent is always native. Enter to toggle.`;
}

function diffViewModeDescription(mode: DiffViewMode): string {
	if (mode === "split") return "Force side-by-side diff when width allows; otherwise unified.";
	if (mode === "unified") return "Always render a single unified diff column.";
	return "Auto: split when terminal is wide enough, otherwise unified.";
}

function diffIndicatorDescription(mode: DiffIndicatorMode): string {
	if (mode === "classic") return "Classic +/- gutters on changed lines.";
	if (mode === "none") return "No change indicators; rely on color alone.";
	return "Vertical bar indicators on changed lines (default).";
}

/** 额外功能开关项：on/off 二值，描述随状态切换；切换后需重启生效。 */
function featureToggleSetting(
	id: string,
	label: string,
	onDescription: string,
	offDescription: string,
	current: boolean,
) {
	const setting = {
		id,
		label,
		description: current ? onDescription : offDescription,
		currentValue: current ? "on" : "off",
		values: ["on", "off"],
	};
	return {
		setting,
		apply(on: boolean): void {
			setting.currentValue = on ? "on" : "off";
			setting.description = on ? onDescription : offDescription;
		},
	};
}

function buildExcludeRenderersSubmenu(
	onClose: () => void,
	onLiveChange: () => void,
	options: CcstylePanelOptions,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const candidates = [
		...new Set(options.toolNames ?? [...EXCLUDE_RENDERER_CANDIDATES, ...config.excludeRenderers]),
	].sort((a, b) => a.localeCompare(b));
	const items = candidates.map((name) => ({
		id: name,
		label: name,
		description:
			name === "Agent"
				? "Agent always uses its dedicated renderer and cannot be forced through ccstyle."
				: `Use ${options.host === "omp" ? "OMP" : "Pi"} native renderer for ${name} instead of Claude Code styling.`,
		currentValue: config.excludeRenderers.includes(name) ? "exclude" : "style",
		values: ["style", "exclude"],
	}));
	const list = new SettingsList(
		items,
		Math.min(8, Math.max(4, items.length)),
		getSettingsListTheme(),
		(id: string, value: string) => {
			const excluded = new Set(config.excludeRenderers);
			if (value === "exclude") excluded.add(id);
			else excluded.delete(id);
			updateConfig({ excludeRenderers: [...excluded].sort((a, b) => a.localeCompare(b)) });
			onLiveChange();
		},
		() => onClose(),
		{ enableSearch: candidates.length > 8 },
	);
	return {
		render: (width: number) => [
			...list.render(width),
			"",
			// Extra hint: Esc returns to the Style section list.
			truncateToWidth("  Esc back to Style settings", width),
		],
		invalidate: () => list.invalidate(),
		handleInput: (data: string) => list.handleInput(data),
	};
}

/** 数值项手动输入子面板：预填当前值，Space 循环预设，输入数字自定义，Enter 应用，Esc 取消。 */
function buildNumberInputSubmenu(
	theme: any,
	setting: { label: string; values: readonly string[]; currentValue: string },
	closeSubmenu: (selected?: string) => void,
): {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
} {
	const input = new Input();
	let error = "";
	input.setValue(setting.currentValue);
	input.onSubmit = (value: string) => {
		const raw = value.trim();
		if (raw === "") {
			closeSubmenu(); // 空输入 = 取消
			return;
		}
		if (!Number.isFinite(Number(raw))) {
			error = `Invalid number: "${raw}"`;
			return;
		}
		closeSubmenu(raw);
	};
	input.onEscape = () => closeSubmenu();
	return {
		render: (width: number) => {
			const safe = Math.max(0, Math.floor(width));
			const lines = [
				theme.fg("dim", `  ${setting.label} — custom value:`),
				...input.render(safe),
				truncateToWidth(theme.fg("dim", "  Enter to apply · Esc to go back"), safe),
			];
			if (error !== "") lines.push(theme.fg("dim", `  ${error}`));
			return lines;
		},
		invalidate: () => {},
		handleInput: (data: string) => input.handleInput(data),
	};
}

/** Section tabs for /ccstyle — matches Zentui-style "A / B / C" headers. */
type CcstyleSection = {
	id: "style" | "diff" | "thinking" | "ui" | "feature";
	label: string;
	items: any[];
};

function isForwardTabKey(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isBackTabKey(data: string): boolean {
	// CSI Z is the common terminal encoding for Shift+Tab.
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

function renderPanelRule(theme: any, width: number): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function renderSectionTabBar(
	theme: any,
	sections: readonly { label: string }[],
	activeIndex: number,
	width: number,
): string {
	const pieces: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (i > 0) pieces.push(theme.fg("dim", " / "));
		const label = sections[i]?.label ?? "";
		pieces.push(
			i === activeIndex
				? theme.fg("text", typeof theme.bold === "function" ? theme.bold(label) : label)
				: theme.fg("dim", label),
		);
	}
	return truncateToWidth(pieces.join(""), Math.max(0, width));
}

export async function showCcstylePanel(
	ctx: any,
	hooks: CcstylePanelHooks,
	toolGrouping?: ToolGroupingHooks,
	compactThinking?: CompactThinkingController,
	options: CcstylePanelOptions = {},
): Promise<void> {
	if (
		(ctx?.mode !== "tui" && ctx?.mode !== undefined) ||
		!ctx?.hasUI ||
		typeof ctx.ui?.custom !== "function"
	) {
		ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
		return;
	}

	await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
		const modeSetting = {
			id: "mode",
			label: "Mode",
			description: panelModeDescription(config.mode, options),
			currentValue: config.mode === "compact" ? "compact (Experimental)" : config.mode,
			values: ["on", "compact (Experimental)", "off"],
		};
		// Tracks whether the Exclude-tools submenu is open so Tab switches sections
		// only at the top level (mirrors Zentui settings: Tab = switch sections).
		let excludeSubmenuOpen = false;
		const excludeSetting = {
			id: "excludeRenderers",
			label: "Exclude tools",
			description: panelExcludeDescription(config.excludeRenderers, options),
			currentValue: formatExcludeRenderers(config.excludeRenderers),
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) => {
				excludeSubmenuOpen = true;
				return buildExcludeRenderersSubmenu(
					() => {
						excludeSubmenuOpen = false;
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = panelExcludeDescription(config.excludeRenderers, options);
						closeSubmenu();
					},
					() => {
						excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
						excludeSetting.description = panelExcludeDescription(config.excludeRenderers, options);
						hooks.refreshCurrentTranscript(ctx);
					},
					options,
				);
			},
		};
		const inputClipSetting = {
			id: "inputClip",
			label: "Input clip",
			description:
				"Max characters for path/command/name in single and grouped tool summaries. Enter to type a custom value.",
			currentValue: String(config.inputClip),
			values: [...INPUT_CLIP_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, inputClipSetting, closeSubmenu),
		};
		const diffViewSetting = {
			id: "diffViewMode",
			label: "Diff layout",
			description: diffViewModeDescription(config.diffViewMode),
			currentValue: config.diffViewMode,
			values: [...DIFF_VIEW_MODES],
		};
		const diffIndicatorSetting = {
			id: "diffIndicatorMode",
			label: "Diff indicator",
			description: diffIndicatorDescription(config.diffIndicatorMode),
			currentValue: config.diffIndicatorMode,
			values: [...DIFF_INDICATOR_MODES],
		};
		const diffSplitSetting = {
			id: "diffSplitMinWidth",
			label: "Split min width",
			description:
				"Minimum terminal width before auto/split layout uses side-by-side columns. Enter to type a custom value.",
			currentValue: String(config.diffSplitMinWidth),
			values: [...DIFF_SPLIT_MIN_WIDTH_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, diffSplitSetting, closeSubmenu),
		};
		const diffCollapsedSetting = {
			id: "editDiffCollapsedLines",
			label: "Edit collapsed lines",
			description:
				"How many edit/diff body lines to show before the expand hint (Ctrl+O / click). Write uses its own setting below.",
			currentValue: String(config.editDiffCollapsedLines),
			values: [...DIFF_COLLAPSED_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, diffCollapsedSetting, closeSubmenu),
		};
		const writeDiffCollapsedSetting = {
			id: "writeDiffCollapsedLines",
			label: "Write collapsed lines",
			description:
				"Write-only collapsed body lines. 0 shows ↳ created + expand hint (stats stay on the title). Enter to type a custom value.",
			currentValue: String(config.writeDiffCollapsedLines),
			values: [...WRITE_DIFF_COLLAPSED_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, writeDiffCollapsedSetting, closeSubmenu),
		};
		const diffWordWrapSetting = {
			id: "diffWordWrap",
			label: "Diff word wrap",
			description: config.diffWordWrap
				? "Long diff lines wrap within the panel width."
				: "Long diff lines are truncated to the panel width.",
			currentValue: config.diffWordWrap ? "on" : "off",
			values: ["on", "off"],
		};
		const expandedInputSetting = {
			id: "expandedInputMaxLines",
			label: "Expanded input lines",
			description:
				"Max Input section lines in an expanded tool card. Overflow shows click to show more. Default 5.",
			currentValue: String(config.expandedInputMaxLines),
			values: [...EXPANDED_INPUT_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, expandedInputSetting, closeSubmenu),
		};
		const expandedOutputSetting = {
			id: "expandedOutputMaxLines",
			label: "Expanded output lines",
			description:
				"Max Output section lines in an expanded tool card. Overflow shows click to show more. Default 10.",
			currentValue: String(config.expandedOutputMaxLines),
			values: [...EXPANDED_OUTPUT_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, expandedOutputSetting, closeSubmenu),
		};
		const expandedMaxSetting = {
			id: "expandedPreviewMaxLines",
			label: "Expanded max lines",
			description:
				"Max diff/TaskList body lines when expanded. Tool Input/Output use the two settings above.",
			currentValue: String(config.expandedPreviewMaxLines),
			values: [...EXPANDED_PREVIEW_MAX_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, expandedMaxSetting, closeSubmenu),
		};
		const thinkingTitleSetting = {
			id: "useSummaryTitlesAsThinkingTitle",
			label: "Summary title",
			description: "Use the latest provider summary as the active thinking title.",
			currentValue: config.useSummaryTitlesAsThinkingTitle ? "on" : "off",
			values: ["on", "off"],
		};
		const thinkingPreviewSetting = {
			id: "previewLines",
			label: "Preview lines",
			description: "Thinking preview lines; 0 hides the preview body.",
			currentValue: String(config.previewLines),
			values: [...THINKING_PREVIEW_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, thinkingPreviewSetting, closeSubmenu),
		};
		const thinkingAnimationSetting = {
			id: "animationIntervalMs",
			label: "Animation interval ms",
			description: "Thinking title animation interval for the next thinking run.",
			currentValue: String(config.animationIntervalMs),
			values: [...THINKING_ANIMATION_INTERVAL_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, thinkingAnimationSetting, closeSubmenu),
		};
		const thinkingDimSetting = {
			id: "dimThinkingText",
			label: "Dim thinking text",
			description: config.dimThinkingText
				? "Thinking text uses the theme's dim color."
				: "Keep the default thinking text color.",
			currentValue: config.dimThinkingText ? "on" : "off",
			values: ["on", "off"],
		};
		const startupHeaderSetting = {
			id: "showStartupHeader",
			label: "Startup header",
			description: config.showStartupHeader
				? "Show the custom startup header (logo + tips) on new sessions."
				: "Use Pi's native startup header instead.",
			currentValue: config.showStartupHeader ? "on" : "off",
			values: ["on", "off"],
		};
		const scrollStepSetting = {
			id: "scrollStepLines",
			label: "Scroll step",
			description: "Mouse wheel scroll lines in fullscreen mode.",
			currentValue: String(config.scrollStepLines),
			values: [...SCROLL_STEP_LINES_VALUES],
			submenu: (_current: string, closeSubmenu: (selected?: string) => void) =>
				buildNumberInputSubmenu(theme, scrollStepSetting, closeSubmenu),
		};

		// 额外功能开关：注册于扩展加载期，切换后需重启（/reload）生效。
		const sessionReferenceToggle = featureToggleSetting(
			"enableSessionReference",
			"Session reference",
			"@ session mentions search & inject referenced session context. Next restart applies.",
			"Session reference disabled.",
			config.enableSessionReference,
		);
		const subagentAutocompleteToggle = featureToggleSetting(
			"enableSubagentAutocomplete",
			"Subagent autocomplete",
			"@ subagent mentions suggest agents and inject delegation instructions. Next restart applies.",
			"Subagent autocomplete disabled.",
			config.enableSubagentAutocomplete,
		);
		const contextCommandToggle = featureToggleSetting(
			"enableContextCommand",
			"Context usage",
			"/context shows context-window distribution with previews. Next restart applies.",
			"Context command disabled.",
			config.enableContextCommand,
		);
		const agentSummaryToggle = featureToggleSetting(
			"enableAgentSummary",
			"Agent summary",
			"Append per-round tool stats after each agent turn. Next restart applies.",
			"Agent summary disabled.",
			config.enableAgentSummary,
		);
		const workingMessageToggle = featureToggleSetting(
			"enableWorkingMessage",
			"Working message",
			"Extend Working... footer with token count and elapsed time. Next restart applies.",
			"Native Working... footer only.",
			config.enableWorkingMessage,
		);
		const aliasesToggle = featureToggleSetting(
			"enableAliases",
			"Aliases",
			"/clear and /exit aliases enabled. Next restart applies.",
			"Aliases disabled.",
			config.enableAliases,
		);
		const featureToggles: Record<string, { apply: (on: boolean) => void }> = {
			enableSessionReference: sessionReferenceToggle,
			enableSubagentAutocomplete: subagentAutocompleteToggle,
			enableContextCommand: contextCommandToggle,
			enableAgentSummary: agentSummaryToggle,
			enableWorkingMessage: workingMessageToggle,
			enableAliases: aliasesToggle,
		};

		const onSettingChange = (id: string, value: string) => {
			// 额外功能开关：字段名与配置布尔字段一一对应，切换后重启生效。
			const featureToggle = featureToggles[id];
			if (featureToggle) {
				updateConfig({ [id]: value === "on" } as Partial<Config>);
				featureToggle.apply(value === "on");
				ctx.ui.notify(`Updated ${id}: ${value} (next restart)`, "info");
				return;
			}
			switch (id) {
				case "inputClip":
					updateConfig({
						inputClip: pickPositiveInt(value, DEFAULT_CONFIG.inputClip, 8, 500),
					});
					inputClipSetting.currentValue = String(config.inputClip);
					break;
				case "mode": {
					// 选项值带 Experimental 标记，选择后还原为真实 mode 值。
					const mode: CompactStyleMode =
						value === "compact (Experimental)" ? "compact" : (value as CompactStyleMode);
					modeSetting.description = panelModeDescription(mode, options);
					hooks.applyStyleMode(mode, ctx, toolGrouping);
					return;
				}
				case "excludeRenderers":
					excludeSetting.currentValue = formatExcludeRenderers(config.excludeRenderers);
					excludeSetting.description = panelExcludeDescription(config.excludeRenderers, options);
					return;
				case "diffViewMode":
					updateConfig({ diffViewMode: value as DiffViewMode });
					diffViewSetting.description = diffViewModeDescription(config.diffViewMode);
					break;
				case "diffIndicatorMode":
					updateConfig({ diffIndicatorMode: value as DiffIndicatorMode });
					diffIndicatorSetting.description = diffIndicatorDescription(config.diffIndicatorMode);
					break;
				case "diffSplitMinWidth":
					updateConfig({
						diffSplitMinWidth: pickPositiveInt(value, DEFAULT_CONFIG.diffSplitMinWidth, 40, 300),
					});
					diffSplitSetting.currentValue = String(config.diffSplitMinWidth);
					break;
				case "editDiffCollapsedLines":
					updateConfig({
						editDiffCollapsedLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.editDiffCollapsedLines,
							1,
							500,
						),
					});
					diffCollapsedSetting.currentValue = String(config.editDiffCollapsedLines);
					break;
				case "writeDiffCollapsedLines":
					updateConfig({
						writeDiffCollapsedLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.writeDiffCollapsedLines,
							0,
							500,
						),
					});
					writeDiffCollapsedSetting.currentValue = String(config.writeDiffCollapsedLines);
					break;
				case "diffWordWrap":
					updateConfig({ diffWordWrap: value === "on" });
					diffWordWrapSetting.description = config.diffWordWrap
						? "Long diff lines wrap within the panel width."
						: "Long diff lines are truncated to the panel width.";
					break;
				case "expandedInputMaxLines":
					updateConfig({
						expandedInputMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.expandedInputMaxLines,
							1,
							5_000,
						),
					});
					expandedInputSetting.currentValue = String(config.expandedInputMaxLines);
					break;
				case "expandedOutputMaxLines":
					updateConfig({
						expandedOutputMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.expandedOutputMaxLines,
							1,
							5_000,
						),
					});
					expandedOutputSetting.currentValue = String(config.expandedOutputMaxLines);
					break;
				case "expandedPreviewMaxLines":
					updateConfig({
						expandedPreviewMaxLines: pickPositiveInt(
							value,
							DEFAULT_CONFIG.expandedPreviewMaxLines,
							10,
							50_000,
						),
					});
					expandedMaxSetting.currentValue = String(config.expandedPreviewMaxLines);
					break;
				case "useSummaryTitlesAsThinkingTitle":
					updateConfig({ useSummaryTitlesAsThinkingTitle: value === "on" });
					break;
				case "previewLines":
					updateConfig({ previewLines: pickPositiveInt(value, DEFAULT_CONFIG.previewLines, 0) });
					thinkingPreviewSetting.currentValue = String(config.previewLines);
					break;
				case "animationIntervalMs":
					updateConfig({
						animationIntervalMs: pickPositiveNumber(value, DEFAULT_CONFIG.animationIntervalMs),
					});
					thinkingAnimationSetting.currentValue = String(config.animationIntervalMs);
					break;
				case "dimThinkingText":
					updateConfig({ dimThinkingText: value === "on" });
					thinkingDimSetting.description = config.dimThinkingText
						? "Thinking text uses the theme's dim color."
						: "Keep the default thinking text color.";
					break;
				case "showStartupHeader":
					updateConfig({ showStartupHeader: value === "on" });
					startupHeaderSetting.description = config.showStartupHeader
						? "Show the custom startup header (logo + tips) on new sessions."
						: "Use Pi's native startup header instead.";
					// 实时切换：on → 自定义 header；off → 官方默认 header。
					applyStartupHeader(ctx);
					break;
				case "scrollStepLines":
					updateConfig({
						scrollStepLines: pickPositiveInt(value, DEFAULT_CONFIG.scrollStepLines, 1, 50),
					});
					scrollStepSetting.currentValue = String(config.scrollStepLines);
					break;
				default:
					return;
			}
			compactThinking?.updateConfig(getCompactThinkingConfig());
			hooks.refreshCurrentTranscript(ctx);
			ctx.ui.notify(`Updated ${id}: ${value}`, "info");
		};

		let sections: CcstyleSection[] = [
			{
				id: "style",
				label: "Style",
				items: [modeSetting, excludeSetting],
			},
			{
				id: "diff",
				label: "Diff",
				items: [
					diffViewSetting,
					diffIndicatorSetting,
					diffSplitSetting,
					diffCollapsedSetting,
					writeDiffCollapsedSetting,
					diffWordWrapSetting,
				],
			},
			{
				id: "thinking",
				label: "Thinking",
				items: [
					thinkingTitleSetting,
					thinkingPreviewSetting,
					thinkingAnimationSetting,
					thinkingDimSetting,
				],
			},
			{
				id: "ui",
				label: "UI",
				items: [
					expandedInputSetting,
					expandedOutputSetting,
					expandedMaxSetting,
					inputClipSetting,
					startupHeaderSetting,
					scrollStepSetting,
				],
			},
			{
				id: "feature",
				label: "Feature",
				items: [
					sessionReferenceToggle.setting,
					subagentAutocompleteToggle.setting,
					contextCommandToggle.setting,
					agentSummaryToggle.setting,
					workingMessageToggle.setting,
					aliasesToggle.setting,
				],
			},
		];
		if (options.host === "omp") {
			inputClipSetting.description =
				"Max characters for paths and commands in tool summaries. Enter to type a custom value.";
			thinkingPreviewSetting.description =
				"Thinking preview body lines in on mode; 0 hides the body.";
			sections = [
				{
					id: "style",
					label: "Style",
					items: [modeSetting, ...(options.toolNames?.length === 0 ? [] : [excludeSetting])],
				},
				{ id: "thinking", label: "Thinking", items: [thinkingPreviewSetting, thinkingDimSetting] },
				{ id: "ui", label: "UI", items: [inputClipSetting, startupHeaderSetting] },
				sections.find((section) => section.id === "feature")!,
			];
		}

		let activeSection = 0;
		const settingsTheme = getSettingsListTheme();
		const lists = sections.map(
			(section) =>
				new SettingsList(
					section.items,
					Math.min(8, Math.max(section.items.length, 1)),
					settingsTheme,
					onSettingChange,
					() => done(),
					{ enableSearch: false },
				),
		);

		const activeList = () => lists[activeSection]!;

		const switchSection = (delta: number) => {
			if (excludeSubmenuOpen) return;
			activeSection = (activeSection + delta + sections.length) % sections.length;
		};

		/** 数值项：当前选中项有 submenu + values 时，Space 仅循环预设，不打开子面板。 */
		const cyclePresetInList = (list: InstanceType<typeof SettingsList>): boolean => {
			const internal = list as unknown as {
				getSelectedItem?: () => any;
				hasOpenSubmenu?: () => boolean;
				submenuComponent: unknown;
				items: {
					id: string;
					currentValue: string;
					submenu?: unknown;
					values?: readonly string[];
				}[];
				selectedIndex: number;
			};
			if (internal.hasOpenSubmenu?.() || internal.submenuComponent) return false;
			const item = internal.getSelectedItem?.() ?? internal.items?.[internal.selectedIndex];
			if (!item?.submenu || !item.values?.length) return false;
			const i = item.values.indexOf(item.currentValue);
			item.currentValue = item.values[i === -1 ? 0 : (i + 1) % item.values.length]!;
			onSettingChange(item.id, item.currentValue);
			return true;
		};

		return {
			render(width: number): string[] {
				const safeWidth = Math.max(0, Math.floor(width));
				const rule = renderPanelRule(theme, safeWidth);
				const body = activeList().render(safeWidth);
				// Drop SettingsList's built-in hint — the panel footer below is the single source.
				while (body.length > 0 && body[body.length - 1] === "") body.pop();
				const listHintIndex = body.findIndex(
					(line) =>
						typeof line === "string" &&
						(line.includes("Enter/Space to change") || line.includes("Esc to cancel")),
				);
				const listBody = listHintIndex >= 0 ? body.slice(0, listHintIndex) : body;
				while (listBody.length > 0 && listBody[listBody.length - 1] === "") listBody.pop();

				// Frame: top rule · tabs · mid rule · settings · mid rule · footer · bottom rule
				return [
					rule,
					renderSectionTabBar(theme, sections, activeSection, safeWidth),
					rule,
					...listBody,
					...(options.host === "omp"
						? wrapTextWithAnsi(
								theme.fg(
									"dim",
									"OMP controls diffs, read groups, task cards, expanded output and mouse input. Themes: /ccstyle themes, then /theme.",
								),
								safeWidth,
							)
						: []),
					rule,
					truncateToWidth(
						theme.fg(
							"dim",
							"  Enter/Space to change · Enter on numbers types a custom value · Tab/Shift+Tab to switch sections · Esc to close",
						),
						safeWidth,
					),
					rule,
				];
			},
			invalidate() {
				for (const list of lists) list.invalidate();
			},
			handleInput(data: string) {
				if (!excludeSubmenuOpen && isForwardTabKey(data)) {
					switchSection(1);
					tui.requestRender();
					return;
				}
				if (!excludeSubmenuOpen && isBackTabKey(data)) {
					switchSection(-1);
					tui.requestRender();
					return;
				}
				const list = activeList();
				// Space 循环预设（数值项不进子面板）；Enter 打开子面板输入自定义值。
				if (data === " " && cyclePresetInList(list)) {
					tui.requestRender();
					return;
				}
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
	// 面板卸下后主 transcript 重新挂载；再刷一次，吃掉打开期间扫树失败的切换。
	hooks.refreshCurrentTranscript(ctx, toolGrouping);
}
