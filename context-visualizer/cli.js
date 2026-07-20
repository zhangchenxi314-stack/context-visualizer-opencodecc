#!/usr/bin/env node
// cli.js — Interactive CLI for Context Visualizer.
// Cross-platform: macOS / Linux / Windows.
//
// Usage:
//   node cli.js                     # interactive menu
//   node cli.js --scan              # scan & print sessions, exit
//   node cli.js --scan --platform claude  # filter by platform
//   node cli.js --serve events.json # just start server
//
// Pipeline: scan → pick sessions → build events.json → serve

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const scanner = require("./scanner");

// ---------- constants ----------
const ROOT = __dirname;
const EV_PATH = path.join(ROOT, "events.json");
const PKG = (() => { try { return require("./package.json"); } catch (e) { return { version: "0.2.0" }; } })();
const VERSION = PKG.version || "0.2.0";

const PAGE_SIZE = 10;

// ---------- ASCII formatting ----------
const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const CYAN = "\x1b[36m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", BLUE = "\x1b[34m", MAGENTA = "\x1b[35m";
const CLR = "\x1b[2J\x1b[H";

function color(s, c) { return c + s + RESET; }

// ---------- readline helpers ----------
function ask(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(color(query, CYAN), ans => { rl.close(); resolve(ans.trim()); });
  });
}

function pressEnter() {
  return ask("\nPress [Enter] to continue...");
}

// ---------- screen ----------
function clearScreen() {
  process.stdout.write(CLR);
}

function printHeader() {
  clearScreen();
  console.log("");
  console.log(color("  ╔══════════════════════════════════════════════════════╗", CYAN));
  console.log(color("  ║        Context Visualizer CLI v" + VERSION.padEnd(16) + "║", CYAN));
  console.log(color("  ║     Visualize Claude Code & OpenCode Sessions       ║", CYAN));
  console.log(color("  ╚══════════════════════════════════════════════════════╝", CYAN));
  console.log("");
}

// ---------- platform selection ----------
function printPlatforms(scanResult) {
  console.log(color(`  Detected ${scanResult.platforms.length} platform(s):`, BOLD));
  scanResult.platforms.forEach((p, i) => {
    const count = p === "claude" ? scanResult.claudeCount : scanResult.opencodeCount;
    console.log(`    [${i + 1}] ${p === "claude" ? "Claude Code" : "OpenCode"}  ${color(`(${count} sessions)`, DIM)}`);
  });
  console.log(`    [R] ${color("Refresh scan", DIM)}`);
  console.log(`    [Q] ${color("Quit", DIM)}`);
  console.log("");
}

async function selectPlatform(scanResult) {
  if (scanResult.platforms.length === 0) return null;

  const labels = {};
  scanResult.platforms.forEach((p, i) => { labels[i + 1] = p; });

  while (true) {
    const ans = await ask(`  Select platform [1-${scanResult.platforms.length}] (Q)uit: `);
    if (ans.toUpperCase() === "Q") return null;
    if (ans.toUpperCase() === "R") return "REFRESH";
    const n = parseInt(ans, 10);
    if (labels[n]) return labels[n];
    console.log(color(`  Invalid choice. Try again.`, RED));
  }
}

