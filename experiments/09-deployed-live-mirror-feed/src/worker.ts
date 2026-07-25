// Experiment 09 — deployed DO SQL authority with Web standard SSE live feed.
// One DO = one authority. DO SQL = persisted event/revision log. SSE = happy path;
// /events?since=N = gap repair. This is disposable experiment code, not auth'd product.
export interface Env { BRAIN: DurableObjectNamespace; }
export default { async fetch(request: Request, env: Env): Promise<Response> { const id=env.BRAIN.idFromName("singleton"); return env.BRAIN.get(id).fetch(request); } };
type MemoryEvent={revision:number;id:string;client:string;text:string;tags:string[];committedAtNs:string;committedAtMs:number};
const enc=new TextEncoder();
function response(body:unknown,status=200){return Response.json(body,{status,headers:{"cache-control":"no-store"}})}
function tokens(value:string){return value.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean)}
function matches(event:MemoryEvent,q:string){const hay=new Set(tokens(`${event.text} ${(event.tags||[]).join(" ")}`)); return tokens(q).every(n=>[...hay].some(w=>w.includes(n)));}
function sse(type:string,data:unknown,id?:number){return enc.encode(`${id?`id: ${id}\n`:""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)}
export class BrainDO {
  ctx: DurableObjectState; sql: SqlStorage; initialized=false; streams=new Set<WritableStreamDefaultWriter<Uint8Array>>();
  constructor(ctx:DurableObjectState,_env:Env){this.ctx=ctx; this.sql=(ctx.storage as any).sql as SqlStorage;}
  init(){if(this.initialized)return; if(!this.sql)throw new Error("sql unavailable"); this.sql.exec(`CREATE TABLE IF NOT EXISTS events(revision INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,client TEXT,text TEXT,tags TEXT,committed_at_ns TEXT,committed_at_ms INTEGER);`); this.initialized=true;}
  head(){return Number((this.sql.exec(`SELECT COALESCE(MAX(revision),0) AS n FROM events`).one() as any).n)}
  rows(sql:string,...params:any[]):MemoryEvent[]{return this.sql.exec(sql,...params).toArray().map((r:any)=>({revision:Number(r.revision),id:r.id,client:r.client,text:r.text,tags:JSON.parse(r.tags||"[]"),committedAtNs:r.committed_at_ns,committedAtMs:Number(r.committed_at_ms)}));}
  since(n:number){return this.rows(`SELECT * FROM events WHERE revision>? ORDER BY revision ASC`,n)}
  // Live fanout is best-effort and must never hold the durable write response.
  // Experiment 09 remote found awaiting writer.write() against stale/backpressured
  // SSE subscribers can wedge /remember until Cloudflare returns 502/timeouts.
  broadcast(event:MemoryEvent){for(const writer of [...this.streams]){writer.write(sse("memory",event,event.revision)).catch(()=>this.streams.delete(writer));}}
  async remember(request:Request){const b:any=await request.json(); const text=String(b.text||"").trim(); if(!text)return response({ok:false,error:"text required"},400); const id=`mem_${crypto.randomUUID().replaceAll("-","")}`, ns=`${Date.now()}000000`, ms=Date.now(), tags=JSON.stringify(Array.isArray(b.tags)?b.tags:[]); const row=this.sql.exec(`INSERT INTO events(id,client,text,tags,committed_at_ns,committed_at_ms) VALUES(?,?,?,?,?,?) RETURNING revision`,id,String(b.client||"unknown"),text,tags,ns,ms).one() as any; const event=this.since(Number(row.revision)-1)[0]; await this.broadcast(event); return response({ok:true,event,receipt:{revision:event.revision,id:event.id}},201)}
  stream(url:URL){const after=Number(url.searchParams.get("since")||"0"); let writer:WritableStreamDefaultWriter<Uint8Array>; const stream=new TransformStream<Uint8Array,Uint8Array>(); writer=stream.writable.getWriter(); this.ctx.waitUntil((async()=>{await writer.write(sse("hello",{headRevision:this.head()})); for(const event of this.since(after)) await writer.write(sse("memory",event,event.revision)); this.streams.add(writer);})()); return new Response(stream.readable,{headers:{"content-type":"text/event-stream","cache-control":"no-cache, no-store","connection":"keep-alive"}})}
  async fetch(request:Request){this.init(); const url=new URL(request.url); if(request.method==="GET"&&url.pathname==="/health")return response({ok:true,headRevision:this.head(),subscribers:this.streams.size}); if(request.method==="POST"&&url.pathname==="/remember")return this.remember(request); if(request.method==="GET"&&url.pathname==="/events")return response({ok:true,headRevision:this.head(),events:this.since(Number(url.searchParams.get("since")||"0"))}); if(request.method==="GET"&&url.pathname==="/recall"){const q=String(url.searchParams.get("q")||"").trim(); const all=this.since(0).filter(e=>matches(e,q)).slice(-8).reverse(); return response({ok:true,headRevision:this.head(),hits:all});} if(request.method==="GET"&&url.pathname==="/stream")return this.stream(url); return response({ok:false,error:"not found"},404)}
}
