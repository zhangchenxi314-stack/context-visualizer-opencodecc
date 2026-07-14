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
            "[tool:" + (part.name || "?") + " " +
            JSON.stringify(part.input || {}).slice(0, 200) + "]"
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

// ---------- exports ----------

module.exports = {
  normalizeOpenCode,
  userTurnsFromOpenCode,
  normalizeClaudeLine,
  turnsFromClaudeText,
  userTurnsFromClaude,
  firstUserText,
  clean,
};
