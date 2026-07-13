// distill-core.js — ISOMORPHIC distillation engine (Node + browser share ONE algorithm).
//
//   raw user-turns (+ folder/agent) → trusted storyline `doc` (agents/manifest/threadDefs/
//   events/coverage/meta). Identical logic to the original distill.js; the only things the
//   host injects are (a) how to read files and (b) how to call the model (`ctx.callModel`).
//
// Reentrant: distillAll() builds ALL mutable state fresh per call (no module globals), so a
// host can distill many projects back-to-back with zero bleed. The Node CLI (distill.js) is
// a thin shell over this file; a browser host can wrap it the same way.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node
  else root.DistillCore = api;                                               // browser → window.DistillCore
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

// ---------- stateless helpers (safe at module scope) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
// tiny concurrency gate: bounds total in-flight async fns to `limit` (rate-limit safe when many
// sessions/agents run at once). gate(fn) → Promise that runs fn when a slot frees.
function makeGate(limit) {
  let active = 0; const q = [];
  const pump = () => {
    if (active >= limit || !q.length) return;
    active++; const { fn, resolve, reject } = q.shift();
    Promise.resolve().then(fn).then(v => { active--; resolve(v); pump(); },
                                    e => { active--; reject(e); pump(); });
  };
  return fn => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); pump(); });
}
const T = s => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z").getTime();
const clean = s => (s || "")
  .replace(/<current_note>[\s\S]*?<\/current_note>/g, "")
  .replace(/<editor_selection>[\s\S]*?<\/editor_selection>/g, "")
  .replace(/\s+/g, " ").trim();
// content 可能是字符串(旧 enqueue)或 Claude Code 的 block 数组(新格式)。只取用户 TEXT 块。
// 须与 coverage-audit.js 的 blockText 保持一致。
const blockText = c => typeof c === "string" ? c
  : Array.isArray(c) ? c.filter(b => b && b.type === "text").map(b => b.text || "").join("\n")
  : "";
const approxTokens = s => Math.ceil([...String(s)].reduce((n, c) => n + (/[一-鿿]/.test(c) ? 1 : 0.34), 0));

const TYPE_DEFS = { question:{glyph:"?",name:"开端 / 提问"}, finding:{glyph:"●",name:"发现 / 洞察"},
  artifact:{glyph:"▭",name:"产物 / 文件"}, decision:{glyph:"◆",name:"决策"}, pivot:{glyph:"✱",name:"转向 / pivot"},
  abandon:{glyph:"✕",name:"废弃"}, interrupt:{glyph:"▲",name:"中断"}, verify:{glyph:"✔",name:"验证通过"}, handoff:{glyph:"➜",name:"交接"} };
const TYPES = Object.keys(TYPE_DEFS);
// CLI slash 命令(/init /compact …)= 工具调用,非故事内容。须与 coverage-audit.js 的判据一致。
const SLASH_CMD = /^\/[a-z][\w-]*/i;
// 14 色等亮度暗底和谐色 —— 与 index.html 的 RPAL 一致(渲染端会按序覆盖,此处只为数据自洽)。
const PALETTE = ["#8BA3FF","#55C6B1","#C79BF2","#E2B357","#6FC98B","#EC8FB0","#5EB7E6","#E89B6E","#A9C05C","#D98BE0","#6ED0D8","#C9B458","#95A7E0","#E0798C"];
const titleize = s => String(s).split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ") || String(s);

// parse one raw .jsonl line-object → a user turn {line,ts,text} or null (mirrors distill.js userTurns).
// Host reads the file & splits lines; this keeps the turn-recognition rule in ONE place.
function turnFromLine(o, lineNo) {
  if (o && o.type === "queue-operation" && o.operation === "enqueue")        // legacy queue format
    return { line: lineNo, ts: o.timestamp || "", text: clean(o.content) };
  if (o && o.type === "user" && o.message && o.message.role === "user") {     // 标准 Claude Code 格式
    const text = clean(blockText(o.message.content));
    if (text) return { line: lineNo, ts: o.timestamp || "", text };           // 纯 tool_result/纯图片 → 非 turn
  }
  return null;
}
// text of a jsonl line → turns[] (used by both Node fs reads and browser File.text()).
function turnsFromText(text) {
  const L = String(text).split("\n"); const t = [];
  L.forEach((l, i) => { if (!l.trim()) return; let o; try { o = JSON.parse(l); } catch (e) { return; }
    const turn = turnFromLine(o, i + 1); if (turn) t.push(turn); });
  return t;
}