// ---------- session list ----------
function printSessionList(sessions, page, totalPages, query) {
  const start = page * PAGE_SIZE;
  const pageSessions = sessions.slice(start, start + PAGE_SIZE);

  console.log("");
  const title = query ? `  Search results for "${query}":` : `  Sessions (page ${page + 1}/${totalPages}):`;
  console.log(color(title, BOLD));
  console.log("");

  // Table header
  const platformLabel = sessions.some(s => s.platform !== sessions[0].platform);
  const hdr = `  ${"#".padEnd(4)} │ ${"Session".padEnd(36)} │ ${"Project".padEnd(20)} │ ${"Turns".padEnd(5)} │ ${"Time"}`;
  console.log(color(hdr, DIM));
  console.log(color(`  ${"─".repeat(4)}┼${"─".repeat(37)}┼${"─".repeat(21)}┼${"─".repeat(6)}┼${"─".repeat(10)}`, DIM));

  pageSessions.forEach((s, i) => {
    const idx = start + i + 1;
    const id = s.platform === "opencode" ? s.sessionId.slice(0, 20) : s.sessionId.slice(0, 20);
    const proj = s.project.length > 18 ? s.project.slice(0, 17) + "…" : s.project;
    const time = scanner.fmtMtime(s.mtime);
    const pLabel = platformLabel ? (s.platform === "claude" ? "CC" : "OC") + " " : "";
    console.log(`  ${String(idx).padEnd(4)} │ ${pLabel}${id.padEnd(30)} │ ${proj.padEnd(19)} │ ${String(s.turns).padEnd(5)} │ ${time}`);
  });

  console.log("");
}

async function sessionMenu(sessions) {
  if (!sessions.length) {
    console.log(color("  No sessions found.", YELLOW));
    return null;
  }

  let page = 0;
  let query = "";
  let filtered = sessions;

  while (true) {
    printHeader();
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
    if (page >= totalPages) page = totalPages - 1;

    printSessionList(filtered, page, totalPages, query);

    // Options
    let hint = "  (n)umbers to select  ";
    if (page > 0) hint += "(p)rev  ";
    if (page < totalPages - 1) hint += "(n)ext  ";
    hint += "(s)earch  (a)ll sessions  (q)uit";

    if (query) hint += color(`  [filter: "${query}"]`, YELLOW);
    console.log(color(hint, DIM));

    const ans = await ask("  > ");

    if (ans.toUpperCase() === "Q") return null;
    if (ans.toUpperCase() === "R" || ans.toUpperCase() === "A") {
      query = "";
      filtered = sessions;
      page = 0;
      continue;
    }
    if (ans.toLowerCase() === "p" && page > 0) { page--; continue; }
    if (ans.toLowerCase() === "n" && page < totalPages - 1) { page++; continue; }
    if (ans.toLowerCase() === "s") {
      const q = await ask("  Search keyword: ");
      if (q.trim()) {
        query = q.trim();
        filtered = scanner.search(sessions, query);
        page = 0;
      }
      continue;
    }

    // Try parsing as comma-separated session numbers
    const nums = ans.split(",").map(s => s.trim()).filter(Boolean);
    const indices = [];
    let bad = false;
    for (const n of nums) {
      const idx = parseInt(n, 10);
      if (isNaN(idx) || idx < 1 || idx > filtered.length) {
        console.log(color(`  Invalid number: ${n}`, RED));
        bad = true;
        break;
      }
      indices.push(idx - 1);
    }
    if (bad) { await pressEnter(); continue; }
    if (indices.length === 0) continue;

    // Return selected sessions (deduplicated, preserving order)
    const seen = new Set();
    return indices.map(i => filtered[i]).filter(s => { const k = s.filePath; if (seen.has(k)) return false; seen.add(k); return true; });
  }
}

