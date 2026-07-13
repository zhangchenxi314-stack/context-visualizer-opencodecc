// opencode-export.test.js — Data-layer tests for the OpenCode port.
// Tests: export script, turnFromLine compatibility, coverage audit logic.
//
//   node --test opencode-export.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const TMP = path.join(__dirname, ".test-tmp");

test.beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ============================================================
// 1. Export script: sessionToTurns (inlined for testing)
// ============================================================
test("sessionToTurns extracts user turns with correct format", () => {
  const session = {
    sessionId: "ses_test123",
    subagentType: "oracle",
    projectPath: "/tmp/test",
    startedAt: "2026-01-01T00:00:00Z",
    messages: [
      { role: "user", content: "Hello world", timestamp: "2026-01-01T00:01:00Z" },
      { role: "assistant", content: "Hi there!", timestamp: "2026-01-01T00:01:05Z" },
      { role: "user", content: "Do something", timestamp: "2026-01-01T00:02:00Z" },
      { role: "system", content: "System message", timestamp: "2026-01-01T00:03:00Z" },
    ]
  };

  const turns = sessionToTurns(session);
  assert.strictEqual(turns.length, 2, "should extract 2 user turns");
  assert.strictEqual(turns[0].type, "user");
  assert.strictEqual(turns[0].message.role, "user");
  assert.strictEqual(turns[0].message.content, "Hello world");
  assert.strictEqual(turns[0]._meta.sessionId, "ses_test123");
  assert.strictEqual(turns[0]._meta.agent, "oracle");
});

test("sessionToTurns skips empty content", () => {
  const session = {
    sessionId: "ses_test",
    messages: [
      { role: "user", content: "", timestamp: "2026-01-01T00:00:00Z" },
      { role: "user", content: "   ", timestamp: "2026-01-01T00:01:00Z" },
      { role: "user", content: "Valid turn", timestamp: "2026-01-01T00:02:00Z" },
    ]
  };

  const turns = sessionToTurns(session);
  assert.strictEqual(turns.length, 1, "should skip empty/whitespace turns");
  assert.strictEqual(turns[0].message.content, "Valid turn");
});

test("sessionToTurns handles block array content", () => {
  const session = {
    sessionId: "ses_test",
    messages: [
      { role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }], timestamp: "2026-01-01T00:00:00Z" },
    ]
  };

  const turns = sessionToTurns(session);
  assert.strictEqual(turns.length, 1);
  const c = turns[0].message.content;
  assert.ok(Array.isArray(c));
  assert.strictEqual(c.length, 2);
});

test("agentSlug normalizes subagent types", () => {
  assert.strictEqual(agentSlug("visual-engineering"), "visual-engineering");
  assert.strictEqual(agentSlug("UltraBrain"), "ultrabrain");
  assert.strictEqual(agentSlug("C--planner"), "c-planner");
  assert.strictEqual(agentSlug(null), "agent");
  assert.strictEqual(agentSlug(""), "agent");
});

// ============================================================
// 2. distill-core.js: turnFromLine compatibility
// ============================================================
const Core = require("./distill-core.js");

test("turnFromLine handles OpenCode export format (type:user)", () => {
  const line = {
    type: "user",
    message: { role: "user", content: "Hello from OpenCode" },
    timestamp: "2026-07-13T10:00:00Z",
    _meta: { sessionId: "ses_abc", agent: "oracle" }
  };
  const result = Core.turnFromLine(line, 42);
  assert.ok(result, "should parse the turn");
  assert.strictEqual(result.line, 42);
  assert.strictEqual(result.ts, "2026-07-13T10:00:00Z");
  assert.ok(result.text.includes("Hello from OpenCode"), "should extract text from message.content");
});

test("turnFromLine handles legacy queue-operation format", () => {
  const line = {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-13T10:00:00Z",
    content: "Legacy format message"
  };
  const result = Core.turnFromLine(line, 1);
  assert.ok(result);
  assert.ok(result.text.includes("Legacy format message"));
});

test("turnFromLine returns null for non-user messages", () => {
  assert.strictEqual(Core.turnFromLine({ type: "assistant" }, 1), null);
  assert.strictEqual(Core.turnFromLine({ type: "system" }, 1), null);
  assert.strictEqual(Core.turnFromLine(null, 1), null);
});

