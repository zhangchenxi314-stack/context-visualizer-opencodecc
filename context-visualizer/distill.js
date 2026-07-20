// UNIVERSAL AUTO-DISTILLER (Node shell) — any JSONL transcript → trusted storyline events.json
//
//   node --env-file=.env distill.js <jsonl> [<jsonl> ...]
//   node --env-file=.env distill.js --sessions-dir opencode-sessions   (import all sessions in dir)
//   node --env-file=.env distill.js --out events.json <jsonl ...>
//   node distill.js --reorder|--consolidate|--metrics events.json     (LLM-free post-process)
//
// Supports both Claude Code (/.claude/projects/**/*.jsonl) and OpenCode export format
// (opencode-sessions/<agent>/<session>.jsonl). Agent identity reads from directory name,
// falling back to _meta.agent in the JSONL content.
//
// The distillation ALGORITHM lives in distill-core.js (shared with the browser BYOK build).
// This file only does the Node-specific parts: CLI args, reading files from disk, injecting the
// OpenRouter HTTP call, and writing the output. Trust contract + cost discipline are in the core.
const fs = require("fs"), path = require("path");
const Core = require("./distill-core.js");

const OR_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.DISTILL_MODEL || "deepseek/deepseek-v4-pro";
const CONCURRENCY = Math.max(1, +process.env.DISTILL_CONCURRENCY || 8);
const BLOCK_SIZE = Math.max(1, +process.env.DISTILL_BLOCK_SIZE || 12);
const MAX_PER_AGENT = +process.env.MAX_THREADS_PER_AGENT || 7;

// ---------- args ----------
const argv = process.argv.slice(2); let OUT = "events.json", MERGE = null, REORDER = null, CONSOLIDATE = null, METRICS = null, SESSIONS_DIR = null; const files = [];
for (let i = 0; i < argv.length; i++) { if (argv[i] === "--out") OUT = argv[++i]; else if (argv[i] === "--merge") MERGE = argv[++i]; else if (argv[i] === "--reorder") REORDER = argv[++i]; else if (argv[i] === "--consolidate") CONSOLIDATE = argv[++i]; else if (argv[i] === "--metrics") METRICS = argv[++i]; else if (argv[i] === "--sessions-dir") SESSIONS_DIR = argv[++i]; else files.push(argv[i]); }
// Resolve --sessions-dir: scan directory for **/*.jsonl (OpenCode export format)
if (SESSIONS_DIR) {
  const dir = path.resolve(SESSIONS_DIR);
  if (!fs.existsSync(dir)) { console.error("sessions directory not found:", dir); process.exit(2); }
  const walk = d => { const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) { const fp = path.join(d, e.name);
      if (e.isFile() && e.name.endsWith(".jsonl")) files.push(fp);
      else if (e.isDirectory()) walk(fp); } };
  walk(dir);
}
if (!files.length && !REORDER && !CONSOLIDATE && !METRICS) { console.error("usage: node --env-file=.env distill.js [--out events.json] [--sessions-dir <dir>] <jsonl> [...]   |   node distill.js --reorder|--consolidate|--metrics events.json"); process.exit(2); }
if (!OR_KEY && !REORDER && !CONSOLIDATE && !METRICS) { console.error("OPENROUTER_API_KEY missing (put it in .env, run with --env-file=.env)"); process.exit(2); }

const T = Core.T;
// OPTIONAL project aliases (folder → {name,hue,role,order}; optional _title). Missing file → fully generic.
let ALIASES = {}; try { ALIASES = JSON.parse(fs.readFileSync(path.join(__dirname, "aliases.json"), "utf8")); } catch (e) {}

