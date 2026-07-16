/**
 * Cross-platform utility functions for the context-visualizer plugin.
 *
 * @module utils
 */
import { homedir, tmpdir, platform } from "node:os";
import { join } from "node:path";
/**
 * Returns the path to the OpenCode SQLite database for the current platform.
 *
 * - macOS / Linux: `~/.local/share/opencode/opencode.db`
 * - Windows: `%APPDATA%\opencode\opencode.db`
 */
export function getOpenCodeDbPath() {
    if (platform() === "win32") {
        const appData = process.env.APPDATA ?? "";
        return join(appData, "opencode", "opencode.db");
    }
    return join(homedir(), ".local", "share", "opencode", "opencode.db");
}
/**
 * Returns the system's temporary directory path.
 */
export function getTempDir() {
    return tmpdir();
}
/**
 * Returns a temporary file path for a session HTML export.
 *
 * @param sessionId - The session ID to include in the filename.
 */
export function getTempFilePath(sessionId) {
    return join(getTempDir(), `opencode-session-${sessionId}.html`);
}
/**
 * Returns the command used to open a file/URL in the default browser.
 *
 * - macOS: `"open"`
 * - Linux: `"xdg-open"`
 * - Windows: `"start"`
 */
export function getBrowserOpenCommand() {
    switch (platform()) {
        case "darwin":
            return "open";
        case "win32":
            return "start";
        default:
            return "xdg-open";
    }
}
/**
 * Formats a duration in milliseconds to a human-readable string.
 *
 * - ≥60 000 ms → `"Xm Ys"` (e.g. 65000 → "1m 5s")
 * - 1 000–59 999 ms → `"Xs"` (e.g. 30000 → "30s")
 * - < 1 000 ms → `"0s"`
 */
export function formatDuration(ms) {
    if (ms >= 60000) {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }
    if (ms < 1000) {
        return "0s";
    }
    return `${Math.floor(ms / 1000)}s`;
}
/**
 * Truncates text to `maxLen` characters, appending `"\n...(truncated)"`
 * when the original exceeds the limit.
 *
 * @param text   - The text to truncate.
 * @param maxLen - Maximum allowed length before truncation (default: 2000).
 */
export function truncateOutput(text, maxLen = 2000) {
    if (text.length > maxLen) {
        return text.substring(0, maxLen) + "\n...(truncated)";
    }
    return text;
}
