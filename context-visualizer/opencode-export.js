#!/usr/bin/env node
// opencode-export.mjs — OpenCode session exporter → JSONL compatible with distill pipeline.
//
// Reads exported session JSON files and converts them to JSONL format that the distill
// engine can process. Each session file is a .session.json with messages array.
//
// Usage:
//   node opencode-export.mjs <sessions-dir> [--out <export-dir>] [--agent <type>]
//   node opencode-export.mjs --stdin < session.json            (single session from stdin)
//
// Export format (one .session.json per session):
//   {
//     "sessionId": "ses_abc123",
//     "subagentType": "oracle",
//     "projectPath": "/Users/...",
//     "startedAt": "2026-07-13T10:00:00Z",
//     "messages": [
//       {"role": "user", "content": "...", "timestamp": "..."},
//       {"role": "assistant", "content": "...", "timestamp": "..."}
//     ]
//   }
//
// Output structure (mirrors ~/.claude/projects/<agent>/<session>.jsonl):
//   <out>/<subagentType>/<sessionId>.jsonl
//
// Each JSONL line carries _meta for the distiller to derive agent identity and provenance.

const fs = require("fs");
const path = require("path");

// ---------- args ----------
const argv = process.argv.slice(2);
let OUT = path.join(process.cwd(), "opencode-sessions");
let AGENT_OVERRIDE = null;
let STDIN = false;
const dirs = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") OUT = argv[++i];
  else if (argv[i] === "--agent") AGENT_OVERRIDE = argv[++i];
  else if (argv[i] === "--stdin") STDIN = true;
  else dirs.push(argv[i]);
}

if (!STDIN && !dirs.length) {
  console.error("usage: node opencode-export.js <sessions-dir> [--out <export-dir>] [--agent <type>]");
  console.error("       node opencode-export.js --stdin --agent <type> < session.json");
  process.exit(2);
}

// ---------- helpers ----------
const T = s => {
  try { return new Date(s).toISOString(); } catch (e) { return s || new Date().toISOString(); }
};

// Normalize subagent type to a short, filesystem-safe name
function agentSlug(subagentType) {
  if (!subagentType) return "agent";
  return subagentType.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "agent";
}

// Convert a single OpenCode session → array of JSONL-ready objects
// Each user turn becomes a Claude-Code-compatible JSONL line with _meta extension.
function sessionToTurns(session) {
  const turns = [];
  if (!session || !Array.isArray(session.messages)) return turns;

  const agent = agentSlug(session.subagentType || AGENT_OVERRIDE || "agent");
  const sid = session.sessionId || "unknown";

  session.messages.forEach((msg, idx) => {
    // Skip non-user messages, empty content, and tool-call-only messages
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    if (!content || (typeof content === "string" && !content.trim())) return;

    // Reconstruct Claude Code compatible format.
    // Claude Code expects: {"type":"user","message":{"role":"user","content":<blocks|string>},"timestamp":"..."}
    // We add _meta as a non-intrusive extension that the distiller can read.
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: typeof content === "string"
          ? content
          : (Array.isArray(content) ? content : [content])
      },
      timestamp: msg.timestamp || T(session.startedAt || new Date().toISOString()),
      _meta: {
        sessionId: sid,
        agent,
        subagentType: session.subagentType || AGENT_OVERRIDE || null,
        projectPath: session.projectPath || null,
        turnIndex: idx,
      }
    };
    turns.push(entry);
  });

  return turns;
}

// Read a .session.json file and convert to turns
function processFile(filePath) {
  let session;
  try {
    session = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`  ⚠ failed to parse ${filePath}: ${e.message}`);
    return { turns: [], agent: "error", sid: path.basename(filePath) };
  }
  const turns = sessionToTurns(session);
  const agent = agentSlug(session.subagentType || AGENT_OVERRIDE || "agent");
  const sid = session.sessionId || path.basename(filePath).replace(/\.session\.json$/i, "");
  return { turns, agent, sid };
}