function deriveSession(file) {
  const base = path.basename(file).replace(/\.jsonl$/i, "");
  // Session ID: try Claude Code 8-char hex, then OpenCode ses_xxx prefix, then first 12 chars
  const id = (base.match(/^[0-9a-f]{8}/i) || base.match(/^(ses_[a-z0-9]{5,20})/i) || [base.slice(0, 12)])[0];
  const folder = path.basename(path.dirname(file));
  const agent = folder.replace(/^C--/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  // Try reading _meta.agent from first JSONL line for better agent naming
  let metaAgent = null;
  try { const first = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
    metaAgent = (first._meta && first._meta.agent) || null; } catch (e) {}
  return { id, agent: metaAgent || agent, sourcePath: file, folder };
}

// ---------- LLM-free post-process modes (deterministic layout engine, from the core) ----------
if (REORDER) { const fp = path.join(__dirname, REORDER); const d = JSON.parse(fs.readFileSync(fp, "utf8"));
  const rank = Core.agentRankFromEvents(d.events, Object.fromEntries((d.manifest || []).map(m => [m.agent, m.folder])), ALIASES);
  d.threadDefs = Core.orderThreads(d.threadDefs, rank, d.events);
  fs.writeFileSync(fp, JSON.stringify(d, null, 2));
  console.log(`reordered ${REORDER}: ${d.threadDefs.length} threadDefs in barycenter-DFS/agent order`); process.exit(0); }
if (CONSOLIDATE) { const fp = path.join(__dirname, CONSOLIDATE); const d = JSON.parse(fs.readFileSync(fp, "utf8"));
  const before = d.threadDefs.length;
  const rank = Core.agentRankFromEvents(d.events, Object.fromEntries((d.manifest || []).map(m => [m.agent, m.folder])), ALIASES);
  d.threadDefs = Core.orderThreads(Core.consolidate(d.events, d.threadDefs, MAX_PER_AGENT), rank, d.events);
  fs.writeFileSync(fp, JSON.stringify(d, null, 2));
  console.log(`consolidated ${CONSOLIDATE}: ${before} → ${d.threadDefs.length} threads (≤${MAX_PER_AGENT}/agent; events re-threaded, ledger intact)`); process.exit(0); }
// --metrics: dev-only readability numbers (regression REFERENCE, not a gate — trend-watch only).
if (METRICS) { const fp = path.join(__dirname, METRICS); const d = JSON.parse(fs.readFileSync(fp, "utf8"));
  const lane = {}; d.threadDefs.forEach((t, i) => lane[t.id] = i);
  const forkE = d.threadDefs.filter(t => t.parent && lane[t.parent] !== undefined)
    .map(t => ({ a: lane[t.parent], b: lane[t.id], lbl: `${t.parent}→${t.id}` }));
  const sessEv = {}; d.events.forEach(e => (sessEv[e.session] || (sessEv[e.session] = [])).push(e));
  const hoE = [];
  d.events.filter(e => e.handoff_to && sessEv[e.handoff_to]).forEach(e => {
    const tgt = sessEv[e.handoff_to].slice().sort((a, b) => T(a.ts) - T(b.ts))[0].thread;
    if (lane[e.thread] !== undefined && lane[tgt] !== undefined) hoE.push({ a: lane[e.thread], b: lane[tgt], lbl: `${e.thread}⇢${tgt}` });
  });
  const edges = [...forkE, ...hoE].map(e => ({ lo: Math.min(e.a, e.b), hi: Math.max(e.a, e.b) }));
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const A = edges[i], B = edges[j];
    if ((A.lo < B.lo && B.lo < A.hi && A.hi < B.hi) || (B.lo < A.lo && A.lo < B.hi && B.hi < A.hi)) crossings++;
  }
  const allTs = d.events.map(e => T(e.ts)); const BW = (Math.max(...allTs) - Math.min(...allTs)) / 18 || 1;
  const evByT = {}; d.events.forEach(e => (evByT[e.thread] || (evByT[e.thread] = [])).push(T(e.ts)));
  let gmax = 1e-9; const peak = {};
  for (const [id, ts] of Object.entries(evByT)) {
    peak[id] = Math.max(...ts.map(a => ts.reduce((s, b) => s + Math.exp(-(((a - b) / BW) ** 2)), 0)));
    if (peak[id] > gmax) gmax = peak[id];
  }
  const LANE_GAP = 66, wToPx = w => 3.5 + w * 24;
  const sumW = d.threadDefs.reduce((s, t) => s + wToPx(Math.max(.08, Math.min(1, (peak[t.id] || 0) / gmax))), 0);
  const white = 1 - sumW / ((d.threadDefs.length || 1) * LANE_GAP);
  const gaps = forkE.map(e => Math.abs(e.a - e.b));
  console.log(`metrics ${METRICS}: ${d.threadDefs.length} lanes · ${forkE.length} fork edges · ${hoE.length} handoff edges`);
  forkE.forEach(e => console.log(`  gap ${Math.abs(e.a - e.b)}  ${e.lbl}`));
  console.log(`SPE (mean parent→child lane gap) = ${(gaps.reduce((s, x) => s + x, 0) / (gaps.length || 1)).toFixed(2)} · max=${gaps.length ? Math.max(...gaps) : 0} · >2: ${gaps.filter(g => g > 2).length}/${gaps.length}`);
  console.log(`Crossings (interleaving fork+handoff pairs) = ${crossings}`);
  console.log(`Whitespace ≈ ${(white * 100).toFixed(0)}%  (target 25–45%; coarse — raw-time KDE, no idle compression)`);
  process.exit(0); }

