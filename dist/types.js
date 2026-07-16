/**
 * Type definitions for the context-visualizer plugin.
 *
 * @module types
 */
// ── Enums ────────────────────────────────────────────────────────────────────
/** 6 tool categories for visual classification. */
export var ToolCategory;
(function (ToolCategory) {
    ToolCategory["SEARCH"] = "search";
    ToolCategory["FILE_IO"] = "file_io";
    ToolCategory["SHELL"] = "shell";
    ToolCategory["AGENT"] = "agent";
    ToolCategory["NETWORK"] = "network";
    ToolCategory["OTHER"] = "other";
})(ToolCategory || (ToolCategory = {}));
// ── Category config ──────────────────────────────────────────────────────────
/** Pre-defined visual configuration for every tool category. */
export const TOOL_CATEGORY_CONFIG = {
    [ToolCategory.SEARCH]: {
        category: ToolCategory.SEARCH,
        shape: "round",
        color: "#4FC3F7",
        icon: "🔍",
        cssClass: "cat-search",
    },
    [ToolCategory.FILE_IO]: {
        category: ToolCategory.FILE_IO,
        shape: "rect",
        color: "#81C784",
        icon: "📝",
        cssClass: "cat-fileio",
    },
    [ToolCategory.SHELL]: {
        category: ToolCategory.SHELL,
        shape: "diamond",
        color: "#FFB74D",
        icon: "⚡",
        cssClass: "cat-shell",
    },
    [ToolCategory.AGENT]: {
        category: ToolCategory.AGENT,
        shape: "hex",
        color: "#CE93D8",
        icon: "🤖",
        cssClass: "cat-agent",
    },
    [ToolCategory.NETWORK]: {
        category: ToolCategory.NETWORK,
        shape: "rect",
        color: "#F48FB1",
        icon: "🌐",
        cssClass: "cat-network",
    },
    [ToolCategory.OTHER]: {
        category: ToolCategory.OTHER,
        shape: "round",
        color: "#B0BEC5",
        icon: "⚙️",
        cssClass: "cat-other",
    },
};
// ── Classifier ───────────────────────────────────────────────────────────────
/** Map a tool name to its visual category. */
export function classifyTool(toolName) {
    switch (toolName) {
        case "grep":
        case "glob":
        case "codegraph_codegraph_explore":
        case "codegraph_codegraph_search":
        case "codegraph_codegraph_node":
        case "websearch_web_search_exa":
            return ToolCategory.SEARCH;
        case "read":
        case "write":
        case "edit":
            return ToolCategory.FILE_IO;
        case "bash":
            return ToolCategory.SHELL;
        case "task":
            return ToolCategory.AGENT;
        case "webfetch":
        case "websearch":
            return ToolCategory.NETWORK;
        default:
            return ToolCategory.OTHER;
    }
}