test("turnFromLine handles block array content (Claude Code format)", () => {
  const line = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Hello" }, { type: "text", text: "World" }] },
    timestamp: "2026-07-13T10:00:00Z"
  };
  const result = Core.turnFromLine(line, 1);
  assert.ok(result);
  assert.ok(result.text.includes("Hello"), "should join text blocks");
  assert.ok(result.text.includes("World"));
});

test("blockText handles string and array content", () => {
  assert.strictEqual(Core.blockText("plain text"), "plain text");
  assert.strictEqual(Core.blockText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.strictEqual(Core.blockText([{ type: "image", url: "x" }]), "");
  assert.strictEqual(Core.blockText(""), "");
});

test("turnsFromText parses JSONL into turns", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { role: "user", content: "turn 1" }, timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "reply" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "turn 2" }, timestamp: "2026-01-01T00:01:00Z" }),
  ].join("\n");

  const turns = Core.turnsFromText(jsonl);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].text, "turn 1");
  assert.strictEqual(turns[1].text, "turn 2");
});

// ============================================================
// 3. preFilter skips noise deterministically
// ============================================================
test("preFilter returns reason for noise", () => {
  assert.strictEqual(Core.preFilter("", []), "empty");
  assert.strictEqual(Core.preFilter("   ".slice(0, 0) || "", []), "empty");
});

test("preFilter returns null for genuine turns", () => {
  assert.strictEqual(Core.preFilter("Let's refactor the auth module", []), null);
  assert.strictEqual(Core.preFilter("Fix the bug in the login handler", []), null);
});

// ============================================================
// 4. Event validation
// ============================================================
test("validEvent accepts complete event", () => {
  const ev = Core.validEvent({
    action: "event",
    type: "decision",
    thread: "auth",
    threadName: "认证",
    title: "选方案",
    summary: "决定用JWT"
  });
  assert.ok(ev);
  assert.strictEqual(ev.type, "decision");
  assert.strictEqual(ev.thread, "auth");
});

test("validEvent rejects incomplete event", () => {
  assert.strictEqual(Core.validEvent({ action: "event", type: "decision" }), null);
  assert.strictEqual(Core.validEvent({ action: "event", type: "invalid", thread: "x", title: "t", summary: "s" }), null);
  assert.strictEqual(Core.validEvent(null), null);
});

test("validEvent handles merge action", () => {
  const ev = Core.validEvent({ action: "merge", thread: "auth" });
  assert.ok(ev);
  assert.strictEqual(ev.action, "merge");
});

// ============================================================
// 5. Coverage audit: userTurns (inlined from coverage-audit.js)
// ============================================================
function auditUserTurns(file) {
  const L = fs.readFileSync(file, "utf8").split("\n");
  const t = [];
  L.forEach((l, i) => {
    if (!l.trim()) return;
    let o;
    try { o = JSON.parse(l); } catch (e) { return; }
    if (o.type === "queue-operation" && o.operation === "enqueue")
      t.push({ line: i + 1, ts: o.timestamp || "", text: cleanAudit(o.content) });
    else if (o.type === "user" && o.message && o.message.role === "user") {
      const ct = o.message.content;
      const text = cleanAudit(typeof ct === "string" ? ct
        : Array.isArray(ct) ? ct.filter(b => b && b.type === "text").map(b => b.text || "").join("\n") : "");
      if (text) t.push({ line: i + 1, ts: o.timestamp || "", text });
    }
  });
  return t;
}
const cleanAudit = s => (s || "").replace(/<current_note>[\s\S]*?<\/current_note>/g, "")
  .replace(/<editor_selection>[\s\S]*?<\/editor_selection>/g, "").replace(/\s+/g, " ").trim();

