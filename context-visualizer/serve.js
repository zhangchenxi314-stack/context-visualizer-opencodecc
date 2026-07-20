// conv-viz-storyline — zero-dep local server: provenance + import. OpenCode port.
//   • serves index.html / events.json / assets from this folder
//   • GET  /source?session=<id>&line=<n>&ctx=<k>  → real turn at that jsonl line (+/- ctx)
//   • GET  /list                                  → .jsonl files under OP_SESSIONS_DIR (for the import picker)
//   • POST /distill {paths:[...]|path, mode}      → distill those logs → audit → swap events.json if ❌=0
//   • POST /redistill                             → incremental re-distill of manifest sessions (rollback on gate fail)
//     ↑ both STREAM NDJSON (one {type:log|done|error} per line) so the browser shows a live log in real time
//
// Data source: OP_SESSIONS_DIR env var (default ./opencode-sessions). Supports both
// Claude Code ~/.claude/projects/**/*.jsonl and OpenCode export opencode-sessions/<agent>/<session>.jsonl.
//   run:  node serve.js          (PORT env optional, default 8123)
const http=require("http"), fs=require("fs"), path=require("path"), readline=require("readline");
const { execFile, spawn }=require("child_process");

const ROOT=__dirname, PORT=process.env.PORT||8123;
const PROJ=path.resolve(process.env.OP_SESSIONS_DIR || path.join(ROOT, "opencode-sessions"));
const EV=path.join(ROOT,"events.json");
const MIME={ ".html":"text/html; charset=utf-8",".json":"application/json; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".md":"text/markdown; charset=utf-8" };

// ---- data-driven allowlist: session id → {agent, path} from events.json manifest ----
let SESSION_MANIFEST={};
function loadManifest(){ try{ const d=JSON.parse(fs.readFileSync(EV,"utf8"));
  SESSION_MANIFEST={}; (d.manifest||[]).forEach(m=>{ SESSION_MANIFEST[m.id]={agent:m.agent,path:m.sourcePath}; });
}catch(e){ /* events.json may be mid-rewrite */ } }
loadManifest();

// ---- path guard: only JSONL files under sessions dir ----
function safeJsonl(p){ try{ const full=path.resolve(p); const root=path.resolve(PROJ);
  return full.toLowerCase().startsWith(root.toLowerCase()+path.sep) && /\.jsonl$/i.test(full) && fs.existsSync(full) ? full : null;
}catch(e){ return null; } }

function summarize(o){
  if(!o||typeof o!=="object") return {role:"?",ts:"",text:""};
  if(o.type==="queue-operation"&&o.operation==="enqueue"){
    let c=(o.content||"").replace(/<current_note>[\s\S]*?<\/current_note>/g,"").replace(/<editor_selection>[\s\S]*?<\/editor_selection>/g,"").trim();
    return {role:"user",ts:o.timestamp||"",text:c}; }
  if(o.type==="user"&&o.message&&o.message.role==="user"){          // 标准 Claude Code 用户消息(provenance 下钻)
    const c=o.message.content; let parts=[];
    if(typeof c==="string") parts.push(c);
    else if(Array.isArray(c)) c.forEach(b=>{ if(b.type==="text")parts.push(b.text);
      else if(b.type==="image")parts.push("〔图片〕"); else if(b.type==="tool_result")parts.push("〔tool_result〕"); });
    return {role:"user",ts:o.timestamp||"",text:parts.join("\n\n").trim()}; }
  if(o.type==="assistant"&&o.message&&Array.isArray(o.message.content)){
    let parts=[]; o.message.content.forEach(b=>{ if(b.type==="text")parts.push(b.text);
      else if(b.type==="thinking")parts.push("〔thinking〕 "+(b.thinking||""));
      else if(b.type==="tool_use")parts.push("〔tool: "+b.name+"〕 "+JSON.stringify(b.input||{}).slice(0,300)); });
    return {role:"assistant",ts:o.timestamp||"",text:parts.join("\n\n")}; }
  let txt=""; if(o.toolUseResult) txt=(typeof o.toolUseResult==="string"?o.toolUseResult:JSON.stringify(o.toolUseResult)).slice(0,1500);
  return {role:o.type||"meta",ts:o.timestamp||"",text:txt};
}
function readLines(file,line,ctx){ return new Promise((resolve,reject)=>{
  const lo=Math.max(1,line-ctx),hi=line+ctx,cap={}; let n=0,done=false;
  const stream=fs.createReadStream(file,{encoding:"utf8"}); const rl=readline.createInterface({input:stream,crlfDelay:Infinity});
  rl.on("line",l=>{ n++; if(n>=lo&&n<=hi)cap[n]=l; if(n>=hi&&!done){done=true;rl.close();stream.destroy();} });
  rl.on("close",()=>resolve(cap)); rl.on("error",reject); stream.on("error",reject); }); }

const sendJSON=(res,code,obj)=>{ res.writeHead(code,{"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(obj)); };

async function handleSource(res,q){
  let sess=SESSION_MANIFEST[q.get("session")];
  if(!sess){ loadManifest(); sess=SESSION_MANIFEST[q.get("session")]; }   // reload once (events.json may have changed)
  if(!sess) return sendJSON(res,404,{error:"unknown session"});
  const line=Math.max(1,parseInt(q.get("line"),10)||1), ctx=Math.max(0,Math.min(10,parseInt(q.get("ctx"),10)||0));
  try{ const cap=await readLines(sess.path,line,ctx); const raw=cap[line];
    let parsed; try{parsed=JSON.parse(raw);}catch(e){ return sendJSON(res,200,{error:"unparseable",session:q.get("session"),file:path.basename(sess.path),line,raw:(raw||"").slice(0,500)}); }
    const s=summarize(parsed); const contextLines=[];
    for(const k of Object.keys(cap).map(Number).sort((a,b)=>a-b)){ if(k===line)continue; let o; try{o=JSON.parse(cap[k]);}catch(e){continue;} const cs=summarize(o); contextLines.push({line:k,role:cs.role,text:(cs.text||"").replace(/\s+/g," ").slice(0,140)}); }
    sendJSON(res,200,{session:q.get("session"),agent:sess.agent,file:path.basename(sess.path),line,role:s.role,ts:s.ts,text:s.text,contextLines});
  }catch(err){ sendJSON(res,500,{error:String(err)}); }
}

// list jsonl under sessions dir (recursive scan for **/*.jsonl)
function listJsonl(){ const out=[];
  const walk = (dir, project) => {
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isFile() && /\.jsonl$/i.test(e.name)) {
        try { const st = fs.statSync(fp);
          out.push({ project: project || path.basename(dir), name: e.name, path: fp, sizeMB: +(st.size / 1048576).toFixed(2), mtime: st.mtimeMs }); } catch (e) {}
      } else if (e.isDirectory() && !e.name.startsWith(".")) {
        walk(fp, e.name);
      }
    }
  };
  walk(PROJ, "");
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---- live-log streaming: NDJSON (one JSON object per line) so the browser sees progress in real time ----
function startStream(res){ res.writeHead(200,{ "content-type":"application/x-ndjson; charset=utf-8",
  "cache-control":"no-store", "x-accel-buffering":"no", "connection":"keep-alive" }); }
function ndjson(res,obj){ if(!res.writableEnded){ try{ res.write(JSON.stringify(obj)+"\n"); }catch(_){} } }
// run a child, stream its stdout+stderr to res line-by-line, then onDone(exitCode)
function streamProc(res, args, label, onDone){
  ndjson(res,{type:"log",line:`$ ${label}`});
  const ch=spawn("node",args,{cwd:ROOT});
  let buf="";
  const pump=src=>src.on("data",d=>{ buf+=d.toString(); let i;
    while((i=buf.indexOf("\n"))>=0){ const ln=buf.slice(0,i); buf=buf.slice(i+1); if(ln.trim()!=="") ndjson(res,{type:"log",line:ln}); } });
  pump(ch.stdout); pump(ch.stderr);
  const onClose=res.on("close",()=>{ try{ch.kill();}catch(_){} });
  ch.on("close",code=>{ if(buf.trim()!=="") ndjson(res,{type:"log",line:buf}); buf=""; onDone(code); });
  ch.on("error",e=>{ ndjson(res,{type:"log",line:"spawn error: "+e.message}); onDone(-1); });
}

// distill <paths> (mode add|replace) → audit-gate the candidate → atomic-swap events.json only if ❌=0
function runDistillSwap(safe, mode, res){
  if(!safe.length){ ndjson(res,{type:"error",error:"no valid .jsonl under ~/.claude/projects"}); return res.end(); }
  const args=["--env-file=.env","distill.js","--out","_import.json"];
  if(mode!=="replace") args.push("--merge","events.json");
  args.push(...safe);
  streamProc(res, args, `蒸馏 ${safe.length} 个会话${mode!=="replace"?"(增量合并)":""}`, code=>{
    if(code!==0){ ndjson(res,{type:"error",error:`distill 进程退出码 ${code}`}); return res.end(); }
    streamProc(res, ["coverage-audit.js","_import.json"], "信任审计 (coverage-audit)", code2=>{
      if(code2!==0){ try{fs.unlinkSync(path.join(ROOT,"_import.json"));}catch(_){}
        ndjson(res,{type:"error",error:"审计未过 (❌≠0) — events.json 未替换"}); return res.end(); }
      try{ fs.renameSync(path.join(ROOT,"_import.json"), EV); loadManifest();
        const d=JSON.parse(fs.readFileSync(EV,"utf8"));
        ndjson(res,{type:"done",ok:true,events:d.events.length,sessions:d.manifest.length});
      }catch(e){ ndjson(res,{type:"error",error:"swap 失败: "+e.message}); }
      res.end();
    });
  });
}
function handleDistill(req,res){
  let body=""; req.on("data",c=>{ body+=c; if(body.length>1e5) req.destroy(); });
  req.on("end",()=>{
    let j={}; try{ j=JSON.parse(body||"{}"); }catch(e){ return sendJSON(res,400,{error:"bad json"}); }
    const raw=Array.isArray(j.paths)?j.paths:(j.path?[j.path]:[]);
    startStream(res);
    runDistillSwap(raw.map(safeJsonl).filter(Boolean), j.mode, res);
  });
}
// manual refresh: INCREMENTAL re-distill — process only NEW turns (past frontier) for the manifest's
// sessions via live-update.js --once (DeepSeek backend from .env; fast/responsive, not a full rebuild).
// Backup events.json first; restore if the audit gate doesn't pass (trust contract never broken).
function handleRedistill(req,res){
  if(!fs.existsSync(EV)) return sendJSON(res,500,{error:"no events.json — import a conversation first"});
  startStream(res);
  const bak=path.join(ROOT,"_redistill.bak.json");
  fs.copyFileSync(EV, bak);
  streamProc(res, ["--env-file=.env","live-update.js","--once"], "增量重蒸 (只处理新增 turn)", code=>{
    if(code!==0){ try{fs.copyFileSync(bak,EV);}catch(_){}; try{fs.unlinkSync(bak);}catch(_){};
      ndjson(res,{type:"error",error:`refresh 进程退出码 ${code} — 已回滚`}); return res.end(); }
    streamProc(res, ["coverage-audit.js"], "信任审计 (coverage-audit)", code2=>{
      if(code2!==0){ try{fs.copyFileSync(bak,EV);}catch(_){}; try{fs.unlinkSync(bak);}catch(_){};   // restore on gate fail
        ndjson(res,{type:"error",error:"审计未过 (❌≠0) — 已回滚"}); return res.end(); }
      try{fs.unlinkSync(bak);}catch(_){}; loadManifest();
      const d=JSON.parse(fs.readFileSync(EV,"utf8"));
      ndjson(res,{type:"done",ok:true,events:d.events.length,sessions:d.manifest.length});
      res.end();
    });
  });
}

function serveStatic(res,pathname){
  let rel=pathname==="/"?"index.html":decodeURIComponent(pathname.replace(/^\/+/,""));
  const full=path.normalize(path.join(ROOT,rel));
  if(!full.startsWith(ROOT)){ res.writeHead(403); return res.end("forbidden"); }
  if(/(^|[\\/])\.env/i.test(rel)){ res.writeHead(403); return res.end("forbidden"); }   // never serve .env
  fs.readFile(full,(err,buf)=>{ if(err){res.writeHead(404);return res.end("not found");}
    res.writeHead(200,{"content-type":MIME[path.extname(full).toLowerCase()]||"application/octet-stream","cache-control":"no-store"}); res.end(buf); });
}

const server=http.createServer((req,res)=>{
  const u=new URL(req.url,"http://localhost");
  if(u.pathname==="/source") return handleSource(res,u.searchParams);
  if(u.pathname==="/list") return sendJSON(res,200,{root:PROJ,files:listJsonl()});
  if(u.pathname==="/distill"&&req.method==="POST") return handleDistill(req,res);
  if(u.pathname==="/redistill"&&req.method==="POST") return handleRedistill(req,res);
  serveStatic(res,u.pathname);
});
server.on("error",e=>{
  if(e.code==="EADDRINUSE"){ console.log(`端口 ${PORT} 已被占用 —— 大概率服务已在运行 → http://localhost:${PORT}`); process.exit(0); }
  console.error("server error:",e.message); process.exit(1);
});
server.listen(PORT, ()=> console.log(`conv-viz-storyline → http://localhost:${PORT}  (/source · /list · /distill · /redistill)`));
