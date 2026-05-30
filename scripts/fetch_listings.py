"""Fetch current p2peg + OpenSea listings, write data/listings.json.

p2peg has CORS open and could be fetched live by the dashboard, but caching
both sources in one file keeps the dashboard simple (single load, one read
path). Re-run whenever you want fresh prices.

OpenSea key resolution order:
  1. OPENSEA_API_KEY in environment
  2. OPENSEA_API_KEY in .env at repo root (KEY=VALUE format)
  3. Auto-mint a temporary agent key
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

P2PEG_URL = "https://server.p2peg.app/listings"
P2PEG_PAGE = 60

OPENSEA_BASE = "https://api.opensea.io"
OPENSEA_COLLECTION = "unipegv4"
OPENSEA_CONTRACT = "0xfd7db13b002f927891ab20ebbca890c1b5a459fd"
OPENSEA_PAGE = 100
ETH_TOKEN = "0x0000000000000000000000000000000000000000"

TIMEOUT_S = 30
RETRIES = 3
UA = "upeg-otc-lens/fetch_listings (https://github.com/sonyschan/upeg)"

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "listings.json"


def http_json(url: str, headers: dict | None = None) -> dict:
    cmd = ["curl", "-sSf", "--max-time", str(TIMEOUT_S),
           "-A", UA, "-H", "Accept: application/json"]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    cmd.append(url)
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            out = subprocess.run(cmd, capture_output=True, check=True)
            return json.loads(out.stdout)
        except Exception as e:
            last = e
            time.sleep(0.5 * attempt)
    raise RuntimeError(f"GET {url}: {last}")


def http_post_json(url: str, body: dict) -> dict:
    payload = json.dumps(body)
    cmd = ["curl", "-sSf", "--max-time", str(TIMEOUT_S),
           "-A", UA, "-H", "Content-Type: application/json",
           "-X", "POST", "--data", payload, url]
    out = subprocess.run(cmd, capture_output=True, check=True)
    return json.loads(out.stdout)


def fetch_p2peg() -> list[dict]:
    items: list[dict] = []
    for offset in range(0, 100_000, P2PEG_PAGE):
        url = f"{P2PEG_URL}?limit={P2PEG_PAGE}&offset={offset}&status=OPEN"
        data = http_json(url)
        page = data.get("items", [])
        items.extend(page)
        print(f"  p2peg offset={offset:>5} got={len(page)} total={len(items)}", file=sys.stderr)
        if len(page) < P2PEG_PAGE:
            break
    return items


def load_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def get_opensea_key() -> tuple[str, str]:
    """Return (key, source) where source describes where it came from."""
    if v := os.environ.get("OPENSEA_API_KEY"):
        return v, "env"
    env_file = load_dotenv(ROOT / ".env")
    if v := env_file.get("OPENSEA_API_KEY"):
        return v, ".env"
    r = http_post_json(f"{OPENSEA_BASE}/api/v2/auth/keys", {"name": "upeg-otc-lens-listings"})
    return r["api_key"], "agent-mint"


def fetch_opensea() -> list[dict]:
    key, src = get_opensea_key()
    print(f"  opensea key ({src}): {key[:8]}…", file=sys.stderr)
    items: list[dict] = []
    next_tok = None
    for page in range(50):
        url = f"{OPENSEA_BASE}/api/v2/listings/collection/{OPENSEA_COLLECTION}/all?limit={OPENSEA_PAGE}"
        if next_tok:
            url += f"&next={next_tok}"
        data = http_json(url, headers={"x-api-key": key})
        listings = data.get("listings", [])
        items.extend(listings)
        next_tok = data.get("next")
        print(f"  opensea page={page:>2} got={len(listings)} total={len(items)} next={'y' if next_tok else 'n'}",
              file=sys.stderr)
        if not next_tok:
            break
    return items


def normalize_p2peg(raw: list[dict]) -> list[dict]:
    out = []
    for l in raw:
        if (l.get("paymentToken") or "").lower() != ETH_TOKEN:
            continue
        ids = [str(i) for i in (l.get("upegIds") or [])]
        out.append({
            "source": "p2peg",
            "id": l.get("id"),
            "priceWei": str(l.get("priceWei", "0")),
            "seller": l.get("seller"),
            "upegIds": ids,
            "upegCount": l.get("upegCount") or len(ids),
        })
    return out


def normalize_opensea(raw: list[dict]) -> list[dict]:
    out = []
    for l in raw:
        params = l.get("protocol_data", {}).get("parameters", {})
        offer = (params.get("offer") or [{}])[0]
        if (offer.get("token") or "").lower() != OPENSEA_CONTRACT:
            continue
        currency = (l.get("price", {}).get("current", {}).get("currency") or "").upper()
        if currency != "ETH":
            continue
        token_id = str(offer.get("identifierOrCriteria"))
        price_wei = str(l.get("price", {}).get("current", {}).get("value", "0"))
        out.append({
            "source": "opensea",
            "id": l.get("order_hash"),
            "priceWei": price_wei,
            "seller": params.get("offerer"),
            "upegIds": [token_id],
            "upegCount": 1,
            "tokenId": token_id,
        })
    return out


def index_by_upeg(p2peg: list[dict], opensea: list[dict]) -> dict[str, list[dict]]:
    """Index listings by upegId, keeping at most one listing per (upegId, source).

    OpenSea's `/listings/collection/all` returns every active order, so a single
    seller can show up multiple times at different price points; only the
    cheapest is the canonical "live" listing. We collapse to that here so the
    dashboard never shows phantom duplicates.
    """
    by: dict[str, list[dict]] = {}
    for l in p2peg + opensea:
        for uid in l.get("upegIds", []):
            by.setdefault(uid, []).append(l)
    for uid, ls in by.items():
        cheapest_by_src: dict[str, dict] = {}
        for l in ls:
            src = l["source"]
            cur = cheapest_by_src.get(src)
            if cur is None or int(l["priceWei"]) < int(cur["priceWei"]):
                cheapest_by_src[src] = l
        by[uid] = list(cheapest_by_src.values())
    return by


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()

    print("fetching p2peg…", file=sys.stderr)
    try:
        raw_p = fetch_p2peg()
    except Exception as e:
        print(f"  p2peg failed: {e} — continuing with empty list", file=sys.stderr)
        raw_p = []
    print("fetching opensea…", file=sys.stderr)
    try:
        raw_o = fetch_opensea()
    except Exception as e:
        print(f"  opensea failed: {e} — continuing with empty list", file=sys.stderr)
        raw_o = []

    p2peg = normalize_p2peg(raw_p)
    opensea = normalize_opensea(raw_o)
    by_upeg = index_by_upeg(p2peg, opensea)

    payload = {
        "fetchedAt": int(time.time()),
        "p2pegCount": len(p2peg),
        "openseaCount": len(opensea),
        "uniqueUpegsListed": len(by_upeg),
        "byUpegId": by_upeg,
    }
    OUT.write_text(json.dumps(payload))
    print(f"wrote p2peg={len(p2peg)} opensea={len(opensea)} unique_upegs={len(by_upeg)} "
          f"in {time.time()-started:.1f}s -> {OUT.relative_to(ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