// deterministic pre-filter (0 token)
function preFilter(text, coveredTexts) {
  if (text.length === 0) return "empty";
  if (/^<task-notification>/.test(text) || /<task-id>/.test(text)) return "task-notif";
  if (SLASH_CMD.test(text)) return "slash-command";
  if (text.length <= 8 || /^(继续|可以|好的?|行|ok|go on?|嗯|中文.*|.*分钟.*(了|过去).*)$/i.test(text)) return "terse-ack";
  const sameStart = (a, b) => { if (!a || !b) return false; const k = Math.min(a.length, b.length, 20); return k >= 10 && a.slice(0, k) === b.slice(0, k); };
  if (coveredTexts.some(ct => sameStart(text, ct))) return "re-send";
  return null;
}

// ---------- model plumbing ----------
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// build the request body (host passes its own useJsonSchema flag; browser keeps it false = json_object).
function reqBody(model, messages, opts, useJsonSchema) {
  opts = opts || {};
  // provider.sort=throughput → OpenRouter routes to the FASTEST backend for this model (no quality
  // change, just latency). reasoning off. Big speed win for many small parallel JSON calls.
  const b = { model, max_tokens: opts.maxTok || 500, reasoning: { enabled: false }, provider: { sort: "throughput" }, messages };
  if (useJsonSchema && !opts.forceJsonObject) b.response_format = { type: "json_schema", json_schema: { name: "event", strict: true, schema: {
    type: "object", additionalProperties: false,
    properties: { action:{type:"string",enum:["event","merge"]},
      type:{type:"string",enum:TYPES}, thread:{type:"string"}, parentThread:{type:"string"}, threadName:{type:"string"},
      title:{type:"string"}, summary:{type:"string"}, excerpt:{type:"string"} },
    required: ["action"] } } };
  else b.response_format = { type: "json_object" };
  return JSON.stringify(b);
}
function validEvent(o) {
  if (!o || typeof o !== "object") return null;
  if (o.action === "merge") return o.thread ? { action:"merge", thread:String(o.thread) } : null;
  if (!TYPES.includes(o.type)) return null;
  if (!o.thread || !o.title || !o.summary) return null;
  return { action:"event", type:o.type, thread:String(o.thread),
    parentThread: o.parentThread ? String(o.parentThread) : null,
    threadName: String(o.threadName || o.thread).slice(0, 10), title: String(o.title).slice(0, 6),
    summary: String(o.summary).slice(0, 90), excerpt: String(o.excerpt || "").slice(0, 140) };
}
function parseEvent(content) {
  if (!content) return null;
  const m = content.match(/\{[\s\S]*\}/); if (!m) return null;
  let o; try { o = JSON.parse(m[0]); } catch (e) { return null; }
  return validEvent(o);
}
function parseBlock(content) {
  if (!content) return null;
  const m = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/); if (!m) return null;
  let o; try { o = JSON.parse(m[0]); } catch (e) { return null; }
  const arr = Array.isArray(o) ? o : Array.isArray(o && o.results) ? o.results : null;
  if (!arr) return null;
  return arr.map(it => ({ line: (it && it.line != null) ? Number(it.line) : null, ev: validEvent(it) })).filter(x => x.ev);
}

const RULES =
  `thread 规则:简短小写领域名(尽量一个词,如 topic-a / setup / review / discuss);`+
  `能复用上面"已有线程"id 就复用;不要用 agent 名当 thread。\n`+
  `【关键-分叉树】新建一条 thread 时,必须给 parentThread = 它从哪条"已有线程"分叉而来(本 agent 已存在的 id);`+
  `只有确实是本 agent 全新开端(没有更早的来源)才省略 parentThread。\n`+
  `type 判定:handoff=把活交给"另一个 agent / 另开一个窗口去执行"(给出 prompt 让别处跑、交接);`+
  `pivot=推翻先前方向/重定义目标(如 pause、"我不需要X我需要Y"、"换个做法重来");decision=拍板某方案;`+
  `abandon=废弃/删除;verify=验证通过;artifact=产出文件;question=提问;finding=发现/洞察。\n`;