// ---------- build events from raw turns (deterministic, no LLM) ----------
function buildEvents(sessions) {
  const events = [];
  const threadDefs = [];
  const typeDefs = {
    question: { glyph: "?", name: "开端 / 提问" },
    finding: { glyph: "●", name: "发现 / 洞察" },
    artifact: { glyph: "▭", name: "产物 / 文件" },
    decision: { glyph: "◆", name: "决策" },
    pivot: { glyph: "✱", name: "转向 / pivot" },
    abandon: { glyph: "✕", name: "废弃" },
    verify: { glyph: "✔", name: "验证通过" },
    handoff: { glyph: "➜", name: "交接" },
  };
  const palette = ["#8BA3FF", "#55C6B1", "#C79BF2", "#E2B357", "#6FC98B", "#EC8FB0", "#5EB7E6", "#E89B6E", "#A9C05C", "#D98BE0"];

  const agents = new Set();
  sessions.forEach(s => { if (s.agent) agents.add(s.agent); });

  const agentList = [...agents];
  agentList.forEach((agent, i) => {
    const agentSessions = sessions.filter(s => s.agent === agent);
    const rootThread = { id: `t_${agent}_main`, base: agent, name: agent, color: palette[i % palette.length], agent, parent: null, glow: true };
    threadDefs.push(rootThread);
    let evIdx = 0;
    agentSessions.forEach(s => {
      try {
        const lines = fs.readFileSync(s.filePath, "utf8").split("\n").filter(Boolean);
        lines.forEach((l, li) => {
          try {
            const o = JSON.parse(l);
            let text = "", ts = o.timestamp || s.firstTs || new Date().toISOString();
            if (o.type === "queue-operation" && o.operation === "enqueue") {
              text = (o.content || "").replace(/<[^>]+>/g, "").trim();
            } else if (o.type === "user" && o.message && o.message.role === "user") {
              const c = o.message.content;
              text = typeof c === "string" ? c
                : Array.isArray(c) ? c.filter(b => b && b.type === "text").map(b => b.text || "").join("\n")
                : "";
            }
            if (!text || text.length < 3) return;
            text = text.replace(/\s+/g, " ").trim();
            const id = `${s.platform}_${s.sessionId}_${li}`;
            const ev = {
              id, agent, session: s.sessionId, line: li + 1, ts,
              type: "finding", thread: rootThread.id,
              title: text.slice(0, 6),
              summary: text.slice(0, 90),
              excerpt: text.slice(0, 140),
            };
            events.push(ev);
            evIdx++;
          } catch (e) { /* skip unparseable line */ }
        });
      } catch (e) { /* skip unreadable file */ }
    });
  });

  events.sort((a, b) => {
    const ta = new Date(a.ts).getTime(), tb = new Date(b.ts).getTime();
    return ta - tb || a.line - b.line;
  });

  const agentsOut = agentList.map((id, i) => ({
    id, name: id.charAt(0).toUpperCase() + id.slice(1),
    short: id.slice(0, 2).toUpperCase(), hue: palette[i % palette.length], role: "对话"
  }));

  // Load aliases if available
  try {
    const aliases = JSON.parse(fs.readFileSync(path.join(ROOT, "aliases.json"), "utf8"));
    agentsOut.forEach(a => {
      const al = aliases[a.id];
      if (al) { a.name = al.name || a.name; a.hue = al.hue || a.hue; a.role = al.role || a.role; }
    });
  } catch (e) { /* no aliases, use auto */ }

  // Build coverage
  const coverage = {
    sessions: {},
    totals: { turns: 0, extracted: events.length, merged: 0, skipped: 0, genuineUncovered: 0 },
    note: "CLI auto-build — deterministic (no LLM)"
  };

  const sessionIds = [...new Set(sessions.map(s => s.sessionId))];
  sessionIds.forEach(sid => {
    const s = sessions.find(ss => ss.sessionId === sid);
    coverage.sessions[sid] = {
      turns: s ? s.turns : 0, extracted: events.filter(e => e.session === sid).length,
      merged: 0, skipped: 0, ledger: []
    };
  });

  const doc = {
    meta: {
      version: 1, project: "opencode-context-visualizer",
      generator: "cli.js (deterministic build)",
      model: "deterministic",
      title: `${agentList.map(a => a.charAt(0).toUpperCase() + a.slice(1)).join(" · ")} · Session Storyline`
    },
    agents: agentsOut,
    manifest: sessions.map(s => ({ id: s.sessionId, agent: s.agent, folder: s.project, sourcePath: s.filePath })),
    sessions: sessions.map(s => ({ id: s.sessionId, agent: s.agent, file: path.basename(s.filePath), label: s.project })),
    threadDefs,
    typeDefs,
    coverage,
    events,
  };

  return doc;
}

