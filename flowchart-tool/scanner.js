// scanner.js — Dual-platform session discovery.
//
// Discovers Claude Code sessions (~/.claude/projects/*/*.jsonl) and OpenCode
// sessions via `opencode session list` CLI (or direct SQLite fallback).
//
// API:
//   scanAll(config)          → [{platform, id, title, directory, agent, model, time,
//                              turns, tokens, cost, hasSubAgents, firstMessage, ...}]
//   scanClaude(config)       → [...]
//   scanOpenCode(config)     → [...]

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, exec } = require("child_process");

const EXPORT_TIMEOUT_MS = 120000;

// ---------- helpers ----------

function safeExec(command, options) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
  } catch (e) {
    return null;
  }
}

function safeJson(str) {
  if (!str) return null;
  try { return JSON.parse(str.trim()); } catch (e) { return null; }
}

function fmtMs(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1048576).toFixed(1) + "MB";
}

// ---------- Claude Code scanning ----------

function defaultClaudeDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

function scanClaude(config) {
  const dir = config.platforms.claude.projectsDir || defaultClaudeDir();
  if (!fs.existsSync(dir)) return [];

  const sessions = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    return [];
  }

  for (const proj of projectDirs) {
    const projDir = path.join(dir, proj);
    let files;
    try {
      files = fs.readdirSync(projDir).filter(f => /\.jsonl$/i.test(f));
    } catch (e) {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(projDir, file);
      let stat;
      try { stat = fs.statSync(filePath); } catch (e) { continue; }

      const id = file.replace(/\.jsonl$/i, "").slice(0, 8);
      const firstLine = readFirstLine(filePath);
      let firstMessage = "";
      if (firstLine) {
        const obj = safeJson(firstLine);
        if (obj) {
          if (obj.type === "user" && obj.message && obj.message.role === "user") {
            firstMessage = cleanBlockText(obj.message.content);
          } else if (obj.type === "queue-operation" && obj.operation === "enqueue") {
            firstMessage = cleanStr(obj.content);
          }
        }
      }

      sessions.push({
        platform: "claude",
        id,
        title: file.replace(/\.jsonl$/i, ""),
        directory: path.dirname(filePath),
        project: cleanProjName(proj),
        agent: cleanProjName(proj),
        model: "(unknown)",
        time: stat.mtimeMs,
        timeStr: fmtMs(stat.mtimeMs),
        turns: 0, // expensive to count; filled on preview
        tokens: null,
        cost: 0,
        hasSubAgents: false,
        firstMessage: firstMessage.slice(0, 120),
        sourcePath: filePath,
        sourceSize: stat.size,
        sourceSizeStr: fmtSize(stat.size),
        rawExport: null, // lazy: filled by opencodeExport()
      });
    }
  }

  return sessions.sort((a, b) => b.time - a.time);
}

// ---------- OpenCode scanning ----------

/**
 * Enrich sessions with parent_id from the OpenCode SQLite database.
 * The CLI `opencode session list --format json` does not include parent_id,
 * so we query the DB directly to fill in the parent-child relationships.
 * Sets hasSubAgents = true for sessions that are someone's parent.
 */
