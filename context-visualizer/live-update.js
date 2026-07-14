// LIVE GROWTH (P4) — stateless incremental distiller. O(1) per update, O(n) total.
//
// HARD RULE (the disease this project kills): never grow an LLM session. We do NOT
// feed the whole transcript. Each update = [new turn] + [compact state_digest of
// events.json]. State lives in events.json (external memory), not a context window.
//
//   node live-update.js --once        # one incremental pass (process turns past the frontier)
//   node live-update.js --watch [--interval=4]   # poll loop (cadence knob)
//   node live-update.js --once --reprocess-oos    # also re-distill prior out-of-snapshot turns
//
// Distiller backend: Anthropic Haiku when ANTHROPIC_API_KEY is set (LIVE_LLM=1),
// else a free deterministic heuristic (clearly labeled). Either way: genuine turns
// get an event; non-genuine turns are deterministically pre-filtered (0 token) and
// recorded in the ledger with a legal reason → audit stays ❌=0.
const fs=require("fs"), path=require("path"), https=require("https");
const DIR=__dirname;
const EV=path.join(DIR,"events.json");
// NO hardcoded session list — live watches exactly what's in events.json's manifest.
// Read fresh each tick, so importing a new conversation (which appends to manifest via /distill)
// auto-extends what live monitors, with no watcher restart. "导入了哪些,就盯哪些。"
const sessionsFromDoc = doc => Object.fromEntries(
  (doc.manifest||[]).map(m=>[m.id, {agent:m.agent, file:m.sourcePath}]));
const T=s=>new Date(/Z|[+-]\d\d:?\d\d$/.test(s)?s:s+"Z").getTime();
const clean=s=>(s||"").replace(/<current_note>[\s\S]*?<\/current_note>/g,"").replace(/<editor_selection>[\s\S]*?<\/editor_selection>/g,"").replace(/\s+/g," ").trim();
const approxTokens=s=>Math.ceil([...s].reduce((n,c)=>n+(/[一-鿿]/.test(c)?1:0.34),0)); // CJK≈1, latin≈0.34
function userTurns(file){const L=fs.readFileSync(file,"utf8").split("\n");const t=[];
  L.forEach((l,i)=>{if(!l.trim())return;let o;try{o=JSON.parse(l)}catch(e){return;}
    if(o.type==="queue-operation"&&o.operation==="enqueue")t.push({line:i+1,ts:o.timestamp||"",text:clean(o.content)});});return t;}

// Register a threadDef for a live-discovered thread so the event actually RENDERS
// (no orphan threads). New thread forks from its agent's root; inserted inside that
// agent's band block so bands stay contiguous. (cf. distill.js ensureThread/orderThreads.)
const LPAL=["#5b9bff","#2dd4bf","#7c8bff","#f0b252","#34d399","#a78bfa","#fb7baf","#22d3ee","#c084fc","#7b8597"];
function ensureThreadDef(doc, thread, agent){
  doc.threadDefs=doc.threadDefs||[];
  if(doc.threadDefs.find(t=>t.id===thread)) return;
  const root=doc.threadDefs.find(t=>t.agent===agent && !t.parent);
  let h=0; for(const c of thread) h=(h*31+c.charCodeAt(0))>>>0;
  const def={ id:thread, name:thread.replace(/_(cl|cd)$/,""), color:LPAL[h%LPAL.length],
    agent, parent:root?root.id:null, glow:/visual|storyline|viz/.test(thread) };
  let idx=-1; doc.threadDefs.forEach((t,i)=>{ if(t.agent===agent) idx=i; });   // last same-agent slot
  if(idx>=0) doc.threadDefs.splice(idx+1,0,def); else doc.threadDefs.push(def);
}

// ---- state_digest: compact summary of events.json — NOT the transcript. Bounded size. ----
function buildDigest(doc){
  const threads=doc.threadDefs.map(t=>t.id).join(",");
  const types=Object.keys(doc.typeDefs).join(",");
  const recent=doc.events.slice().sort((a,b)=>T(b.ts)-T(a.ts)).slice(0,8).reverse()
    .map(e=>`${e.ts.slice(5,16)} ${e.agent}/${e.thread} ${e.type}:${e.title}`).join(" | ");
  const text=`THREADS(${threads}). TYPES(${types}). RECENT: ${recent}`;
  return {text, tokens:approxTokens(text)};
}

