// cli.js — Context Visualizer CLI entry point for OpenCode & Claude Code.
//
// Workflow:
//   1. Scan for sessions on both platforms
//   2. User picks platform → sees recent sessions → can search
//   3. Select a session → preview → optionally include sub-agents
//   4. Distill with LLM (configurable endpoint from config.json)
//   5. Generate self-contained HTML → auto-open in browser
//
// Usage:
//   node cli.js                        Interactive mode
//   node cli.js --platform opencode    Skip platform selection
//   node cli.js --help                 Show help

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { execSync } = require("child_process");

const scanner = require("./scanner.js");
const normalizer = require("./normalizer.js");
const distill = require("./distill.js");
const Core = require("./distill-core.js");

// ---------- config ----------

const CONFIG_PATH = path.join(__dirname, "config.json");
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error("config.json not found or invalid, using defaults");
}

const RECENT_COUNT = CONFIG.cli?.recentCount || 10;
const MAX_SUB_DEPTH = CONFIG.cli?.maxSubAgentDepth || 2;
const MAX_TOTAL_SESSIONS = CONFIG.cli?.maxTotalSessions || 20;
const OUTPUT_DIR = CONFIG.cli?.outputDir || ".";

// ---------- I/O ----------

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise(resolve => rl.question(q, resolve));
}

function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

// ---------- platform detection ----------

function detectPlatforms() {
  const home = os.homedir();
  const found = [];
  if (fs.existsSync(path.join(home, ".claude", "projects"))) found.push("claude");
  try {
    execSync("opencode session list --format json --max-count 1", {
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    found.push("opencode");
  } catch (e) {
    // opencode CLI not available; try DB path
    const db = CONFIG.platforms?.opencode?.dbPath
      || path.join(home, ".local", "share", "opencode", "opencode.db");
    if (fs.existsSync(db)) found.push("opencode");
  }
  return found;
}

// ---------- HTML generation ----------

function getSelfContainedTemplate() {
  // Read index.html and modify it to accept inline data
  const htmlPath = path.join(__dirname, "index.html");
  if (!fs.existsSync(htmlPath)) return null;
  return fs.readFileSync(htmlPath, "utf8");
}

function buildSelfContainedHtml(eventsDoc) {
  let html = getSelfContainedTemplate();
  if (!html) {
    html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  }

  const dataJson = JSON.stringify(eventsDoc);

  // Replace loadData() — first fetch for events.json
  html = html.replace(
    'try { d = await fetch("events.json", {cache:"no-store"}).then(r=>{ if(!r.ok) throw 0; return r.json(); }); }',
    'try { d = window.__STORYLINE_DATA__; }'
  );

  // Replace pollLive() — second fetch for events.json
  html = html.replace(
    'const d = await fetch("events.json",{cache:"no-store"}).then(r=>r.json());',
    'const d = window.__STORYLINE_DATA__;'
  );

  // Disable LIVE mode (no server to poll)
  html = html.replace(
    "LIVE_ON=true",
    "LIVE_ON=false"
  );

  // Disable import panel (no /list endpoint)
  html = html.replace(
    'document.getElementById("bImport").onclick=(e)=>{ e.stopPropagation(); openImport(); };',
    'document.getElementById("bImport").style.display="none";'
  );

  // Disable redistill button (no /redistill endpoint)
  html = html.replace(
    'document.getElementById("bRedistill").onclick=async function(){',
    'document.getElementById("bRedistill").style.display="none"; document._noopRedistill=async function(){'
  );

  // Make /source provenance gracefully fail (file:// can't fetch)
  html = html.replace(
    /fetch\(`\/source\?session=\${encodeURIComponent\(m\.session\)}&line=\${m\.line}&ctx=3`\)/g,
    'Promise.reject(new Error("offline"))'
  );

  // Inject inline data at end of <head>
  const injectCode = `<script>
window.__STORYLINE_DATA__ = ${dataJson};
</script>
`;
  html = html.replace("</head>", injectCode + "</head>");

  return html;
}

function openBrowser(filePath) {
  const absPath = path.resolve(filePath);
  const url = "file://" + absPath;
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (platform === "linux") {
      execSync(`xdg-open "${url}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${absPath}"`);
    }
    return true;
  } catch (e) {
    console.log(`\n  浏览器无法自动打开，请手动打开:`);
    console.log(`  ${url}`);
    return false;
  }
}

// ---------- session selection helper ----------

async function selectPlatform() {
  const detected = detectPlatforms();

  if (detected.length === 0) {
    console.log("  未检测到 Claude Code 或 OpenCode 会话存储。");
    console.log("  请确认已安装至少其中一个工具。");
    process.exit(1);
  }

  if (detected.length === 1) {
    console.log(`  检测到 1 个平台: ${detected[0]}`);
    return detected[0];
  }

  console.log("  检测到以下平台:");
  const opts = [];
  detected.forEach((p, i) => {
    const label = p === "claude" ? "Claude Code" : "OpenCode";
    opts.push(`  [${i + 1}] ${label}`);
  });
  console.log(opts.join("\n"));

  while (true) {
    const choice = await ask(`\n  选择平台 [1-${detected.length}]: `);
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < detected.length) return detected[idx];
    console.log("  无效选择，请重试");
  }
}

