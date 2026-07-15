// normalizer.js — OpenCode session normalization layer.
//
// OpenCode stores messages as multi-part structures (text, reasoning, step-start,
// step-finish, tool, tool_result). distill-core.js expects flat "turns" with a
// single text field. This module reconstructs coherent user/assistant turns from
// OpenCode's export format (as produced by `opencode export <session-id>`).
//
// Also handles the older Claude Code .jsonl format (one JSON object per line) so
// scanner results from both platforms feed into the same pipeline.
//
// API:
//   normalizeOpenCode(exportJson) → [{line, ts, role, text, tokens?}]
//   normalizeClaudeLine(jsonObj, lineNo) → {line, ts, role, text} | null

"use strict";

// ---------- helpers ----------

const clean = s => (s || "")
  .replace(/<current_note>[\s\S]*?<\/current_note>/g, "")
  .replace(/<editor_selection>[\s\S]*?<\/editor_selection>/g, "")
  .replace(/\s+/g, " ")
  .trim();

// ---------- OpenCode normalization ----------

/**
 * Normalize an OpenCode session export into flat turns.
 *
 * The export format (from `opencode export <session-id>`) looks like:
 * {
 *   info: { id, title, agent, model, directory, time: {created, updated}, tokens, cost },
 *   messages: [
 *     {
 *       info: { role, time: {created}, id, sessionID, agent, model, tokens, cost },
 *       parts: [
 *         { type: "text",       text: "..." },
 *         { type: "reasoning",  text: "..." },
 *         { type: "step-start" },
 *         { type: "step-finish", tokens, cost },
 *         { type: "tool", ... }
 *       ]
 *     }
 *   ]
 * }
 *
 * We reconstruct each message into a single turn:
 *   - user messages:   concatenate text parts → the user turn
 *   - assistant messages: concatenate text parts (skip reasoning/step/tool for LLM input)
 *   - reasoning/thinking: optionally included as metadata
 */
function normalizeOpenCode(exportJson) {
  const session = exportJson.info || exportJson;
  const messages = exportJson.messages || [];
  const turns = [];
  let lineNo = 0;

  for (const msg of messages) {
    const info = msg.info || {};
    const parts = msg.parts || [];
    if (!info.role) continue;

    lineNo++;

    // Collect text from parts
    const textParts = [];
    let reasoningText = "";
    let toolSummary = [];
    let stepTokens = null;

    for (const part of parts) {
      switch (part.type) {
        case "text":
          textParts.push(part.text || "");
          break;
        case "reasoning":
          reasoningText += (part.text || "") + "\n";
          break;
        case "tool":
          toolSummary.push(
            "[tool:" + (part.tool || part.name || "?") + " " +
            JSON.stringify((part.state && part.state.input) || part.input || {}).slice(0, 200) + "]"
          );
          break;
        case "step-finish":
          if (part.tokens) stepTokens = part.tokens;
          break;
        // step-start, tool_result, etc. — skip for turn text
      }
    }

    const text = clean(textParts.join("\n"));

    const turn = {
      line: lineNo,
      ts: info.time ? (info.time.created || info.time.completed || 0) : 0,
      role: info.role,
      text: text,
      // optional metadata for richer distillation
      agent: info.agent || session.agent || "",
      model: info.modelID || (session.model && session.model.id) || "",
      tokens: info.tokens || stepTokens || null,
      cost: info.cost || 0,
      reasoning: clean(reasoningText) || undefined,
      tools: toolSummary.length ? toolSummary : undefined,
      sessionId: info.sessionID || session.id || "",
      messageId: info.id || "",
    };

    turns.push(turn);
  }

  return turns;
}

/**
 * Extract user turns as Claude Code-compatible .jsonl lines.
 * distill-core.js turnFromLine() expects either:
 *   {type:"queue-operation", operation:"enqueue", timestamp:"...", content:"..."}
 *   {type:"user", message:{role:"user", content:"..."}, timestamp:"..."}
 */
function userTurnsFromOpenCode(exportJson) {
  const turns = normalizeOpenCode(exportJson);
  return turns
    .filter(t => t.role === "user")
    .map(t => ({
      type: "user",
      message: { role: "user", content: t.text },
      timestamp: typeof t.ts === "number" ? new Date(t.ts).toISOString() : t.ts,
      _line: t.line,
      _text: t.text,
    }));
}