// ---- deterministic pre-filter (0 token). Mirrors coverage-audit "skippable" defn. ----
function preFilter(turn, coveredTexts){
  const t=turn.text;
  if(t.length===0) return "empty";
  if(/^<task-notification>/.test(t)||/<task-id>/.test(t)) return "task-notif";
  if(t.length<=8 || /^\/[a-z]+/i.test(t) || /^(继续|可以|好的?|行|ok|go on?|嗯|中文.*|.*分钟.*(了|过去).*)$/i.test(t)) return "terse-ack";
  const sameStart=(a,b)=>{if(!a||!b)return false;const k=Math.min(a.length,b.length,20);return k>=10&&a.slice(0,k)===b.slice(0,k);};
  if(coveredTexts.some(ct=>sameStart(t,ct))) return "re-send";
  return null; // genuine → distill
}

// ---- heuristic distiller (free fallback, no key): turn → event fields. NEUTRAL buckets, agent-agnostic. ----
const THREAD_HINTS=[
  [/部署|deploy|systemd|proxy|端口|:80|ssh|发布|上线/i,"deploy"],
  [/拖拽|文本框|textbox|focus|缩放|界面|ux|交互/i,"ui"],
  [/研究|调研|对比|paradigm|search/i,"research"],
  [/文档|wiki|记录|归档|笔记/i,"docs"],
  [/计划|方案|设计|架构|setup/i,"setup"],
  [/复盘|回顾|反思|review|总结/i,"review"],
];
const cleanTitle=t=>(t.replace(/^c?任务[:：]?\s*/,"").replace(/^[【「"'@\s]+/,"").replace(/[^一-鿿A-Za-z0-9].*$/,"").slice(0,6))||"新事件";
function heuristicDistill(turn, agent){
  const t=turn.text;
  let type="finding";
  if(/[?？]|吗|怎么|能不能|可以.*吗/.test(t)) type="question";
  else if(/决定|改成|应该|定为|方案|换成/.test(t)) type="decision";
  else if(/废弃|删掉|不要|放弃|abandon/.test(t)) type="abandon";
  else if(/验证|通过|works|跑通|pass|成功/.test(t)) type="verify";
  else if(/写出|建好|部署|commit|产出|file ?回|生成/.test(t)) type="artifact";
  else if(/pivot|转向|重定义|pause|不需要.*需要/.test(t)) type="pivot";
  else if(/交接|handoff|交给|另开|让.*那边|委托|给.*prompt/.test(t)) type="handoff";
  let thread="general";   // default neutral bucket (no project-specific assumptions)
  for(const [re,id] of THREAD_HINTS) if(re.test(t)){thread=id;break;}
  return {type, thread, title:cleanTitle(t), summary:t.slice(0,70), excerpt:t.slice(0,140)};
}

// ---- LLM distiller (Anthropic Haiku) — used when ANTHROPIC_API_KEY set ----
function llmDistill(turn, digest, doc){
  return new Promise((resolve,reject)=>{
    const sys="你把【一条用户 turn】蒸馏成 storyline 的一个事件。只输出 JSON,不要解释。";
    const user=`已有状态摘要(不是全文):\n${digest.text}\n\n新 turn(${turn.ts}):\n${turn.text.slice(0,800)}\n\n`+
      `输出 JSON:{"type":<${Object.keys(doc.typeDefs).join("|")}>,"thread":<${doc.threadDefs.map(t=>t.id).join("|")}>,`+
      `"title":"≤6字","summary":"一句","excerpt":"≤120字原文短摘"}`;
    const body=JSON.stringify({model:process.env.LIVE_MODEL||"claude-haiku-4-5-20251001",max_tokens:300,
      system:sys,messages:[{role:"user",content:user}]});
    const req=https.request("https://api.anthropic.com/v1/messages",{method:"POST",headers:{
      "content-type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"}},res=>{
      let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{
        const j=JSON.parse(d); const txt=(j.content&&j.content[0]&&j.content[0].text)||"";
        const m=txt.match(/\{[\s\S]*\}/); resolve(JSON.parse(m[0]));
      }catch(e){reject(e);} });});
    req.on("error",reject); req.write(body); req.end();
  });
}

// ---- LLM distiller (OpenRouter / DeepSeek) — preferred; same engine as distill.js.
// Constrains thread to the CURRENT agent's existing threadDefs → reuses lanes (no orphan threads). ----
function orDistill(turn, digest, doc, agent){
  return new Promise((resolve,reject)=>{
    const ids=doc.threadDefs.filter(t=>t.agent===agent).map(t=>t.id);
    const sys="你把【一条用户 turn】蒸馏成 storyline 的一个事件。只输出 JSON,不要解释。";
    const user=`已有状态摘要(不是全文):\n${digest.text}\n\n新 turn(${turn.ts}):\n${turn.text.slice(0,800)}\n\n`+
      `thread 从这些已有 id 选最贴切的一个(尽量复用):${ids.join("|")||"(无)"}。\n`+
      `输出 JSON:{"type":<${Object.keys(doc.typeDefs).join("|")}>,"thread":"<已有 id>","title":"≤6字","summary":"一句","excerpt":"≤120字原文短摘"}`;
    const body=JSON.stringify({model:process.env.LIVE_MODEL||"deepseek/deepseek-v4-pro",max_tokens:400,
      reasoning:{enabled:false}, response_format:{type:"json_object"},
      messages:[{role:"system",content:sys},{role:"user",content:user}]});
    const req=https.request("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{
      "content-type":"application/json","authorization":"Bearer "+process.env.OPENROUTER_API_KEY}},res=>{
      let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{
        const j=JSON.parse(d); if(j.error) return reject(new Error(JSON.stringify(j.error).slice(0,150)));
        const txt=j.choices[0].message.content||""; const m=txt.match(/\{[\s\S]*\}/); resolve(JSON.parse(m[0]));
      }catch(e){reject(e);} });});
    req.on("error",reject); req.write(body); req.end();
  });
}

