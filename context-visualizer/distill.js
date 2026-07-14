// distill.js — Configurable LLM distillation engine for Claude Code & OpenCode sessions.
//
//   node distill.js <jsonl> [<jsonl> ...]
//   node distill.js --out events.json <jsonl ...>
//   node distill.js --reorder|--consolidate|--metrics events.json
//
// Config via config.json:
//   { "llm": { "baseUrl": "...", "apiKey": "...", "model": "..." },
//     "concurrency": 8, "blockSize": 12, "maxThreadsPerAgent": 7 }
//
// Programmatic API:
//   const { distillSessions } = require('./distill.js');
//   const { doc, stats } = await distillSessions(sessions, opts);

const fs = require("fs"), path = require("path");
const Core = require("./distill-core.js");

let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (e) {}

const OR_KEY = process.env.OPENROUTER_API_KEY || ((config.llm || {}).apiKey) || "";
const LLM_BASE = process.env.OPENROUTER_BASE_URL || ((config.llm || {}).baseUrl) || "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.DISTILL_MODEL || ((config.llm || {}).model) || "deepseek/deepseek-v4-pro";
const CONCURRENCY = Math.max(1, +process.env.DISTILL_CONCURRENCY || ((config.llm || {}).concurrency) || 8);
const BLOCK_SIZE = Math.max(1, +process.env.DISTILL_BLOCK_SIZE || ((config.llm || {}).blockSize) || 12);
const MAX_PER_AGENT = +process.env.MAX_THREADS_PER_AGENT || ((config.llm || {}).maxThreadsPerAgent) || 7;

const T = Core.T;
let ALIASES = {};
try { ALIASES = JSON.parse(fs.readFileSync(path.join(__dirname, "aliases.json"), "utf8")); } catch (e) {}

let useJsonSchema = process.env.DISTILL_SCHEMA === "1";

function isOpenRouter(url) {
  return url && /openrouter\.ai/i.test(url);
}

function baseUrl(url) {
  return (url || LLM_BASE).replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
}

async function callModel(messages, opts) {
  opts = opts || {};
  const endpoint = baseUrl(LLM_BASE);
  const chatUrl = endpoint + "/chat/completions";
  const or = isOpenRouter(LLM_BASE);

  // Standard headers (all providers)
  const headers = {
    "Authorization": "Bearer " + OR_KEY,
    "Content-Type": "application/json",
  };
  // OpenRouter-specific: referer + title for ranking
  if (or) {
    headers["HTTP-Referer"] = "http://localhost";
    headers["X-Title"] = "context-visualizer";
  }

  // Build body: base = OpenAI-compatible, extras = provider-specific
  const extraBody = {};
  if (or) {
    extraBody.reasoning = { enabled: false };       // OpenRouter: skip reasoning tokens
    extraBody.provider = { sort: "throughput" };    // OpenRouter: fastest backend
    opts.noResponseFormat = false;                   // OpenRouter supports json_object
  } else {
    // Non-OpenRouter providers (DeepSeek, internal API, Ollama, etc.)
    // may not support response_format reliably. Skip it — the system prompt
    // already tells the model to output JSON.
    opts.noResponseFormat = true;
  }
  opts.extraBody = extraBody;
  opts.useJsonSchema = useJsonSchema;

  const body = Core.reqBody(MODEL, messages, opts);

  const res = await fetch(chatUrl, { method: "POST", headers, body });
  const j = await res.json();
  if (j.error) {
    if (useJsonSchema && /schema|response_format|json/i.test(JSON.stringify(j.error))) { useJsonSchema = false; return { retry: true, usage: null }; }
    throw new Error(JSON.stringify(j.error).slice(0, 200));
  }
  return { content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "", usage: j.usage };
}