// ---------- Claude Code normalization ----------

/**
 * Parse one line of a Claude Code .jsonl transcript into a turn.
 * Returns null for non-turn lines (system, assistant, empty content).
 */
function normalizeClaudeLine(obj, lineNo) {
  if (!obj) return null;

  // Legacy queue format
  if (obj.type === "queue-operation" && obj.operation === "enqueue") {
    const text = clean(obj.content);
    if (!text) return null;
    return {
      line: lineNo,
      ts: obj.timestamp || "",
      role: "user",
      text,
    };
  }

  // Standard Claude Code format
  if (obj.type === "user" && obj.message && obj.message.role === "user") {
    const text = clean(blockText(obj.message.content));
    if (!text) return null;
    return {
      line: lineNo,
      ts: obj.timestamp || "",
      role: "user",
      text,
    };
  }

  // Assistant messages with text content
  if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
    const parts = obj.message.content
      .filter(b => b.type === "text")
      .map(b => b.text || "")
      .join("\n");
    const text = clean(parts);
    if (!text) return null;
    return {
      line: lineNo,
      ts: obj.timestamp || "",
      role: "assistant",
      text,
    };
  }

  return null;
}

/**
 * Parse full Claude Code .jsonl file content into turns.
 */
function turnsFromClaudeText(text) {
  const lines = String(text).split("\n");
  const turns = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let obj;
    try { obj = JSON.parse(l); } catch (e) { return; }
    const turn = normalizeClaudeLine(obj, i + 1);
    if (turn) turns.push(turn);
  });
  return turns;
}

/**
 * Extract user turns only (for distill-core.js compatibility).
 */
function userTurnsFromClaude(text) {
  return turnsFromClaudeText(text)
    .filter(t => t.role === "user")
    .map(t => ({ line: t.line, ts: t.ts, text: t.text }));
}

/**
 * Extract first meaningful user message for preview purposes.
 */
function firstUserText(text, maxLen) {
  maxLen = maxLen || 120;
  const turns = turnsFromClaudeText(text);
  const user = turns.find(t => t.role === "user");
  if (!user) return "(无用户消息)";
  return user.text.length > maxLen ? user.text.slice(0, maxLen) + "…" : user.text;
}

// ---------- helpers ----------

function blockText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(b => b && b.type === "text")
      .map(b => b.text || "")
      .join("\n");
  }
  return "";
}

// ---------- Tool call extraction ----------

/**
 * Build a structured one-line result summary from tool output.
 * Extracts key metrics: match count, file count, char count, exit status, etc.
 */
function buildToolResult(name, input, output, status) {
  if (!output || status === "running") return "";

  const out = String(output);

  switch (name) {
    case "grep":
    case "search": {
      const lines = out.split("\n").filter(l => l.includes(":") && !l.startsWith("["));
      const files = [...new Set(lines.map(l => l.split(":")[0]).filter(Boolean))];
      if (lines.length === 0) return "0 匹配";
      const fileList = files.slice(0, 3).map(f => f.split("/").pop()).join(", ");
      return `匹配 ${lines.length} 行 · ${files.length} 个文件 (${fileList}${files.length > 3 ? "…" : ""})`;
    }
    case "glob": {
      const items = out.split("\n").filter(l => l.trim() && !l.startsWith("["));
      if (items.length === 0) return "0 文件";
      const samples = items.slice(0, 3).map(f => f.split("/").pop()).join(", ");
      return `找到 ${items.length} 个文件 (${samples}${items.length > 3 ? "…" : ""})`;
    }
    case "read": {
      const len = out.length;
      const firstLine = out.split("\n")[0] || "";
      if (len < 100) return `内容: ${firstLine.slice(0, 60)}`;
      return `读取 ${len} 字符 · ${firstLine.slice(0, 50)}…`;
    }
    case "bash":
    case "execute_command": {
      const lines = out.trim().split("\n");
      const lastLine = lines[lines.length - 1] || "";
      const trimmed = out.trim();
      const len = trimmed.length;
      if (len === 0) return "无输出";
      const meaningful = lines.filter(l => l.trim() && !l.startsWith("[") && !l.includes("exit code"));
      const result = meaningful.length > 0 ? meaningful[meaningful.length - 1].slice(0, 80) : lastLine.slice(0, 80);
      return `输出 ${len} 字符 · ${result}`;
    }
    case "edit":
    case "write": {
      if (status === "completed") return "已写入";
      const oldStr = input.oldString || "";
      const newStr = input.newString || "";
      if (oldStr && newStr) return `替换 ${oldStr.length}→${newStr.length} 字符`;
      return `写入 ${(input.content || "").length} 字符`;
    }
    case "web_fetch":
    case "web_search": {
      const len = out.length;
      if (len === 0) return "无结果";
      const firstLine = out.split("\n")[0] || "";
      return `获取 ${len} 字符 · ${firstLine.slice(0, 50)}`;
    }
    default: {
      const len = out.length;
      if (len === 0) return "";
      return `输出 ${len} 字符`;
    }
  }
}

