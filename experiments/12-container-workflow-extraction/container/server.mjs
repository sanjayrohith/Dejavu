import http from "node:http";

const port = 8080;
const target = process.env.SUPERMEMORY_BASE_URL ?? "http://host.docker.internal:6767";

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, target, pid: process.pid }));
      return;
    }
    if (!request.url?.startsWith("/supermemory/")) {
      response.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstreamPath = request.url.slice("/supermemory".length);
    const upstream = await fetch(new URL(upstreamPath, target), {
      method: request.method,
      headers: {
        "authorization": request.headers.authorization ?? "",
        "content-type": request.headers["content-type"] ?? "application/json"
      },
      body: chunks.length ? Buffer.concat(chunks) : undefined
    });
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: String(error), target }));
  }
});

server.listen(port, "0.0.0.0", () => console.log(`bridge listening on ${port}, target=${target}`));