// ---- one incremental pass ----
async function processOnce(opts={}){
  const doc=JSON.parse(fs.readFileSync(EV,"utf8"));
  doc.coverage=doc.coverage||{sessions:{},totals:{}};
  // backend preference: DeepSeek(OpenRouter) > Haiku(Anthropic) > free heuristic
  const backend = process.env.OPENROUTER_API_KEY ? "deepseek"
                : (process.env.LIVE_LLM==="1" && process.env.ANTHROPIC_API_KEY) ? "haiku" : "heuristic";
  let digest=buildDigest(doc);
  const idset=new Set(doc.events.map(e=>e.id));
  let processed=0, newEvents=0, skips=0, llmCalls=0, tokensIn=0, tokensOut=0;
  const log=[];

  const SESSIONS=sessionsFromDoc(doc);          // watch-list = current manifest (re-read each pass)
  for(const [sid,meta] of Object.entries(SESSIONS)){
    if(!fs.existsSync(meta.file)) continue;
    const cs=(doc.coverage.sessions[sid] ||= {turns:0,extracted:0,merged:0,skipped:0,ledger:[]});
    const byLine=new Map(cs.ledger.map(e=>[e.line,e]));
    const frontier=cs.ledger.reduce((m,e)=>Math.max(m,e.line),0);
    const coveredTexts=()=>doc.events.filter(e=>e.session===sid).map(e=>e.excerpt||e.title);
    const turns=userTurns(meta.file);
    for(const turn of turns){
      const existing=byLine.get(turn.line);
      // process: (a) past frontier (new) OR (b) prior out-of-snapshot (re-evaluate now)
      const isNew = turn.line>frontier && !existing;
      const isOOS = existing && existing.status==="skipped" && existing.reason==="out-of-snapshot" && opts.reprocessOOS;
      if(!isNew && !isOOS) continue;
      processed++;
      const reason=preFilter(turn, coveredTexts());
      if(reason){ upsertLedger(cs,{line:turn.line,ts:turn.ts,status:"skipped",reason,snip:turn.text.slice(0,60)}); skips++;
        log.push(`skip  ${sid} L${turn.line} (${reason})`); continue; }
      // genuine → distill (digest is O(1) input; transcript NEVER sent)
      let fields;
      tokensIn += digest.tokens + approxTokens(turn.text.slice(0,800));
      try{
        if(backend==="deepseek"){ fields=await orDistill(turn,digest,doc,meta.agent); llmCalls++; tokensOut+=120; }
        else if(backend==="haiku"){ fields=await llmDistill(turn,digest,doc); llmCalls++; tokensOut+=120; }
        else fields=heuristicDistill(turn,meta.agent);
      }catch(e){ fields=heuristicDistill(turn,meta.agent); log.push(`  (${backend} err→heuristic: ${e.message})`); }
      if(!doc.typeDefs[fields.type]) fields.type="finding";   // guard invalid type
      ensureThreadDef(doc, fields.thread, meta.agent);   // register so the event renders (no orphan thread)
      let id=`${sid}-${turn.line}`; if(idset.has(id)) id+="-l"; idset.add(id);
      const ev={id,agent:meta.agent,session:sid,line:turn.line,ts:turn.ts,type:fields.type,thread:fields.thread,
        title:String(fields.title).slice(0,8),summary:fields.summary,excerpt:fields.excerpt||turn.text.slice(0,140)};
      // de-dup if reprocessing OOS that somehow already had an event
      doc.events=doc.events.filter(e=>e.id!==id); doc.events.push(ev);
      upsertLedger(cs,{line:turn.line,ts:turn.ts,status:"extracted",eventIds:[id],snip:turn.text.slice(0,60)});
      newEvents++; log.push(`event ${sid} L${turn.line} → ${fields.thread}/${fields.type} «${ev.title}»`);
      digest=buildDigest(doc); // refresh digest cheaply (still bounded)
    }
    cs.turns=turns.length;
    cs.extracted=cs.ledger.filter(e=>e.status==="extracted").length;
    cs.merged=cs.ledger.filter(e=>e.status==="merged").length;
    cs.skipped=cs.ledger.filter(e=>e.status==="skipped").length;
  }
  // recompute totals + write
  const tot={turns:0,extracted:0,merged:0,skipped:0,genuineUncovered:0};
  Object.values(doc.coverage.sessions).forEach(s=>{tot.turns+=s.turns;tot.extracted+=s.extracted;tot.merged+=s.merged;tot.skipped+=s.skipped;});
  doc.coverage.totals=tot;
  doc.events.sort((a,b)=>T(a.ts)-T(b.ts)||a.line-b.line);
  if(newEvents||skips) fs.writeFileSync(EV,JSON.stringify(doc,null,2));
  return {processed,newEvents,skips,llmCalls,backend,
    watched:Object.keys(SESSIONS).length, digestTokens:digest.tokens, tokensIn, tokensOut, log};
}
function upsertLedger(cs,entry){ const i=cs.ledger.findIndex(e=>e.line===entry.line);
  if(i>=0) cs.ledger[i]=entry; else cs.ledger.push(entry); cs.ledger.sort((a,b)=>a.line-b.line); }

