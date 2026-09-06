<p align="center">
  <img src="./assets/readme/hero.svg" width="100%">
</p>

<p align="center">
  <a href="https://pi.dev/packages?name=pi-cc-extensions"><img alt="Pi package catalog" src="https://img.shields.io/badge/Pi-package-58B7FF?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pi-cc-extensions"><img alt="npm version" src="https://img.shields.io/npm/v/pi-cc-extensions?style=flat-square&color=66E3C4"></a>
  <a href="#兼容性"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-66E3C4?style=flat-square"></a>
</p>

<p align="center">
  类 Claude Code TUI 输出风格，并融入了一些个人喜好，和一些实用小功能。
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

---

## 界面预览

https://github.com/user-attachments/assets/6c858000-fdad-43f9-957f-4d0278648498

## OMP 兼容版

本 fork 基于 [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)，同时支持 Pi 和 Oh My Pi。OMP 适配以 **18.1.11** 为验证版本。

```bash
omp install git:github.com/zeroxer/pi-cc-extensions
```

安装后重启 OMP，或在会话里执行 `/reload`，使用 `/ccstyle` 打开设置。这个 GitHub fork 包含兼容修复；`npm:pi-cc-extensions` 仍指向上游 npm 包。

OMP 使用独立的界面适配层：`on` 显示简洁工具摘要，`compact` 将工具卡压缩为单行，`off` 恢复原生渲染。通过 OMP 原生展开操作查看完整输出。编辑/写入差异、任务卡片、读取分组及鼠标交互由 OMP 管理；不会替换 OMP 的写文件工具。Pi 的工具分组和全屏鼠标补丁不会在 OMP 中安装。

上下文面板、已保存的会话引用、思考预览、启动页和工作状态支持 OMP。OMP 的实时 task 子代理引用尚未接入；下方实时子代理功能说明针对 Pi。OMP 的 Memory 计入 System prompt，面板直接预览实际系统提示；最近一轮工具摘要通过 widget 展示，不写入模型上下文。配置位于宿主的 agent 目录（OMP 默认 `~/.omp/agent/claude-code-style.json`，也支持 `PI_CODING_AGENT_DIR`）。OMP 使用 `/ccstyle themes` 安装兼容格式的 CC Dark / CC Light 主题，再在 `/settings` 中选择。已有主题文件会保留；Pi 继续自动发现随包主题。

本地验证：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
# 使用 Bun 和已安装的 OMP 包目录，不发送模型请求
npm run test:omp -- /path/to/node_modules/@oh-my-pi/pi-coding-agent
```

## Pi 快速开始

```bash
pi install npm:pi-cc-extensions