function enrichParentIds(sessions) {
  if (sessions.length === 0) return;

  const parentMap = new Map();

  // Method A: try sqlite3 CLI
  try {
    const dbPath = (safeExec("opencode db path 2>/dev/null") || "").trim();
    if (dbPath && fs.existsSync(dbPath)) {
      const result = safeExec(`sqlite3 "${dbPath}" "SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL"`);
      if (result) {
        result.trim().split("\n").forEach(line => {
          const [id, parentId] = line.split("|").map(s => s.trim());
          if (id && parentId) parentMap.set(id, parentId);
        });
      }
    }
  } catch (e) { /* sqlite3 CLI not available */ }

  // Method B: try node with better-sqlite3
  if (parentMap.size === 0) {
    try {
      const dbPath = (safeExec("opencode db path 2>/dev/null") || "").trim()
        || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
      if (fs.existsSync(dbPath)) {
        try {
          const Database = require("better-sqlite3");
          const db = new Database(dbPath, { readonly: true });
          const rows = db.prepare("SELECT id, parent_id FROM session WHERE parent_id IS NOT NULL").all();
          rows.forEach(r => parentMap.set(r.id, r.parent_id));
          db.close();
        } catch (e2) { /* better-sqlite3 not available */ }
      }
    } catch (e) { /* fallback failed */ }
  }

  // Merge into sessions
  if (parentMap.size > 0) {
    sessions.forEach(s => {
      const pid = parentMap.get(s.id);
      if (pid) s.parentId = pid;
    });

    // Update hasSubAgents
    const parentIds = new Set(sessions.filter(s => s.parentId).map(s => s.parentId));
    sessions.forEach(s => {
      if (parentIds.has(s.id)) s.hasSubAgents = true;
    });
  }
}

function defaultOpenCodeDb() {
  const home = os.homedir();
  // macOS / Linux XDG
  const candidates = [
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    path.join(home, ".opencode", "opencode.db"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]; // default, even if doesn't exist
}

function scanOpenCode(config) {
  const dbPath = config.platforms.opencode.dbPath || defaultOpenCodeDb();
  const sessions = [];

  // Try `opencode session list --format json` first (fast, official interface)
  const cliResult = safeExec("opencode session list --format json --max-count 200", { timeout: 10000 });
  if (cliResult) {
    const list = safeJson(cliResult);
    if (Array.isArray(list)) {
      for (const s of list) {
        sessions.push({
          platform: "opencode",
          id: s.id,
          title: s.title || "",
          directory: s.directory || "",
          project: path.basename(s.directory || ""),
          agent: s.agent || "",
          model: s.model ? s.model.id || "" : "",
          time: s.created || 0,
          timeStr: fmtMs(s.created || 0),
          turns: s.turns || 0,
          tokens: s.tokens || null,
          cost: s.cost || 0,
          hasSubAgents: false, // filled later
          firstMessage: "",
          sourcePath: dbPath,
          sourceSize: 0,
          sourceSizeStr: "",
          parentId: s.parentId || null,
          rawExport: null,
        });
      }
    }
  }

  // Fallback: direct SQLite query
  if (sessions.length === 0 && fs.existsSync(dbPath)) {
    try {
      const sqlite = require("better-sqlite3");
      const db = new sqlite(dbPath, { readonly: true });
      const rows = db.prepare(`
        SELECT s.id, s.slug, s.title, s.directory, s.agent, s.model,
               s.parent_id, s.time_created, s.time_updated,
               s.tokens_input, s.tokens_output, s.cost
        FROM session s
        ORDER BY s.time_created DESC
        LIMIT 200
      `).all();
      db.close();

      for (const r of rows) {
        let modelId = "";
        try { const m = JSON.parse(r.model); modelId = m.id || ""; } catch (e) {}

        sessions.push({
          platform: "opencode",
          id: r.id,
          title: r.title || "",
          directory: r.directory || "",
          project: path.basename(r.directory || ""),
          agent: r.agent || "",
          model: modelId,
          time: r.time_created,
          timeStr: fmtMs(r.time_created),
          turns: 0,
          tokens: r.tokens_input ? { input: r.tokens_input, output: r.tokens_output || 0 } : null,
          cost: r.cost || 0,
          hasSubAgents: false,
          firstMessage: "",
          sourcePath: dbPath,
          sourceSize: 0,
          sourceSizeStr: "",
          parentId: r.parent_id || null,
          rawExport: null,
        });
      }
    } catch (e) {
      // better-sqlite3 not available; sessions list remains from CLI or empty
    }
  }

  enrichParentIds(sessions);

  return sessions.sort((a, b) => b.time - a.time);
}

// ---------- OpenCode export (full session data, lazy-loaded) ----------

// Cross-platform stderr redirect
const stderrNull = process.platform === "win32" ? "2>NUL" : "2>/dev/null";

async function opencodeExport(sessionId, options) {
  const timeout = (options && options.timeout) || EXPORT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `oc-export-${sessionId.slice(-8)}-${Date.now()}.json`);
    const cmd = process.platform === "win32"
      ? `opencode export "${sessionId}" > "${tmp}" ${stderrNull}`
      : `opencode export "${sessionId}" > "${tmp}" ${stderrNull}`;
    exec(cmd, { timeout }, (err) => {
      if (err) {
        try { fs.unlinkSync(tmp); } catch (e) {}
        return reject(new Error(`opencode export failed: ${err.message}`));
      }
      try {
        if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
          return reject(new Error("opencode export produced empty output"));
        }
        const text = fs.readFileSync(tmp, "utf8");
        fs.unlinkSync(tmp);
        const data = safeJson(text);
        if (!data) return reject(new Error("Invalid JSON from opencode export"));
        resolve(data);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        reject(new Error(`opencode export failed: ${e.message}`));
      }
    });
  });
}

