// flowchart.js — AI Session Flowchart Generator
// Usage: node flowchart.js [--session <session-id>]

const fs = require("fs");
const path = require("path");
const os = require("os");
const scanner = require("./scanner");
const normalizer = require("./normalizer");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

async function main() {
  const argv = process.argv.slice(2);
  const presetSession = argv.includes("--session") ? argv[argv.indexOf("--session") + 1] : null;

  console.log("╔══════════════════════════════════════╗");
  console.log("║    AI Session Flowchart Generator    ║");
  console.log("╚══════════════════════════════════════╝\n");

  // If no preset session, discover and let user select
  let session;
  if (presetSession) {
    const all = scanner.scanAll(CONFIG);
    session = all.find(s => s.id === presetSession);
    if (!session) { console.error("Session not found:", presetSession); process.exit(1); }
  } else {
    // Platform selection
    const platforms = [];
    if (scanner.scanClaude(CONFIG).length > 0) platforms.push("claude");
    if (scanner.scanOpenCode(CONFIG).length > 0) platforms.push("opencode");
    if (platforms.length === 0) { console.log("未找到会话"); process.exit(0); }

    let platform;
    if (platforms.length === 1) platform = platforms[0];
    else {
      console.log("选择平台:");
      platforms.forEach((p, i) => console.log(`  [${i + 1}] ${p === "claude" ? "Claude Code" : "OpenCode"}`));
      const choice = await ask(`选择 [1-${platforms.length}]: `);
      platform = platforms[parseInt(choice) - 1];
    }

    const sessions = platform === "claude" ? scanner.scanClaude(CONFIG) : scanner.scanOpenCode(CONFIG);
    console.log(`\n最近 ${Math.min(10, sessions.length)} 个会话:`);
    console.log(scanner.formatSessionList(sessions.slice(0, 10), true));

    while (true) {
      const input = await ask("\n输入编号选择，或搜索关键词 (q 退出): ");
      if (input.toLowerCase() === "q") process.exit(0);
      if (isNaN(parseInt(input))) {
        const results = scanner.searchSessions(sessions, input);
        if (results.length === 0) { console.log("无匹配"); continue; }
        console.log(scanner.formatSessionList(results.slice(0, 10), true));
        const sel = await ask("输入编号: ");
        session = results[parseInt(sel) - 1];
        break;
      }
      session = sessions[parseInt(input) - 1];
      if (session) break;
    }
  }

  console.log(`\n选择: ${session.title}`);
  console.log("导出会话数据...");

  // Export session
  let exportData;
  if (session.platform === "opencode") {
    try {
      exportData = await scanner.opencodeExport(session.id);
    } catch (e) {
      console.log("导出失败:", e.message);
      process.exit(1);
    }
  } else {
    // Claude — read file directly
    const text = fs.readFileSync(session.sourcePath, "utf8");
    // Reconstruct into an export-like format
    const turns = normalizer.turnsFromClaudeText(text);
    exportData = {
      info: {
        id: session.id,
        title: session.title,
        agent: session.agent || "agent",
        directory: session.directory,
        time: { created: session.time, updated: session.time },
      },
      messages: turns.map(t => ({
        info: { role: t.role, time: { created: typeof t.ts === "number" ? t.ts : Date.parse(t.ts) || 0 } },
        parts: [{ type: "text", text: t.text }]
      }))
    };
  }

  // Build nodes
  console.log("构建流程图...");
  const nodes = buildNodes(exportData);

  // Build session info
  const info = exportData.info || {};
  const sessionInfo = {
    id: info.id || session.id,
    title: info.title || session.title || "",
    agent: info.agent || session.agent || "",
    model: info.model ? (info.model.id || JSON.stringify(info.model)) : (session.model || ""),
    directory: info.directory || session.directory || "",
    time: info.time || { created: 0, updated: 0 },
    cost: info.cost || session.cost || 0,
    tokens: info.tokens || { input: 0, output: 0 },
  };

  // Build flowchart data
  const flowchartData = {
    session: sessionInfo,
    nodes: nodes,
  };

  // Read template and generate HTML
  const templatePath = path.join(__dirname, "flowchart.html");
  let html;
  try {
    html = fs.readFileSync(templatePath, "utf8");
  } catch (e) {
    console.log("找不到 flowchart.html 模板。请确认文件存在。");
    process.exit(1);
  }

  const dataJson = JSON.stringify(flowchartData).replace(/<\/script>/g, '<\\/script>');
  html = html.replace(
    'window.__FLOWCHART_DATA__ = {"session":{},"nodes":[]}',
    'window.__FLOWCHART_DATA__ = ' + dataJson
  );

  // Write output
  const safeName = (sessionInfo.title || sessionInfo.id || "session")
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_")
    .slice(0, 40);
  const outFile = path.join(__dirname, safeName + "-flowchart.html");
  fs.writeFileSync(outFile, html);

  const size = fs.statSync(outFile).size;
  console.log(`\n✓ 已生成: ${outFile} (${scanner.fmtSize(size)})`);
  console.log(`  ${nodes.length} 个节点 · ${formatTypes(nodes)}`);

  // Open browser
  const platform = process.platform;
  const { execSync } = require("child_process");
  try {
    if (platform === "darwin") execSync(`open "${outFile}"`);
    else if (platform === "linux") execSync(`xdg-open "${outFile}"`);
    else if (platform === "win32") execSync(`start "" "${outFile}"`);
  } catch (e) {
    console.log(`  浏览器: file://${outFile}`);
  }

  rl.close();
}

