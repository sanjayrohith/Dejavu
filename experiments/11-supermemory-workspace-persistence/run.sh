#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FS_PORT=${FS_PORT:-8911}
CONTAINER_PORT=${CONTAINER_PORT:-8912}
STATE="$HERE/.tmp/wrangler"
MARKER="workspace-persist-$(date +%s)-$RANDOM"
mkdir -p "$HERE/.tmp"
FS_PID=""
CONTAINER_PID=""

stop_port() {
  local port=$1 pid=${2:-}
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  sleep .3
  local pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$pids" ] || echo "$pids" | xargs kill 2>/dev/null || true
}

cleanup() {
  stop_port "$FS_PORT" "$FS_PID"
  stop_port "$CONTAINER_PORT" "$CONTAINER_PID"
}
trap cleanup EXIT INT TERM

wait_url() {
  local url=$1 pid=$2
  for _ in $(seq 1 180); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep .2
  done
  return 1
}

start_fs() {
  wrangler dev --config "$HERE/wrangler.fs.jsonc" --port "$FS_PORT" --persist-to "$STATE" >"$HERE/.tmp/fs.log" 2>&1 &
  FS_PID=$!
  wait_url "http://127.0.0.1:$FS_PORT/health" "$FS_PID"
}

rm -rf "$STATE"
start_fs
printf '%s' "$MARKER" | curl -fsS -X PUT --data-binary @- "http://127.0.0.1:$FS_PORT/workspace/exp11/supermemory-data/probe.txt"
BEFORE=$(curl -fsS "http://127.0.0.1:$FS_PORT/workspace/exp11/supermemory-data/probe.txt")
stop_port "$FS_PORT" "$FS_PID"
start_fs
AFTER=$(curl -fsS "http://127.0.0.1:$FS_PORT/workspace/exp11/supermemory-data/probe.txt")
stop_port "$FS_PORT" "$FS_PID"
[ "$BEFORE" = "$MARKER" ] && [ "$AFTER" = "$MARKER" ] || { echo "Workspace restart persistence failed" >&2; exit 1; }

# The matching x64 binary is baked into the real Workspace wsd image. This
# probes execution and writes provider state under the Workspace mount. Local
# Container parity may fail before the command reaches the binary; preserve it.
wrangler dev --config "$HERE/wrangler.container.jsonc" --port "$CONTAINER_PORT" --persist-to "$STATE-container" >"$HERE/.tmp/container.log" 2>&1 &
CONTAINER_PID=$!
CONTAINER_JSON='{"ok":false,"stage":"wrangler-start","error":"server did not start"}'
if wait_url "http://127.0.0.1:$CONTAINER_PORT/health" "$CONTAINER_PID"; then
  COMMAND='set -eu; sha256sum /usr/local/bin/supermemory-server; mkdir -p /workspace/supermemory-data; SUPERMEMORY_SKIP_EMBEDDING_PREWARM=1 SUPERMEMORY_DATA_DIR=/workspace/supermemory-data OPENAI_BASE_URL=http://host.docker.internal:11434/v1 OPENAI_API_KEY=ollama OPENAI_MODEL=gpt-oss:20b PORT=6767 /usr/local/bin/supermemory-server >/tmp/supermemory.log 2>&1 & p=$!; for i in $(seq 1 80); do curl -fsS http://127.0.0.1:6767/ >/dev/null 2>&1 && break; sleep .25; done; curl -fsS http://127.0.0.1:6767/ >/dev/null; kill $p; wait $p 2>/dev/null || true; test -f /workspace/supermemory-data/probe.txt || echo native-started > /workspace/supermemory-data/probe.txt; find /workspace/supermemory-data -maxdepth 2 -type f -print | sort'
  set +e
  CONTAINER_JSON=$(curl -sS --max-time 90 -X POST "http://127.0.0.1:$CONTAINER_PORT/probe" -H 'content-type: application/json' --data "$(node -e 'console.log(JSON.stringify({command:process.argv[1]}))' "$COMMAND")")
  CONTAINER_CURL=$?
  set -e
  [ "$CONTAINER_CURL" -eq 0 ] || CONTAINER_JSON=$(printf '{"ok":false,"stage":"probe-http","error":"curl exit %s"}' "$CONTAINER_CURL")
fi
stop_port "$CONTAINER_PORT" "$CONTAINER_PID"

node - "$MARKER" "$CONTAINER_JSON" <<'NODE' > "$HERE/.tmp/result.json"
const [marker, raw] = process.argv.slice(2);
let container;
try { container = JSON.parse(raw); } catch { container = { ok:false, stage:"invalid-response", error:raw.slice(0,500) }; }
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  workspace: { package:"0.0.0-alpha.7", restartPersisted:true, markerSha256:require("node:crypto").createHash("sha256").update(marker).digest("hex").slice(0,12) },
  supermemory: { version:"0.0.2", artifact:"linux-x64", checksum:"8bf394690807b37786d22a61d3ee64212b7ae82374894e754856134ca60761b4", container },
}, null, 2));
NODE

node "$HERE/scripts/render-result.mjs" "$HERE/.tmp/result.json" "$HERE/RESULT.md"
echo "PASS: Workspace bytes survived Wrangler restart"
node -e 'const r=require(process.argv[1]); console.log(`Container native execution: ${r.supermemory.container.ok ? "PASS" : "BLOCKED at "+r.supermemory.container.stage}`)' "$HERE/.tmp/result.json"