// ---------- normal distill path ----------
let useJsonSchema = process.env.DISTILL_SCHEMA === "1";
async function callModel(messages, opts) {
  const res = await fetch(Core.ENDPOINT, { method: "POST", headers: {
    "Authorization": "Bearer " + OR_KEY, "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost", "X-Title": "conv-viz-storyline" }, body: Core.reqBody(MODEL, messages, opts, useJsonSchema) });
  const j = await res.json();
  if (j.error) {
    if (useJsonSchema && /schema|response_format|json/i.test(JSON.stringify(j.error))) { useJsonSchema = false; return { retry: true, usage: null }; }
    throw new Error(JSON.stringify(j.error).slice(0, 200));
  }
  return { content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "", usage: j.usage };
}

(async () => {
  const manifest = files.map(deriveSession);
  let prevDoc = null; if (MERGE) { try { prevDoc = JSON.parse(fs.readFileSync(path.join(__dirname, MERGE), "utf8")); } catch (e) {} }
  const sessions = [];
  for (const m of manifest) {
    if (!fs.existsSync(m.sourcePath)) { console.error("  missing:", m.sourcePath); continue; }
    sessions.push({ id: m.id, agent: m.agent, folder: m.folder, sourcePath: m.sourcePath, text: fs.readFileSync(m.sourcePath, "utf8") });
  }
  const doc = await Core.distillAll({
    sessions, aliases: ALIASES, callModel, log: msg => process.stderr.write(msg + "\n"),
    concurrency: CONCURRENCY, blockSize: BLOCK_SIZE, maxPerAgent: MAX_PER_AGENT, model: MODEL, merge: prevDoc,
  });
  const stats = doc._stats || {}; delete doc._stats;
  fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(doc, null, 2));
  const tot = doc.coverage.totals;
  console.log(`\nwrote ${OUT}: ${doc.events.length} events · ${doc.threadDefs.length} threads · ${doc.agents.length} agents`);
  console.log(`ledger: turns=${tot.turns} extracted=${tot.extracted} merged=${tot.merged} skipped=${tot.skipped} GENUINE-UNCOVERED=${stats.uncovered || 0}`);
  console.log(`LLM: ${stats.calls || 0} calls · real prompt_tok=${stats.tokInReal || 0} completion_tok=${stats.tokOutReal || 0} · est input/turn≈${stats.calls ? Math.round(stats.tokInReal / stats.calls) : 0} tok (bounded, O(1)/turn)`);
  if (stats.uncovered) console.log(`⚠ ${stats.uncovered} GENUINE-UNCOVERED → audit will fail (by design; rerun or inspect)`);
})();
