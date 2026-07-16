/**
 * HTML template generator for session-tool-call visualisations.
 *
 * Produces a self-contained HTML page with dark theme, Mermaid diagram,
 * interactive filter panel, causal detail panel with tabbed interface,
 * and inline tool-call / reasoning / sub-diagram data.
 *
 * v2 — causal reasoning chain with arrow labels, sub-diagrams, and
 *      tabbed detail panel (操作详情 / 推理链路).
 *
 * @module html-template
 */
import { TOOL_CATEGORY_CONFIG } from "./types.js";
// ── Helpers ────────────────────────────────────────────────────────────────────
/** Chinese labels for each ToolCategory (in enum declaration order). */
const CATEGORY_LABELS = {
    search: "搜索",
    file_io: "读写",
    shell: "命令",
    agent: "Agent",
    network: "网络",
    other: "其他",
};
/**
 * Escape a string for safe embedding in HTML.
 * Replaces `&`, `<`, `>`, `"`, and `'` with HTML entities.
 */
function escapeHtml(raw) {
    return raw
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/** Escape a regex meta-character so it can be used as a literal inside a RegExp. */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Serialise an object to JSON and guard against `</script>` injection. */
function jsonScriptBlock(obj) {
    // Escape any "</" sequence (not just </script>) so no HTML end-tag leaks
    // out of the inline script element.
    return JSON.stringify(obj).replace(/<\//gi, "<\\/");
}
/**
 * Post-process `mermaidCode` to inject arrow labels (`edgeLabels`).
 *
 * Maps keys like `"N1->N2"` → Mermaid labelled-arrow syntax
 * `N1 -->|"label text"| N2`.  Supports `-->`, `==>`, and `---` arrows.
 */
function injectEdgeLabels(code, edgeLabels) {
    let result = code;
    for (const [key, label] of Object.entries(edgeLabels)) {
        const parts = key.split("->");
        if (parts.length !== 2)
            continue;
        const [from, to] = parts.map((s) => s.trim());
        if (!from || !to)
            continue;
        // HTML-escape the label because mermaidCode is embedded in an HTML <div>.
        // escapeHtml also turns " → &quot; which keeps the Mermaid |"..."| delimiters intact.
        const htmlEscaped = escapeHtml(label);
        const regex = new RegExp(`(${escapeRegex(from)})\\s*(-->|==>|---)\\s*(${escapeRegex(to)})`, "g");
        result = result.replace(regex, `$1 $2|"${htmlEscaped}"| $3`);
    }
    return result;
}
// ── Section builders ───────────────────────────────────────────────────────────
/** Build the filter-panel <aside> with category checkboxes. */
function buildFilterPanel() {
    const rows = Object.values(TOOL_CATEGORY_CONFIG)
        .map((cfg) => `      <label class="filter-item" title="${cfg.category}">
        <input type="checkbox" checked data-category="${cfg.category}" />
        <span class="filter-icon">${cfg.icon}</span>
        <span class="filter-label">${CATEGORY_LABELS[cfg.category]}</span>
      </label>`)
        .join("\n");
    return `<aside id="filter-panel">
    <h3>筛选</h3>
    <label class="filter-item filter-all">
      <input type="checkbox" checked data-category="all" />
      <span class="filter-icon">📋</span>
      <span class="filter-label">全部</span>
    </label>
${rows}
  </aside>`;
}
/** Build the <style> block with dark theme CSS (v2 — tab styles added). */
function buildStyles() {
    // Emit a class-per-category so Mermaid can colour each node
    const categoryStyles = Object.values(TOOL_CATEGORY_CONFIG)
        .map((cfg) => `    .${cfg.cssClass} rect, .${cfg.cssClass} circle, .${cfg.cssClass} polygon, .${cfg.cssClass} path { fill: ${cfg.color} !important; stroke: ${cfg.color} !important; color: #1a1a2e !important; }`)
        .join("\n");
    return `<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #1a1a2e;
      color: #e0e0e0;
      min-height: 100vh;
    }

    code, pre {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.875rem;
    }

    /* ── Header ──────────────────────────────── */
    #session-info {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1.25rem;
      background: #16213e;
      border-bottom: 1px solid #2a2a4a;
      font-size: 0.875rem;
    }
    #session-info h2 {
      font-size: 1.125rem;
      font-weight: 600;
      color: #fff;
      margin-right: auto;
    }
    #session-info .meta-item {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      color: #9e9e9e;
    }
    #session-info .meta-item strong {
      color: #e0e0e0;
      font-weight: 500;
    }

    /* ── Layout ───────────────────────────────── */
    .layout {
      display: flex;
      height: calc(100vh - 54px);
    }

    /* ── Filter sidebar ───────────────────────── */
    #filter-panel {
      width: 180px;
      min-width: 180px;
      border-right: 1px solid #2a2a4a;
      padding: 1rem 0.75rem;
      overflow-y: auto;
      background: #16213e;
    }
    #filter-panel h3 {
      font-size: 0.875rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #b0b0b0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .filter-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.5rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8125rem;
      transition: background 0.15s;
    }
    .filter-item:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    .filter-item input[type="checkbox"] {
      accent-color: #4FC3F7;
    }
    .filter-icon { font-size: 1rem; }
    .filter-label { color: #ccc; }

    /* ── Flowchart area ───────────────────────── */
    #flowchart {
      flex: 1;
      overflow: auto;
      padding: 1.5rem;
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }
    #flowchart .mermaid {
      min-width: 400px;
    }

    /* ── Detail panel ─────────────────────────── */
    #detail-panel {
      width: 360px;
      min-width: 360px;
      border-left: 1px solid #2a2a4a;
      padding: 1rem;
      overflow-y: auto;
      background: #16213e;
    }
    #detail-panel h3 {
      font-size: 0.875rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: #b0b0b0;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    /* ── Detail tabs (v2) ─────────────────────── */
    .detail-tabs {
      display: flex;
      gap: 0;
      margin-bottom: 0.75rem;
      border-bottom: 2px solid #2a2a4a;
    }
    .detail-tab {
      flex: 1;
      padding: 0.5rem 0.75rem;
      background: transparent;
      border: none;
      color: #9e9e9e;
      font-size: 0.8125rem;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      outline: none;
    }
    .detail-tab:hover {
      color: #e0e0e0;
    }
    .detail-tab.active {
      color: #4FC3F7;
      border-bottom-color: #4FC3F7;
    }
    .tab-content {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .sub-diagram {
      background: #0d1117;
      border-radius: 4px;
      padding: 0.5rem;
      overflow: auto;
      max-height: 300px;
      min-height: 60px;
    }
    .sub-diagram svg {
      max-width: 100%;
      height: auto;
    }

    /* ── Mermaid category colours ─────────────── */
${categoryStyles}
  </style>`;
}
// ── Interaction JS builder ─────────────────────────────────────────────────────
/**
 * Build the inline interaction JavaScript (v2).
 *
 * Implements:
 *   (a) Mermaid init + render,
 *   (b) node-click → tabbed detail panel (v2: 操作详情 / 推理链路),
 *   (c) mouse-wheel zoom,
 *   (d) drag-to-pan,
 *   (e) filter checkboxes,
 *   (f) reset-view button,
 *   (g) Mermaid error fallback,
 *   (h) export button,
 *   (i) sub-diagram rendering via mermaid.render() (v2),
 *   (j) tab switching between 操作详情 and 推理链路 (v2).
 */
function buildInteractionJs() {
    // NOTE: no template literals inside the JS — use only '' / "" / concatenation
    // to avoid collision with TypeScript template-literal interpolation.
    return `
    (function() {
      // ── State ──────────────────────────────────
      var scale = 1;
      var tx = 0;
      var ty = 0;
      var dragging = false;
      var dsX = 0, dsY = 0;
      var ltX = 0, ltY = 0;

      var CAT_CLASS = {
        all: null, search: 'cat-search', file_io: 'cat-fileio',
        shell: 'cat-shell', agent: 'cat-agent', network: 'cat-network', other: 'cat-other'
      };

      // ── Helpers ────────────────────────────────
      function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
          .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      function nodeId(el) {
        var node = el;
        for (var i = 0; i < 10; i++) {
          if (node.nodeName === 'g' && node.id && /flowchart-/.test(node.id)) {
            var m = node.id.match(/^flowchart-(.+?)-\\d+$/);
            return m ? m[1] : null;
          }
          node = node.parentNode;
          if (!node) return null;
        }
        return null;
      }

      function xform() {
        var svg = document.querySelector('#flowchart svg');
        if (!svg) return;
        svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
        svg.style.transformOrigin = '0 0';
      }

      // ── (a) Mermaid init ───────────────────────
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });

      // ── (j) Tab switching (v2) ─────────────────
      function switchTab(ev, name) {
        var tabs = document.querySelectorAll('#detail-content .detail-tab');
        for (var i = 0; i < tabs.length; i++) {
          tabs[i].classList.remove('active');
        }
        if (ev && ev.target) ev.target.classList.add('active');

        var tabOps = document.getElementById('tab-ops');
        var tabReason = document.getElementById('tab-reason');
        if (name === 'ops') {
          if (tabOps) tabOps.style.display = '';
          if (tabReason) tabReason.style.display = 'none';
        } else {
          if (tabOps) tabOps.style.display = 'none';
          if (tabReason) tabReason.style.display = '';
          // Trigger sub-diagram render when switching to reason tab
          var panel = document.getElementById('detail-content');
          if (panel && panel._nid) renderSubDiagram(panel._nid);
        }
      }
      window.switchTab = switchTab;

      // ── (i) Sub-diagram rendering (v2) ─────────
      function renderSubDiagram(nid) {
        var sub = (window.__subDiagrams && window.__subDiagrams[nid]) || '';
        var container = document.getElementById('sub-diagram');
        if (!container) return;

        if (!sub) {
          container.innerHTML = '<p style="color:#666;font-size:0.8125rem;">\\u65e0\\u63a8\\u7406\\u94fe\\u8def\\u6570\\u636e</p>';
          return;
        }

        // Show loading only if empty or still showing loader
        if (!container.innerHTML || container.querySelector('.sub-loading')) {
          container.innerHTML = '<p class="sub-loading" style="color:#9e9e9e;font-size:0.8125rem;">\\u52a0\\u8f7d\\u4e2d...</p>';
        }

        try {
          mermaid.render('sub-diagram-svg-' + nid, sub).then(function(result) {
            container.innerHTML = result.svg;
          }).catch(function(err) {
            container.innerHTML = '<p style="color:#f44336;font-size:0.8125rem;">\\u63a8\\u7406\\u94fe\\u8def\\u6e32\\u67d3\\u5931\\u8d25: ' + esc(err.message) + '</p>';
          });
        } catch(e) {
          container.innerHTML = '<p style="color:#f44336;font-size:0.8125rem;">\\u63a8\\u7406\\u94fe\\u8def\\u6e32\\u67d3\\u5931\\u8d25: ' + esc(e.message) + '</p>';
        }
      }

      // ── (b) Node click → tabbed detail panel (v2) ──
      function showDetail(nid) {
        var d = (window.__toolDetails && window.__toolDetails[nid]) || null;
        var panel = document.getElementById('detail-content');
        if (!panel) return;
        if (!d) {
          panel.innerHTML = '<p style="color:#666;font-size:0.8125rem;">\\u672a\\u627e\\u5230\\u5de5\\u5177\\u8c03\\u7528\\u8be6\\u60c5</p>';
          return;
        }

        // Find cause (edge label pointing to this node) — v2
        var cause = '';
        var edgeLabels = window.__edgeLabels || {};
        var keys = Object.keys(edgeLabels);
        for (var i = 0; i < keys.length; i++) {
          var parts = keys[i].split('->');
          if (parts.length === 2 && parts[1] === nid) {
            cause = edgeLabels[keys[i]];
            break;
          }
        }

        var reasoning = (window.__reasoningTexts && window.__reasoningTexts[nid]) || '';
        var hasSub = !!(window.__subDiagrams && window.__subDiagrams[nid]);

        var sc = d.status === 'completed' ? '#81C784' : d.status === 'error' ? '#F48FB1' : '#FFB74D';

        // Store for tab switching
        panel._nid = nid;

        // ── Build HTML ───────────────────────────
        var html = '';

        // Tabs
        html += '<div class="detail-tabs">';
        html += '<button class="detail-tab active" onclick="switchTab(event,\\'ops\\')">操作详情</button>';
        html += '<button class="detail-tab" onclick="switchTab(event,\\'reason\\')">推理链路</button>';
        html += '</div>';

        // Tab 1: Operations detail
        html += '<div id="tab-ops" class="tab-content">';
        html += '<div><span style="color:#9e9e9e;font-size:0.75rem;">工具</span>';
        html += '<div style="font-weight:600;color:#fff;">' + esc(d.tool) + '</div></div>';
        html += '<div><span style="color:#9e9e9e;font-size:0.75rem;">状态</span>';
        html += '<div><span style="color:' + sc + ';">' + esc(d.status) + '</span></div></div>';
        html += '<div><span style="color:#9e9e9e;font-size:0.75rem;">耗时</span>';
        html += '<div style="color:#e0e0e0;">' + (d.duration != null ? d.duration.toFixed(2) + 's' : 'N/A') + '</div></div>';

        // Cause (edge label) — v2
        if (cause) {
          html += '<div><span style="color:#9e9e9e;font-size:0.75rem;">原因</span>';
          html += '<div style="color:#FFB74D;margin-top:0.25rem;font-size:0.875rem;">' + esc(cause) + '</div></div>';
        }

        html += '<div><span style="color:#9e9e9e;font-size:0.75rem;">输入</span>';
        html += '<pre style="background:#0d1117;color:#c9d1d9;padding:0.5rem;border-radius:4px;overflow:auto;max-height:150px;font-size:0.75rem;margin-top:0.25rem;">' + esc(JSON.stringify(d.input, null, 2)) + '</pre></div>';
        html += '<div><span style="color:#9e9e9e;font-size:0.75rem;">输出</span>';
        html += '<pre style="background:#0d1117;color:#c9d1d9;padding:0.5rem;border-radius:4px;overflow:auto;max-height:200px;font-size:0.75rem;margin-top:0.25rem;">' + esc(d.output) + '</pre></div>';
        html += '</div>';

        // Tab 2: Reasoning chain — v2
        html += '<div id="tab-reason" class="tab-content" style="display:none;">';
        if (reasoning) {
          html += '<div style="background:#0d1117;color:#c9d1d9;padding:0.75rem;border-radius:4px;font-size:0.8125rem;line-height:1.6;white-space:pre-wrap;">' + esc(reasoning) + '</div>';
        }
        html += '<div id="sub-diagram" class="sub-diagram"></div>';
        html += '</div>';

        panel.innerHTML = html;

        // Render sub-diagram in background — v2
        if (hasSub) {
          renderSubDiagram(nid);
        }
      }

      // ── (b-aux) Click binding on SVG nodes ─────
      function bindClicks() {
        var svg = document.querySelector('#flowchart svg');
        if (!svg) return;
        svg.addEventListener('click', function(e) {
          var nid = nodeId(e.target);
          if (nid) showDetail(nid);
        });
      }

      // ── (c) Zoom + (d) Drag ────────────────────
      function bindZoomDrag() {
        var c = document.getElementById('flowchart');
        if (!c) return;

        c.addEventListener('wheel', function(e) {
          e.preventDefault();
          scale *= e.deltaY > 0 ? 0.9 : 1.1;
          scale = Math.max(0.1, Math.min(5, scale));
          xform();
        }, { passive: false });

        c.addEventListener('mousedown', function(e) {
          if (e.target.closest('button, input')) return;
          dragging = true; dsX = e.clientX; dsY = e.clientY;
          ltX = tx; ltY = ty; c.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', function(e) {
          if (!dragging) return;
          tx = ltX + (e.clientX - dsX);
          ty = ltY + (e.clientY - dsY);
          xform();
        });

        window.addEventListener('mouseup', function() {
          if (!dragging) return;
          dragging = false;
          var el = document.getElementById('flowchart');
          if (el) el.style.cursor = '';
        });
      }

      // ── (e) Filter checkboxes ──────────────────
      function bindFilters() {
        var cbs = document.querySelectorAll('#filter-panel input[type="checkbox"]');
        var allCb = document.querySelector('#filter-panel [data-category="all"]');

        cbs.forEach(function(cb) {
          cb.addEventListener('change', function() {
            var cat = cb.dataset.category;
            var svg = document.querySelector('#flowchart svg');
            if (!svg) return;

            if (cat === 'all') {
              var v = cb.checked;
              cbs.forEach(function(o) { o.checked = v; });
              svg.querySelectorAll('g.node').forEach(function(n) { n.style.display = v ? '' : 'none'; });
            } else {
              var cls = CAT_CLASS[cat];
              if (cls) {
                svg.querySelectorAll('g.' + cls).forEach(function(n) { n.style.display = cb.checked ? '' : 'none'; });
              }
              if (!cb.checked && allCb) allCb.checked = false;
              var allOn = true;
              cbs.forEach(function(o) { if (o.dataset.category !== 'all' && !o.checked) allOn = false; });
              if (allCb) allCb.checked = allOn;
            }
          });
        });
      }

      // ── (f) Reset view ─────────────────────────
      function bindReset() {
        var b = document.getElementById('btn-reset');
        if (!b) return;
        b.addEventListener('click', function() { scale = 1; tx = 0; ty = 0; xform(); });
      }

      // ── (h) Export ─────────────────────────────
      function bindExport() {
        var b = document.getElementById('btn-export');
        if (!b) return;
        b.addEventListener('click', function() {
          var blob = new Blob([document.documentElement.outerHTML], {type: 'text/html'});
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'session-visualization.html';
          a.click();
          URL.revokeObjectURL(a.href);
        });
      }

      // ── Toolbar (inject buttons) ───────────────
      function addToolbar() {
        var h = document.getElementById('session-info');
        if (!h) return;
        var div = document.createElement('div');
        div.style.cssText = 'display:flex;gap:0.5rem;margin-left:auto;';
        div.innerHTML =
          '<button id="btn-reset" style="background:#2a2a4a;color:#ccc;border:1px solid #3a3a5a;padding:0.3rem 0.8rem;border-radius:4px;cursor:pointer;font-size:0.8rem;">\\u91cd\\u7f6e\\u89c6\\u56fe</button>' +
          '<button id="btn-export" style="background:#2a2a4a;color:#ccc;border:1px solid #3a3a5a;padding:0.3rem 0.8rem;border-radius:4px;cursor:pointer;font-size:0.8rem;">\\u5bfc\\u51fa</button>';
        h.appendChild(div);
        bindReset();
        bindExport();
      }

      // ── (g) Error fallback ─────────────────────
      function fallback(code, msg) {
        var div = document.querySelector('.mermaid');
        if (!div) return;
        div.innerHTML =
          '<div style="color:#f44336;margin-bottom:0.5rem;font-weight:600;">' + esc(msg) + '</div>' +
          '<pre style="background:#0d1117;color:#c9d1d9;padding:1rem;border-radius:4px;overflow:auto;font-size:0.8rem;line-height:1.5;white-space:pre-wrap;">' + esc(code) + '</pre>';
      }

      // ── Main ───────────────────────────────────
      async function render() {
        addToolbar();
        var md = document.querySelector('.mermaid');
        if (!md) return;
        var orig = md.textContent.trim();

        try {
          await mermaid.run({ nodes: [md] });
          var svg = document.querySelector('#flowchart svg');
          if (!svg || svg.querySelectorAll('g.node').length === 0) {
            fallback(orig, 'Mermaid \\u672a\\u751f\\u6210\\u6709\\u6548\\u7684 SVG \\u56fe');
            return;
          }
          bindClicks();
          bindZoomDrag();
          bindFilters();
        } catch (e) {
          fallback(orig, 'Mermaid \\u6e32\\u67d3\\u9519\\u8bef: ' + e.message);
        }
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
      } else {
        render();
      }
    })();`;
}
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Generate a self-contained HTML page for visualising session tool calls
 * with a Mermaid flow-chart, filter sidebar, and tabbed detail panel (v2).
 */
export function generateHtml(data) {
    const { sessionTitle, sessionInfo, mermaidCode, toolDetails, edgeLabels = {}, subDiagrams = {}, reasoningTexts = {}, } = data;
    // Inject edge labels into the Mermaid code (v2)
    const labelledCode = Object.keys(edgeLabels).length > 0
        ? injectEdgeLabels(mermaidCode, edgeLabels)
        : mermaidCode;
    // Escape user-provided strings
    const titleEsc = escapeHtml(sessionTitle);
    const modelEsc = escapeHtml(sessionInfo.model);
    const agentEsc = escapeHtml(sessionInfo.agent);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${titleEsc}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
${buildStyles()}
</head>
<body>
  <header id="session-info">
    <h2>${escapeHtml(sessionInfo.title)}</h2>
    <span class="meta-item"><strong>Model</strong> ${modelEsc}</span>
    <span class="meta-item"><strong>Agent</strong> ${agentEsc}</span>
    <span class="meta-item"><strong>Tokens</strong> ${sessionInfo.tokensInput} → ${sessionInfo.tokensOutput}</span>
    <span class="meta-item"><strong>Duration</strong> ${sessionInfo.duration}s</span>
  </header>

  <main class="layout">
${buildFilterPanel()}

    <div id="flowchart">
      <div class="mermaid">
${labelledCode}
      </div>
    </div>

    <aside id="detail-panel">
      <h3>详情</h3>
      <div id="detail-content">
        <p style="color:#666;font-size:0.8125rem;">点击流程图节点查看工具调用详情</p>
      </div>
    </aside>
  </main>

  <script>
    window.__toolDetails = ${jsonScriptBlock(toolDetails)};
    window.__edgeLabels = ${jsonScriptBlock(edgeLabels)};
    window.__subDiagrams = ${jsonScriptBlock(subDiagrams)};
    window.__reasoningTexts = ${jsonScriptBlock(reasoningTexts)};
${buildInteractionJs()}
  </script>
</body>
</html>`;
}
