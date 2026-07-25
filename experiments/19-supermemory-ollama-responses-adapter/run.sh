#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN="$HERE/.tmp/bin/supermemory-server"
VERSION="0.0.2"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=supermemory-server-darwin-arm64; SHA=89884e8d9c431d4bc3ae3947143aa13cd56af58736740aba4b53dc1faf77dc54 ;;
  Darwin-x86_64) ASSET=supermemory-server-darwin-x64; SHA=c4f355381b5e0ef1b4162e979739d3ae32441cf982e00e2b19badb35a9102633 ;;
  Linux-aarch64) ASSET=supermemory-server-linux-arm64; SHA=90ebd17c42d2d649af328b1a80518d8eacf966ed2444d8cd25ef5e2d9bb0b165 ;;
  Linux-x86_64) ASSET=supermemory-server-linux-x64; SHA=8bf394690807b37786d22a61d3ee64212b7ae82374894e754856134ca60761b4 ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac
mkdir -p "$HERE/.tmp/bin"
if [ ! -f "$BIN" ]; then
  curl -fL --retry 2 "https://github.com/supermemoryai/supermemory/releases/download/server-v${VERSION}/${ASSET}" -o "$BIN.download"
  mv "$BIN.download" "$BIN"
fi
ACTUAL=$(shasum -a 256 "$BIN" | awk '{print $1}')
if [ "$ACTUAL" != "$SHA" ]; then
  echo "Supermemory checksum mismatch: expected $SHA, got $ACTUAL" >&2
  exit 3
fi
chmod +x "$BIN"
command -v ollama >/dev/null || { echo "ollama is required" >&2; exit 4; }
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null || { echo "host Ollama is not listening at 127.0.0.1:11434" >&2; exit 5; }
ollama show qwen3-coder:30b >/dev/null 2>&1 || { echo "required local model is missing: qwen3-coder:30b" >&2; exit 6; }
if [ "${RUN_GPT_OSS:-0}" = 1 ]; then ollama show gpt-oss:20b >/dev/null 2>&1 || { echo "optional local model is missing: gpt-oss:20b" >&2; exit 6; }; fi
npm test
SUPERMEMORY_CHECKSUM_VERIFIED=1 SUPERMEMORY_ARTIFACT="$ASSET" SUPERMEMORY_SHA256="$SHA" node "$HERE/scripts/run-experiment.mjs"