/**
 * Extract tool call events from OpenCode session export.
 * These are created from assistant messages with tool parts, providing
 * visibility into agent actions (file edits, commands, etc.).
 *
 * Returns an array of event-like objects compatible with events.json:
 *   { id, agent, session, line, ts, type, thread, title, summary, excerpt }
 * with type "artifact" for file edits and "finding" for other tools.
 */
function extractToolCalls(exportJson, sessionId) {
  const session = exportJson.info || exportJson;
  const messages = exportJson.messages || [];
  const agent = session.agent || "agent";
  const events = [];
  const threadColorMap = {};

  const toolEventTypes = {
    "edit": "artifact",
    "write": "artifact",
    "create": "artifact",
    "rename": "artifact",
    "delete": "artifact",
    "bash": "finding",
    "command": "finding",
    "execute_command": "finding",
    "read": "finding",
    "glob": "finding",
    "grep": "finding",
    "search": "finding",
    "fetch": "finding",
    "web_fetch": "finding",
    "web_search": "finding",
    "ask": "question",
    "question": "question",
    "tool": "finding",
  };

  let toolCount = 0;

  for (const msg of messages) {
    const info = msg.info || {};
    const parts = msg.parts || [];
    if (info.role !== "assistant") continue;

    for (const part of parts) {
      if (part.type !== "tool") continue;
      const name = part.tool || part.name || "tool";
      const input = (part.state && part.state.input) || part.input || {};
      const output = (part.state && part.state.output) || "";
      const status = (part.state && part.state.status) || "unknown";

      toolCount++;
      const eventId = `${sessionId || "s"}-tool-${toolCount}`;
      const eventType = toolEventTypes[name] || "finding";
      const thread = "tools";
      const toolIdx = toolCount;

      // Build descriptive title showing the target (file, command, pattern)
      let title = "";
      if (name === "read") {
        const fp = (input.filePath || input.file || "").split("/").pop() || "";
        title = "read " + (fp || input.filePath || "").slice(0, 35);
      } else if (name === "edit" || name === "write") {
        const fp = (input.filePath || input.file || "").split("/").pop() || "";
        title = name + " " + fp.slice(0, 34);
      } else if (name === "bash" || name === "execute_command") {
        const cmd = (input.command || input.cmd || "");
        title = "$ " + cmd.slice(0, 37);
      } else if (name === "grep" || name === "glob") {
        title = name + " " + (input.pattern || input.query || "").slice(0, 34);
      } else if (input.filePath || input.file) {
        const fp = (input.filePath || input.file || "").split("/").pop();
        title = name + " " + fp.slice(0, 34);
      } else if (input.query || input.pattern) {
        title = name + " " + (input.query || input.pattern || "").slice(0, 34);
      } else {
        title = name;
      }
      title = title.slice(0, 40);

      // Build structured result summary from tool output
      const resultSummary = buildToolResult(name, input, output, status);

      // Summary: tool action + key result
      let summary = name;
      if (input.filePath || input.file) {
        summary = name + " " + (input.filePath || input.file);
      } else if (input.command || input.cmd) {
        summary = "$ " + (input.command || input.cmd || "").slice(0, 80);
      } else if (input.pattern) {
        summary = name + " " + input.pattern;
      } else if (input.query) {
        summary = name + " " + input.query;
      } else {
        summary = name + " " + JSON.stringify(input).slice(0, 80);
      }

      // Excerpt: summary + result (shown on hover AND click detail)
      let excerpt = summary;
      if (resultSummary) excerpt = summary + " · " + resultSummary;
      excerpt = excerpt.slice(0, 300);
      summary = summary.slice(0, 120);

      const ts = info.time ? (info.time.created || info.time.completed || 0) : 0;

      events.push({
        id: eventId,
        agent: info.agent || agent,
        session: sessionId || "",
        line: toolIdx,
        ts: typeof ts === "number" ? ts : Date.parse(ts) || 0,
        type: eventType,
        thread: thread,
        title: title.slice(0, 40),
        summary: summary.slice(0, 90),
        excerpt: excerpt,
      });
    }
  }

  return events;
}