async function opencodeExportSync(sessionId) {
  const tmp = path.join(os.tmpdir(), `oc-export-${sessionId.slice(-8)}-${Date.now()}.json`);
  try {
    const cmd = process.platform === "win32"
      ? `opencode export "${sessionId}" > "${tmp}" ${stderrNull}`
      : `opencode export "${sessionId}" > "${tmp}" ${stderrNull}`;
    execSync(cmd, { timeout: 60000 });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
      throw new Error("opencode export produced empty output");
    }
    const text = fs.readFileSync(tmp, "utf8");
    fs.unlinkSync(tmp);
    const data = safeJson(text);
    if (!data) throw new Error("Invalid JSON");
    return data;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw new Error(`opencode export failed: ${e.message}`);
  }
}

// ---------- Sub-agent discovery (parent_id tree) ----------

/**
 * Find all descendant sessions of a given session via parent_id.
 * Enforces maxDepth and maxTotal limits from config.
 */
async function discoverSubAgents(sessions, rootId, config) {
  const maxDepth = config.cli.maxSubAgentDepth || 2;
  const maxTotal = config.cli.maxTotalSessions || 20;

  const visited = new Set();
  const result = [];
  const queue = [{ id: rootId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (visited.has(id)) continue;
    if (depth > maxDepth) continue;
    if (result.length >= maxTotal) break;

    visited.add(id);
    result.push(id);

    // Find children
    const children = sessions.filter(s => s.parentId === id && !visited.has(s.id));
    for (const child of children) {
      if (result.length + queue.length >= maxTotal) break;
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }

  return result;
}

// ---------- First message extraction ----------

/**
 * Extract first user message from an OpenCode session for preview/search.
 */
function extractFirstUserMessage(exportData) {
  if (!exportData || !exportData.messages) return "";
  for (const msg of exportData.messages) {
    if (msg.info && msg.info.role === "user") {
      const textPart = (msg.parts || []).find(p => p.type === "text");
      if (textPart && textPart.text) {
        return cleanStr(textPart.text).slice(0, 120);
      }
    }
  }
  return "";
}

// ---------- Search ----------

function searchSessions(sessions, query) {
  const q = query.toLowerCase();
  return sessions.filter(s => {
    if ((s.title || "").toLowerCase().includes(q)) return true;
    if ((s.firstMessage || "").toLowerCase().includes(q)) return true;
    if ((s.directory || "").toLowerCase().includes(q)) return true;
    if ((s.agent || "").toLowerCase().includes(q)) return true;
    return false;
  });
}

// ---------- Display ----------

function formatSessionList(sessions, showIndex) {
  const lines = [];
  // Header
  const header = "  " +
    (showIndex ? "#".padEnd(4) : "") +
    "标题".padEnd(36) +
    "目录".padEnd(46) +
    "代理".padEnd(22) +
    "时间".padEnd(18) +
    "Token";
  lines.push(header);
  lines.push("  " + "─".repeat(header.length - 2));

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const idx = showIndex ? String(i + 1).padEnd(4) : "";
    const title = (s.title || "").slice(0, 34).padEnd(36);
    const dir = (s.project || path.basename(s.directory || "")).slice(0, 44).padEnd(46);
    const agent = ((s.agent || "").replace("Sisyphus - ", "S:").replace("ultraworker", "uw")).slice(0, 20).padEnd(22);
    const time = (s.timeStr || "").slice(0, 16).padEnd(18);

    let tok = "";
    if (s.tokens && s.tokens.input) {
      tok = fmtSize(s.tokens.input);
    } else if (s.tokens && s.tokens.total) {
      tok = fmtSize(s.tokens.total);
    }
    tok = tok.padEnd(10);

    lines.push(`  ${idx}${title}${dir}${agent}${time}${tok}`);
  }

  return lines.join("\n");
}

function formatSessionPreview(session, subCount) {
  const lines = [];
  lines.push("");
  lines.push("  " + "═".repeat(60));
  lines.push("  会话预览");
  lines.push("  " + "═".repeat(60));
  lines.push(`  标题:     ${session.title || "(无标题)"}`);
  lines.push(`  代理:     ${session.agent || "(未知)"}${subCount > 0 ? `  (+ ${subCount} 个子代理)` : ""}`);
  lines.push(`  模型:     ${session.model || "(未知)"}`);
  lines.push(`  目录:     ${session.directory || "(未知)"}`);
  lines.push(`  时间:     ${session.timeStr || "(未知)"}`);
  if (session.tokens && session.tokens.input) {
    lines.push(`  Token:    ${fmtSize(session.tokens.input)} in / ${fmtSize(session.tokens.output || 0)} out`);
  }
  if (session.cost) {
    lines.push(`  成本:     $${session.cost.toFixed(4)}`);
  }
  if (session.firstMessage) {
    lines.push(`  首轮消息: ${session.firstMessage.slice(0, 100)}`);
  }
  lines.push("  " + "═".repeat(60));
  return lines.join("\n");
}

// ---------- utilities ----------

function readFirstLine(filePath) {
  try {
    const buf = Buffer.alloc(4096);
    const fd = fs.openSync(filePath, "r");
    const bytes = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const text = buf.toString("utf8", 0, bytes);
    return text.split("\n")[0] || "";
  } catch (e) {
    return "";
  }
}

function cleanStr(s) {
  return (s || "")
    .replace(/<current_note>[\s\S]*?<\/current_note>/g, "")
    .replace(/<editor_selection>[\s\S]*?<\/editor_selection>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanBlockText(c) {
  if (typeof c === "string") return cleanStr(c);
  if (Array.isArray(c)) {
    return cleanStr(c.filter(b => b && b.type === "text").map(b => b.text || "").join("\n"));
  }
  return "";
}

function cleanProjName(name) {
  return (name || "")
    .replace(/^C--/, "")
    .replace(/--/g, " · ")
    .replace(/-/g, " ")
    .trim();
}

// ---------- All-platform scan ----------

function scanAll(config) {
  const results = [];

  if (config.platforms.claude.enabled !== false) {
    const claudeSessions = scanClaude(config);
    results.push(...claudeSessions);
  }

  if (config.platforms.opencode.enabled !== false) {
    const opencodeSessions = scanOpenCode(config);
    results.push(...opencodeSessions);
  }

  return results.sort((a, b) => b.time - a.time);
}

// ---------- exports ----------

module.exports = {
  scanAll,
  scanClaude,
  scanOpenCode,
  opencodeExport,
  opencodeExportSync,
  discoverSubAgents,
  extractFirstUserMessage,
  searchSessions,
  formatSessionList,
  formatSessionPreview,
  fmtMs,
  fmtSize,
};