# GitHub
pi install git:github.com/minuque/pi-cc-extensions
```

安装后执行 `/reload`

## Pi 功能

| 功能                  | 说明                                                                            | 入口                                            |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| Claude Code UI        | 工具摘要、折叠展开、rich edit/write diff，以及`on` / `compact` / `off` 三种模式 | `/ccstyle`                                      |
| Markdown 增强         | Mermaid 图、提示框、URL 链接化等                                                        | 自动生效                                        |
| Fullscreen mode       | 工具卡/group 单击展开、双击收起、预览、hover 高亮、回到底部按钮                 | `TUIMODE=fullscreen` 或 `--tui-mode fullscreen` |
| 配置面板              | `Style / Diff / Thinking / UI / Feature` 五页签                                 | `/ccstyle`                                      |
| 上下文检查            | 查看上下文占用，并预览 System prompt、Memory、Skills、Tools definition 和消息内容 | `/context`                                      |
| Session/Subagent 引用 | 搜索并注入历史 Session 或现有 SubAgent 的有效上下文                             | `@`                                             |
| 主题                  | 随包提供内置 CC Dark、CC Light 主题                                             | Pi: `/theme`；OMP: `/ccstyle themes` 后 `/settings` |

## 配置

`/ccstyle` 的配置保存在宿主 agent 目录：Pi 为 `~/.pi/agent/claude-code-style.json`，OMP 通常为 `~/.omp/agent/claude-code-style.json`。以下为 Pi 的完整配置；OMP 面板仅提供适用选项：

```js
{
  "mode": "on",                            // on / compact / off
  "excludeRenderers": [],                  // 走原生渲染的工具名；Agent 始终保留专用渲染器

  // diff
  "diffViewMode": "auto",                  // 布局：auto / split / unified
  "diffIndicatorMode": "bars",             // 变更指示：bars / classic / none
  "diffSplitMinWidth": 120,                // 左右分栏的最小终端宽度
  "editDiffCollapsedLines": 24,            // Edit 折叠行数，超出显示展开提示
  "writeDiffCollapsedLines": 0,            // write 折叠行数，0 仅显示创建摘要
  "diffWordWrap": true,                    // 长 diff 行换行

  // thinking
  "useSummaryTitlesAsThinkingTitle": true, // 用最新摘要作思考标题
  "previewLines": 3,                       // 预览行数，0 隐藏
  "animationIntervalMs": 90,               // 标题动画间隔（毫秒）
  "dimThinkingText": false,                // thinking 正文用 dim 色

  // ui
  "expandedInputMaxLines": 5,              // 展开工具卡 Input 可见行数，超出在末行显示展开提示
  "expandedOutputMaxLines": 10,            // 展开工具卡 Output 可见行数，超出在末行显示展开提示
  "expandedPreviewMaxLines": 40,           // 展开 diff/TaskList 正文最大行数
  "inputClip": 100,                        // 工具摘要 path/command 折叠字符数
  "showStartupHeader": true,               // 启动头（logo + tips）开关
  "scrollStepLines": 3,                    // fullscreen 滚轮步进

  // features
  "enableSessionReference": true,          // @ session 引用
  "enableSubagentAutocomplete": true,      // @ subagent 补全与委派提示
  "enableContextCommand": true,            // /context 上下文检查
  "enableAgentSummary": true,              // 每回合工具摘要
  "enableWorkingMessage": true,            // Working... 底部 token/耗时
  "enableAliases": true                    // /clear、/exit 别名
}
```

> **Fullscreen**：单击 `click to show more` 展开工具卡、思考、Skill 和 compact 摘要；展开后 Input/Output 超行时，末行 `… +N more lines • click to show more` 打开全量预览。双击展开面板收起。
>
> **建议**：`markdown.mermaid` 设为 `final`（`~/.pi/agent/settings.json` 或 `/settings` 面板的 Mermaid diagrams 选项）。默认 `streaming` 逐帧重绘，`final` 渲染最终版更稳定。

## 本地开发

```bash
npm test
npm run typecheck
./test.bat # or pi -e .
```

## 兼容性

- Node.js `>=22.19.0`，Pi `^0.84.0`

## 推荐搭配

| 扩展                                     | 用途                                             |
| ---------------------------------------- | ------------------------------------------------ |
| `npm:@tintinweb/pi-subagents`            | 并行 SubAgent、后台任务与工作树隔离              |
| `npm:@tintinweb/pi-tasks`                | Claude Code 风格任务跟踪与协调                   |
| `npm:pi-mcp-adapter`                     | 按需发现 MCP 工具，减少上下文占用                |
| `npm:@ff-labs/pi-fff`                    | 模糊文件与内容检索（fffind / ffgrep）            |
| `npm:pi-web-access`                      | 网页搜索、URL 抓取、GitHub 克隆、PDF/视频解析    |
| `npm:@narumitw/pi-usage`                 | 查看当前账号用量（Codex / Copilot / OpenRouter） |
| `git:github.com/DietrichGebert/ponytail` | 极简编码：强制最懒但有效的方案                   |

## 致谢

- Rich diff 改编自 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)（MIT）；详见 [`extensions/renderer/tool/diff/ATTRIBUTION.md`](./extensions/renderer/tool/diff/ATTRIBUTION.md)。
