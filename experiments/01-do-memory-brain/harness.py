#!/usr/bin/env python3
"""Harness for experiment 01: DO-like memory brain.

Tests, in order:

1. Single-client remember -> immediate recall.
2. Receipt-then-second-client recall (a *separate* HTTP client object,
   modeling a different agent process talking to the same DO).
3. Concurrency: N parallel writers; verify (a) every receipt is unique, (b)
   ids form a contiguous monotonic range, (c) every text is recallable.
4. Latency: percentiles for remember and recall under light load.

Writes RESULT.md with observed numbers and notes.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path


def _request(method: str, url: str, body: dict | None = None, timeout: float = 5.0) -> tuple[int, dict]:
    data = None
    headers = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode("utf-8") or "{}")
            return r.status, payload
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            payload = {}
        return e.code, payload


class Client:
    """A standalone HTTP client. Each instance models a different agent."""

    def __init__(self, base: str, name: str):
        self.base = base.rstrip("/")
        self.name = name

    def remember(self, text: str, tags: list[str] | None = None) -> tuple[int, dict, float]:
        t0 = time.perf_counter()
        status, body = _request("POST", f"{self.base}/remember", {"text": text, "tags": tags or [], "author": self.name})
        return status, body, (time.perf_counter() - t0) * 1000.0

    def recall(self, q: str, limit: int = 20) -> tuple[int, dict, float]:
        t0 = time.perf_counter()
        status, body = _request("GET", f"{self.base}/recall?q={urllib.request.quote(q)}&limit={limit}")
        return status, body, (time.perf_counter() - t0) * 1000.0

    def stats(self) -> dict:
        _, body = _request("GET", f"{self.base}/stats")
        return body


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)


def fmt_ms(x: float) -> str:
    return f"{x:.2f}ms"


def run(base: str, out_path: Path) -> None:
    alice = Client(base, "alice")
    bob = Client(base, "bob")

    results: dict = {"base": base}

    # ---- Test 1: same-client read-after-write ----
    text1 = f"read-after-write probe {time.time_ns()}"
    s, body, _ = alice.remember(text1, tags=["probe"])
    assert s == 201 and body.get("ok"), f"alice remember failed: {s} {body}"
    receipt1 = body["receipt"]
    s, body, _ = alice.recall(text1)
    assert s == 200 and body.get("ok"), f"alice recall failed: {s} {body}"
    hits1 = body["hits"]
    saw_self = any(h["ulid"] == receipt1["ulid"] for h in hits1)
    results["t1_same_client_raw"] = {
        "receipt": receipt1,
        "hitCount": len(hits1),
        "sawOwnWrite": saw_self,
    }
    assert saw_self, "same-client read-after-write FAILED"

    # ---- Test 2: receipt -> different client recall ----
    text2 = f"cross-client probe {time.time_ns()}"
    s, body, _ = alice.remember(text2, tags=["probe", "cross"])
    assert s == 201 and body.get("ok")
    receipt2 = body["receipt"]
    # bob is a fully separate Client instance: separate connection, separate
    # state. As soon as alice's POST returns, bob should see the row.
    s, body, _ = bob.recall(text2)
    assert s == 200 and body.get("ok")
    hits2 = body["hits"]
    bob_sees = any(h["ulid"] == receipt2["ulid"] for h in hits2)
    results["t2_cross_client"] = {
        "receipt": receipt2,
        "hitCount": len(hits2),
        "secondClientSaw": bob_sees,
    }
    assert bob_sees, "second-client read-after-receipt FAILED"

    # ---- Test 3: concurrency ----
    N = 64
    base_id = alice.stats()["latestId"]
    payloads = [f"concurrent probe {i} {uuid_short()}" for i in range(N)]
    writers = [Client(base, f"writer-{i % 4}") for i in range(N)]

    write_times: list[float] = []
    receipts: list[dict] = []
    errors: list[str] = []

    def do_write(i: int) -> None:
        try:
            s, body, dt = writers[i].remember(payloads[i], tags=["concurrent"])
            if s != 201 or not body.get("ok"):
                errors.append(f"#{i}: {s} {body}")
                return
            write_times.append(dt)
            receipts.append(body["receipt"])
        except Exception as exc:  # noqa: BLE001
            errors.append(f"#{i}: {exc!r}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(do_write, range(N)))

    ids = sorted(r["id"] for r in receipts)
    ulids = {r["ulid"] for r in receipts}
    # Verify each text is now recallable from a fresh reader (charlie).
    charlie = Client(base, "charlie")
    missing: list[int] = []
    for i, p in enumerate(payloads):
        _, body, _ = charlie.recall(p, limit=5)
        if not any(h["ulid"] == receipts[i]["ulid"] for h in body.get("hits", []) if "ulid" in h):
            # Fallback: if order of writes != order of receipts (because of
            # ThreadPoolExecutor.map result ordering), do a text-match check.
            found = any(h.get("text") == p for h in body.get("hits", []))
            if not found:
                missing.append(i)
    contiguous = ids == list(range(min(ids), min(ids) + N)) if ids else False
    monotonic_after_base = bool(ids) and min(ids) == base_id + 1
    results["t3_concurrency"] = {
        "writers": N,
        "errors": errors,
        "uniqueUlids": len(ulids) == N,
        "uniqueIds": len(set(ids)) == N,
        "contiguousIds": contiguous,
        "startsAtBasePlusOne": monotonic_after_base,
        "idRange": [min(ids), max(ids)] if ids else None,
        "missingFromRecall": missing,
        "writeMs": {
            "p50": pct(write_times, 0.50),
            "p95": pct(write_times, 0.95),
            "p99": pct(write_times, 0.99),
            "max": max(write_times) if write_times else float("nan"),
        },
    }
    assert not errors, f"concurrency errors: {errors}"
    assert len(ulids) == N, "ulid collisions"
    assert contiguous, f"ids not contiguous: {ids[:5]}..{ids[-5:]}"
    assert not missing, f"texts missing from recall: {missing}"

    # ---- Test 4: latency ----
    M = 100
    rem_ms: list[float] = []
    rec_ms: list[float] = []
    e2e_ms: list[float] = []
    for i in range(M):
        text = f"latency probe {i} {uuid_short()}"
        s, body, dt = alice.remember(text, tags=["latency"])
        assert s == 201 and body.get("ok")
        rem_ms.append(dt)
        s, body, dr = alice.recall(text, limit=5)
        assert s == 200 and body.get("ok")
        rec_ms.append(dr)
        e2e_ms.append(dt + dr)
    results["t4_latency"] = {
        "samples": M,
        "remember": {"p50": pct(rem_ms, .5), "p95": pct(rem_ms, .95), "p99": pct(rem_ms, .99), "mean": statistics.fmean(rem_ms)},
        "recall":   {"p50": pct(rec_ms, .5), "p95": pct(rec_ms, .95), "p99": pct(rec_ms, .99), "mean": statistics.fmean(rec_ms)},
        "e2e":      {"p50": pct(e2e_ms, .5), "p95": pct(e2e_ms, .95), "p99": pct(e2e_ms, .99), "mean": statistics.fmean(e2e_ms)},
    }

    # ---- Write RESULT.md ----
    out_path.write_text(render_result(results), encoding="utf-8")
    # Echo a compact JSON line for run.sh convenience.
    print(json.dumps({"summary": "ok", "tests": list(results.keys())}))


def uuid_short() -> str:
    import uuid
    return uuid.uuid4().hex[:8]


def render_result(r: dict) -> str:
    t1 = r["t1_same_client_raw"]
    t2 = r["t2_cross_client"]
    t3 = r["t3_concurrency"]
    t4 = r["t4_latency"]
    lines = []
    lines.append("# Experiment 01 — RESULT")
    lines.append("")
    lines.append(f"- brain endpoint: `{r['base']}`")
    lines.append("- prototype: single Python process, ThreadingHTTPServer, SQLite WAL, "
                 "global write lock around `BEGIN IMMEDIATE` (DO-shaped authority).")
    lines.append("")
    lines.append("## Test 1 — same-client read-after-write")
    lines.append("")
    lines.append(f"- receipt id: `{t1['receipt']['id']}`  ulid: `{t1['receipt']['ulid']}`  durable: `{t1['receipt']['durable']}`")
    lines.append(f"- recalled own write: **{t1['sawOwnWrite']}**  ({t1['hitCount']} hits)")
    lines.append("")
    lines.append("## Test 2 — receipt → *different* client recall")
    lines.append("")
    lines.append(f"- receipt id: `{t2['receipt']['id']}`  ulid: `{t2['receipt']['ulid']}`")
    lines.append(f"- second client saw the write: **{t2['secondClientSaw']}**  ({t2['hitCount']} hits)")
    lines.append("")
    lines.append("## Test 3 — concurrency")
    lines.append("")
    lines.append(f"- writers: {t3['writers']}  errors: {len(t3['errors'])}")
    lines.append(f"- unique ulids: {t3['uniqueUlids']}  unique ids: {t3['uniqueIds']}")
    lines.append(f"- contiguous id range: {t3['contiguousIds']}  starts at base+1: {t3['startsAtBasePlusOne']}")
    lines.append(f"- id range: {t3['idRange']}")
    lines.append(f"- texts missing from recall: {len(t3['missingFromRecall'])}")
    w = t3["writeMs"]
    lines.append(f"- write latency under load: p50={fmt_ms(w['p50'])}  p95={fmt_ms(w['p95'])}  p99={fmt_ms(w['p99'])}  max={fmt_ms(w['max'])}")
    lines.append("")
    lines.append("## Test 4 — latency (light load)")
    lines.append("")
    for name in ("remember", "recall", "e2e"):
        s = t4[name]
        lines.append(f"- **{name}**: mean={fmt_ms(s['mean'])}  p50={fmt_ms(s['p50'])}  p95={fmt_ms(s['p95'])}  p99={fmt_ms(s['p99'])}")
    lines.append("")
    lines.append("## Interpretation")
    lines.append("")
    lines.append(
        "Read-after-write is unconditional in this model: the DO-shaped authority commits "
        "the row inside the lock and only then returns a receipt, so any subsequent reader — "
        "the writer or another client — that hits the same authority sees it. There is no "
        "replication lag to hide, because there is exactly one place memory lives."
    )
    lines.append("")
    lines.append(
        "Concurrency holds because writes are serialized through `BEGIN IMMEDIATE` under a "
        "global threading lock — the local stand-in for a Durable Object's single-threaded "
        "execution. Ids are contiguous; ulids are unique; every payload is recallable."
    )
    lines.append("")
    lines.append("## Honest limitations of this prototype")
    lines.append("")
    lines.append(
        "- Local fsync is not a Cloudflare durability proof. WAL+`synchronous=NORMAL` is "
        "weaker than DO storage's distributed commit; numbers will differ on real CF."
    )
    lines.append(
        "- `LIKE` recall, not FTS5. Production Dejavu uses FTS5; this experiment intentionally "
        "tests authority/visibility, not ranking."
    )
    lines.append(
        "- No network: clients and the DO share a loopback socket. CF-side latency, DO "
        "placement, and cold-start cost are not modeled here."
    )
    lines.append(
        "- No auth, no quotas, no eviction, no embeddings — those are orthogonal."
    )
    lines.append(
        "- One DO id only. The shard/routing question (one DO per owner? per workspace?) "
        "is not in scope; this prototype models the inside of one authority."
    )
    lines.append("")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    run(args.base, args.out)


if __name__ == "__main__":
    main()
