/**
 * LLM prompt template for the `/visualize` slash command (v2 — causal chain).
 *
 * Guides the LLM through an 8-step flow:
 *   read mixed timeline → build causal chain → generate Mermaid with arrow
 *   labels → generate sub-diagrams → extract reasoning texts → assemble
 *   edge-label map → assemble HTML → save & open.
 *
 * The HTML reference block is compile-time-embedded via `generateHtml()`.
 *
 * @module prompt
 */
import { generateHtml } from "./html-template.js";
import { ToolCategory } from "./types.js";
// ── Compile-time HTML reference block ──────────────────────────────────────────
/** Placeholder tool-call detail used in the reference HTML. */
const PLACEHOLDER_DETAIL = {
    seq: 1,
    tool: "{TOOL}",
    callID: "call_placeholder",
    status: "completed",
    input: { placeholder: true },
    output: "{OUTPUT}",
    title: undefined,
    timeStart: 0,
    timeEnd: 0,
    duration: 0,
};
/** Placeholder data used to generate the compile-time HTML reference block. */
const PLACEHOLDER_DATA = {
    sessionTitle: "{SESSION_TITLE}",
    sessionInfo: {
        id: "ses_placeholder",
        agent: "{AGENT}",
        model: "{MODEL}",
        title: "{SESSION_TITLE}",
        tokensInput: 0,
        tokensOutput: 0,
        cost: 0,
        timeCreated: 0,
        duration: 0,
    },
    nodes: [
        { id: "N1", label: "示例操作", category: ToolCategory.OTHER },
    ],
    mermaidCode: "graph TD\n  N1[⚙️ 示例操作]:::cat-other",
    toolDetails: { N1: PLACEHOLDER_DETAIL },
    edgeLabels: { "N1->N2": "{原因标注}" },
    subDiagrams: {
        N1: 'graph LR\n  A["💭 推理摘要"] --> B["🔍 决策: 执行搜索"] --> C["⚙️ 示例操作"]',
    },
    reasoningTexts: { N1: "{完整推理文本}" },
};
/** Compile-time HTML reference block, embedded in the prompt string. */
const HTML_REFERENCE = generateHtml(PLACEHOLDER_DATA);
// ── Prompt ────────────────────────────────────────────────────────────────────
/**
 * Full `/visualize` command prompt that drives the 8-step **causal reasoning
 * chain** workflow.
 *
 * ## Key difference from v1
 *
 * V1 produced an **operation timeline** — a flat sequence of tool calls.
 * V2 produces a **causal reasoning chain** — each tool call is connected
 * to the AI reasoning that caused it, and arrows are labelled with the
 * extracted cause.
 *
 * ## Data source
 *
 * The LLM calls `context_visualizer_read_session` which returns
 * `CausalSessionData` — a **mixed timeline** where reasoning items and
 * tool-call items are interleaved in chronological order.  The LLM uses
 * this to derive the causal structure.
 */
