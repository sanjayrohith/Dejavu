import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(arg("--port", "8897"));
const rememberMs = Number(arg("--remember-ms", "235"));
const recallMs = Number(arg("--recall-ms", "188"));
let seq = 0;
const slips = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function send(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
  res.end(bytes);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function tokenize(s) {
  return String(s).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}
function matches(slip, query) {
  const hay = new Set(tokenize(`${slip.text} ${(slip.tags || []).join(" ")}`));
  return tokenize(query).every((token) => [...hay].some((candidate) => candidate.includes(token)));
}
function recall(q, limit = 8) {
  return slips.filter((slip) => matches(slip, q)).slice(-limit).reverse();
}
function recents(limit = 8) {
  return slips.slice(-limit).reverse();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, count: slips.length, seq, rememberMs, recallMs });
    }
    if (req.method === "POST" && url.pathname === "/remember") {
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return send(res, 400, { ok: false, error: "text required" });
      await delay(rememberMs);
      const slip = {
        id: `slip_${randomUUID().replaceAll("-", "")}`,
        seq: ++seq,
        text,
        tags: Array.isArray(body.tags) ? body.tags : [],
        createdAt: Date.now(),
      };
      slips.push(slip);
      return send(res, 201, { ok: true, slip, receipt: { seq: slip.seq, committed: true } });
    }
    if (req.method === "GET" && url.pathname === "/recall") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return send(res, 400, { ok: false, error: "q required" });
      await delay(recallMs);
      return send(res, 200, { ok: true, q, headSeq: seq, hits: recall(q) });
    }
    if (req.method === "GET" && url.pathname === "/recents") {
      await delay(recallMs);
      return send(res, 200, { ok: true, headSeq: seq, hits: recents(Number(url.searchParams.get("limit") || "8")) });
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error?.stack || error) });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`authority http://127.0.0.1:${port} remember=${rememberMs} recall=${recallMs}`));