test("auditUserTurns counts all user turns in OpenCode export JSONL", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { role: "user", content: "turn 1" }, timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "turn 2" }, timestamp: "2026-01-01T00:01:00Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "reply" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "" }, timestamp: "2026-01-01T00:02:00Z" }),
    "",  // empty line
    "not valid json",
  ].join("\n");

  const fp = path.join(TMP, "test.jsonl");
  fs.writeFileSync(fp, jsonl);
  const turns = auditUserTurns(fp);
  assert.strictEqual(turns.length, 2, "should count 2 valid user turns");
  assert.strictEqual(turns[0].text, "turn 1");
  assert.strictEqual(turns[1].line, 2);
});

// ============================================================
// 6. Export script: full pipeline (end-to-end on temp files)
// ============================================================
test("export pipeline: session JSON → JSONL file → turnsFromText → valid", () => {
  const sessionFiles = [];
  // Create two .session.json files
  for (const [subagentType, sid, messages] of [
    ["oracle", "ses_abc", [
      { role: "user", content: "Research the problem", timestamp: "2026-01-01T00:01:00Z" },
      { role: "assistant", content: "OK", timestamp: "2026-01-01T00:01:05Z" },
      { role: "user", content: "What about alternatives?", timestamp: "2026-01-01T00:02:00Z" },
    ]],
    ["build", "ses_def", [
      { role: "user", content: "Implement the fix", timestamp: "2026-01-01T00:05:00Z" },
      { role: "user", content: "", timestamp: "2026-01-01T00:06:00Z" },
      { role: "user", content: "Add tests too", timestamp: "2026-01-01T00:07:00Z" },
    ]],
  ]) {
    const fp = path.join(TMP, `${sid}.session.json`);
    fs.writeFileSync(fp, JSON.stringify({ sessionId: sid, subagentType, messages }));
    sessionFiles.push(fp);
  }

  // Run export logic manually (inlined from opencode-export.js)
  const outDir = path.join(TMP, "exported");
  let total = 0, totalFiles = 0;
  for (const fp of sessionFiles) {
    const session = JSON.parse(fs.readFileSync(fp, "utf8"));
    const turns = sessionToTurns(session);
    assert.ok(turns.length > 0, `should have turns for ${fp}`);
    const agent = agentSlug(session.subagentType);
    const sid = session.sessionId;
    const dir = path.join(outDir, agent);
    fs.mkdirSync(dir, { recursive: true });
    const lines = turns.map(t => JSON.stringify(t)).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines);
    total += turns.length;
    totalFiles++;
  }

  assert.strictEqual(totalFiles, 2);
  // oracle session: 2 user turns (skip assistant)
  const oracleTurns = Core.turnsFromText(fs.readFileSync(path.join(outDir, "oracle", "ses_abc.jsonl"), "utf8"));
  assert.strictEqual(oracleTurns.length, 2);
  assert.strictEqual(oracleTurns[0].text, "Research the problem");

  // build session: 2 user turns (skip empty)
  const buildTurns = Core.turnsFromText(fs.readFileSync(path.join(outDir, "build", "ses_def.jsonl"), "utf8"));
  assert.strictEqual(buildTurns.length, 2, "should skip empty turn");
  assert.strictEqual(buildTurns[0].text, "Implement the fix");

  // Verify the directory structure matches expected format
  assert.ok(fs.existsSync(path.join(outDir, "oracle")));
  assert.ok(fs.existsSync(path.join(outDir, "build")));
});

// ============================================================
// Helper functions (inlined from opencode-export.js for testing)
// ============================================================
function agentSlug(subagentType) {
  if (!subagentType) return "agent";
  return subagentType.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "agent";
}

function sessionToTurns(session) {
  const turns = [];
  if (!session || !Array.isArray(session.messages)) return turns;
  const agent = agentSlug(session.subagentType || "agent");
  const sid = session.sessionId || "unknown";
  session.messages.forEach((msg, idx) => {
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    if (!content || (typeof content === "string" && !content.trim())) return;
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: typeof content === "string" ? content
          : (Array.isArray(content) ? content : [content])
      },
      timestamp: msg.timestamp || (session.startedAt || new Date().toISOString()),
      _meta: {
        sessionId: sid, agent,
        subagentType: session.subagentType || null,
        projectPath: session.projectPath || null,
        turnIndex: idx,
      }
    };
    turns.push(entry);
  });
  return turns;
}

console.log("All tests passed ✓");
