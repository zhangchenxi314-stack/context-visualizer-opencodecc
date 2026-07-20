// scanner.js — Cross-platform session scanner.
// Detects Claude Code and OpenCode sessions on macOS / Linux / Windows.
//
//   const scanner = require("./scanner");
//   const sessions = await scanner.scan();          // auto-detect all
//   const results = scanner.search(sessions, "todo"); // search by keyword
//   const picked = scanner.pickRecent(sessions, 10);   // top N by mtime

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------- platform helpers ----------
function isWindows() { return process.platform === "win32"; }

/** Resolve path for Claude Code projects on any OS */
function claudeProjectsPath() {
  if (isWindows()) {
    const userDir = process.env.USERPROFILE || "C:\\Users\\Default";
    return path.join(userDir, ".claude", "projects");
  }
  return path.join(os.homedir(), ".claude", "projects");
}

/** Resolve OpenCode export session directory (OP_SESSIONS_DIR env >> default) */
function opencodeExportPath(custom) {
  if (custom) return path.resolve(custom);
  if (process.env.OP_SESSIONS_DIR) return path.resolve(process.env.OP_SESSIONS_DIR);
  // cwd fallback
  return path.resolve(process.cwd(), "opencode-sessions");
}

// ---------- JSONL turn counting & content extraction ----------
const CLEAN_RE = /<current_note>[\s\S]*?<\/current_note>|<editor_selection>[\s\S]*?<\/editor_selection>/g;

function cleanText(s) {
  return (s || "").replace(CLEAN_RE, "").replace(/\s+/g, " ").trim();
}

function firstUserTextFromLine(line) {
  if (!line || !line.trim()) return "";
  try {
    const o = JSON.parse(line);
    // Claude Code format
    if (o.type === "queue-operation" && o.operation === "enqueue") {
      return cleanText(o.content).slice(0, 120);
    }
    if (o.type === "user" && o.message && o.message.role === "user") {
      const c = o.message.content;
      const text = typeof c === "string" ? c
        : Array.isArray(c) ? c.filter(b => b && b.type === "text").map(b => b.text || "").join("\n")
        : "";
      return cleanText(text).slice(0, 120);
    }
  } catch (e) { /* skip unparseable */ }
  return "";
}

function sessionStats(filePath) {
  try {
    const st = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    let turnCount = 0;
    let firstTs = "";
    let lastTs = "";
    let firstText = "";
    let lastText = "";
    for (const l of lines) {
      const text = firstUserTextFromLine(l);
      if (!text) continue;
      turnCount++;
      if (!firstText) { firstText = text; }
      lastText = text;
      // extract timestamp
      try {
        const o = JSON.parse(l);
        const ts = o.timestamp || "";
        if (ts) {
          if (!firstTs) firstTs = ts;
          lastTs = ts;
        }
      } catch (e) {}
    }
    return {
      turns: turnCount,
      sizeKB: Math.round(st.size / 1024),
      mtime: st.mtimeMs,
      birthtime: st.birthtimeMs || st.mtimeMs,
      firstText: firstText || "(empty)",
      lastText: lastText || "(empty)",
      firstTs,
      lastTs,
    };
  } catch (e) {
    return { turns: 0, sizeKB: 0, mtime: 0, birthtime: 0, firstText: "", lastText: "" };
  }
}

// ---------- scan Claude Code ----------
/** Claude Code sessions from ~/.claude/projects/ */
function scanClaude(root) {
  const sessions = [];
  if (!root || !fs.existsSync(root)) return sessions;

  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) { return sessions; }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(root, projectDir);
    let files = [];
    try { files = fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl")); } catch (e) { continue; }

    // Derive agent name from folder (mirrors distill.js logic)
    const agent = projectDir.replace(/^C--/, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

    for (const file of files) {
      const filePath = path.join(projectPath, file);
      const sessionId = file.replace(/\.jsonl$/i, "");
      const stats = sessionStats(filePath);
      if (!stats.turns && !stats.sizeKB) continue;

      sessions.push({
        platform: "claude",
        project: projectDir.replace(/^C--/, "").replace(/--/g, " / ").replace(/-/g, " ").trim() || projectDir,
        sessionId,
        agent,
        filePath,
        ...stats,
      });
    }
  }
  return sessions;
}

// ---------- scan OpenCode export ----------
/** OpenCode sessions from export directory */
function scanOpenCode(root) {
  const sessions = [];
  if (!root || !fs.existsSync(root)) return sessions;

  // Recursive walk of export dir: opencode-sessions/<agent>/<session>.jsonl
  const walk = (dir, agentPrefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        const sessionId = e.name.replace(/\.jsonl$/i, "");
        const stats = sessionStats(fp);
        if (!stats.turns && !stats.sizeKB) continue;
        sessions.push({
          platform: "opencode",
          project: agentPrefix || path.basename(path.dirname(fp)),
          sessionId,
          agent: agentPrefix || path.basename(path.dirname(fp)),
          filePath: fp,
          ...stats,
        });
      } else if (e.isDirectory() && !e.name.startsWith(".")) {
        walk(fp, agentPrefix || e.name);
      }
    }
  };
  walk(root, "");
  return sessions;
}

// ---------- main scan ----------
// Returns { platforms: string[], sessions: Session[] }
// enum platforms: "claude" | "opencode"
function scanAll(opts = {}) {
  const claudeRoot = opts.claudeRoot || claudeProjectsPath();
  const opencodeRoot = opts.opencodeRoot || opencodeExportPath(opts.opencodeCustom);

  const claude = scanClaude(claudeRoot);
  const opencode = scanOpenCode(opencodeRoot);
  const sessions = [...claude, ...opencode];
  const platforms = [];
  if (claude.length) platforms.push("claude");
  if (opencode.length) platforms.push("opencode");

  // Sort all sessions by mtime descending (most recent first)
  sessions.sort((a, b) => b.mtime - a.mtime);

  return { platforms, sessions, claudeCount: claude.length, opencodeCount: opencode.length };
}

// ---------- search ----------
function search(sessions, query) {
  if (!query || !query.trim()) return sessions;
  const q = query.toLowerCase();
  return sessions.filter(s =>
    s.sessionId.toLowerCase().includes(q) ||
    s.project.toLowerCase().includes(q) ||
    s.agent.toLowerCase().includes(q) ||
    s.firstText.toLowerCase().includes(q) ||
    s.lastText.toLowerCase().includes(q) ||
    s.filePath.toLowerCase().includes(q)
  );
}

// ---------- pick recent ----------
function pickRecent(sessions, n = 10) {
  return sessions.slice(0, Math.max(1, n));
}

// ---------- format helpers ----------
function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtMtime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtSize(kb) {
  if (kb < 1) return "<1 KB";
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// ---------- export ----------
module.exports = {
  scanAll,
  search,
  pickRecent,
  sessionStats,
  firstUserTextFromLine,
  claudeProjectsPath,
  opencodeExportPath,
  fmtDate,
  fmtMtime,
  fmtSize,
  // test-friendly getters
  _scanClaude: scanClaude,
  _scanOpenCode: scanOpenCode,
};