/**
 * Merge tool call events into a distill output doc.
 * Adds events, threadDefs, and sorts everything properly.
 */
function mergeToolEvents(doc, toolEvents) {
  if (!toolEvents || toolEvents.length === 0) return doc;

  // Create a thread for tool calls if not exists
  const hasToolsThread = doc.threadDefs.some(t => t.id === "tools");
  if (!hasToolsThread && toolEvents.length > 0) {
    doc.threadDefs.push({
      id: "tools",
      name: "工具调用",
      color: "#6b99c0",
      agent: doc.agents && doc.agents[0] ? doc.agents[0].id : "agent",
      parent: null,
      base: "tools",
    });
  }

  // Add events
  doc.events.push(...toolEvents);
  doc.events.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  return doc;
}

/**
 * Extract AI reasoning/thinking from assistant messages.
 * Creates events on a "reasoning" thread so they appear as a separate swimlane.
 * Throttled: one event per assistant message (first reasoning block only).
 */
function extractReasoning(exportJson, sessionId) {
  const messages = exportJson.messages || [];
  const agent = (exportJson.info || {}).agent || "agent";
  const events = [];
  let reasonCount = 0;

  for (const msg of messages) {
    const info = msg.info || {};
    const parts = msg.parts || [];
    if (info.role !== "assistant") continue;

    const reasoningParts = parts.filter(p => p.type === "reasoning" && p.text);
    if (reasoningParts.length === 0) continue;

    const part = reasoningParts[0];
    const text = (part.text || "").trim();
    if (!text) continue;

    reasonCount++;

    const firstSentence = text.replace(/^[^。.!！?\n]{0,80}[。.!！?\n]?/, "").length > 0
      ? text.match(/^([^。.!！?\n]{0,80})/)?.[1] || text.slice(0, 80)
      : text.slice(0, 80);

    const title = text.replace(/^(The user is |用户|Let me |I need to |我需要|首先|根据)/, "")
      .slice(0, 24)
      .trim() || "AI思考";

    const ts = info.time ? (info.time.created || info.time.completed || 0) : 0;

    events.push({
      id: `${sessionId || "s"}-reason-${reasonCount}`,
      agent: info.agent || agent,
      session: sessionId || "",
      line: reasonCount,
      ts: typeof ts === "number" ? ts : Date.parse(ts) || 0,
      type: "finding",
      thread: "reasoning",
      title: title.slice(0, 24),
      summary: firstSentence.slice(0, 90),
      excerpt: text.slice(0, 300),
    });
  }

  return events;
}

/**
 * Merge reasoning events into the distill doc.
 */
function mergeReasoningEvents(doc, reasoningEvents) {
  if (!reasoningEvents || reasoningEvents.length === 0) return doc;

  const hasReasoningThread = doc.threadDefs.some(t => t.id === "reasoning");
  if (!hasReasoningThread && reasoningEvents.length > 0) {
    doc.threadDefs.push({
      id: "reasoning",
      name: "AI 推理",
      color: "#e0a3c0",
      agent: doc.agents && doc.agents[0] ? doc.agents[0].id : "agent",
      parent: null,
      base: "reasoning",
    });
  }

  doc.events.push(...reasoningEvents);
  doc.events.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  return doc;
}

module.exports = {
  normalizeOpenCode,
  userTurnsFromOpenCode,
  normalizeClaudeLine,
  turnsFromClaudeText,
  userTurnsFromClaude,
  firstUserText,
  clean,
  extractToolCalls,
  mergeToolEvents,
  extractReasoning,
  mergeReasoningEvents,
};
