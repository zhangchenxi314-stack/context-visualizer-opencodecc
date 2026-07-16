/**
 * Plugin entry point for the context-visualizer OpenCode plugin.
 *
 * Registers the `context_visualizer_read_session` custom tool and the
 * `/visualize` slash command via the config hook.
 *
 * @module index
 */
import { readSessionTool } from "./tool.js";
import { VISUALIZE_PROMPT } from "./prompt.js";
/**
 * Context Visualizer OpenCode Plugin (v1 API).
 *
 * @param _ctx - Standard plugin input provided by the OpenCode runtime.
 * @returns Hooks object with a custom tool definition and a config hook.
 */
const ContextVisualizerPlugin = async (_ctx) => {
    return {
        tool: {
            context_visualizer_read_session: readSessionTool,
        },
        config: async (config) => {
            config.command = config.command ?? {};
            config.command["visualize"] = {
                description: "将当前 session 可视化为交互式流程图",
                template: VISUALIZE_PROMPT,
                subtask: false,
            };
        },
    };
};
/**
 * OpenCode v1 plugin module format.
 * The loader tries `mod.default.server` first, then falls back to
 * iterating `Object.values(mod)` for function exports.
 */
export default {
    id: "context-visualizer",
    server: ContextVisualizerPlugin,
};
// Named export kept for programmatic access in tests
export { ContextVisualizerPlugin };