// ---------- serve ----------
function startServer() {
  return new Promise((resolve, reject) => {
    const cp = require("child_process");
    const srv = cp.spawn("node", [path.join(ROOT, "serve.js")], {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env }
    });

    srv.stdout.on("data", d => {
      const msg = d.toString();
      process.stdout.write(color(msg, DIM));
      if (msg.includes("http://localhost:")) resolve(srv);
    });
    srv.stderr.on("data", d => process.stderr.write(d));

    srv.on("error", reject);
    srv.on("close", code => {
      if (code !== 0 && code !== null) {
        console.log(color(`\n  Server exited with code ${code}`, RED));
      }
    });

    // Timeout fallback: after 3s assume server started even without the log line
    setTimeout(() => resolve(srv), 3000);
  });
}

function openBrowser(url) {
  const plat = process.platform;
  const cmd = plat === "darwin" ? "open" : plat === "win32" ? "start" : "xdg-open";
  try {
    if (plat === "win32") {
      require("child_process").execSync(`start "" "${url}"`, { timeout: 2000 });
    } else {
      require("child_process").spawn(cmd, [url], { detached: true, stdio: "ignore" });
    }
    return true;
  } catch (e) { return false; }
}

// ---------- main interactive loop ----------
async function mainInteractive() {
  printHeader();
  console.log(`  Scanning for sessions...`);

  let scanResult = scanner.scanAll();
  const total = scanResult.sessions.length;

  if (total === 0) {
    console.log(color("\n  No sessions found.", YELLOW));
    const scanClaude = scanner.claudeProjectsPath();
    const scanOpenCode = scanner.opencodeExportPath();
    console.log(`  Looked in:\n    Claude Code: ${color(scanClaude, DIM)}\n    OpenCode:    ${color(scanOpenCode, DIM)}`);
    console.log(color("\n  Tip: For OpenCode, first run: node opencode-export.js <sessions-dir>", DIM));
    return;
  }

  // Step 1: Platform selection
  while (true) {
    printHeader();
    printPlatforms(scanResult);

    const platform = await selectPlatform(scanResult);
    if (platform === null) { console.log(color("\n  Goodbye!", GREEN)); return; }
    if (platform === "REFRESH") {
      scanResult = scanner.scanAll();
      console.log(color(`\n  Rescanned: ${scanResult.sessions.length} sessions found.`, GREEN));
      await pressEnter();
      continue;
    }

    // Step 2: Filter sessions for platform
    const plats = platform === "claude" ? ["claude"] : ["opencode"];
    const filtered = scanResult.sessions.filter(s => plats.includes(s.platform));
    if (!filtered.length) {
      console.log(color(`  No ${platform} sessions found.`, YELLOW));
      await pressEnter();
      continue;
    }

    // Step 3: Session selection
    const selected = await sessionMenu(filtered);
    if (!selected || !selected.length) continue;

    // Step 4: Build events & serve
    await buildAndServe(selected);
    break;
  }
}