// ---- CLI ----
const args=process.argv.slice(2);
const interval=(+(args.find(a=>a.startsWith("--interval="))||"").split("=")[1])||4;
const reprocessOOS=args.includes("--reprocess-oos");
(async()=>{
  if(args.includes("--watch")){
    const be=process.env.OPENROUTER_API_KEY?"deepseek":(process.env.LIVE_LLM==="1"&&process.env.ANTHROPIC_API_KEY?"haiku":"heuristic");
    console.log(`live watch: every ${interval}s · backend=${be} · 监控列表=events.json manifest(导入即扩展)`);
    const tick=async()=>{ try{ const r=await processOnce({reprocessOOS});
      if(r.newEvents||r.skips) console.log(`[update] watched ${r.watched} sessions · +${r.newEvents} events, ${r.skips} skips · digest≈${r.digestTokens}tok · in≈${r.tokensIn}tok (O(1)/turn)`);
      r.log.forEach(x=>console.log("   "+x)); }catch(e){console.error("tick err",e.message);} };
    await tick(); setInterval(tick, interval*1000);
  } else {
    const r=await processOnce({reprocessOOS});
    console.log(`backend=${r.backend} · watching ${r.watched} sessions (from manifest) · processed ${r.processed} new/oos turns → +${r.newEvents} events, ${r.skips} skips`);
    console.log(`per-update input is O(1): digest≈${r.digestTokens} tok; total this run in≈${r.tokensIn} tok, out≈${r.tokensOut} tok (${r.llmCalls} LLM calls)`);
    r.log.forEach(x=>console.log("  "+x));
  }
})();