const EVENT_SHAPE =
  `{"action":"event","type":<${TYPES.join("|")}>,"thread":"<领域 id>","parentThread":"<新建时:作为父的已有 id>","threadName":"<≤8字中文显示名,新建时给>","title":"<≤6字>","summary":"<一句>","excerpt":"<≤120字,原文短摘>"}`+
  ` 或并入最近同线程事件(细节/追问,不值独立标记):{"action":"merge","thread":"<已有 id>"}`;
const SYS_TURN = "你把【一条用户 turn】蒸馏成长对话 storyline 的一个事件。只输出 JSON,不要解释。genuine 内容不得跳过:不确定也要出 event。";
const SYS_BLOCK = "你把【多条已编号的用户 turn】各蒸馏成长对话 storyline 的一个事件。只输出 JSON,不要解释。genuine 内容不得跳过:不确定也要出 event。每条 turn 必须恰好回一个对象、原样带回其行号。";

// one genuine turn → model. ctx.callModel injected; ctx.log for progress. 5× exponential backoff.
async function callTurn(ctx, turn, digest, meta, stats) {
  const user = `${digest}\n\n新 turn(${turn.ts}):\n${turn.text.slice(0, 1000)}\n\n` + RULES +
    `输出 JSON 之一:\nA) 新事件:${EVENT_SHAPE}`;
  stats.tokIn += approxTokens(digest) + approxTokens(turn.text.slice(0, 1000));
  let parsed = null;
  for (let attempt = 0; attempt < 5 && !parsed; attempt++) {
    try {
      const r = await ctx.callModel([{ role:"system", content:SYS_TURN }, { role:"user", content:user }]);
      if (r.retry) { attempt--; continue; }
      if (r.usage) { stats.calls++; stats.tokOutReal += r.usage.completion_tokens || 0; stats.tokInReal += r.usage.prompt_tokens || 0; }
      parsed = parseEvent(r.content);
      if (!parsed) await sleep(800 * (attempt + 1));
    } catch (e) { stats.errs++;
      ctx.log(`  ⏳ ${meta.id} L${turn.line}: API 出错,退避重试 ${attempt + 1}/5 (${(e.message || "").slice(0, 50)})`);
      await sleep(1200 * Math.pow(2, attempt));
    }
  }
  return parsed;
}
async function blockOnce(ctx, block, digest, meta, stats, maxAttempt) {
  const list = block.map(t => `#${t.line} (${t.ts}):\n${t.text.slice(0, 1000)}`).join("\n\n");
  const user = `${digest}\n\n下面是 ${block.length} 条【已编号】用户 turn(顺序即输入顺序)。为【每一条】蒸馏一个事件对象,放进 results 数组:\n`+
    `results 必须与输入 turn 一一对应、顺序一致 —— 每个 #行号 恰好一个对象、把该行号原样填进对象的 "line" 字段,不得缺行、不得把多条并成一条、不得多出。\n`+
    RULES +
    `\n输出:{"results":[ {"line":<行号>, ...单事件字段}, ... ]},其中单事件字段 = ${EVENT_SHAPE}\n\nturns:\n${list}`;
  stats.tokIn += approxTokens(digest) + approxTokens(list);
  const maxTok = Math.min(12000, Math.max(700, 240 * block.length));
  for (let attempt = 0; attempt < maxAttempt; attempt++) {
    try {
      const r = await ctx.callModel([{ role:"system", content:SYS_BLOCK }, { role:"user", content:user }], { maxTok, forceJsonObject:true });
      if (r.retry) { attempt--; continue; }
      if (r.usage) { stats.calls++; stats.tokOutReal += r.usage.completion_tokens || 0; stats.tokInReal += r.usage.prompt_tokens || 0; }
      const arr = parseBlock(r.content);
      if (arr && arr.length) return arr;
      await sleep(800 * (attempt + 1));
    } catch (e) { stats.errs++;
      ctx.log(`  ⏳ ${meta.id} 块[L${block[0].line}–${block[block.length - 1].line}]: API 出错,退避 ${attempt + 1}/${maxAttempt} (${(e.message || "").slice(0, 50)})`);
      await sleep(1200 * Math.pow(2, attempt));
    }
  }
  return [];
}
// block → Map(line → parsed). 三级对齐:① 显式行号 ② 位置兜 ③ 逐-turn 回退。
async function callBlock(ctx, block, digest, meta, stats) {
  const arr = await blockOnce(ctx, block, digest, meta, stats, 4);
  const lines = new Set(block.map(t => t.line));
  const map = new Map();
  for (const { line, ev } of arr) { if (line != null && lines.has(line)) map.set(line, ev); }   // ①
  if (map.size < block.length && arr.length === block.length) {                                  // ②
    block.forEach((t, i) => { if (!map.has(t.line) && arr[i] && arr[i].ev) map.set(t.line, arr[i].ev); });
  }
  const misses = block.filter(t => !map.has(t.line));                                            // ③
  if (misses.length) {
    ctx.log(`  ↳ ${meta.id} 块漏 ${misses.length}/${block.length} 行 → 逐-turn 回退`);
    const res = await Promise.all(misses.map(t => callTurn(ctx, t, digest, meta, stats)));
    misses.forEach((t, i) => { if (res[i]) map.set(t.line, res[i]); });
  }
  return map;
}

