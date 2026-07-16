/**
 * SQLite data access layer for reading OpenCode session data.
 *
 * Uses Bun's built-in {@link https://bun.sh/docs/api/sqlite | bun:sqlite} for
 * zero-dependency SQLite access.
 *
 * @module db
 */
import { Database } from "bun:sqlite";
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Open an OpenCode SQLite database in **readonly** mode.
 *
 * @param dbPath Absolute path to the `.sqlite` file.
 * @returns A `bun:sqlite` Database handle opened with `{ readonly: true }`.
 */
export function openDb(dbPath) {
    return new Database(dbPath, { readonly: true });
}
/**
 * Query session metadata by ID.
 *
 * @param db        An open `bun:sqlite` Database handle.
 * @param sessionId The session UUID.
 * @returns A populated {@link SessionInfo} object, or `null` if no row matches.
 */
export function getSession(db, sessionId) {
    const row = db
        .query(`SELECT id, agent, model, title,
              tokens_input, tokens_output, cost, time_created
       FROM session
       WHERE id = ?`)
        .get(sessionId);
    if (row === null) {
        return null;
    }
    return {
        id: row.id,
        agent: row.agent ?? "",
        model: row.model ?? "",
        title: row.title ?? "",
        tokensInput: row.tokens_input ?? 0,
        tokensOutput: row.tokens_output ?? 0,
        cost: row.cost ?? 0,
        timeCreated: row.time_created ?? 0,
        duration: 0,
    };
}
/**
 * Query all tool-call parts for a session, ordered by creation time.
 *
 * Joins the `part` table (filtered to `type = 'tool'` via `json_extract`)
 * and returns a fully-hydrated array of {@link ToolCallRecord} objects with
 * sequential numbering and computed duration.
 *
 * **Note:** ALL tool parts are returned regardless of `state.status`
 * (including `"error"`, `"running"`, and `"pending"`).
 *
 * @param db        An open `bun:sqlite` Database handle.
 * @param sessionId The session UUID.
 * @returns Array of tool-call records, or an empty array if none found.
 */
export function getToolCalls(db, sessionId) {
    const rows = db
        .query(`SELECT p.id, p.message_id, p.session_id, p.time_created, p.data
       FROM part p
       WHERE p.session_id = ?
         AND json_extract(p.data, '$.type') = 'tool'
       ORDER BY p.time_created ASC`)
        .all(sessionId);
    return rows.map((row, idx) => {
        const parsed = JSON.parse(row.data);
        const state = parsed.state;
        const timeStart = state.time.start;
        const timeEnd = state.time.end;
        return {
            seq: idx + 1,
            tool: parsed.tool,
            callID: parsed.callID,
            status: state.status,
            input: state.input,
            output: state.output,
            title: state.title,
            timeStart,
            timeEnd,
            duration: (timeEnd - timeStart) / 1000,
        };
    });
}
/**
 * Query all reasoning parts for a session, ordered by creation time.
 *
 * Filters the `part` table to `type = 'reasoning'` via `json_extract`
 * and returns an array of {@link ReasoningRecord} objects with truncated
 * preview text (first 500 chars) and the full text.
 *
 * @param db        An open `bun:sqlite` Database handle.
 * @param sessionId The session UUID.
 * @returns Array of reasoning records, or an empty array if none found.
 */
export function getReasoningParts(db, sessionId) {
    const rows = db
        .query(`SELECT p.id, p.message_id, p.session_id, p.time_created, p.data
       FROM part p
       WHERE p.session_id = ?
         AND json_extract(p.data, '$.type') = 'reasoning'
       ORDER BY p.time_created ASC`)
        .all(sessionId);
    return rows.map((row, idx) => {
        const parsed = JSON.parse(row.data);
        const text = parsed.text ?? "";
        const time = parsed.time;
        return {
            seq: idx + 1,
            text: text.slice(0, 500),
            fullText: text,
            timeStart: time?.start ?? 0,
            timeEnd: time?.end ?? 0,
            messageId: row.message_id,
        };
    });
}
/**
 * Build a mixed timeline of reasoning and tool-call parts, interleaved
 * by `time_created` ascending.
 *
 * Calls {@link getReasoningParts} and {@link getToolCalls}, converts
 * each to a {@link MixedTimelineItem}, then merges, sorts by `timeCreated`,
 * and re-assigns sequential numbering.
 *
 * @param db        An open `bun:sqlite` Database handle.
 * @param sessionId The session UUID.
 * @returns Array of mixed timeline items sorted chronologically.
 */
export function getMixedTimeline(db, sessionId) {
    const reasoningParts = getReasoningParts(db, sessionId);
    const toolCalls = getToolCalls(db, sessionId);
    const reasoningItems = reasoningParts.map((r) => ({
        seq: 0,
        type: "reasoning",
        timeCreated: r.timeStart,
        text: r.text,
        fullText: r.fullText,
        timeStart: r.timeStart,
        timeEnd: r.timeEnd,
        messageId: r.messageId,
    }));
    const toolItems = toolCalls.map((t) => ({
        seq: 0,
        type: "tool",
        timeCreated: t.timeStart,
        tool: t.tool,
        callID: t.callID,
        status: t.status,
        input: t.input,
        output: t.output,
        title: t.title,
        timeStart: t.timeStart,
        timeEnd: t.timeEnd,
        duration: t.duration,
    }));
    const combined = [...reasoningItems, ...toolItems].sort((a, b) => a.timeCreated - b.timeCreated);
    return combined.map((item, idx) => ({
        ...item,
        seq: idx + 1,
    }));
}