export const VISUALIZE_PROMPT = `你是一个「因果推理链路可视化引擎」。你的任务是将 AI 会话中的时间线转换为一条带有因果标注的可视化推理链路。

## 核心概念

一次 AI 会话由**混合时间线**（Mixed Timeline）组成：AI 的推理（reasoning）与工具调用（tool）交替出现，按时间顺序排列。

- **推理项**：\`{"type":"reasoning", "text":"...", "fullText":"...", "timeCreated":...}\` — AI 在调用工具前的思考过程
- **工具项**：\`{"type":"tool", "tool":"grep", "status":"completed", ...}\` — AI 执行的工具操作

**因果链路**：每个工具调用的前面，一定有一段推理解释了 WHY 调用这个工具。你的任务是从推理文本中提取这个因果关系的摘要。

### 示例因果链路

\`\`\`
[推理] "错误栈指向 UserService.java 第 42 行有 NPE 异常，需要先确认 null 检查逻辑"
  ↓ 原因: "需要验证 null 检查"
[工具] read UserService.java

[推理] "代码中确实缺少 null 检查，需要 grep 搜索项目中是否还有其他类似模式"
  ↓ 原因: "确认其他文件也有类似问题"
[工具] grep "NullPointer" 搜索项目
\`\`\`

在可视化图中，箭头标注的就是「原因」，例如：
\`N1 -->|"异常堆栈指向 UserService"| N2\`

---

## Step 1: 读取会话因果时间线

调用 \`context_visualizer_read_session\` 工具，传入当前 session ID。
返回结果为 \`CausalSessionData\` 类型的 JSON，包含：

- \`session\`: 会话元数据（id, agent, model, title, tokens, duration, cost）
- \`timeline\`: 混合时间线数组，每项为 \`{"type":"reasoning", ...}\` 或 \`{"type":"tool", ...}\`
- \`totalTools\`: 工具调用总数
- \`totalReasonings\`: 推理步骤总数

## Step 2: 构建因果链路

遍历 \`timeline\` 中的每一条工具调用记录，对每条执行：

### 2.1 定位前置推理

从当前工具调用向前扫描 \`timeline\`，找到最近的一条或多条 \`type === "reasoning"\` 记录。
这些推理解释了 AI 为什么要调用该工具。

### 2.2 生成工具摘要（10-30 字中文）

格式：操作类型 + 操作对象 + 关键结果。

按工具类别示例：

- **搜索类** (grep/glob/codegraph_*) → "在 src/auth/ 中搜索 JWT 实现，命中 3 个文件"
- **读写类** (read/write/edit) → "读取 app.ts 120 行，了解路由配置结构"
- **命令执行** (bash) → "执行 npm install，安装 15 个依赖包"
- **Agent 委派** (task) → "委派 explore 子代理搜索 auth 相关 pattern"
- **网络请求** (webfetch) → "抓取 React 官方文档 Hooks 章节"
- **失败操作** → 前缀加 ❌，如 "❌ bash: 编译失败，缺少依赖"

### 2.3 生成原因标注（10-20 字中文）

从 2.1 中找到的前置推理文本中，提取**一句话原因摘要**。
这是「WHY」——AI 为什么执行这个工具调用。将其作为**箭头上的标注**。

规则：
- 如果前置推理存在 → 从推理文本中提取核心原因，如 "异常堆栈指向 UserService"
- 如果没有前置推理 → 使用默认值 "执行操作"
- 如果推理文本过长 → 只提取与当前工具调用最相关的那一句

## Step 3: 生成因果 Mermaid 流程图

使用 \`graph TD\` 语法，按时间顺序从上到下排列工具节点。
**箭头必须携带原因标注**。

### 节点样式规则（与 v1 相同）

| 类别 | 形状 | 图标 | CSS 类 | 颜色 |
|------|------|------|--------|------|
| 搜索 | round \`[...]\` | 🔍 | cat-search | 蓝 #4FC3F7 |
| 读写 | rect \`[...]\` | 📝 | cat-fileio | 绿 #81C784 |
| 命令 | diamond \`{...}\` | ⚡ | cat-shell | 橙 #FFB74D |
| Agent | hex \`{{...}}\` | 🤖 | cat-agent | 紫 #CE93D8 |
| 网络 | rect \`[...]\` | 🌐 | cat-network | 粉 #F48FB1 |
| 其他 | round \`[...]\` | ⚙️ | cat-other | 灰 #B0BEC5 |

节点 ID：N1, N2, N3, ...

### 节点标签格式

每个节点包含工具摘要 + 执行耗时，两行：

\`\`\`
🔍 在 src/ 中搜索 NPE 异常，命中 3 个文件
⏱ 0.3s
\`\`\`

失败操作（status === "error"）在摘要前加 ❌：

\`\`\`
❌ bash: 编译失败，缺少依赖
⏱ 1.2s
\`\`\`

### 箭头格式

箭头必须携带原因标注（来自 Step 2.3）：

\`\`\`
N1 -->|"异常堆栈指向 UserService"| N2
N2 -->|"第 42 行缺少 null 检查"| N3
\`\`\`

### classDef 定义

每条 classDef 必须出现在 Mermaid 代码中：

\`\`\`
classDef cat-search fill:#4FC3F7,stroke:#0288D1,color:#000
classDef cat-fileio fill:#81C784,stroke:#388E3C,color:#000
classDef cat-shell fill:#FFB74D,stroke:#F57C00,color:#000
classDef cat-agent fill:#CE93D8,stroke:#7B1FA2,color:#000
classDef cat-network fill:#F48FB1,stroke:#C2185B,color:#000
classDef cat-other fill:#B0BEC5,stroke:#607D8B,color:#000
\`\`\`

### 完整示例

\`\`\`mermaid
graph TD
  N1[🔍 在 src/main/java 中搜索 NullPointerException，命中 3 个文件\n⏱ 0.3s]:::cat-search
  N2[📝 读取 UserService.java，定位第 42 行\n⏱ 0.1s]:::cat-fileio
  N3{⚡ 执行单元测试，确认 null 检查缺失\n⏱ 2.1s}:::cat-shell
  N4[📝 修改 UserService.java，添加 null 检查\n⏱ 0.2s]:::cat-fileio

  N1 -->|"异常堆栈指向 UserService"| N2
  N2 -->|"第 42 行缺少 null 检查"| N3
  N3 -->|"测试确认根因"| N4

classDef cat-search fill:#4FC3F7,stroke:#0288D1,color:#000
classDef cat-fileio fill:#81C784,stroke:#388E3C,color:#000
classDef cat-shell fill:#FFB74D,stroke:#F57C00,color:#000
\`\`\`

## Step 4: 生成推理子图

为每个工具节点创建一个小型 Mermaid 图，展示从推理到操作的小型因果链。
使用 \`graph LR\`（左到右）以节省空间。

每个子图包含 2-4 个节点：

\`\`\`mermaid
graph LR
  A["💭 {推理一句话摘要}"] --> B["🔍 决策: {AI 的决定}"] --> C["{工具图标} {工具摘要}"]
\`\`\`

示例：

\`\`\`mermaid
graph LR
  A["💭 错误堆栈显示 NPE 在第 42 行"] --> B["🔍 决策: 读取 UserService.java"] --> C["📝 读取 UserService.java，定位第 42 行"]
\`\`\`

将每个子图存入 \`subDiagrams: Record<string, string>\`，key 为节点 ID（N1, N2, ...）：

\`\`\`json
{
  "N1": "graph LR\\n  A[\\"💭 错误堆栈显示 NPE\\"] --> B[\\"🔍 决策: 搜索相关代码\\"] --> C[\\"🔍 搜索 NullPointerException\\"]",
  "N2": "graph LR\\n  A[\\"💭 搜索结果指向 UserService\\"] --> B[\\"🔍 决策: 读取源文件\\"] --> C[\\"📝 读取 UserService.java\\"]"
}
\`\`\`

## Step 5: 提取推理文本

为每个工具节点，收集根据 Step 2.1 定位到的前置推理记录的完整文本（\`fullText\`）。
如果有多个推理步骤关联到同一个工具调用，合并为一段文本（用空行分隔）。

存入 \`reasoningTexts: Record<string, string>\`，key 为节点 ID：

\`\`\`json
{
  "N1": "用户报告了 NullPointerException，错误栈指向 UserService.java 第 42 行。我需要先确认项目中是否有多处类似的 null 检查问题...",
  "N2": "搜索结果显示有 3 处 NPE 风险点，其中 UserService.java 的嫌疑最大。需要读取这个文件查看具体代码..."
}
\`\`\`

## Step 6: 生成边标注映射

将 Step 3 中每条箭头的「原因标注」整理为 \`Record<string, string>\`。
key 格式为 \`"N1->N2"\`，value 为原因标注文字。

\`\`\`json
{
  "N1->N2": "异常堆栈指向 UserService",
  "N2->N3": "第 42 行缺少 null 检查",
  "N3->N4": "测试确认根因"
}
\`\`\`

## Step 7: 组装 HTML 页面

调用 \`generateHtml()\` 函数，传入以下参数：

- \`sessionTitle\`: 从 \`session.title\` 获取
- \`sessionInfo\`: 从 \`session\` 获取完整对象
- \`nodes\`: \`[{id: "N1", label: "工具摘要", category: ToolCategory.SEARCH}, ...]\`
- \`mermaidCode\`: Step 3 生成的完整 Mermaid 代码
- \`toolDetails\`: \`{N1: toolCallRecord, N2: toolCallRecord, ...}\` — 每条工具调用的完整记录
- \`edgeLabels\`: Step 6 生成的边标注映射
- \`subDiagrams\`: Step 4 生成的子图映射
- \`reasoningTexts\`: Step 5 生成的推理文本映射

参考模板结构（你需要替换其中的占位符）：

\`\`\`html
${HTML_REFERENCE}
\`\`\`

## Step 8: 保存并打开

- 将生成的 HTML 写入系统临时目录: \`/tmp/opencode-session-{sessionId}.html\`
- 使用系统默认浏览器打开:
  - macOS: \`open /tmp/opencode-session-{sessionId}.html\`
  - Linux: \`xdg-open /tmp/opencode-session-{sessionId}.html\`
  - Windows: \`start /tmp/opencode-session-{sessionId}.html\`

---

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 空时间线（\`timeline\` 为空数组） | 显示 "本会话暂无操作记录" 消息，不生成图表 |
| 工具调用无前置推理 | 使用默认原因标注 "执行操作" |
| 工具调用失败（\`status === "error"\`） | 节点摘要前缀加 ❌；子图中标注失败原因；原因标注保持不变 |
| \`session\` 为 null | 使用 "Unknown Session" 作为标题 |

---

## 用户要求
$ARGUMENTS`;
