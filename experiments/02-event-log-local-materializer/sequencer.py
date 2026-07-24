#!/usr/bin/env python3
"""Local stand-in for a DO sequencer + durable R2 append log.

The append receipt is intentionally boring: monotonically assigned `seq`, caller
supplied or generated event id, and a flush+fsync'd JSONL record before success.
Clients ask `/events?after=N` to deterministically catch up.
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def now_ms() -> int:
    return time.time_ns() // 1_000_000


class EventLog:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.events: list[dict] = []
        if self.path.exists():
            for line in self.path.read_text().splitlines():
                if line.strip():
                    self.events.append(json.loads(line))
        self.next_seq = (self.events[-1]["seq"] + 1) if self.events else 1

    def append(self, event_type: str, payload: dict, author: str, event_id: str | None) -> dict:
        with self.lock:
            event = {
                "seq": self.next_seq,
                "id": event_id or f"evt_{uuid.uuid4().hex}",
                "type": event_type,
                "author": author,
                "payload": payload,
                "createdAtMs": now_ms(),
            }
            # A real DO would transact its hot DB / durable state, then persist or
            # segment events to R2. Here fsync is the strongest local receipt we can model.
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, separators=(",", ":")) + "\n")
                f.flush()
                os.fsync(f.fileno())
            self.events.append(event)
            self.next_seq += 1
            return event

    def since(self, after: int) -> list[dict]:
        with self.lock:
            return [event for event in self.events if event["seq"] > after]

    @property
    def latest(self) -> int:
        with self.lock:
            return self.next_seq - 1


class MemoryHandler(BaseHTTPRequestHandler):
    server: "SequencerHTTPServer"

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {"ok": True, "latestSeq": self.server.log.latest})
            return
        if parsed.path == "/events":
            query = parse_qs(parsed.query)
            try:
                after = int((query.get("after") or ["0"])[0])
            except ValueError:
                self._json(400, {"ok": False, "error": "after must be integer"})
                return
            events = self.server.log.since(after)
            self._json(200, {"ok": True, "after": after, "latestSeq": self.server.log.latest, "events": events})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if urlparse(self.path).path != "/append":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > 64_000:
                raise ValueError("invalid content length")
            body = json.loads(self.rfile.read(size))
            event_type = str(body.get("type") or "remember")
            payload = body.get("payload") or {}
            author = str(body.get("author") or "unknown-agent")
            if event_type != "remember":
                raise ValueError("prototype only supports remember")
            text = str(payload.get("text") or "").strip()
            if not text:
                raise ValueError("payload.text required")
            event = self.server.log.append(event_type, {"text": text, "tags": list(payload.get("tags") or [])}, author, body.get("id"))
            self._json(201, {"ok": True, "receipt": {"seq": event["seq"], "eventId": event["id"], "durable": "jsonl-fsync"}, "event": event})
        except (ValueError, json.JSONDecodeError, TypeError) as exc:
            self._json(400, {"ok": False, "error": str(exc)})


class SequencerHTTPServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], log: EventLog):
        super().__init__(address, MemoryHandler)
        self.log = log


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8872)
    parser.add_argument("--log", type=Path, required=True)
    args = parser.parse_args()
    httpd = SequencerHTTPServer(("127.0.0.1", args.port), EventLog(args.log))
    print(f"sequencer listening on http://127.0.0.1:{args.port} log={args.log}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
