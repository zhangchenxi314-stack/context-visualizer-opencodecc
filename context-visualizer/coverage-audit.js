// COVERAGE AUDIT / REGRESSION GATE.
// Independently validates the per-turn ledger in events.json against the RAW logs.
// Does NOT trust the build's labels — it re-derives "legitimately skippable" here.
// Exits NONZERO if any violation (missing ledger entry, genuine turn skipped,
// illegal reason, dangling merge/extract, uncorroborated agent-report).
//   run:  node coverage-audit.js     (CI gate: must exit 0)
const fs = require("fs");
const path = require("path");

// data-driven: events file path optional arg (default events.json); sessions from its manifest
const EVPATH = process.argv[2] || path.join(__dirname,"events.json");
const doc = JSON.parse(fs.readFileSync(EVPATH,"utf8"));
const events = doc.events, cov = doc.coverage;
const SESSIONS = {};
(doc.manifest||[]).forEach(m=>{ SESSIONS[m.id]=m.sourcePath; });
if(!Object.keys(SESSIONS).length){ console.error("FAIL: events.json has no manifest[] (run distill.js to (re)generate)."); process.exit(1); }

const T = s => new Date(/Z|[+-]\d\d:?\d\d$/.test(s)?s:s+"Z").getTime();
const clean = s => (s||"").replace(/<current_note>[\s\S]*?<\/current_note>/g,"")
  .replace(/<editor_selection>[\s\S]*?<\/editor_selection>/g,"").replace(/\s+/g," ").trim();
// 须与 distill.js 的 blockText 一致:字符串原样;block 数组只取 text 块;纯 tool_result/纯图片→""
const blockText = c => typeof c==="string" ? c
  : Array.isArray(c) ? c.filter(b=>b&&b.type==="text").map(b=>b.text||"").join("\n")
  : "";
function userTurns(file){ const L=fs.readFileSync(file,"utf8").split("\n"); const t=[];
  L.forEach((l,i)=>{ if(!l.trim())return; let o; try{o=JSON.parse(l)}catch(e){return;}
    if(o.type==="queue-operation"&&o.operation==="enqueue"){            // legacy queue format
      t.push({line:i+1,ts:o.timestamp||"",text:clean(o.content)}); }
    else if(o.type==="user"&&o.message&&o.message.role==="user"){       // 标准 Claude Code 格式
      const text=clean(blockText(o.message.content));
      if(text) t.push({line:i+1,ts:o.timestamp||"",text}); } });
  return t; }
const idset = new Set(events.map(e=>e.id));
const sessHasEvents = new Set(events.map(e=>e.session));
const SNAPSHOT = events.reduce((m,e)=> e.ts>m?e.ts:m, "");
const LEGAL = new Set(["empty","task-notif","re-send","terse-ack","slash-command","out-of-snapshot","agent-report"]);
// CLI slash 命令(/init /compact /fewer-permission-prompts…)= 工具调用,非故事内容。
// 此正则必须与 distill.js 的 SLASH_CMD 保持一致。
const SLASH_CMD = /^\/[a-z][\w-]*/i;

if(!cov || !cov.sessions){ console.error("FAIL: events.json has no coverage block."); process.exit(1); }

// INDEPENDENT judgment of whether a skip reason is justified for a given turn.
// This is the explicit, inspectable definition of "legitimately skippable" that
// replaces the old implicit "significance". A turn not matching ⇒ genuine ⇒ must NOT be skipped.
function skipJustified(turn, reason, entry, ctx){
  const t = turn.text;
  switch(reason){
    case "empty":      return t.length===0;
    case "task-notif": return /^<task-notification>/.test(t) || /<task-id>/.test(t);
    case "out-of-snapshot": return !!SNAPSHOT && turn.ts > SNAPSHOT;
    case "terse-ack":  return t.length<=8 ||
                               /^(继续|可以|好的?|行|ok|go on?|嗯|中文.*|.*分钟.*(了|过去).*)$/i.test(t);
    case "slash-command": return SLASH_CMD.test(t);
    case "re-send":    return ctx.hasCoveredDup;   // a covered turn (anywhere in session) with same leading text
    case "agent-report":
      return /完工汇报|完成的情况|本次会话总结|Working tree clean|Session concluded/.test(t)
             && !!entry.corroboratedBy && sessHasEvents.has(entry.corroboratedBy);
    default: return false;
  }
}

let md = "# Coverage Audit — 回归门禁(ledger 对账)\n\n";
md += "> 独立校验:把 `events.json` 的 per-turn ledger 与**原始日志**对账。审计自带「可跳过」定义,不信任 build 的标签。\n";
md += "> 判据:每条 enqueue turn 必须有 ledger 条目;**genuine turn 不得 skipped**;skip 理由须正当且 ∈ 枚举。\n\n";

