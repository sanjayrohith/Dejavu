import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const tokenize = (value) => String(value).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
const ftsQuery = (q) => tokenize(q).map((t) => `${t}*`).join(" ");
async function requestJson(base, method, path, body) {
  const t0 = performance.now();
  const res = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return { data, ms: performance.now() - t0 };
}
export class LiveMirrorClient {
  constructor({ base, name, dbPath = ":memory:" }) {
    this.base = base;
    this.name = name;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory (revision INTEGER PRIMARY KEY, id TEXT UNIQUE, client TEXT, text TEXT, tags TEXT, committedAtNs TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, tags, content='memory', content_rowid='revision');
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta(k,v) VALUES('revision',0);`);
    this.getRevisionStmt = this.db.prepare(`SELECT v FROM meta WHERE k='revision'`);
    this.setRevisionStmt = this.db.prepare(`UPDATE meta SET v=? WHERE k='revision'`);
    this.hasStmt = this.db.prepare(`SELECT revision FROM memory WHERE revision=?`);
    this.insertStmt = this.db.prepare(`INSERT OR IGNORE INTO memory(revision,id,client,text,tags,committedAtNs) VALUES(?,?,?,?,?,?)`);
    this.ftsStmt = this.db.prepare(`INSERT INTO memory_fts(rowid,text,tags) VALUES(?,?,?)`);
    this.recallStmt = this.db.prepare(`SELECT m.revision,m.id,m.client,m.text,m.tags,m.committedAtNs FROM memory_fts f JOIN memory m ON m.revision=f.rowid WHERE memory_fts MATCH ? ORDER BY m.revision DESC LIMIT 8`);
    this.streamAbort = null;
    this.connected = false;
    this.helloHead = 0;
    this.streamErrors = 0;
    this.eventWaiters = [];
    this.streamTask = null;
  }
  revision() { return Number(this.getRevisionStmt.get().v); }
  close() { this.disconnect(); this.db.close(); }
  advanceWatermark() { let rev = this.revision(); while (this.hasStmt.get(rev + 1)) rev++; this.setRevisionStmt.run(rev); return rev; }
  apply(event, source = "event") {
    if (this.hasStmt.get(event.revision)) return false;
    this.insertStmt.run(event.revision, event.id, event.client, event.text, JSON.stringify(event.tags || []), event.committedAtNs || "");
    this.ftsStmt.run(event.revision, event.text, JSON.stringify(event.tags || []));
    this.advanceWatermark();
    for (const waiter of this.eventWaiters.splice(0)) waiter(event, source);
    return true;
  }
  recallLocal(q) {
    const t0 = performance.now();
    const query = ftsQuery(q);
    const hits = query ? this.recallStmt.all(query) : [];
    return { hits, ms: performance.now() - t0, revision: this.revision(), connected: this.connected };
  }
  async remember(text, tags = []) {
    const result = await requestJson(this.base, "POST", "/remember", { client: this.name, text, tags });
    const t0 = performance.now();
    this.apply(result.data.event, "own-ack");
    return { ...result, event: result.data.event, localApplyMs: performance.now() - t0 };
  }
  async recallAuth(q) { const r = await requestJson(this.base, "GET", `/recall?q=${encodeURIComponent(q)}`); return { ...r, hits: r.data.hits }; }
  async catchUp() {
    const t0 = performance.now();
    const result = await requestJson(this.base, "GET", `/events?since=${this.revision()}`);
    let applied = 0;
    for (const event of result.data.events) if (this.apply(event, "catch-up")) applied++;
    return { applied, headRevision: result.data.headRevision, revision: this.revision(), ms: performance.now() - t0 };
  }
  async freshness() {
    const r = await requestJson(this.base, "GET", "/health");
    return { revision: this.revision(), headRevision: r.data.headRevision, behind: r.data.headRevision - this.revision(), fresh: r.data.headRevision === this.revision(), connected: this.connected, ms: r.ms };
  }
  waitForEvent(timeoutMs = 1000) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("event timeout")), timeoutMs); this.eventWaiters.push((event, source) => { clearTimeout(timer); resolve({ event, source }); }); }); }
  disconnect() { if (this.streamAbort) this.streamAbort.abort(); this.streamAbort = null; this.connected = false; }
  async connect() {
    this.disconnect();
    const ctrl = new AbortController();
    this.streamAbort = ctrl;
    const res = await fetch(`${this.base}/stream?since=${this.revision()}`, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    this.connected = true;
    this.streamTask = this.consumeSse(res.body.getReader(), ctrl.signal).catch((error) => { if (!ctrl.signal.aborted) { this.streamErrors++; this.connected = false; } });
    return true;
  }
  async consumeSse(reader, signal) {
    const decoder = new TextDecoder(); let buf = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n\n"); if (idx < 0) break;
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let eventType = "message", data = "";
        for (const line of block.split("\n")) { if (line.startsWith("event: ")) eventType = line.slice(7); if (line.startsWith("data: ")) data += line.slice(6); }
        if (eventType === "hello") { try { this.helloHead = JSON.parse(data).headRevision || 0; } catch {} }
        if (eventType === "memory" && data) this.apply(JSON.parse(data), "stream");
      }
    }
    this.connected = false;
  }
}
