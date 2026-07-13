<div align="center">

<h1>Context Visualizer</h1>
<h3>Distill AI conversations into a readable storyline</h3>

**Cross-platform · Zero dependencies · Local · Open Source**

[![License: MIT](https://img.shields.io/badge/License-MIT-8BA3FF.svg)](LICENSE)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-55C6B1.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-E2B357.svg)
![Cross-Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-EC8FB0.svg)

[中文](README.md)

</div>

---

## What it is

Dozens of sessions, thousands of turns, multiple agents, branches, dead ends—scrolling through raw chat logs makes it impossible to grasp the full picture.

**Context Visualizer** turns raw Claude Code and OpenCode conversation transcripts (`.jsonl`) into a spatial **storyline** timeline you can read at a glance.

## Features

- **Auto-scan** — detects Claude Code sessions (`~/.claude/projects/`) and OpenCode sessions across macOS, Linux, and Windows
- **Interactive CLI** — pick platform → browse sessions → search → select → visualize, all without writing code
- **Cross-platform** — same commands on macOS, Linux, and Windows
- **Zero dependency SVG renderer** — drag to pan, scroll to zoom, hover for details, click for provenance
- **Provenance drill-down** — every milestone links back to the exact source line
- **Coverage audit** — every user turn is accounted for; ❌=0 means truly complete

## Visual encoding

```
Horizontal bands    = agent zones
X axis              = real time (idle compressed into "night bands")
Colored ribbons     = topic threads, thickness = effort
Ribbon forks        = new thread branching from parent
Fading / dashed     = abandoned or paused thread
Cross-band arrows   = agent handoffs
Milestone shapes    = ◆decision · ✱pivot · ✕abandon · ✔verify · ➜handoff · ?question · ●finding
```

## Quick start

```bash
git clone <repo-url> context-visualizer
cd context-visualizer

# Interactive CLI (recommended)
node cli.js

# Or just start the visualization server
node serve.js
# Open http://localhost:8123
```

### CLI demo

```
$ node cli.js

  ╔══════════════════════════════════════════╗
  ║   Context Visualizer CLI v0.3.0          ║
  ╚══════════════════════════════════════════╝

  Detected 2 platform(s):
    [1] Claude Code (36 sessions)
    [2] OpenCode (4 sessions)

  Select platform: 2
  > 1

  ✅ Storyline built: 12 events, 4 threads
  ✅ Server running at http://localhost:8123
```

## Commands

| Command | Purpose |
|---|---|
| `node cli.js` | Interactive menu (scan → select → build → serve) |
| `node cli.js --scan` | Scan & print all sessions as JSON |
| `node cli.js --scan --platform claude` | Scan only Claude Code sessions |
| `node cli.js --scan --platform opencode` | Scan only OpenCode sessions |
| `node cli.js --serve events.json` | Start server directly |
| `node serve.js` | Start visualization server |
| `node opencode-export.js <dir>` | Export OpenCode sessions to JSONL |
| `node --test opencode-export.test.js` | Run test suite |
| `node coverage-audit.js` | Run coverage audit |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    User Interface Layer                        │
│  cli.js (interactive CLI)    serve.js (HTTP server + API)     │
│  index.html (SVG renderer)                                    │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                     Data Pipeline Layer                        │
│  scanner.js (cross-platform scan)   opencode-export.js        │
│  buildEvents (deterministic)        distill-core.js (LLM)     │
│  distill.js (CLI distiller)                                   │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                      Data Layer                                │
│  events.json (data contract)    opencode-sessions/            │
│  coverage-audit.js (trust gate)                               │
└──────────────────────────────────────────────────────────────┘
```

### Cross-platform paths

| Platform | Claude Code | OpenCode |
|---|---|---|
| **macOS** | `~/.claude/projects/` | `opencode-sessions/` or `$OP_SESSIONS_DIR` |
| **Linux** | `~/.claude/projects/` | same |
| **Windows** | `%USERPROFILE%\.claude\projects\` | same |

## Prerequisites

- **Node.js >= 18** (zero npm dependencies, built-in modules only)
- Optional: **OpenRouter API key** (for LLM-based distillation)
- Any browser (Chrome / Safari / Firefox / Edge)

## File structure

```
context-visualizer/
├── cli.js                 # Interactive CLI ★
├── scanner.js             # Cross-platform session scanner ★
├── opencode-export.js     # OpenCode session export
├── distill-core.js        # Distillation engine (isomorphic)
├── distill.js             # CLI distiller
├── serve.js               # Local visualization server
├── coverage-audit.js      # Trust gate (independent audit)
├── live-update.js         # Incremental realtime distiller
├── index.html             # SVG storyline renderer (zero-dep)
├── events.json            # Data contract (distillation output)
├── aliases.json           # Agent display name mapping
├── package.json           # Project metadata
├── .env.example           # Environment template
├── opencode-export.test.js# Test suite (22 tests)
├── README.md              # Chinese docs
├── README.en.md           # This file
└── LICENSE                # MIT license
```

## License

[MIT](LICENSE) © 2026
