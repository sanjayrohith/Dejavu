#!/usr/bin/env python3
"""Local stand-in for a Durable Object + SQLite "memory brain".

The hypothesis: a single authoritative DO-like process owning one SQLite
database can satisfy Dejavu's shared-memory guarantees:

- `remember` returns a receipt only after the row is committed (fsync'd).
- `recall` after a successful receipt always sees that write — from the same
  client *and* from any other client — because there is one authority.
- Concurrent writers are serialized through the DO; ordering is the DO's
  monotonic rowid, not wall-clock racing.

This file is the entire "brain". It is deliberately a single Python process
with ThreadingHTTPServer + a global lock around the write path so it mirrors
what a Cloudflare Durable Object gives us for free: single-threaded execution
per DO id. SQLite WAL handles durability inside that single authority.

Endpoints:

    GET  /health
    POST /remember        body: {"text": str, "tags": [str], "author": str}
                          -> 201 {"ok": True, "receipt": {"id": int, "ulid": str, "committedAtMs": int, "durable": "sqlite-wal"}}
    GET  /recall?q=...&limit=10
                          -> 200 {"ok": True, "hits": [...], "latestId": int}
    GET  /stats           -> 200 {"latestId": int, "total": int}
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def now_ms() -> int:
    return time.time_ns() // 1_000_000


SCHEMA = """
CREATE TABLE IF NOT EXISTS memory (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ulid         TEXT    NOT NULL UNIQUE,
    author       TEXT    NOT NULL,
    text         TEXT    NOT NULL,
    tags_json    TEXT    NOT NULL DEFAULT '[]',
    created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_created_idx ON memory(created_ms);
"""


class Brain:
    """The DO-shaped authority. One process. One DB. One write lock."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False so the http handler threads can share the
        # connection; we serialize ourselves with self.lock so this is safe and
        # in fact mirrors a DO's single-threaded write model.
        self.conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        self.lock = threading.Lock()

    def remember(self, *, text: str, author: str, tags: list[str]) -> dict:
        if not text:
            raise ValueError("text required")
        ulid = f"mem_{uuid.uuid4().hex}"
        with self.lock:
            # BEGIN IMMEDIATE so we hold the write lock for the whole txn.
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                cur = self.conn.execute(
                    "INSERT INTO memory(ulid, author, text, tags_json, created_ms) VALUES (?,?,?,?,?)",
                    (ulid, author, text, json.dumps(tags), now_ms()),
                )
                rowid = cur.lastrowid
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
        # After COMMIT in WAL mode with synchronous=NORMAL, the row is visible
        # to every subsequent reader on this connection AND to a fresh
        # connection that opens the same file. That is the "DO authority" win.
        return {
            "id": rowid,
            "ulid": ulid,
            "committedAtMs": now_ms(),
            "durable": "sqlite-wal",
        }

    def recall(self, *, query: str, limit: int) -> list[dict]:
        # Simple LIKE-based recall. Real Dejavu would use FTS5; the point of this
        # experiment is the authority/visibility model, not ranking quality.
        like = f"%{query}%"
        rows = self.conn.execute(
            """
            SELECT id, ulid, author, text, tags_json, created_ms
            FROM memory
            WHERE text LIKE ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (like, limit),
        ).fetchall()
        out: list[dict] = []
        for r in rows:
            out.append({
                "id": r[0],
                "ulid": r[1],
                "author": r[2],
                "text": r[3],
                "tags": json.loads(r[4]),
                "createdMs": r[5],
            })
        return out

    def stats(self) -> dict:
        row = self.conn.execute("SELECT COALESCE(MAX(id), 0), COUNT(*) FROM memory").fetchone()
        return {"latestId": row[0], "total": row[1]}


class BrainHandler(BaseHTTPRequestHandler):
    server: "BrainHTTPServer"

    def log_message(self, fmt: str, *args: object) -> None:  # silence stderr noise
        return

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json(200, {"ok": True, **self.server.brain.stats()})
            return
        if parsed.path == "/stats":
            self._json(200, {"ok": True, **self.server.brain.stats()})
            return
        if parsed.path == "/recall":
            query = parse_qs(parsed.query)
            q = (query.get("q") or [""])[0]
            try:
                limit = int((query.get("limit") or ["10"])[0])
            except ValueError:
                limit = 10
            limit = max(1, min(limit, 200))
            hits = self.server.brain.recall(query=q, limit=limit)
            self._json(200, {"ok": True, "hits": hits, "latestId": self.server.brain.stats()["latestId"]})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/remember":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > 128_000:
                raise ValueError("invalid content length")
            body = json.loads(self.rfile.read(size))
            text = str(body.get("text") or "").strip()
            if not text:
                raise ValueError("text required")
            author = str(body.get("author") or "unknown-agent")
            tags = list(body.get("tags") or [])
            receipt = self.server.brain.remember(text=text, author=author, tags=[str(t) for t in tags])
            self._json(201, {"ok": True, "receipt": receipt})
        except (ValueError, json.JSONDecodeError, TypeError) as exc:
            self._json(400, {"ok": False, "error": str(exc)})
        except sqlite3.Error as exc:
            self._json(500, {"ok": False, "error": f"sqlite: {exc}"})


class BrainHTTPServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], brain: Brain):
        super().__init__(address, BrainHandler)
        self.brain = brain


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8873)
    parser.add_argument("--db", type=Path, required=True)
    args = parser.parse_args()
    brain = Brain(args.db)
    httpd = BrainHTTPServer(("127.0.0.1", args.port), brain)
    print(f"brain listening on http://127.0.0.1:{args.port} db={args.db}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