// ---------- graph helpers (stateless; operate on passed data) ----------
function buildAgentShorts(agentIds, seed) {
  const map = { ...(seed || {}) }, used = new Set(Object.values(seed || {}));
  for (const a of agentIds) { if (map[a]) continue;
    const base = (a.replace(/[^a-z0-9]/gi, "").toLowerCase()) || "a";
    let s = base.slice(0, 2) || "a", n = 2;
    while (used.has(s)) { n++; s = n <= base.length ? base.slice(0, n) : base + (used.size); }
    used.add(s); map[a] = s; }
  return map;
}
const cleanBase = x => String(x).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 20);

function agentRankFromEvents(events, folderOf, aliases) {
  folderOf = folderOf || {}; aliases = aliases || {};
  const firstTs = {}; for (const e of events) { const t = T(e.ts); if (firstTs[e.agent] === undefined || t < firstTs[e.agent]) firstTs[e.agent] = t; }
  const key = a => { const al = aliases[folderOf[a]]; return (al && al.order !== undefined) ? [0, al.order] : [1, firstTs[a] || 0]; };
  const ag = Object.keys(firstTs).sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1]; });
  const rank = {}; ag.forEach((a, i) => rank[a] = i); return rank;
}
// Sibling sort = BARYCENTER (tree stays top constraint; only same-parent siblings reorder).
function orderThreads(list, agentRank, events) {
  agentRank = agentRank || {}; events = events || [];
  const bySession = {}; events.forEach(e => (bySession[e.session] || (bySession[e.session] = new Set())).add(e.thread));
  const partners = {};
  events.filter(e => e.handoff_to && bySession[e.handoff_to]).forEach(e => {
    for (const tid of bySession[e.handoff_to]) {
      (partners[e.thread] || (partners[e.thread] = [])).push(tid);
      (partners[tid] || (partners[tid] = [])).push(e.thread);
    }
  });
  const agents = [...new Set(list.map(t => t.agent))].sort((a, b) => (agentRank[a] ?? 99) - (agentRank[b] ?? 99));
  const pass = keyOf => {
    const out = [];
    for (const ag of agents) {
      const ts = list.filter(t => t.agent === ag);
      const inSet = new Set(ts.map(t => t.id));
      const kids = id => ts.filter(t => t.parent === id);
      const subMemo = {}; const subtree = id => subMemo[id] || (subMemo[id] = [id, ...kids(id).flatMap(c => subtree(c.id))]);
      const kMemo = {}; const key = id => kMemo[id] !== undefined ? kMemo[id] : (kMemo[id] = keyOf(id, subtree));
      const childrenSorted = id => kids(id).slice().sort((a, b) => key(a.id) - key(b.id));
      const roots = ts.filter(t => !t.parent || !inSet.has(t.parent)).sort((a, b) => key(a.id) - key(b.id));
      const seen = new Set();
      const dfs = t => { if (seen.has(t.id)) return; seen.add(t.id); out.push(t); childrenSorted(t.id).forEach(dfs); };
      roots.forEach(dfs);
      ts.forEach(t => { if (!seen.has(t.id)) { seen.add(t.id); out.push(t); } });
    }
    return out;
  };
  const p1 = pass((id, subtree) => subtree(id).length);
  if (!events.length) return p1;
  const lane0 = {}; p1.forEach((t, i) => lane0[t.id] = i);
  return pass((id, subtree) => {
    const own = subtree(id).map(tid => lane0[tid]).filter(x => x !== undefined);
    if (!own.length) return Infinity;
    let sum = own.reduce((s, x) => s + x, 0), n = own.length;
    const plv = subtree(id).flatMap(tid => partners[tid] || []).map(pid => lane0[pid]).filter(x => x !== undefined);
    if (plv.length) { const W = n * 0.5; sum += (plv.reduce((s, x) => s + x, 0) / plv.length) * W; n += W; }
    return sum / n;
  });
}
// Cap threads per agent: merge SMALLEST non-root into parent until ≤ maxPerAgent (ledger intact).
function consolidate(events, defs, maxPerAgent) {
  defs = defs.map(t => ({ ...t }));
  const evByThread = {}; events.forEach(e => (evByThread[e.thread] || (evByThread[e.thread] = [])).push(e));
  const size = id => (evByThread[id] || []).length;
  const byAgent = {}; defs.forEach(t => (byAgent[t.agent] || (byAgent[t.agent] = [])).push(t));
  for (const ag of Object.keys(byAgent)) {
    let list = byAgent[ag];
    const has = id => list.some(t => t.id === id);
    while (list.length > maxPerAgent) {
      const cands = list.filter(t => t.parent && has(t.parent)).sort((a, b) => size(a.id) - size(b.id));
      if (!cands.length) break;
      const victim = cands[0], into = victim.parent;
      (evByThread[victim.id] || []).forEach(e => { e.thread = into; });
      evByThread[into] = (evByThread[into] || []).concat(evByThread[victim.id] || []); delete evByThread[victim.id];
      list.forEach(t => { if (t.parent === victim.id) t.parent = into; });
      list = list.filter(t => t.id !== victim.id);
    }
    byAgent[ag] = list;
  }
  const survivors = new Set(Object.values(byAgent).flat().map(t => t.id));
  return defs.filter(t => survivors.has(t.id));
}

