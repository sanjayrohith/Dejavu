#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    pos = (len(ordered) - 1) * p
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    frac = pos - lo
    return ordered[lo] * (1 - frac) + ordered[hi] * frac


def post_json(url: str, body: dict) -> tuple[dict, float]:
    data = json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json"})
    start = time.perf_counter()
    with urllib.request.urlopen(request, timeout=5) as response:
        payload = json.loads(response.read())
    return payload, (time.perf_counter() - start) * 1000


def get_json(url: str) -> tuple[dict, float]:
    start = time.perf_counter()
    with urllib.request.urlopen(url, timeout=5) as response:
        payload = json.loads(response.read())
    return payload, (time.perf_counter() - start) * 1000


class MaterializedMemory:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS events (
              seq INTEGER PRIMARY KEY,
              id TEXT NOT NULL UNIQUE,
              text TEXT NOT NULL,
              tags TEXT NOT NULL,
              author TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
              text, tags, content='events', content_rowid='seq'
            );
            CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
              INSERT INTO events_fts(rowid, text, tags) VALUES (new.seq, new.text, new.tags);
            END;
            """
        )
        self.db.commit()
        self.last_seq = self.db.execute("SELECT COALESCE(MAX(seq), 0) FROM events").fetchone()[0]

    def apply(self, events: list[dict]) -> int:
        rows = 0
        for event in events:
            payload = event["payload"]
            cur = self.db.execute(
                "INSERT OR IGNORE INTO events(seq, id, text, tags, author) VALUES (?, ?, ?, ?, ?)",
                (event["seq"], event["id"], payload["text"], json.dumps(payload.get("tags", [])), event["author"]),
            )
            rows += cur.rowcount
            self.last_seq = max(self.last_seq, int(event["seq"]))
        self.db.commit()
        return rows

    def recall(self, query: str) -> list[tuple[int, str]]:
        safe = " ".join(part.replace('"', "") for part in query.split() if part.strip())
        if not safe:
            return []
        return self.db.execute(
            "SELECT events.seq, events.text FROM events_fts JOIN events ON events_fts.rowid = events.seq WHERE events_fts MATCH ? ORDER BY bm25(events_fts) LIMIT 8",
            (safe,),
        ).fetchall()

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    def close(self) -> None:
        self.db.close()


def pull(base: str, memory: MaterializedMemory) -> tuple[int, float, int]:
    payload, ms = get_json(f"{base}/events?" + urllib.parse.urlencode({"after": memory.last_seq}))
    applied = memory.apply(payload["events"])
    return applied, ms, int(payload["latestSeq"])


def fmt_stats(values: list[float]) -> str:
    return f"p50 {statistics.median(values):.2f} ms · p95 {percentile(values, .95):.2f} ms · max {max(values):.2f} ms"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root = args.out.parent / ".tmp"
    alice = MaterializedMemory(root / "alice.sqlite")
    bob = MaterializedMemory(root / "bob.sqlite")
    append_ms: list[float] = []
    local_apply_ms: list[float] = []
    local_recall_ms: list[float] = []
    catch_up_ms: list[float] = []
    immediate_ok = 0
    bob_ok = 0

    try:
        for i in range(40):
            phrase = f"mars pigeon receipt needle{i}"
            response, ms = post_json(
                f"{args.base}/append",
                {"author": "alice", "type": "remember", "payload": {"text": phrase, "tags": ["experiment", "needle"]}},
            )
            append_ms.append(ms)
            event = response["event"]
            start = time.perf_counter()
            alice.apply([event])
            local_apply_ms.append((time.perf_counter() - start) * 1000)
            start = time.perf_counter()
            hits = alice.recall(f"needle{i}")
            local_recall_ms.append((time.perf_counter() - start) * 1000)
            immediate_ok += int(any(f"needle{i}" in text for _, text in hits))
            start = time.perf_counter()
            pull(args.base, bob)
            catch_up_ms.append((time.perf_counter() - start) * 1000)
            bob_ok += int(any(f"needle{i}" in text for _, text in bob.recall(f"needle{i}")))

        def append_concurrent(i: int) -> int:
            response, _ = post_json(
                f"{args.base}/append",
                {"author": f"writer-{i % 4}", "type": "remember", "payload": {"text": f"concurrent flock token{i}", "tags": ["concurrent"]}},
            )
            return int(response["receipt"]["seq"])

        with ThreadPoolExecutor(max_workers=8) as pool:
            seqs = list(pool.map(append_concurrent, range(24)))
        concurrency_unique = len(set(seqs)) == len(seqs)
        concurrency_contiguous = sorted(seqs) == list(range(min(seqs), max(seqs) + 1))
        bob_applied, final_pull_http_ms, latest = pull(args.base, bob)
        flock_hits = bob.recall("flock")
        concurrent_visible = len(flock_hits) > 0 and bob.count() >= 64
        passed = immediate_ok == 40 and bob_ok == 40 and concurrency_unique and concurrency_contiguous and concurrent_visible

        result = f"""# Result — Experiment 02 event log + local materializer

Run verdict: **{'PASS' if passed else 'FAIL'}**

## Observed locally

- Writer append receipts: **{fmt_stats(append_ms)}** across 40 sequential writes.
- Apply acked event to writer-local SQLite FTS: **{fmt_stats(local_apply_ms)}**.
- Warm local FTS recall after apply: **{fmt_stats(local_recall_ms)}**.
- Other-client pull + SQLite materialization: **{fmt_stats(catch_up_ms)}**.
- Immediate writer read-after-write after ack/apply: **{immediate_ok}/40**.
- Second-client catch-up then recall: **{bob_ok}/40**.
- Concurrent append receipt sequences: **unique={str(concurrency_unique).lower()}**, **contiguous={str(concurrency_contiguous).lower()}** over 24 requests.
- Final second-client catch-up applied **{bob_applied}** concurrent events; HTTP fetch portion **{final_pull_http_ms:.2f} ms**; latest sequence **{latest}**.
- Second materialized DB rows: **{bob.count()}**.

## What this says

This design can make durable writes crisp: the sequencer responds only after the
append log is fsync'd, and a client can apply that exact acked event locally and
recall it with local FTS immediately. Another runtime deterministically catches up
by sequence and sees the same memory without any ambiguous indexing phase.

## What is still suspicious

- The writer's "immediate" read is immediate only after it applies its own
  receipt locally. That is simple in one SDK, but it is still protocol logic.
- Another client does **not** see the write until it fetches or receives a live
  fanout event. A real product would need a DO subscription/WebSocket/SSE or
  fetch-on-recall rule.
- This uses JSONL + local fsync, not real Durable Objects or R2 segments. R2
  segment flush, snapshots, and compaction are untested.
- SQLite FTS5 is available in local Python here; browser/Worker WASM parity is
  a separate question.

Command: `./run.sh`
"""
        args.out.write_text(result)
        print(f"wrote {args.out} verdict={'PASS' if passed else 'FAIL'}")
        if not passed:
            raise SystemExit(1)
    finally:
        alice.close()
        bob.close()


if __name__ == "__main__":
    main()
