"""Fetch full per-uPEG metadata (traits + colors) from /api/upegs/{id}.

Reads non-twin IDs from data/upegs.json. The per-uPEG record (seed, traits,
colors, provenance) is immutable, so we cache it once in data/upegs_full.jsonl
and never re-fetch. Each run:
  1. Loads the cache.
  2. Prunes any cached IDs that no longer exist in the latest non-twin set
     (i.e. burnt uPEGs).
  3. Fetches only IDs missing from the cache, in a thread pool.
  4. Rewrites the JSONL (atomic) and dumps a consolidated upegs_full.json.

Resumable: if the run crashes or is interrupted, partial fetches survive in
the JSONL and the next run picks up where it left off.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

API = "https://server.unipeg.art/api/upegs"
TIMEOUT_S = 30
RETRIES = 3
WORKERS = 4
UA = "upeg-otc-lens/fetch_upegs_full (https://github.com/sonyschan/upeg)"

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "upegs.json"
JSONL = ROOT / "data" / "upegs_full.jsonl"
OUT = ROOT / "data" / "upegs_full.json"


def fetch(id_: str) -> dict:
    url = f"{API}/{id_}"
    cmd = ["curl", "-sSf", "--max-time", str(TIMEOUT_S),
           "-A", UA, "-H", "Accept: application/json", url]
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            out = subprocess.run(cmd, capture_output=True, check=True)
            return json.loads(out.stdout)
        except Exception as e:
            last = e
            time.sleep(0.5 * attempt)
    raise RuntimeError(f"id={id_}: {last}")


def load_cache() -> dict[str, dict]:
    if not JSONL.exists():
        return {}
    cache: dict[str, dict] = {}
    for line in JSONL.read_text().splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
            cache[str(rec["id"])] = rec  # later lines win on duplicates
        except Exception:
            continue
    return cache


def write_jsonl(cache: dict[str, dict]) -> None:
    tmp = JSONL.with_suffix(".jsonl.tmp")
    with tmp.open("w") as f:
        for k in sorted(cache, key=int):
            f.write(json.dumps(cache[k]) + "\n")
    tmp.replace(JSONL)


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC} — run fetch_upegs.py first", file=sys.stderr)
        return 1
    src = json.loads(SRC.read_text())
    current = {str(x["upegId"]) for x in src["items"] if not x.get("twin")}
    JSONL.parent.mkdir(parents=True, exist_ok=True)

    cache = load_cache()
    burnt = sorted(set(cache) - current, key=int)
    if burnt:
        for i in burnt:
            cache.pop(i, None)
        print(f"pruned {len(burnt)} burnt: {burnt[:10]}{'...' if len(burnt) > 10 else ''}", file=sys.stderr)

    todo = sorted(current - set(cache), key=int)
    print(f"non-twins: {len(current)}  cached: {len(cache)}  todo: {len(todo)}", file=sys.stderr)

    if todo:
        started = time.time()
        ok = 0
        fail = 0
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(fetch, i): i for i in todo}
            for n, fut in enumerate(as_completed(futs), 1):
                i = futs[fut]
                try:
                    rec = fut.result()
                    cache[str(rec["id"])] = rec
                    ok += 1
                    if ok % 200 == 0:
                        write_jsonl(cache)  # periodic crash-safety checkpoint
                except Exception as e:
                    fail += 1
                    print(f"  FAIL id={i}: {e}", file=sys.stderr)
                if n % 100 == 0 or n == len(todo):
                    elapsed = time.time() - started
                    rate = n / elapsed if elapsed else 0
                    eta = (len(todo) - n) / rate if rate else 0
                    print(f"  {n}/{len(todo)}  ok={ok} fail={fail}  {rate:.1f}/s  eta={eta/60:.1f}min", file=sys.stderr)

    write_jsonl(cache)
    items = sorted(cache.values(), key=lambda r: int(r.get("id", 0)))

    # Enrich with rarity-only fields (nDistinctColors, combinedRank) joined from
    # the rarity dump. These can shift over time (e.g. ranks reshuffle on new
    # mints) so we recompute every consolidation rather than caching.
    enrich = {}
    for x in src["items"]:
        enrich[str(x["upegId"])] = {
            "nDistinctColors": x.get("nDistinctColors"),
            "combinedRank": x.get("combinedRank"),
            "colorRank": x.get("colorRank"),
            "traitRank": x.get("traitRank"),
        }
    for it in items:
        meta = enrich.get(str(it["id"]))
        if meta:
            for k, v in meta.items():
                if v is not None:
                    it[k] = v

    payload = {
        "fetchedAt": int(time.time()),
        "count": len(items),
        "items": items,
    }
    OUT.write_text(json.dumps(payload))
    print(f"wrote {len(items)} -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size/1e6:.1f} MB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