// ============================================================================
//  distillAll — the orchestrator. ALL mutable state lives here (reentrant).
//
//  opts = {
//    sessions: [{ id, agent, folder, text }]   // raw .jsonl content already read by host
//    aliases:  {}                              // optional project aliases (folder → {name,hue,role,order}, _title)
//    callModel: async (messages, opts) => {content, usage} | {retry:true}   // host injects HTTP
//    log:       (msg) => void                  // progress
//    concurrency, blockSize, maxPerAgent, model // tuning (defaults mirror distill.js)
//    merge:     prevDoc | null                 // fold into an existing doc (incremental import)
//  }
//  → returns the full `doc` (same shape distill.js writes to events.json).
// ============================================================================
async function distillAll(opts) {
  const aliases = opts.aliases || {};
  const MODEL = opts.model || "deepseek/deepseek-v4-pro";
  const CONCURRENCY = Math.max(1, opts.concurrency || 8);
  const BLOCK_SIZE = Math.max(1, opts.blockSize || 12);
  const MAX_PER_AGENT = opts.maxPerAgent || 7;
  const log = opts.log || (() => {});
  // gate every model call through one global semaphore (limit = CONCURRENCY) so agent-groups can run
  // concurrently without exceeding the provider's rate limit.
  const gate = makeGate(CONCURRENCY);
  const ctx = { callModel: (messages, o) => gate(() => opts.callModel(messages, o)), log };

  // ---- fresh per-call state ----
  const events = []; const threads = new Map(); const rootByAgent = {}; const sessionsAgent = {};
  let THREAD_CI = 0;
  const manifest = opts.sessions.map(s => ({ id: s.id, agent: s.agent, folder: s.folder, sourcePath: s.sourcePath || s.folder + "/" + s.id + ".jsonl", text: s.text }));

  // seed agent-shorts from a prev doc (merge) so new agents never collide with baked suffixes
  const prevDoc = opts.merge || null;
  const seedShort = prevDoc ? Object.fromEntries((prevDoc.agents || []).map(a => [a.id, (a.short || "").toLowerCase()]).filter(x => x[1])) : {};
  const AGENT_SHORT = buildAgentShorts([...new Set(manifest.map(m => m.agent))], seedShort);
  const shortA = a => AGENT_SHORT[a] || (a.replace(/[^a-z0-9]/gi, "").slice(0, 2).toLowerCase() || "a");
  function fullId(base, agent) {
    let b = cleanBase(base);
    const shorts = Object.values(AGENT_SHORT).filter(Boolean);
    if (shorts.length) b = b.replace(new RegExp("_(" + shorts.join("|") + ")$"), "");
    else b = b.replace(new RegExp("_" + shortA(agent) + "$"), "");
    if (!b) b = "x"; return b + "_" + shortA(agent);
  }
  function ensureThread(base, name, agent, parentBase) {
    const id = fullId(base, agent); if (threads.has(id)) return threads.get(id);
    let parent = null;
    if (parentBase) { const pid = fullId(parentBase, agent); if (threads.has(pid) && pid !== id) parent = pid; }
    if (!parent && rootByAgent[agent] && rootByAgent[agent] !== id) parent = rootByAgent[agent];
    const b = id.replace(new RegExp("_" + shortA(agent) + "$"), "");
    const t = { id, base: b, name: name || b, color: PALETTE[THREAD_CI++ % PALETTE.length], agent, parent, glow: /visual|storyline|viz/.test(b) };
    threads.set(id, t); if (!rootByAgent[agent]) rootByAgent[agent] = id;
    return t;
  }
  function buildDigest(agent) {
    const mine = [...threads.values()].filter(t => t.agent === agent);
    const tl = mine.slice(0, 16).map(t => `${t.base}(${t.name})`).join(", ") || "(无 → 你将创建本 agent 第一条=根线程)";
    const recent = events.filter(e => e.agent === agent).slice(-8).map(e => `${e.ts.slice(5, 16)} ${e.agent}/${e.thread} ${e.type}:${e.title}`).join(" | ") || "(none)";
    return `当前 agent=${agent}. 已有线程[本 agent](id(名),优先复用并可作 parent): ${tl}. 最近事件: ${recent}.`;
  }

  const stats = { events:0, skips:0, merged:0, uncovered:0, calls:0, errs:0, tokIn:0, tokInReal:0, tokOutReal:0 };
  const cov = { sessions:{}, totals:{} };

  async function distillSession(meta) {
    const turns = turnsFromText(meta.text);
    sessionsAgent[meta.id] = meta.agent;
    const cs = (cov.sessions[meta.id] = { turns: turns.length, extracted:0, merged:0, skipped:0, ledger:[] });
    const coveredTexts = [];

    const applyResult = (turn, parsed) => {
      if (!parsed) { cs.ledger.push({ line:turn.line, ts:turn.ts, status:"GENUINE-UNCOVERED", snip:turn.text.slice(0,60) }); stats.uncovered++; return; }
      if (parsed.action === "merge") {
        const mid = fullId(parsed.thread, meta.agent);
        const tgt = events.filter(e => e.session === meta.id && e.thread === mid).sort((a, b) => T(b.ts) - T(a.ts))[0];
        if (tgt) { cs.ledger.push({ line:turn.line, ts:turn.ts, status:"merged", mergedInto:tgt.id, snip:turn.text.slice(0,60) }); cs.merged++; coveredTexts.push(turn.text); return; }
        parsed = { action:"event", type:"finding", thread:parsed.thread, threadName:parsed.thread, parentThread:null, title:turn.text.slice(0,6), summary:turn.text.slice(0,90), excerpt:turn.text.slice(0,140) };
      }
      const th = ensureThread(parsed.thread, parsed.threadName, meta.agent, parsed.parentThread);
      const id = `${meta.id}-${turn.line}`;
      const ev = { id, agent:meta.agent, session:meta.id, line:turn.line, ts:turn.ts, type:parsed.type, thread:th.id,
        title:parsed.title, summary:parsed.summary, excerpt:parsed.excerpt || turn.text.slice(0,140) };
      events.push(ev); cs.ledger.push({ line:turn.line, ts:turn.ts, status:"extracted", eventIds:[id], snip:turn.text.slice(0,60) });
      cs.extracted++; coveredTexts.push(turn.text); stats.events++;
    };

    // 1) prefilter → genuine
    const genuine = [];
    for (const turn of turns) {
      const reason = preFilter(turn.text, coveredTexts);
      if (reason) { cs.ledger.push({ line:turn.line, ts:turn.ts, status:"skipped", reason, snip:turn.text.slice(0,60) }); cs.skipped++; stats.skips++; continue; }
      genuine.push(turn);
    }
    if (!genuine.length) return;

    // regression mode: per-turn
    if (BLOCK_SIZE <= 1) {
      for (const t of genuine) applyResult(t, await callTurn(ctx, t, buildDigest(meta.agent), meta, stats));
      return;
    }
    // 2) blocks
    const blocks = []; for (let i = 0; i < genuine.length; i += BLOCK_SIZE) blocks.push(genuine.slice(i, i + BLOCK_SIZE));
    const applyBlock = (blk, map) => { for (const t of blk) applyResult(t, map.get(t.line) || null); };
    // 3) seed block (build skeleton)
    ctx.log(`  ↻ ${meta.id}: seed 块 ${blocks[0].length} 条 (L${blocks[0][0].line}–L${blocks[0][blocks[0].length-1].line})`);
    applyBlock(blocks[0], await callBlock(ctx, blocks[0], buildDigest(meta.agent), meta, stats));
    // 4) rest in waves of CONCURRENCY
    for (let i = 1; i < blocks.length; i += CONCURRENCY) {
      const wave = blocks.slice(i, i + CONCURRENCY);
      const digest = buildDigest(meta.agent);
      const last = wave[wave.length - 1];
      ctx.log(`  ↻ ${meta.id}: 波 ${wave.length} 块并发 (L${wave[0][0].line}–L${last[last.length-1].line}) · 已出 ${cs.extracted}`);
      const maps = await Promise.all(wave.map(blk => callBlock(ctx, blk, digest, meta, stats)));
      const applies = [];
      wave.forEach((blk, wi) => { for (const t of blk) applies.push([t, maps[wi].get(t.line) || null]); });
      applies.sort((a, b) => a[0].line - b[0].line);
      for (const [t, p] of applies) applyResult(t, p);
    }
  }

  // ---- run: group by agent → agent-groups run CONCURRENTLY (the semaphore bounds total in-flight);
  //    sessions WITHIN an agent stay sequential so that agent's thread-skeleton/digest stays coherent. ----
  const byAgent = {};
  for (const meta of manifest) (byAgent[meta.agent] || (byAgent[meta.agent] = [])).push(meta);
  log(`distill: ${manifest.length} session(s) · ${Object.keys(byAgent).length} agent(并行) · model=${MODEL} · reasoning off · 并发=${CONCURRENCY}`);
  await Promise.all(Object.values(byAgent).map(async group => {
    for (const meta of group) {
      await distillSession(meta);
      const c = cov.sessions[meta.id]; log(`  ${meta.id} [${meta.agent}] ${c.turns} turns → ${c.extracted} ev / ${c.merged} mer / ${c.skipped} skip`);
    }
  }));

  // handoff_to: link a handoff event to a DIFFERENT-agent session starting shortly after.
  const firstTs = {}, agentOf = {};
  manifest.forEach(m => { agentOf[m.id] = m.agent; const t = turnsFromText(m.text)[0]; if (t) firstTs[m.id] = T(t.ts); });
  events.filter(e => e.type === "handoff").forEach(e => {
    let best = null, bt = Infinity;
    for (const [sid, ts] of Object.entries(firstTs)) {
      if (agentOf[sid] === e.agent) continue;
      if (ts >= T(e.ts) - 600e3 && ts <= T(e.ts) + 6 * 3600e3 && ts < bt) { best = sid; bt = ts; }
    }
    if (best) e.handoff_to = best;
  });

  // agents + threadDefs
  const folderOf = Object.fromEntries(manifest.map(m => [m.agent, m.folder]));
  const agentRank = agentRankFromEvents(events, folderOf, aliases);
  const agentOrder = [...new Set(manifest.map(m => m.agent))].sort((a, b) => (agentRank[a] ?? 99) - (agentRank[b] ?? 99));
  const agents = agentOrder.map((id, i) => { const al = aliases[folderOf[id]] || {};
    return { id, name: al.name || titleize(id), short: (AGENT_SHORT[id] || "").toUpperCase(),
      hue: al.hue || PALETTE[i % PALETTE.length], role: al.role || "对话" }; });
  const used = new Set(events.map(e => e.thread));
  const threadDefs = orderThreads(consolidate(events, [...threads.values()].filter(t => used.has(t.id)), MAX_PER_AGENT), agentRank, events);

  // totals
  const tot = { turns:0, extracted:0, merged:0, skipped:0, genuineUncovered:stats.uncovered };
  Object.values(cov.sessions).forEach(s => { tot.turns += s.turns; tot.extracted += s.extracted; tot.merged += s.merged; tot.skipped += s.skipped; });
  cov.totals = tot;
  cov.note = "自动蒸馏:每条 turn 都留账;genuine 不得 skip(无效输出→GENUINE-UNCOVERED 让门禁报错)。";
  events.sort((a, b) => T(a.ts) - T(b.ts) || a.line - b.line);
  const sessions = manifest.map(m => ({ id:m.id, agent:m.agent, file:(m.sourcePath.split(/[\\/]/).pop()), label:m.agent }));
  const cleanManifest = manifest.map(m => ({ id:m.id, agent:m.agent, folder:m.folder, sourcePath:m.sourcePath }));
  const projTitle = (agents.length >= 2 && aliases._title) ? aliases._title : `${agents.map(a => a.name).join(" · ")} · 对话 Storyline`;
  let out = { meta:{ version:1, project:"conv-viz-storyline", generator:"distill-core.js", model:MODEL, title:projTitle },
    agents, manifest: cleanManifest, sessions, threadDefs, typeDefs: TYPE_DEFS, coverage: cov, events };

  // ---- merge into an existing doc (incremental import) ----
  if (prevDoc) {
    const prev = prevDoc;
    const newIds = new Set(manifest.map(m => m.id));
    const keepEv = (prev.events || []).filter(e => !newIds.has(e.session));
    out.events = keepEv.concat(events).sort((a, b) => T(a.ts) - T(b.ts) || a.line - b.line);
    out.manifest = [...(prev.manifest || []).filter(m => !newIds.has(m.id)), ...cleanManifest];
    out.sessions = [...(prev.sessions || []).filter(s => !newIds.has(s.id)), ...sessions];
    out.agents = [...new Map([...(prev.agents || []), ...agents].map(a => [a.id, a])).values()];
    const folderAll = Object.fromEntries((out.manifest || []).map(m => [m.agent, m.folder]));
    const rankAll = agentRankFromEvents(out.events, folderAll, aliases);
    out.agents.sort((a, b) => (rankAll[a.id] ?? 99) - (rankAll[b.id] ?? 99));
    out.meta.title = (out.agents.length >= 2 && aliases._title) ? aliases._title : `${out.agents.map(a => a.name).join(" · ")} · 对话 Storyline`;
    const usedAll = new Set(out.events.map(e => e.thread));
    out.threadDefs = orderThreads(consolidate(out.events, [...new Map([...(prev.threadDefs || []), ...threadDefs].map(t => [t.id, t])).values()].filter(t => usedAll.has(t.id)), MAX_PER_AGENT), rankAll, out.events);
    out.coverage = { note: cov.note, sessions: { ...(prev.coverage && prev.coverage.sessions), ...cov.sessions }, totals:{} };
    const tt = { turns:0, extracted:0, merged:0, skipped:0, genuineUncovered:0 };
    Object.values(out.coverage.sessions).forEach(s => { tt.turns += s.turns; tt.extracted += s.extracted; tt.merged += s.merged; tt.skipped += s.skipped;
      tt.genuineUncovered += (s.ledger || []).filter(e => e.status === "GENUINE-UNCOVERED").length; });
    out.coverage.totals = tt;
  }

  out._stats = stats;   // host may log LLM usage; not part of the persisted contract
  return out;
}

return { // public API
  T, clean, blockText, approxTokens, TYPE_DEFS, TYPES, PALETTE, titleize,
  turnFromLine, turnsFromText, preFilter, reqBody, ENDPOINT,
  validEvent, parseEvent, parseBlock,
  buildAgentShorts, agentRankFromEvents, orderThreads, consolidate,
  distillAll,
};
});
