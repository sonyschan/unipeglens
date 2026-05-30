"""Fetch the unipeg.art rarity list and write data/upegs.json.

Modes:
  (default) incremental — fetch `?by=newest` from the head and stop the moment
    we hit a uPEG already cached in data/upegs.json. Typically 1–2 pages on a
    quiet day. Falls back to a full sweep automatically if the API's `total`
    diverges from `cached + new` (i.e. some uPEGs were burnt).
  --full — fetch every page from offset 0 to the end. Use occasionally to
    detect burnt uPEGs and refresh mutable fields (owner, kindRank).

Each page is `?by=newest&limit=200&offset=N`. Sleeps DELAY_S between pages.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

API = "https://server.unipeg.art/api/rarity/top"
LIMIT = 200
DELAY_S = 2.0
TIMEOUT_S = 30
RETRIES = 3
UA = "upeg-otc-lens/fetch_upegs (https://github.com/sonyschan/upeg)"

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "upegs.json"

META_KEYS = (
    "by", "filter", "total", "totalCanonical", "lastBuiltAt",
    "colorJointAlpha", "colorCountBeta", "colorCountGamma",
    "colorContrastEpsilon", "maxMintPosition",
)


def fetch_page(offset: int) -> dict:
    url = f"{API}?by=newest&limit={LIMIT}&offset={offset}"
    cmd = ["curl", "-sSf", "--max-time", str(TIMEOUT_S),
           "-A", UA, "-H", "Accept: application/json", url]
    last_err: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            out = subprocess.run(cmd, capture_output=True, check=True)
            return json.loads(out.stdout)
        except Exception as e:
            last_err = e
            backoff = DELAY_S * attempt
            print(f"  retry {attempt}/{RETRIES} after error: {e} (sleep {backoff:.1f}s)", file=sys.stderr)
            time.sleep(backoff)
    raise RuntimeError(f"giving up on offset={offset}: {last_err}")


def fetch_all() -> tuple[dict, list[dict]]:
    """Page from offset 0 to the end. Returns (meta, all_items)."""
    items: list[dict] = []
    seen: set[str] = set()
    meta: dict | None = None
    offset = 0
    while True:
        page = fetch_page(offset)
        if meta is None:
            meta = {k: page.get(k) for k in META_KEYS}
            print(f"meta: total={meta['total']} canonical={meta['totalCanonical']}", file=sys.stderr)
        batch = page.get("items", [])
        new = 0
        for it in batch:
            uid = str(it.get("upegId"))
            if uid in seen:
                continue
            seen.add(uid)
            items.append(it)
            new += 1
        print(f"  offset={offset:>5} got={len(batch):>3} new={new:>3} total={len(items)}", file=sys.stderr)
        if len(batch) < LIMIT:
            break
        offset += LIMIT
        time.sleep(DELAY_S)
    assert meta is not None
    return meta, items


def fetch_incremental(known: set[str]) -> tuple[dict, list[dict]]:
    """Page from the head; stop on first known uPEG. Returns (meta, new_items)."""
    new_items: list[dict] = []
    meta: dict | None = None
    offset = 0
    while True:
        page = fetch_page(offset)
        if meta is None:
            meta = {k: page.get(k) for k in META_KEYS}
            print(f"meta: total={meta['total']} canonical={meta['totalCanonical']}", file=sys.stderr)
        batch = page.get("items", [])
        hit = False
        page_new = 0
        for it in batch:
            uid = str(it.get("upegId"))
            if uid in known:
                hit = True
                break
            new_items.append(it)
            page_new += 1
        print(f"  offset={offset:>5} got={len(batch):>3} new={page_new:>3} (cumulative {len(new_items)})", file=sys.stderr)
        if hit or len(batch) < LIMIT:
            break
        offset += LIMIT
        time.sleep(DELAY_S)
    assert meta is not None
    return meta, new_items


def write(meta: dict, items: list[dict]) -> None:
    payload = {
        "meta": meta,
        "fetchedAt": int(time.time()),
        "count": len(items),
        "items": items,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--full", action="store_true",
                    help="re-fetch every page from offset 0 (use for burnt detection)")
    args = ap.parse_args()

    started = time.time()

    if args.full or not OUT.exists():
        if not OUT.exists():
            print("no cache — running full fetch", file=sys.stderr)
        meta, items = fetch_all()
        write(meta, items)
        elapsed = time.time() - started
        print(f"full: wrote {len(items)} items in {elapsed:.1f}s -> {OUT.relative_to(ROOT)}", file=sys.stderr)
        return 0

    cache = json.loads(OUT.read_text())
    cached_items = cache.get("items", [])
    known = {str(x["upegId"]) for x in cached_items}
    print(f"cache has {len(known)} items; fetching incrementally from head", file=sys.stderr)

    meta, new_items = fetch_incremental(known)
    expected_total = meta.get("total")  # everything (incl twins)
    new_total = len(known) + len(new_items)

    if expected_total is not None and new_total != expected_total:
        diff = new_total - expected_total
        print(f"\ntotal mismatch: cache+new={new_total} vs api total={expected_total} "
              f"(diff={diff:+d}) — falling back to full sweep", file=sys.stderr)
        meta, items = fetch_all()
        write(meta, items)
        elapsed = time.time() - started
        print(f"full (after fallback): wrote {len(items)} items in {elapsed:.1f}s", file=sys.stderr)
        return 0

    if new_items:
        # Prepend new items so the file stays in newest-first order.
        merged = new_items + cached_items
    else:
        merged = cached_items
    write(meta, merged)
    elapsed = time.time() - started
    print(f"incremental: +{len(new_items)} new (total {len(merged)}) in {elapsed:.1f}s -> {OUT.relative_to(ROOT)}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