async function buildAndServe(selected) {
  printHeader();
  console.log(`  Selected ${selected.length} session(s):`);
  selected.forEach(s => {
    console.log(`    ${color("•", GREEN)} ${s.platform}/${s.project} — ${s.sessionId} (${s.turns} turns)`);
  });
  console.log("");

  // Step A: Build events.json deterministically
  console.log(color("  Building storyline...", BOLD));
  const doc = buildEvents(selected);
  fs.writeFileSync(EV_PATH, JSON.stringify(doc, null, 2));
  console.log(`  events.json: ${doc.events.length} events, ${doc.threadDefs.length} threads, ${doc.agents.length} agent(s)`);
  console.log(color("  ✅ Storyline built", GREEN));
  console.log("");

  // Step B: Start server
  console.log(color("  Starting visualization server...", BOLD));
  const srv = await startServer();

  const url = "http://localhost:8123";
  console.log(color(`  ✅ Server running at ${url}`, GREEN));

  const opened = openBrowser(url);
  if (opened) console.log(`  Browser opened automatically.`);

  console.log("");
  console.log(color("  ┌─ Controls ─────────────────────────────────────┐", DIM));
  console.log(color("  │  Open http://localhost:8123 in your browser      │", DIM));
  console.log(color("  │  [R] Refresh storyline (re-scan & rebuild)       │", DIM));
  console.log(color("  │  [Q] Quit server                                 │", DIM));
  console.log(color("  └─────────────────────────────────────────────────┘", DIM));
  console.log("");

  // Step C: Wait for user command
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => { /* handle Ctrl+C */ });

  await new Promise(resolve => {
    const onData = (buffer) => {
      const key = buffer.toString().toLowerCase();
      if (key === "q" || key === "\u0003") { // q or Ctrl+C
        process.stdin.removeListener("data", onData);
        if (!rl.closed) rl.close();
        resolve();
      } else if (key === "r") {
        process.stdin.removeListener("data", onData);
        if (!rl.closed) rl.close();
        resolve("REFRESH");
      }
    };
    process.stdin.setRawMode && process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);

    // Also allow readline input
    rl.question(color("  Press [Q] to quit, [R] to refresh: ", DIM), ans => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode && process.stdin.setRawMode(false);
      process.stdin.pause();
      if (ans.toUpperCase() === "R") resolve("REFRESH");
      else resolve();
    });
  });

  process.stdin.setRawMode && process.stdin.setRawMode(false);
  process.stdin.pause();

  // Cleanup
  srv.kill();
  if (!rl.closed) rl.close();

  const reason = await new Promise(r => {
    srv.on("close", () => r("stopped"));
    setTimeout(() => r("timeout"), 2000);
  });

  if (reason === "stopped") {
    console.log(color("\n  Server stopped.", YELLOW));
    // Check if we need to refresh
    const lastAction = await new Promise(resolve => {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl2.question(color("\n  [Enter] to go back to menu, [Q] to quit: ", DIM), ans => {
        rl2.close();
        resolve(ans.toUpperCase() === "Q" ? "QUIT" : "MENU");
      });
    });
    if (lastAction === "QUIT") {
      console.log(color("\n  Goodbye!", GREEN));
      return "QUIT";
    }
    return "MENU";
  }
  return "MENU";
}

// ---------- CLI options ----------
function printHelp() {
  console.log(`
  Context Visualizer CLI v${VERSION}

  Usage:
    node cli.js           Interactive session picker & visualizer
    node cli.js --scan    Scan sessions and print to stdout
    node cli.js --help    Show this help

  Options:
    --scan            Scan & list all available sessions, then exit
    --platform <p>    Filter scan by platform: "claude" or "opencode"
    --serve <file>    Start server with a specific events.json
    --help            Show this help
  `);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--scan")) {
    const platIdx = args.indexOf("--platform");
    const plat = platIdx >= 0 ? args[platIdx + 1] : null;
    const result = scanner.scanAll();

    let sessions = result.sessions;
    if (plat === "claude") sessions = sessions.filter(s => s.platform === "claude");
    else if (plat === "opencode") sessions = sessions.filter(s => s.platform === "opencode");

    console.log(JSON.stringify({ platforms: result.platforms, count: sessions.length, sessions }, null, 2));
    return;
  }

  if (args.includes("--serve")) {
    const idx = args.indexOf("--serve");
    const evFile = args[idx + 1];
    if (evFile && fs.existsSync(evFile)) {
      // Copy specified events.json to our location
      fs.copyFileSync(path.resolve(evFile), EV_PATH);
      console.log(`Loaded ${evFile}`);
    }
    // Start server directly
    const srv = await startServer();
    console.log(`Server running at http://localhost:8123`);
    console.log("Press Ctrl+C to stop.");
    process.on("SIGINT", () => { srv.kill(); process.exit(0); });
    // Keep running
    await new Promise(() => {});
    return;
  }

  // Default: interactive mode
  let nextAction = "MENU";
  while (nextAction === "MENU") {
    nextAction = await mainInteractive();
  }
}

main().catch(e => {
  console.error(color(`\n  Error: ${e.message}`, RED));
  process.exit(1);
});
