/**
 * Custom tool: context_visualizer_read_session
 *
 * Reads an OpenCode session's tool-call history from the SQLite database
 * and returns structured JSON with session metadata and tool-call records.
 *
 * @module tool
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { openDb, getSession, getMixedTimeline } from "./db.js";
// ── Configurable DB path ──────────────────────────────────────────────────────
/**
 * Current database file path.
 *
 * In production this will be set via {@link getOpenCodeDbPath} (Todo 9).
 * For tests, use {@link setDbPath} to point at a temporary file.
 */
let currentDbPath = "";
/**
 * Override the DB path used by the tool. Intended for testing only.
 *
 * @param path Absolute path to an OpenCode SQLite database file.
 */
export function setDbPath(path) {
    currentDbPath = path;
}
// ── Tool definition ───────────────────────────────────────────────────────────
/**
 * Custom tool that reads a session's tool-call history from the OpenCode
 * SQLite database and returns structured JSON.
 *
 * The tool name when registered in the plugin MUST be
 * {@code context_visualizer_read_session}.
 */
export const readSessionTool = tool({
    description: "读取当前 OpenCode session 的完整推理与工具调用时间线（包含 AI 推理过程和工具操作），返回结构化 JSON 数据",
    args: {
        sessionId: z.string().describe("当前 session ID"),
    },
    async execute(args, _context) {
        try {
            const db = openDb(currentDbPath);
            try {
                const session = getSession(db, args.sessionId);
                const timeline = getMixedTimeline(db, args.sessionId);
                const totalTools = timeline.filter((t) => t.type === "tool").length;
                const totalReasonings = timeline.filter((t) => t.type === "reasoning").length;
                const data = { session, timeline, totalTools, totalReasonings };
                return JSON.stringify(data);
            }
            finally {
                db.close();
            }
        }
        catch (err) {
            return JSON.stringify({
                error: `Failed to read session: ${err instanceof Error ? err.message : String(err)}`,
                session: null,
                timeline: [],
                totalTools: 0,
                totalReasonings: 0,
            });
        }
    },
});