async function selectSession(sessions) {
  const recent = sessions.slice(0, RECENT_COUNT);

  while (true) {
    console.log("\n" + scanner.formatSessionList(recent, true));

    const input = (await ask("\n  输入编号选择，或输入关键词搜索 (q 退出): ")).trim();

    if (input.toLowerCase() === "q") return null;

    // Search mode
    if (isNaN(parseInt(input, 10))) {
      const results = scanner.searchSessions(sessions, input);
      if (results.length === 0) {
        console.log(`  未找到匹配 "${input}" 的会话`);
        continue;
      }
      console.log(`\n  搜索 "${input}" 找到 ${results.length} 个结果:`);
      const display = results.slice(0, RECENT_COUNT);
      console.log(scanner.formatSessionList(display, true));

      const sel = await ask(`\n  输入编号选择 (b 返回列表): `);
      if (sel.toLowerCase() === "b") continue;
      const idx = parseInt(sel, 10) - 1;
      if (idx >= 0 && idx < display.length) return display[idx];
      console.log("  无效选择");
      continue;
    }

    // Direct selection
    const idx = parseInt(input, 10) - 1;
    if (idx >= 0 && idx < recent.length) return recent[idx];
    console.log("  无效编号，请重试");
  }
}

// ---------- preview & distill ----------

/**
 * Build a heuristic callModel for use when no LLM API key is configured.
 * Uses simple regex matching for event type classification — fast, no API cost.
 */