function buildNodes(exportData) {
  const messages = exportData.messages || [];
  const sessionAgent = (exportData.info || {}).agent || "agent";
  const nodes = [];

  for (const msg of messages) {
    const info = msg.info || {};
    const parts = msg.parts || [];
    const role = info.role;
    const ts = info.time ? (info.time.created || info.time.completed || 0) : 0;
    const agent = info.agent || sessionAgent;

    if (role === "user") {
      // Collect all text parts
      const text = parts.filter(p => p.type === "text").map(p => p.text || "").join("\n").trim();
      if (text) {
        nodes.push({ type: "user", ts, title: "用户", content: text, agent });
      }
    } else if (role === "assistant") {
      for (const part of parts) {
        switch (part.type) {
          case "reasoning": {
            const text = (part.text || "").trim();
            if (text) {
              nodes.push({ type: "reasoning", ts, title: "AI推理", content: text, agent });
            }
            break;
          }
          case "tool": {
            const name = part.tool || part.name || "tool";
            const input = (part.state && part.state.input) || part.input || {};
            const output = (part.state && part.state.output) || "";
            const status = (part.state && part.state.status) || "";

            // Build title
            let title = name;
            if (name === "read") {
              const fp = (input.filePath || input.file || "").split("/").pop() || "";
              title = "读取 " + (fp || input.filePath || "").slice(0, 30);
            } else if (name === "edit" || name === "write") {
              const fp = (input.filePath || input.file || "").split("/").pop() || "";
              title = "编辑 " + fp.slice(0, 30);
            } else if (name === "bash" || name === "execute_command") {
              title = (input.command || input.cmd || "").slice(0, 40);
            } else if (name === "grep") {
              title = "搜索 " + (input.pattern || "").slice(0, 30);
            } else if (name === "glob") {
              title = "匹配 " + (input.pattern || "").slice(0, 30);
            } else if (name === "web_fetch") {
              title = "网页 " + (input.url || "").slice(0, 30);
            } else if (input.filePath || input.file) {
              title = name + " " + (input.filePath || input.file || "").split("/").pop();
            } else {
              title = name;
            }

            // Build detail (human-readable input summary)
            let detail = "";
            if (input.filePath) detail = "文件: " + input.filePath;
            else if (input.command || input.cmd) detail = "命令: " + (input.command || input.cmd);
            else if (input.pattern) detail = "模式: " + input.pattern;
            else if (input.url) detail = "URL: " + input.url;

            nodes.push({
              type: "tool",
              ts,
              title: title.slice(0, 50),
              content: output || "(无输出)",
              agent,
              toolName: name,
              detail,
              input: JSON.stringify(input, null, 2),
            });
            break;
          }
          case "text": {
            const text = (part.text || "").trim();
            if (text) {
              nodes.push({ type: "response", ts, title: "AI回复", content: text, agent });
            }
            break;
          }
        }
      }
    }
  }

  return nodes;
}

function formatTypes(nodes) {
  const counts = {};
  nodes.forEach(n => { counts[n.type] = (counts[n.type] || 0) + 1; });
  return Object.entries(counts).map(([t, c]) => `${t}=${c}`).join(" · ");
}

module.exports = { buildNodes };

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
