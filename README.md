div align="center">

<h1>Context Visualizer</h1>
<h3>把 AI 对话蒸馏成一张看得懂的时间线</h3>

**跨平台 · 零依赖 · 本地运行 · 开源**

[![License: MIT](https://img.shields.io/badge/License-MIT-8BA3FF.svg)](LICENSE)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-55C6B1.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-E2B357.svg)
![Cross-Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-EC8FB0.svg)

[English](README.en.md)

</div>

---

## 这是什么

几十个 session、上千轮对话、多个 agent、分叉、死胡同——当成聊天记录翻，根本抓不住全貌。

**Context Visualizer** 把 Claude Code 和 OpenCode 的原始对话转录（`.jsonl`），蒸馏成一张「眯眼就能看清」的空间化 **storyline** 时间线。

## 核心能力

- **自动扫描** — 检测电脑上的 Claude Code 会话（`~/.claude/projects/`）和 OpenCode 会话
- **交互式 CLI** — 选择平台 → 浏览会话 → 搜索 → 选择 → 可视化，全程无需写代码
- **跨平台** — macOS、Linux、Windows 同一套命令
- **SVG 渲染** — 零依赖浏览器端渲染器，拖拽平移、滚轮缩放、悬停看详情
- **Provenance** — 每个事件都可点击回源到对话的原始行
- **Coverage 审计** — 每条用户 turn 都有留账，❌=0 才是真的完整

## 视觉编码

```
横向色带     = agent 分区
横轴         = 真实时间（空闲自动压缩为"夜间带"）
彩色丝带     = 话题线程，粗细=投入工作量
丝带分叉     = 从父线程长出新线程
虚线淡出     = 废弃/暂停的线程
跨带虚线箭头 = agent 之间的交接（handoff）
里程碑形状   = ◆决策 · ✱转向 · ✕废弃 · ✔验收 · ➜交接 · ?提问 · ●发现
```

## 快速开始

```bash
git clone <repo-url> context-visualizer
cd context-visualizer

# 方式一：交互式 CLI（推荐）
node cli.js

# 方式二：直接启动可视化服务
node serve.js
# 打开 http://localhost:8123
```

### CLI 交互流程

```
$ node cli.js

  ╔══════════════════════════════════════════╗
  ║   Context Visualizer CLI v0.3.0          ║
  ╚══════════════════════════════════════════╝

  Detected 2 platform(s):
    [1] Claude Code (36 sessions)
    [2] OpenCode (4 sessions)
    [Q] Quit

  Select platform: 2

  Sessions (page 1/1):
    #  | Session ID                | Project    | Turns | Time
   ────┼───────────────────────────┼────────────┼───────┼──────
    1  | ses_current               | sisyphus   | 13    | 4h ago
    2  | ses_demo_builder2         | build      | 3     | 4h ago

    (n)umbers to select  (s)earch  (a)ll sessions  (q)uit

  > 1

  ✅ Storyline built: 12 events, 4 threads
  ✅ Server running at http://localhost:8123
```

## 命令参考

| 命令 | 用途 |
|---|---|
| `node cli.js` | 交互式菜单（扫描→选择→构建→服务） |
| `node cli.js --scan` | 快速扫描所有会话，JSON 格式输出 |
| `node cli.js --scan --platform claude` | 只看 Claude Code 会话 |
| `node cli.js --scan --platform opencode` | 只看 OpenCode 会话 |
| `node cli.js --serve events.json` | 直接启动服务（跳过选择流程） |
| `node serve.js` | 直接启动可视化服务（当前 events.json） |
| `node opencode-export.js <dir>` | 将 OpenCode 会话导出为 JSONL 格式 |
| `node --test opencode-export.test.js` | 运行测试套件 |
| `node coverage-audit.js` | 运行覆盖审计 |

## 架构

```
┌────────────────────────────────────────────────────────────────┐
│                     用户交互层                                   │
│  cli.js (交互式 CLI)       serve.js (HTTP 服务 + API)          │
│  index.html (SVG 渲染器)                                       │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────┐
│                     数据构建层                                   │
│  scanner.js (跨平台会话扫描)   opencode-export.js (格式导出)    │
│  buildEvents (确定性蒸馏)      distill-core.js (LLM 蒸馏引擎)   │
│  distill.js (CLI 蒸馏器)                                       │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────┐
│                     数据层                                       │
│  events.json (数据契约)    opencode-sessions/ (会话存储)        │
│  coverage-audit.js (信任门禁)                                   │
└────────────────────────────────────────────────────────────────┘
```

### 跨平台路径

| 平台 | Claude Code | OpenCode |
|---|---|---|
| **macOS** | `~/.claude/projects/` | `opencode-sessions/` 或 `$OP_SESSIONS_DIR` |
| **Linux** | `~/.claude/projects/` | 同上 |
| **Windows** | `%USERPROFILE%\.claude\projects\` | 同上 |

## 前提条件

- **Node.js >= 18**（零 npm 依赖，纯内置模块）
- 可选：**OpenRouter API Key**（用于 LLM 蒸馏，提升事件分类质量）
- 浏览器（Chrome / Safari / Firefox / Edge）

## 文件结构

```
context-visualizer/
├── cli.js                 # 交互式 CLI 入口 ★
├── scanner.js             # 跨平台会话扫描器 ★
├── opencode-export.js     # OpenCode 会话导出脚本
├── distill-core.js        # 蒸馏引擎核心（同构，Node + 浏览器共用）
├── distill.js             # CLI 蒸馏器
├── serve.js               # 本地可视化服务器
├── coverage-audit.js      # 信任门禁（独立审计）
├── live-update.js         # 增量实时蒸馏
├── index.html             # SVG 故事线渲染器（零依赖）
├── events.json            # 数据契约（蒸馏产物）
├── aliases.json           # Agent 显示名称映射
├── package.json           # 项目元数据
├── .env.example           # 环境变量模板
├── opencode-export.test.js# 数据层测试（22 项）
├── README.md              # 本文件（中文）
├── README.en.md           # 英文文档
└── LICENSE                # MIT 许可证
```

## 许可证

[MIT](LICENSE) © 2026