function buildHeuristicCallModel() {
  const THREAD_HINTS = [
    [/部署|deploy|systemd|proxy|端口|上线|发布/i, "deploy"],
    [/ui|界面|交互|样式|layout|design|css|前端|拖拽|文本框/i, "ui"],
    [/研究|调研|对比|分析|评估/i, "research"],
    [/文档|wiki|记录|归档|笔记|readme/i, "docs"],
    [/计划|方案|设计|架构|setup|规划/i, "setup"],
    [/复盘|回顾|反思|review|总结/i, "review"],
    [/测试|test|验证|debug|调试|fix|修复|bug|报错/i, "test"],
    [/auth|登录|认证|权限|token|jwt|oauth/i, "auth"],
    [/api|接口|请求|响应|route|endpoint|fetch/i, "api"],
    [/db|数据库|sql|查询|migration|orm|存储/i, "db"],
  ];

  return async (messages) => {
    const userMsg = messages.find(m => m.role === "user");
    const text = (userMsg && userMsg.content) || "";

    let type = "finding";
    if (/[?？]|吗|怎么|能不能|可以.*吗|what|how/i.test(text)) type = "question";
    else if (/决定|改成|应该|定为|方案|换成|decide/i.test(text)) type = "decision";
    else if (/废弃|删掉|不要|放弃|abandon/i.test(text)) type = "abandon";
    else if (/验证|通过|works|跑通|pass|成功|ok/i.test(text)) type = "verify";
    else if (/写出|建好|部署|commit|产出|生成|创建|make|build|implement/i.test(text)) type = "artifact";
    else if (/pivot|转向|重定义|pause|不需要.*需要/i.test(text)) type = "pivot";
    else if (/交接|handoff|交给|另开|委托/i.test(text)) type = "handoff";

    let thread = "general";
    for (const [re, id] of THREAD_HINTS) {
      if (re.test(text)) { thread = id; break; }
    }

    const title = (text || "").replace(/^[【「"'@\s]+/, "").replace(/[^一-鿿A-Za-z0-9].*$/, "").slice(0, 6) || "新事件";
    const summary = (text || "").slice(0, 90);
    const excerpt = (text || "").slice(0, 140);

    return {
      content: JSON.stringify({
        action: "event",
        type,
        thread,
        threadName: thread,
        title,
        summary,
        excerpt,
      }),
    };
  };
}

async function showPreviewAndDistill(session, platform, config) {
  // Get full session data for preview
  let exportData = null;
  let subAgentIds = [];
  let allSessions = [];

  if (platform === "opencode") {
    try {
      console.log("\n  正在加载会话详情...");
      exportData = await scanner.opencodeExport(session.id);
    } catch (e) {
      console.log(`\n  ✗ 无法加载会话详情: ${e.message}`);
      console.log("  请确认:");
      console.log("    1. opencode CLI 已安装且在 PATH 中");
      console.log("    2. 可以手动运行: opencode export <session-id>");
      console.log("    3. config.json 中 platforms.opencode.dbPath 配置正确");
      const retry = (await ask("\n  重试? [y/N]: ")).trim().toLowerCase();
      if (retry === "y") {
        try {
          exportData = await scanner.opencodeExport(session.id);
        } catch (e2) {
          console.log(`  再次失败: ${e2.message}`);
        }
      }
    }
  }

  if (!exportData && platform === "opencode") {
    console.log("\n  无法获取会话数据，蒸馏中止。");
    console.log("  请先确保 opencode export 命令可以正常工作。");
    return;
  }

  // Discover sub-agents for OpenCode
  if (platform === "opencode" && exportData) {
    // Get all sessions to find children
    const allOcSessions = scanner.scanOpenCode(config);
    subAgentIds = await scanner.discoverSubAgents(allOcSessions, session.id, config);
    // Remove the root from sub-agents
    subAgentIds = subAgentIds.filter(id => id !== session.id);
  }

  // Preview
  console.log(scanner.formatSessionPreview(session, subAgentIds.length));

  // Include sub-agents?
  let includeSubs = true;
  if (subAgentIds.length > 0) {
    const answer = (await ask(`  包含 ${subAgentIds.length} 个子代理一起可视化? [Y/n]: `)).trim().toLowerCase();
    includeSubs = answer !== "n" && answer !== "no";
  }

  // Use LLM?
  const hasLLM = config.llm?.apiKey || process.env.OPENROUTER_API_KEY;
  let useLLM = hasLLM;
  if (hasLLM) {
    const modelName = config.llm?.model || "deepseek/deepseek-v4-pro";
    const baseUrl = config.llm?.baseUrl || "https://openrouter.ai/api/v1/chat/completions";

    // Check model name validity for OpenRouter
    const isOR = /openrouter\.ai/i.test(baseUrl);
    if (isOR && !modelName.includes("/")) {
      console.log(`  ⚠ 检测到 OpenRouter 端点，但 model 名 "${modelName}" 不包含 provider 前缀`);
      console.log(`    应使用类似 "deepseek/deepseek-v4-pro" 的格式`);
    }

    console.log(`  检测到 LLM 配置 (${modelName}@${baseUrl})`);
    const answer = (await ask("  使用 LLM 蒸馏增强质量? [Y/n]: ")).trim().toLowerCase();
    useLLM = answer !== "n" && answer !== "no";
  } else {
    console.log("  未检测到 LLM API key (请在 config.json 或环境变量 OPENROUTER_API_KEY 中配置)。");
    console.log("  将使用启发式蒸馏 (无需 API)。");
    useLLM = false;
  }

  // Collect all session data
  const sessionList = [];

  // Add main session
  if (platform === "opencode" && exportData) {
    // Diagnostic: count total messages and roles
    const allRoles = {};
    (exportData.messages || []).forEach(m => {
      const role = m.info?.role || "unknown";
      allRoles[role] = (allRoles[role] || 0) + 1;
    });
    const roleSummary = Object.entries(allRoles)
      .map(([r, n]) => `${r}=${n}`).join(", ");

    const userTurns = normalizer.userTurnsFromOpenCode(exportData);
    console.log(`  ✓ 导出 ${exportData.messages?.length || 0} 条消息 (${roleSummary})`);
    console.log(`  ✓ 提取 ${userTurns.length} 条用户轮次 (共 ${allRoles.user || 0} 条 user 角色消息中)`);
    if (userTurns.length < 5) {
      console.log("  ⚠ 用户轮次较少 — 如需完整蒸馏请确认 opencode export 输出了全部消息");
    }
    const text = userTurns.map(t => JSON.stringify(t)).join("\n");

    sessionList.push({
      id: session.id,
      agent: session.agent || exportData.info?.agent || "agent",
      folder: session.project || path.basename(session.directory || ""),
      sourcePath: session.sourcePath || session.id,
      text,
    });
  } else if (platform === "claude") {
    let text = "";
    try {
      text = fs.readFileSync(session.sourcePath, "utf8");
    } catch (e) {
      console.log(`  无法读取会话文件: ${session.sourcePath}`);
      return;
    }
    sessionList.push({
      id: session.id,
      agent: session.agent || path.basename(session.directory || ""),
      folder: session.project || path.basename(session.directory || ""),
      sourcePath: session.sourcePath,
      text,
    });
  }

  // Add sub-agent sessions
  if (includeSubs && subAgentIds.length > 0 && platform === "opencode") {
    console.log(`\n  加载 ${subAgentIds.length} 个子代理...`);
    const allOc = scanner.scanOpenCode(config);
    for (const subId of subAgentIds) {
      const subSess = allOc.find(s => s.id === subId);
      if (!subSess) continue;
      try {
        const subData = await scanner.opencodeExport(subId);
        const subTurns = normalizer.userTurnsFromOpenCode(subData);
        const subText = subTurns.map(t => JSON.stringify(t)).join("\n");

        sessionList.push({
          id: subId,
          agent: subSess.agent || subData.info?.agent || "sub-agent",
          folder: subSess.project || path.basename(subSess.directory || ""),
          sourcePath: subSess.sourcePath || subId,
          text: subText,
        });
      } catch (e) {
        console.log(`    跳过 ${subId}: ${e.message}`);
      }
    }
  }

  console.log(`  共 ${sessionList.length} 个会话待蒸馏 (${sessionList.map(s => s.agent).join(", ")})`);

  // Distill
  console.log("\n  蒸馏中...");

  let doc, stats;

  if (useLLM) {
    try {
      const result = await distill.distillSessions(sessionList, {
        log: msg => process.stderr.write(`    ${msg}\n`),
      });
      doc = result.doc;
      stats = result.stats;
    } catch (e) {
      console.log(`  LLM 蒸馏失败: ${e.message}`);
      console.log("  回退到启发式蒸馏...");
      // Fallback: use distill without LLM
      doc = await Core.distillAll({
        sessions: sessionList,
        callModel: async () => {
          throw new Error("LLM unavailable");
        },
        log: () => {},
        model: "none",
      });
      stats = doc._stats || {};
      delete doc._stats;
    }
  } else {
    // Heuristic mode: simple regex-based event classification (no LLM needed)
    console.log("  使用启发式蒸馏 (无需 API)...");
    const heuristics = buildHeuristicCallModel();
    const result = await distill.distillSessions(sessionList, {
      log: msg => process.stderr.write(`    ${msg}\n`),
    });
    // Override callModel for this run
    // distillSessions uses the module-level callModel, so we can't easily override.
    // Use distill-core directly.
    doc = await Core.distillAll({
      sessions: sessionList,
      callModel: heuristics,
      log: msg => process.stderr.write(`    ${msg}\n`),
      model: "heuristic",
      concurrency: distill.CONCURRENCY,
      blockSize: distill.BLOCK_SIZE,
      maxPerAgent: distill.MAX_PER_AGENT,
    });
    stats = doc._stats || {};
    delete doc._stats;
  }

  // Inject tool call events from assistant messages
  if (exportData && platform === "opencode") {
    const toolEvents = normalizer.extractToolCalls(exportData, session.id);
    if (toolEvents.length > 0) {
      doc = normalizer.mergeToolEvents(doc, toolEvents);
      console.log(`  ✓ 添加 ${toolEvents.length} 个工具调用事件 (edit/bash/read等)`);
    }
  }

  // Coverage audit
  console.log("\n  运行信任审计...");
  const auditPath = path.join(__dirname, "_audit_events.json");
  fs.writeFileSync(auditPath, JSON.stringify(doc, null, 2));

  let auditOk = false;
  try {
    execSync(`node "${path.join(__dirname, "coverage-audit.js")}" "${auditPath}"`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    auditOk = true;
  } catch (e) {
    const stderrStr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : (e.stderr || "");
    const violations = stderrStr.split("\n").filter(l => l.includes("violation")).length;
    if (violations > 0) console.log(`  审计发现 ${violations} 条违规`);
    else console.log(`  审计脚本异常: ${e.message.slice(0, 100)}`);
  }

  // Cleanup audit temp file
  try { fs.unlinkSync(auditPath); } catch (e) {}

  console.log(`  ${auditOk ? "✓ 信任审计通过" : "⚠ 审计有警告，但继续生成"}`);

  // Output
  const timestamp = new Date().toISOString().slice(0, 10);
  const safeName = (session.title || session.id || "session")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
    .slice(0, 40);
  const outFile = path.join(OUTPUT_DIR, `${safeName}-${timestamp}.html`);

  console.log("\n  生成可视化文件...");
  const html = buildSelfContainedHtml(doc);
  fs.writeFileSync(outFile, html);

  const fileSize = fs.statSync(outFile).size;
  console.log(`  ✓ 已生成: ${outFile} (${scanner.fmtSize(fileSize)})`);
  console.log(`    ${doc.events?.length || 0} 事件 · ${doc.threadDefs?.length || 0} 线程 · ${doc.agents?.length || 0} 代理`);
  if (stats) {
    console.log(`    LLM 调用: ${stats.calls || 0} · 真实 token: ${stats.tokInReal || 0} in / ${stats.tokOutReal || 0} out`);
  }

  // Open browser
  console.log("");
  openBrowser(outFile);
}

// ---------- main ----------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Context Visualizer — 多平台 AI 会话可视化工具
      
用法:
  node cli.js                        交互模式
  node cli.js --platform opencode    直接指定平台 (opencode | claude)
  node cli.js --help                 显示帮助

配置:
  config.json — 编辑 LLM 端点、API key、默认路径等信息
`);
    process.exit(0);
  }

  clear();
  console.log("╔══════════════════════════════════════════╗");
  console.log("║       Context Visualizer ═ CLI          ║");
  console.log("║   多平台 AI 会话 · Storyline 可视化      ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  // Platform selection
  let platform = argv.includes("--platform")
    ? argv[argv.indexOf("--platform") + 1]
    : null;

  if (!platform) {
    platform = await selectPlatform();
    if (!platform) process.exit(0);
  }

  console.log(`\n  已选择平台: ${platform === "claude" ? "Claude Code" : "OpenCode"}`);

  // Scan sessions
  console.log("\n  扫描会话中...");
  let sessions;
  if (platform === "claude") {
    sessions = scanner.scanClaude(CONFIG);
    console.log(`  找到 ${sessions.length} 个 Claude Code 会话`);
  } else if (platform === "opencode") {
    sessions = scanner.scanOpenCode(CONFIG);
    console.log(`  找到 ${sessions.length} 个 OpenCode 会话`);

    // Enrich with first messages for OpenCode
    if (sessions.length > 0 && sessions.length <= 30) {
      console.log("  加载会话预览信息...");
      for (let i = 0; i < Math.min(sessions.length, RECENT_COUNT + 10); i++) {
        const s = sessions[i];
        if (s.firstMessage) continue;
        try {
          const data = await scanner.opencodeExport(s.id);
          s.firstMessage = scanner.extractFirstUserMessage(data);
        } catch (e) {
          // silently skip
        }
      }
    }
  } else {
    console.log(`  不支持的平台: ${platform}`);
    process.exit(1);
  }

  if (sessions.length === 0) {
    console.log("  未找到任何会话。");
    console.log("  请确认 config.json 中的路径配置正确。");
    process.exit(0);
  }

  // Select session
  const selected = await selectSession(sessions);
  if (!selected) {
    console.log("  已退出");
    process.exit(0);
  }

  // Preview + distill
  await showPreviewAndDistill(selected, platform, CONFIG);

  rl.close();
  console.log("\n完成。\n");
}

main().catch(e => {
  console.error("Error:", e.message);
  if (rl) rl.close();
  process.exit(1);
});
