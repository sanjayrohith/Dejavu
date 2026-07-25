import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

const args = process.argv.slice(2);
const pick = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const port = Number(pick("--port", "8898"));
let revision = 0;
const events = [];
const subscribers = new Set();

const tokenize = (value) => String(value).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
const matches = (event, query) => {
  const hay = new Set(tokenize(`${event.text} ${(event.tags || []).join(" ")}`));
  return tokenize(query).every((needle) => [...hay].some((word) => word.includes(needle)));
};
function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length, "cache-control": "no-store" });
  res.end(data);
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function wireEvent(event) {
  return `id: ${event.revision}\nevent: memory\ndata: ${JSON.stringify(event)}\n\n`;
}
function broadcast(event) {
  const wire = wireEvent(event);
  for (const res of subscribers) {
    try { res.write(wire); } catch { subscribers.delete(res); }
  }
}
function append({ client = "unknown", text, tags = [] }) {
  const event = { revision: ++revision, id: `mem_${randomUUID().replaceAll("-", "")}`, client, text, tags, committedAtNs: process.hrtime.bigint().toString(), committedAtMs: Date.now() };
  events.push(event);
  broadcast(event);
  return event;
}
function since(n) { return events.filter((event) => event.revision > n); }

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, headRevision: revision, subscribers: subscribers.size });
    if (req.method === "POST" && url.pathname === "/remember") {
      const input = await body(req);
      const text = String(input.text || "").trim();
      if (!text) return json(res, 400, { ok: false, error: "text required" });
      const event = append({ client: String(input.client || "unknown"), text, tags: Array.isArray(input.tags) ? input.tags : [] });
      return json(res, 201, { ok: true, event, receipt: { revision: event.revision, id: event.id } });
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const after = Number(url.searchParams.get("since") || "0");
      return json(res, 200, { ok: true, headRevision: revision, events: since(after) });
    }
    if (req.method === "GET" && url.pathname === "/recall") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json(res, 400, { ok: false, error: "q required" });
      return json(res, 200, { ok: true, headRevision: revision, hits: events.filter((event) => matches(event, q)).slice(-8).reverse() });
    }
    if (req.method === "GET" && url.pathname === "/stream") {
      const after = Number(url.searchParams.get("since") || "0");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-store", connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ headRevision: revision })}\n\n`);
      for (const event of since(after)) res.write(wireEvent(event));
      subscribers.add(res);
      const keepalive = setInterval(() => { try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {} }, 1000);
      req.on("close", () => { clearInterval(keepalive); subscribers.delete(res); });
      return;
    }
    return json(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error?.stack || error) });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`authority stream listening ${port}`));