function deriveSession(file) {
  const base = path.basename(file).replace(/\.jsonl$/i, "");
  const id = (base.match(/^[0-9a-f]{8}/i) || [base.slice(0, 8)])[0];
  const folder = path.basename(path.dirname(file));
  const agent = folder.replace(/^C--/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return { id, agent, sourcePath: file, folder };
}

async function distillSessions(sessions, opts) {
  opts = opts || {};
  const log = opts.log || (msg => process.stderr.write(msg + "\n"));
  let prevDoc = null;
  if (opts.merge) {
    try { prevDoc = JSON.parse(fs.readFileSync(opts.merge, "utf8")); } catch (e) {}
  }
  const doc = await Core.distillAll({
    sessions, aliases: ALIASES, callModel,
    log, concurrency: CONCURRENCY, blockSize: BLOCK_SIZE,
    maxPerAgent: MAX_PER_AGENT, model: MODEL, merge: prevDoc,
  });
  const stats = doc._stats || {};
  delete doc._stats;
  if (opts.outputPath) {
    fs.writeFileSync(opts.outputPath, JSON.stringify(doc, null, 2));
  }
  return { doc, stats };
}

module.exports = { distillSessions, callModel, baseUrl, MODEL, CONCURRENCY, BLOCK_SIZE, MAX_PER_AGENT };

// ========== CLI mode ==========
if (require.main === module) {

const argv = process.argv.slice(2);
let OUT = "events.json", MERGE = null, REORDER = null, CONSOLIDATE = null, METRICS = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") OUT = argv[++i];
  else if (argv[i] === "--merge") MERGE = argv[++i];
  else if (argv[i] === "--reorder") REORDER = argv[++i];
  else if (argv[i] === "--consolidate") CONSOLIDATE = argv[++i];
  else if (argv[i] === "--metrics") METRICS = argv[++i];
  else files.push(argv[i]);
}
if (!files.length && !REORDER && !CONSOLIDATE && !METRICS) {
  console.error("usage: node distill.js [--out events.json] <jsonl> [...]   |   node distill.js --reorder|--consolidate|--metrics events.json");
  process.exit(2);
}
if (!OR_KEY && !REORDER && !CONSOLIDATE && !METRICS) {
  console.error("No API key configured. Set OPENROUTER_API_KEY env var or apiKey in config.json (llm section).");
  process.exit(2);
}

// Post-process modes
if (REORDER) {
  const fp = path.join(__dirname, REORDER);
  const d = JSON.parse(fs.readFileSync(fp, "utf8"));
  const rank = Core.agentRankFromEvents(d.events, Object.fromEntries((d.manifest || []).map(m => [m.agent, m.folder])), ALIASES);
  d.threadDefs = Core.orderThreads(d.threadDefs, rank, d.events);
  fs.writeFileSync(fp, JSON.stringify(d, null, 2));
  console.log(`reordered ${REORDER}: ${d.threadDefs.length} threadDefs`);
  process.exit(0);
}
if (CONSOLIDATE) {
  const fp = path.join(__dirname, CONSOLIDATE);
  const d = JSON.parse(fs.readFileSync(fp, "utf8"));
  const before = d.threadDefs.length;
  const rank = Core.agentRankFromEvents(d.events, Object.fromEntries((d.manifest || []).map(m => [m.agent, m.folder])), ALIASES);
  d.threadDefs = Core.orderThreads(Core.consolidate(d.events, d.threadDefs, MAX_PER_AGENT), rank, d.events);
  fs.writeFileSync(fp, JSON.stringify(d, null, 2));
  console.log(`consolidated ${CONSOLIDATE}: ${before} → ${d.threadDefs.length}`);
  process.exit(0);
}

// Normal distill
(async () => {
  const manifest = files.map(deriveSession);
  let prevDoc = null;
  if (MERGE) { try { prevDoc = JSON.parse(fs.readFileSync(path.join(__dirname, MERGE), "utf8")); } catch (e) {} }
  const sessions = [];
  for (const m of manifest) {
    if (!fs.existsSync(m.sourcePath)) { console.error("  missing:", m.sourcePath); continue; }
    sessions.push({ id: m.id, agent: m.agent, folder: m.folder, sourcePath: m.sourcePath, text: fs.readFileSync(m.sourcePath, "utf8") });
  }
  const doc = await Core.distillAll({
    sessions, aliases: ALIASES, callModel,
    log: msg => process.stderr.write(msg + "\n"),
    concurrency: CONCURRENCY, blockSize: BLOCK_SIZE,
    maxPerAgent: MAX_PER_AGENT, model: MODEL, merge: prevDoc,
  });
  const stats = doc._stats || {};
  delete doc._stats;
  fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(doc, null, 2));
  const tot = doc.coverage.totals;
  console.log(`\nwrote ${OUT}: ${doc.events.length} events · ${doc.threadDefs.length} threads · ${doc.agents.length} agents`);
  console.log(`ledger: turns=${tot.turns} extracted=${tot.extracted} merged=${tot.merged} skipped=${tot.skipped} GENUINE-UNCOVERED=${stats.uncovered || 0}`);
  console.log(`LLM: ${stats.calls || 0} calls · prompt_tok=${stats.tokInReal || 0} completion_tok=${stats.tokOutReal || 0}`);
  if (stats.uncovered) console.log(`⚠ ${stats.uncovered} GENUINE-UNCOVERED → audit will fail`);
})();

}