// Write turns to a JSONL file under <out>/<agent>/<sid>.jsonl
function writeJsonl(turns, agent, sid) {
  const dir = path.join(OUT, agent);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sid}.jsonl`);
  const lines = turns.map(t => JSON.stringify(t)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines, "utf8");
  return filePath;
}

// ---------- main ----------
let totalTurns = 0;
let totalFiles = 0;

function processAll() {
  // Collect all .session.json files from input directories
  const files = [];
  for (const d of dirs) {
    const abs = path.resolve(d);
    if (!fs.existsSync(abs)) { console.error(`  missing directory: ${abs}`); continue; }
    const stat = fs.statSync(abs);
    if (stat.isFile() && abs.endsWith(".session.json")) {
      files.push(abs);
    } else if (stat.isDirectory()) {
      walkDir(abs, files);
    }
  }

  if (!files.length) {
    console.error("no .session.json files found");
    // Synthesize a demo export for testing if no real files
    console.error("creating demo export for testing...");
    createDemoExport();
    return;
  }

  for (const fp of files) {
    const { turns, agent, sid } = processFile(fp);
    if (!turns.length) continue;
    const outPath = writeJsonl(turns, agent, sid);
    console.log(`  ${outPath}: ${turns.length} turns`);
    totalTurns += turns.length;
    totalFiles++;
  }
  printSummary();
}

function walkDir(dir, files) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".session.json")) files.push(fp);
    else if (e.isDirectory() && !e.name.startsWith(".")) walkDir(fp, files);
  }
}

function processStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { data += chunk; });
  process.stdin.on("end", () => {
    let session;
    try { session = JSON.parse(data); } catch (e) { console.error("invalid JSON from stdin"); process.exit(1); }
    const { turns, agent, sid } = { turns: sessionToTurns(session), agent: agentSlug(session.subagentType || AGENT_OVERRIDE || "agent"), sid: session.sessionId || "stdin" };
    if (!turns.length) { console.error("no user turns found in session"); process.exit(1); }
    const outPath = writeJsonl(turns, agent, sid);
    console.log(`  ${outPath}: ${turns.length} turns`);
    totalTurns += turns.length; totalFiles++;
    printSummary();
  });
}

function createDemoExport() {
  // Create a demo export that mirrors the original events.json demo (todo app story)
  const plannerSession = {
    sessionId: "ses_demo_planner",
    subagentType: "oracle",
    projectPath: "/Users/demo/todo-app",
    startedAt: "2024-03-05T09:00:00Z",
    messages: [
      { role: "user", content: "我想做个待办 App,能加任务、打勾完成、分清今天/以后,最好手机电脑都能用。", timestamp: "2024-03-05T09:02:00Z" },
      { role: "assistant", content: "好的,我来帮你分析需求。", timestamp: "2024-03-05T09:02:10Z" },
      { role: "user", content: "", timestamp: "2024-03-05T09:05:00Z" },
      { role: "user", content: "先别贪多,MVP 就四件事:加任务、删任务、打勾、按日期分组。", timestamp: "2024-03-05T09:20:00Z" },
      { role: "assistant", content: "范围明确,继续。", timestamp: "2024-03-05T09:20:05Z" },
      { role: "user", content: "好的,继续", timestamp: "2024-03-05T09:31:00Z" },
      { role: "user", content: "决定:纯前端单页 + localStorage 起步,先不急着上后端。", timestamp: "2024-03-05T09:48:00Z" },
      { role: "user", content: "顺手调研一下:原生 vs 轻框架,先看包体积和心智负担。", timestamp: "2024-03-05T10:10:00Z" },
      { role: "user", content: "对比做到一半发现,MVP 用原生足够,框架这条线先搁置。", timestamp: "2024-03-05T10:35:00Z" },
      { role: "user", content: "需求和选型都定了,交给构建那边开始写代码。", timestamp: "2024-03-05T10:52:00Z" },
    ]
  };
  const builderSession1 = {
    sessionId: "ses_demo_builder1",
    subagentType: "build",
    projectPath: "/Users/demo/todo-app",
    startedAt: "2024-03-05T11:00:00Z",
    messages: [
      { role: "user", content: "先把页面骨架搭好:一个输入框、一个列表、一个空状态。", timestamp: "2024-03-05T11:05:00Z" },
      { role: "assistant", content: "开始搭建页面骨架。", timestamp: "2024-03-05T11:05:05Z" },
      { role: "user", content: "[系统] 构建完成通知", timestamp: "2024-03-05T11:22:00Z" },
      { role: "user", content: "把任务存进 localStorage,刷新页面数据还在了。", timestamp: "2024-03-05T11:40:00Z" },
      { role: "user", content: "打勾划线、按日期分两组都好了,MVP 主流程通了。", timestamp: "2024-03-05T12:15:00Z" },
      { role: "user", content: "验收:加/删/改/打勾/分组/刷新不丢,全部通过。", timestamp: "2024-03-05T13:35:00Z" },
    ]
  };
  const builderSession2 = {
    sessionId: "ses_demo_builder2",
    subagentType: "build",
    projectPath: "/Users/demo/todo-app",
    startedAt: "2024-03-05T12:30:00Z",
    messages: [
      { role: "user", content: "", timestamp: "2024-03-05T12:35:00Z" },
      { role: "user", content: "(重发上一条)", timestamp: "2024-03-05T12:38:00Z" },
      { role: "user", content: "想让手机和电脑同步,试着加一条云同步的线。", timestamp: "2024-03-05T12:40:00Z" },
      { role: "user", content: "云同步得先有后端,超出这次 MVP 范围,先记下以后做。", timestamp: "2024-03-05T13:20:00Z" },
    ]
  };

  const sessions = [plannerSession, builderSession1, builderSession2];
  let allTurns = [];
  for (const s of sessions) {
    const { turns, agent, sid } = { turns: sessionToTurns(s), agent: agentSlug(s.subagentType), sid: s.sessionId };
    allTurns = allTurns.concat(turns);
    writeJsonl(turns, agent, sid);
    totalTurns += turns.length;
    totalFiles++;
    console.log(`  ${OUT}/${agent}/${sid}.jsonl: ${turns.length} turns`);
  }
  printSummary();
}

function printSummary() {
  console.log(`\nexported ${totalFiles} sessions, ${totalTurns} user turns → ${OUT}/`);
}

// ---------- run ----------
if (STDIN) {
  processStdin();
} else {
  processAll();
}
