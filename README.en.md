<p align="center">
  <img src="./assets/readme/hero.en.svg" width="100%" alt="pi-cc-extensions: a productivity extension suite for Pi">
</p>

<p align="center">
  <a href="https://pi.dev/packages?name=pi-cc-extensions"><img alt="Pi package catalog" src="https://img.shields.io/badge/Pi-package-58B7FF?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-cc-extensions"><img alt="npm version" src="https://img.shields.io/npm/v/pi-cc-extensions?style=flat-square&color=66E3C4"></a>
  <a href="#compatibility"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-66E3C4?style=flat-square"></a>
</p>

<p align="center">
  Claude Code-style TUI output with some personal touches and handy utilities.
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

---

## Preview

https://github.com/user-attachments/assets/6c858000-fdad-43f9-957f-4d0278648498

## OMP-compatible fork

This fork of [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) supports both Pi and Oh My Pi. The OMP integration is verified against **18.1.11**.

```bash
omp install git:github.com/zeroxer/pi-cc-extensions
```

Restart OMP or run `/reload`, then open `/ccstyle`. Install this GitHub fork to get these fixes; `npm:pi-cc-extensions` still resolves to the upstream npm release.

OMP uses a separate renderer: `on` shows concise tool summaries, `compact` uses single-line tool cards, and `off` restores native rendering. Use OMP's native expansion to see full output. Edit/write diffs, task cards, read grouping, and mouse interaction stay native. OMP's writer is never replaced. Pi's transcript grouping and fullscreen mouse patches are not installed in OMP.

Context inspection, saved session references, thinking previews, the header, and working status support OMP. Native live OMP task references are not integrated; the live subagent features below apply to Pi. Memory remains part of System prompt because OMP exposes the effective prompt rather than Pi's prompt-building options. The latest turn's tool summary uses a widget without adding model context. Configuration uses the host agent directory (normally `~/.omp/agent/claude-code-style.json` in OMP, honoring `PI_CODING_AGENT_DIR`). In OMP, run `/ccstyle themes` to install compatible CC Dark / CC Light themes, then select one in `/settings`. Existing theme files are preserved. Pi continues to discover its bundled themes automatically.

Local verification:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
# Requires Bun and the installed OMP package directory; makes no model request
npm run test:omp -- /path/to/node_modules/@oh-my-pi/pi-coding-agent
```

## Pi quick start

```bash
pi install npm:pi-cc-extensions

# GitHub
pi install git:github.com/minuque/pi-cc-extensions
```

Run `/reload` after installation.

## Pi features

| Feature                     | Description                                                                               | Entry point                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code Output          | Tool summaries, expand/collapse, rich edit/write diffs, and`on` / `compact` / `off` modes | `/ccstyle`                                      |
| Markdown enhancements      | Mermaid art, admonitions, URL linking, and more                                           | Automatic                                        |
| Fullscreen mode             | Tool card/group click to expand, double-click to collapse, previews, hover highlight, and a back-to-bottom button | `TUIMODE=fullscreen` or `--tui-mode fullscreen` |
| Settings panel              | `Style / Diff / Thinking / UI / Feature` tabs                                             | `/ccstyle`                                      |
| Context inspection          | Usage breakdown and previews for the system prompt, memory, skills, tools definition, and messages | `/context`                                      |
| Session/Subagent references | Search and inject effective context from previous Sessions or existing SubAgents          | `@`                                             |
| Theme                       | Bundled CC Dark and CC Light themes                                                       | Pi: `/theme`; OMP: `/ccstyle themes`, then `/settings` |

## Configuration

`/ccstyle` uses the host agent directory: `~/.pi/agent/claude-code-style.json` in Pi, normally `~/.omp/agent/claude-code-style.json` in OMP. The full Pi configuration follows; OMP shows only applicable controls:

```js
{
  "mode": "on",                            // on / compact / off
  "excludeRenderers": [],                  // tools keeping the native renderer; Agent always keeps its dedicated renderer

  // diff
  "diffViewMode": "auto",                  // layout: auto / split / unified
  "diffIndicatorMode": "bars",             // change indicators: bars / classic / none
  "diffSplitMinWidth": 120,                // min terminal width for side-by-side columns
  "editDiffCollapsedLines": 24,            // Edit collapse lines; beyond that shows the expand hint
  "writeDiffCollapsedLines": 0,            // write collapse lines; 0 = creation summary only
  "diffWordWrap": true,                    // wrap long diff lines

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // use latest summary as thinking title
  "previewLines": 3,                       // preview lines; 0 hides
  "animationIntervalMs": 90,               // title animation interval (ms)
  "dimThinkingText": false,                // dim thinking body text

  // ui
  "expandedInputMaxLines": 5,              // expanded tool Input lines; overflow shows a footer hint
  "expandedOutputMaxLines": 10,            // expanded tool Output lines; overflow shows a footer hint
  "expandedPreviewMaxLines": 40,           // max lines for expanded diff/TaskList bodies
  "inputClip": 100,                        // tool summary path/command clip length
  "showStartupHeader": true,               // startup header (logo + tips) toggle
  "scrollStepLines": 3,                    // fullscreen wheel scroll step

  // features
  "enableSessionReference": true,          // @ session references
  "enableSubagentAutocomplete": true,      // @ subagent completion and delegation hints
  "enableContextCommand": true,            // /context usage check
  "enableAgentSummary": true,              // per-turn tool summary
  "enableWorkingMessage": true,            // Working... bottom token/elapsed
  "enableAliases": true                    // /clear, /exit aliases
}
```

> **Fullscreen**: click `click to show more` to expand tool cards, thinking, Skill, and compact summaries. When expanded Input/Output exceeds the line cap, the footer `… +N more lines • click to show more` opens a full preview. Double-click an expanded panel to collapse it.
>
> **Tip**: set `markdown.mermaid` to `final` via `~/.pi/agent/settings.json` or the Mermaid diagrams option in `/settings`. Default `streaming` redraws per frame; `final` renders once at completion.

## Local development

```bash
npm test
npm run typecheck
./test.bat # or pi -e .
```

## Compatibility

- Node.js `>=22.19.0`, Pi `^0.84.0` (loaded through `pi.extensions` and `pi.themes` in the root `package.json`)

## Recommended companions

| Extension                                | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `npm:@tintinweb/pi-subagents`            | Parallel SubAgents, background tasks, and worktree isolation |
| `npm:@tintinweb/pi-tasks`                | Claude Code-style task tracking and coordination             |
| `npm:pi-mcp-adapter`                     | On-demand MCP tool discovery with lower context usage        |
| `npm:@ff-labs/pi-fff`                    | FFF-powered fuzzy file and content search (fffind / ffgrep)  |
| `npm:pi-web-access`                      | Web search, URL fetching, GitHub cloning, PDF/video parsing  |
| `npm:@narumitw/pi-usage`                 | Current-account usage for Codex / Copilot / OpenRouter       |
| `git:github.com/DietrichGebert/ponytail` | Lazy-mode coding: forces the simplest working solution       |

## Credits

- Rich diffs are adapted from [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) (MIT). See [`extensions/renderer/tool/diff/ATTRIBUTION.md`](./extensions/renderer/tool/diff/ATTRIBUTION.md).