const errors=[]; const summary=[];
for(const [sid,file] of Object.entries(SESSIONS)){
  if(!fs.existsSync(file)){ errors.push(`${sid}: log file missing`); continue; }
  const turns = userTurns(file);
  const led = (cov.sessions[sid] && cov.sessions[sid].ledger) || [];
  const byLine = new Map(led.map(e=>[e.line,e]));
  const sameStart=(a,b)=>{ if(!a||!b)return false; const k=Math.min(a.length,b.length,20); return k>=10&&a.slice(0,k)===b.slice(0,k); };
  const covered = turns.map(t=>{ const e=byLine.get(t.line); return e && (e.status==="extracted"); });
  // texts of all covered (extracted) turns in this session — for non-adjacent re-send justification (triples)
  const coveredTexts = turns.filter((t,i)=>covered[i]).map(t=>t.text);

  let ext=0,mer=0,ski=0,bad=0; const rows=[];
  turns.forEach((t,idx)=>{
    const e = byLine.get(t.line);
    let status="❌", detail="";
    if(!e){
      if(SNAPSHOT && t.ts > SNAPSHOT){ status="⏭️"; detail="out-of-snapshot(快照后新增,待下次蒸馏)"; ski++; }
      else { status="❌"; detail="ledger 无此 turn 条目(完整性缺口)"; errors.push(`${sid} L${t.line} missing ledger entry (<= snapshot)`); bad++; }
    }
    else if(e.status==="extracted"){ status="✅抽取"; ext++; detail=(e.eventIds||[]).join(",");
      (e.eventIds||[]).forEach(id=>{ if(!idset.has(id)){ errors.push(`${sid} L${t.line} extracted→missing event ${id}`); } }); }
    else if(e.status==="merged"){ status="🔁并入"; mer++; detail="→ "+e.mergedInto;
      if(!idset.has(e.mergedInto)){ errors.push(`${sid} L${t.line} merged→missing event ${e.mergedInto}`); bad++; status="❌"; } }
    else if(e.status==="skipped"){
      const ctx={ hasCoveredDup: coveredTexts.some(ct=>sameStart(t.text,ct)) };
      const legal = LEGAL.has(e.reason);
      const justified = legal && skipJustified(t, e.reason, e, ctx);
      if(!legal){ errors.push(`${sid} L${t.line} illegal skip reason '${e.reason}'`); status="❌"; bad++; }
      else if(!justified){ errors.push(`${sid} L${t.line} GENUINE turn skipped as '${e.reason}': 〈${t.text.slice(0,70)}〉`); status="❌真漏"; bad++; }
      else { status="⏭️"; ski++; detail=e.reason+(e.corroboratedBy?(" ✓"+e.corroboratedBy):""); }
    } else { status="❌"; detail="未知 status "+e.status; errors.push(`${sid} L${t.line} unknown status ${e.status}`); bad++; }
    rows.push({line:t.line, ts:t.ts.slice(5,16).replace("T"," "), status, detail, snip:t.text.slice(0,64)});
  });
  // ledger entries with no matching raw turn (stale)
  led.forEach(e=>{ if(!turns.find(t=>t.line===e.line)) errors.push(`${sid} L${e.line} ledger entry has no raw turn (stale)`); });

  const recall = turns.length? (((ext+mer)/turns.length)*100).toFixed(0):"—";
  summary.push({sid, turns:turns.length, ext, mer, ski, bad, recall});
  const ledgerPct = turns.length ? (((ext+mer+ski)/turns.length)*100).toFixed(0) : "0";
  md += `## ${sid}\nturns **${turns.length}** · ✅抽取 ${ext} · 🔁并入 ${mer} · ⏭️跳过 ${ski} · ❌问题 **${bad}** · 留账率 **${ledgerPct}%** · genuine 留存 **${recall}%**(上界)\n\n`;
  md += "| line | ts | 状态 | event / 理由 | 内容 |\n|---|---|---|---|---|\n";
  rows.forEach(r=> md += `| ${r.line} | ${r.ts} | ${r.status} | ${(r.detail||"").replace(/\|/g,"\\|")} | ${r.snip.replace(/\|/g,"\\|")} |\n`);
  md += "\n";
}

md += "## 汇总\n\n| 会话 | turns | ✅ | 🔁 | ⏭️ | ❌ | genuine留存(上界) |\n|---|---|---|---|---|---|---|\n";
let TT=0,TE=0,TM=0,TS=0,TB=0;
summary.forEach(s=>{ TT+=s.turns;TE+=s.ext;TM+=s.mer;TS+=s.ski;TB+=s.bad;
  md+=`| ${s.sid} | ${s.turns} | ${s.ext} | ${s.mer} | ${s.ski} | ${s.bad} | ${s.recall}% |\n`; });
md += `| **合计** | **${TT}** | ${TE} | ${TM} | ${TS} | **${TB}** | **${(((TE+TM)/TT)*100).toFixed(0)}%** |\n\n`;
md += `留账率 = (抽取+并入+跳过)/turns = **${(((TE+TM+TS)/TT)*100).toFixed(0)}%**(目标 100%,即每条 turn 都有交代)。\n`;
md += `genuine 留存 = (抽取+并入)/turns(**上界**:跨度内 ≥1 事件即算覆盖)。\n`;
md += errors.length ? `\n## ❌ 违规(${errors.length})\n\n`+errors.map(e=>"- "+e).join("\n")+"\n" : "\n## ✅ 门禁通过:每条 turn 都留账,无 genuine 被跳过。\n";

fs.writeFileSync(path.join(__dirname,"coverage.md"), md);

console.log("session   turns  ✅ext  🔁mer  ⏭️ski  ❌bad  recall");
summary.forEach(s=>console.log(s.sid.padEnd(9),String(s.turns).padStart(5),String(s.ext).padStart(6),
  String(s.mer).padStart(6),String(s.ski).padStart(6),String(s.bad).padStart(6),String(s.recall+"%").padStart(7)));
console.log(`TOTAL turns=${TT} extracted=${TE} merged=${TM} skipped=${TS} violations=${TB}`);
console.log(`ledger完整率=${(((TE+TM+TS)/TT)*100).toFixed(1)}%  genuine留存(上界)=${(((TE+TM)/TT)*100).toFixed(1)}%`);
if(errors.length){ console.error(`\nGATE FAIL — ${errors.length} violation(s):`); errors.slice(0,40).forEach(e=>console.error("  "+e)); process.exit(1); }
console.log("\nGATE PASS ✅  coverage.md written.");
