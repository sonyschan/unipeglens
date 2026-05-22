// p2peg
const P2PEG_BASE = 'https://server.p2peg.app';
const P2PEG_PAGE_SIZE = 60;

// unipeg.art metadata (notable sets total counts)
const NOTABLE_URL = 'https://server.unipeg.art/api/rarity/notable';

// unipeg-lens dashboard — full per-uPEG metadata mirror (traits + colors),
// the input for OpenRarity + MineRarity scoring. The worker rebuilds this
// file every 6h; we re-pull only when the collection size moves or our
// cached scores age out.
const UPEGS_FULL_URL =
  'https://unipeg-lens.sonys-chan.workers.dev/data/upegs_full.json';
const RARITY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// OpenSea
const OPENSEA_BASE = 'https://api.opensea.io';
const OPENSEA_COLLECTION = 'unipegv4';
const OPENSEA_CONTRACT = '0xfd7db13b002f927891ab20ebbca890c1b5a459fd';
const OPENSEA_PAGE_SIZE = 100;

const ETH_TOKEN = '0x0000000000000000000000000000000000000000';
const STALE_MS = 30_000;

let index = new Map(); // displayId -> listing { source, ...fields }
let lastRefresh = 0;
let inFlight = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- p2peg ----------

const p2pegUrl = (offset) =>
  `${P2PEG_BASE}/listings?limit=${P2PEG_PAGE_SIZE}&offset=${offset}&status=OPEN`;

async function fetchP2pegPage(offset) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(p2pegUrl(offset));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(2000);
    }
  }
}

async function fetchAllP2peg() {
  const all = [];
  for (let offset = 0; ; offset += P2PEG_PAGE_SIZE) {
    const { items = [] } = await fetchP2pegPage(offset);
    all.push(...items);
    if (items.length < P2PEG_PAGE_SIZE) break;
    if (offset > 100_000) break;
  }
  return all.map((l) => ({ source: 'p2peg', ...l }));
}

// ---------- OpenSea ----------

async function getOpenseaKey({ forceFallback = false } = {}) {
  if (!forceFallback) {
    const { opensea_user_key } = await chrome.storage.local.get('opensea_user_key');
    if (opensea_user_key && opensea_user_key.trim()) return opensea_user_key.trim();
  }
  const { opensea_fallback_key, opensea_fallback_expires } =
    await chrome.storage.local.get(['opensea_fallback_key', 'opensea_fallback_expires']);
  const stillValid =
    opensea_fallback_key &&
    opensea_fallback_expires &&
    new Date(opensea_fallback_expires).getTime() - Date.now() > 24 * 3600 * 1000;
  if (stillValid) return opensea_fallback_key;
  return rotateAgentKey();
}

async function rotateAgentKey() {
  const res = await fetch(`${OPENSEA_BASE}/api/v2/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'upeg-otc-lens' }),
  });
  if (!res.ok) throw new Error(`opensea auth ${res.status}`);
  const { api_key, expires_at } = await res.json();
  await chrome.storage.local.set({
    opensea_fallback_key: api_key,
    opensea_fallback_expires: expires_at,
  });
  console.log('[Unipeg Lens] minted new OpenSea agent key, expires', expires_at);
  return api_key;
}

async function openseaFetch(url) {
  let key = await getOpenseaKey();
  let res = await fetch(url, { headers: { 'x-api-key': key, accept: 'application/json' } });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    // primary key invalid / rate-limited — try fallback
    key = await getOpenseaKey({ forceFallback: true });
    res = await fetch(url, { headers: { 'x-api-key': key, accept: 'application/json' } });
  }
  if (!res.ok) throw new Error(`opensea HTTP ${res.status}`);
  return res.json();
}

async function fetchAllOpensea() {
  const url = (next) => {
    const u = new URL(`${OPENSEA_BASE}/api/v2/listings/collection/${OPENSEA_COLLECTION}/all`);
    u.searchParams.set('limit', String(OPENSEA_PAGE_SIZE));
    if (next) u.searchParams.set('next', next);
    return u.toString();
  };
  const all = [];
  let next = null;
  for (let page = 0; page < 50; page++) {
    let data;
    try {
      data = await openseaFetch(url(next));
    } catch (e) {
      if (page === 0) throw e;
      console.warn('[Unipeg Lens] opensea page error, stopping pagination:', e.message);
      break;
    }
    const listings = data.listings || [];
    all.push(...listings.map(normalizeOpenseaListing).filter(Boolean));
    if (!data.next) break;
    next = data.next;
  }
  return all;
}

function normalizeOpenseaListing(o) {
  const params = o?.protocol_data?.parameters;
  if (!params) return null;
  const offer = params.offer?.[0];
  if (!offer || offer.token?.toLowerCase() !== OPENSEA_CONTRACT) return null;
  const tokenId = String(offer.identifierOrCriteria);
  const currency = (o.price?.current?.currency || '').toUpperCase();
  if (currency !== 'ETH') return null; // ETH only for MVP
  const priceWei = o.price?.current?.value || '0';
  return {
    source: 'opensea',
    id: o.order_hash,
    upegIds: [tokenId],
    upegCount: 1,
    priceWei,
    paymentToken: ETH_TOKEN,
    seller: params.offerer,
    rarity: null,
    tokenId,
  };
}

// ---------- Rarity scoring (OpenRarity + MineRarity) ----------
//
// Two independent rarity axes, computed locally over the whole collection:
//
//   OpenRarity (OR) — canonical Information-Content scoring. Collection-
//     relative: a token's score depends on the entire trait/colour
//     frequency distribution. score = Σ −log2 p(value) / entropy H.
//
//   MineRarity (MR) — community kernel-K probability model. Each token's
//     raw probability is self-contained; only its rank/tier need the
//     whole collection. P = P(presence) · K(λ_T) · K_w(λ_C).
//
// Mirrors the reference implementation in the unipeg-lens dashboard
// (js/shared.js, scripts/compute_openrarity.py, scripts/compare_mr_v2.py).

const OR_TRAIT_KEYS = [
  'legsBack', 'legsFront', 'hair', 'horn', 'wings', 'tail', 'accessories',
];
const OR_COLOR_KEYS = [
  'bodyColor', 'eyesColor', 'hairColor', 'hornColor',
  'tailColor', 'accessoriesColor', 'backGroundColor',
];
// OpenRarity percentile tiers — label shown when rank/total ≤ threshold.
const OR_TIERS = [
  [0.01, 'TOP 1%'],
  [0.03, 'TOP 3%'],
  [0.10, 'TOP 10%'],
  [0.25, 'TOP 25%'],
];

// MineRarity part-presence rates (from the on-chain generation params).
const MR_PART_PRESENCE = {
  hair: [0.80, 0.20],
  horn: [0.20, 0.80],
  wings: [0.30, 0.70],
  tail: [0.80, 0.20],
  accessories: [0.30, 0.70],
};
// Trait-token slots — id collisions among these drive the K_T kernel.
const MR_TT_KEYS = [
  'legsBack', 'legsFront', 'hair', 'horn', 'wings', 'tail', 'accessories',
];
// Colour-token slots for K_C — background EXCLUDED (separate 6-colour
// palette). [colorKey, gateTrait]: skip the slot when its gate is absent.
const MR_CT_SLOTS = [
  ['bodyColor', null],
  ['eyesColor', null],
  ['hairColor', 'hair'],
  ['hornColor', 'horn'],
  ['tailColor', 'tail'],
  ['accessoriesColor', 'accessories'],
];
const MR_V_T = 15; // id slots per trait
const MR_V_C = 36; // main palette indices
// On-chain main palette (SvgGenerator.sol). Two hexes appear twice
// (#cbdbfc, #306082) — those carry weight 2, the other 32 weight 1.
const MR_MAIN_PALETTE = [
  '#a9b6d2', '#cbdbfc', '#eae1b5', '#d9a066', '#9dcde4', '#8f563b',
  '#524b24', '#ac3232', '#d77bba', '#847e87', '#626979', '#306082',
  '#323c39', '#306082', '#6e3e54', '#cb67d2', '#37946e', '#df7126',
  '#d95763', '#5fcde4', '#d2ac8d', '#cbdbfc', '#696a6a', '#e7d632',
  '#e76232', '#cee6f3', '#e79090', '#fcf893', '#edb187', '#b3dcf7',
  '#4b8b3b', '#7fc97f', '#1e1e26', '#2d1b1b', '#a0a0a0', '#00ffd0',
];
// Palette weight groups: [[weight, distinctHexCount], ...] ascending.
const MR_PALETTE_WEIGHT_GROUPS = (() => {
  const freq = new Map();
  for (const hex of MR_MAIN_PALETTE) freq.set(hex, (freq.get(hex) || 0) + 1);
  const byWeight = new Map();
  for (const w of freq.values()) byWeight.set(w, (byWeight.get(w) || 0) + 1);
  return [...byWeight.entries()].sort((a, b) => a[0] - b[0]);
})();
// MineRarity → Mine Tier buckets: [cumulative pct threshold, tier 1-12, label].
// Mirrors MT_TIER_BUCKETS on the unipeg-lens dashboard's TCG branch — the
// game-balanced distribution (issue #5, Phase-0-validated) that will merge to
// main. Tier 12 = top 0.3%, tier 1 = bottom ~26%. Labels show for tiers ≥ 5.
const MR_TIERS = [
  [0.003, 12, 'UR'],
  [0.010, 11, 'SSR'],
  [0.020, 10, 'SSR'],
  [0.040, 9, 'SR'],
  [0.070, 8, 'SR'],
  [0.120, 7, 'R'],
  [0.190, 6, 'R'],
  [0.290, 5, 'R'],
  [0.410, 4, ''],
  [0.560, 3, ''],
  [0.740, 2, ''],
  [1.001, 1, ''],
];

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// N(λ) = k! / (Π λ_j! · Π m_s!) — multinomial × group-size symmetry.
function nLambda(lam) {
  const k = lam.reduce((a, b) => a + b, 0);
  let denom = 1;
  for (const sz of lam) denom *= factorial(sz);
  const sizeCounts = new Map();
  for (const sz of lam) sizeCounts.set(sz, (sizeCounts.get(sz) || 0) + 1);
  for (const m of sizeCounts.values()) denom *= factorial(m);
  return factorial(k) / denom;
}

// V·(V−1)·…·(V−r+1) — r falling factors.
function fallingFactorial(v, r) {
  let out = 1;
  for (let i = 0; i < r; i++) out *= v - i;
  return out;
}

// Uniform kernel K(λ | k, V) = N(λ) · V(V−1)…(V−r+1) / V^k.
function kernelK(lam, v) {
  const k = lam.reduce((a, b) => a + b, 0);
  if (k === 0) return 1;
  const r = lam.length;
  if (r > v) return 0;
  return (nLambda(lam) * fallingFactorial(v, r)) / Math.pow(v, k);
}

// Weighted kernel K_w(λ | k, palette) =
//   N(λ) · Σ_{distinct hex picks} Π (w_b / V)^λᵢ.
// Reduces to kernelK when every weight is 1.
function kernelKWeighted(lam, v, weightGroups) {
  const k = lam.reduce((a, b) => a + b, 0);
  if (k === 0) return 1;
  const distinctAvail = weightGroups.reduce((a, g) => a + g[1], 0);
  if (lam.length > distinctAvail) return 0;
  const weights = weightGroups.map((g) => g[0]);
  const cache = new Map();
  function dfs(pos, counts) {
    if (pos === lam.length) return 1;
    const key = pos + ':' + counts.join(',');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let total = 0;
    const expo = lam[pos];
    for (let i = 0; i < weights.length; i++) {
      if (counts[i] <= 0) continue;
      const next = counts.slice();
      next[i] -= 1;
      total += counts[i] * Math.pow(weights[i] / v, expo) * dfs(pos + 1, next);
    }
    cache.set(key, total);
    return total;
  }
  return nLambda(lam) * dfs(0, weightGroups.map((g) => g[1]));
}

// Descending partition (singletons included) of a list of values.
function partitionShape(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.values()].sort((a, b) => b - a);
}

// MineRarity raw probability for one uPEG — pure function of its own record.
function mineRarityProb(item) {
  const m = item.metadata || {};
  const c = item.colors || {};
  let p = 1;
  for (const trait in MR_PART_PRESENCE) {
    const [pres, absent] = MR_PART_PRESENCE[trait];
    p *= (m[trait] || 0) !== 0 ? pres : absent;
  }
  const tt = [];
  for (const k of MR_TT_KEYS) if ((m[k] || 0) !== 0) tt.push(m[k]);
  p *= kernelK(partitionShape(tt), MR_V_T);
  const ct = [];
  for (const [key, gate] of MR_CT_SLOTS) {
    if (gate && (m[gate] || 0) === 0) continue;
    if (c[key]) ct.push(c[key]);
  }
  p *= kernelKWeighted(partitionShape(ct), MR_V_C, MR_PALETTE_WEIGHT_GROUPS);
  return p;
}

// First matching tier label for a percentile (rank / total), else fallback.
function tierLabel(pct, table, fallback, labelIdx) {
  for (const row of table) if (pct <= row[0]) return row[labelIdx];
  return fallback;
}

// The whole matching tier row [threshold, tier#, label] for a percentile.
function tierRow(pct, table) {
  for (const row of table) if (pct <= row[0]) return row;
  return table[table.length - 1];
}

// --- OpenRarity feature extraction ---
//
// Traits are scored by metadata index (0 = absent/null). Colours are
// scored by HEX, with '∅' standing in when the colour's gate part is
// absent — so "hornless" is itself a categorical value. Hex (not palette
// index) is deliberate: the myupeg.art draw panel only exposes hexes, so
// hex keeps a draw candidate scorable through the exact same code path as
// the cached collection.
const OR_COLOR_GATE = {
  bodyColor: null,
  eyesColor: null,
  backGroundColor: null,
  hairColor: 'hair',
  hornColor: 'horn',
  tailColor: 'tail',
  accessoriesColor: 'accessories',
};
const OR_KEYS = OR_TRAIT_KEYS.concat(OR_COLOR_KEYS);

function orValue(item, key) {
  const m = item.metadata || {};
  if (!(key in OR_COLOR_GATE)) return m[key] || 0; // trait slot → index
  const gate = OR_COLOR_GATE[key];
  if (gate && (m[gate] || 0) === 0) return '∅'; // gated-off colour
  return (item.colors || {})[key] || '∅';
}

// Per-item OpenRarity raw information content = Σ −log2 p(value).
// `count(key, value)` → how many uPEGs share that value (Map or object).
function orRawIC(item, count, total) {
  let raw = 0;
  for (const k of OR_KEYS) {
    const n = count(k, orValue(item, k)) || 1; // unseen value → treat as 1
    raw -= Math.log2(n / total);
  }
  return raw;
}

// Score the whole collection → the distribution the draw panel ranks
// against: { total, computedAt, H, orCounts, orScores, mrProbs }.
//   orCounts : { key: { value: n } }       — for a candidate's OR score
//   orScores : OpenRarity scores, DESC     — rarest first
//   mrProbs  : MineRarity probabilities, ASC — rarest (smallest) first
function computeRarity(items) {
  const total = items.length;

  // OpenRarity: per-(key, value) counts → entropy H → normalised IC score.
  const counts = {};
  for (const k of OR_KEYS) counts[k] = new Map();
  for (const it of items) {
    for (const k of OR_KEYS) {
      const v = orValue(it, k);
      counts[k].set(v, (counts[k].get(v) || 0) + 1);
    }
  }
  let H = 0;
  for (const k of OR_KEYS) {
    for (const n of counts[k].values()) {
      const p = n / total;
      H -= p * Math.log2(p);
    }
  }
  const getCount = (k, v) => counts[k].get(v);
  const orScores = items
    .map((it) => orRawIC(it, getCount, total) / (H || 1))
    .sort((a, b) => b - a);

  // MineRarity: kernel-K probability, smallest (rarest) first.
  const mrProbs = items.map(mineRarityProb).sort((a, b) => a - b);

  // Maps don't survive chrome.storage — flatten to plain objects.
  const orCounts = {};
  for (const k of OR_KEYS) orCounts[k] = Object.fromEntries(counts[k]);

  return { total, computedAt: Date.now(), H, orCounts, orScores, mrProbs };
}

// Score one draw-panel candidate against a cached collection distribution.
//   traits : { traitKey: index }   — all 7 trait slots (0 = absent)
//   colors : { colorKey: hex }     — gated-off colours simply omitted
// Returns 1-based ranks ("would rank #N") plus tier labels.
function scoreCandidate(rarity, traits, colors) {
  const item = { metadata: traits || {}, colors: colors || {} };
  const total = rarity.total;
  const count = (k, v) => (rarity.orCounts[k] || {})[v];
  const orScore = orRawIC(item, count, total) / (rarity.H || 1);
  const mrProb = mineRarityProb(item);

  // orScores DESC → rank = #(score strictly greater) + 1.
  let orRank = 1;
  for (const s of rarity.orScores) {
    if (s > orScore) orRank++;
    else break;
  }
  // mrProbs ASC → rank = #(prob strictly smaller) + 1.
  let mrRank = 1;
  for (const p of rarity.mrProbs) {
    if (p < mrProb) mrRank++;
    else break;
  }
  const mtRow = tierRow(mrRank / total, MR_TIERS);
  return {
    orRank,
    orTier: tierLabel(orRank / total, OR_TIERS, '', 1),
    mrRank,
    mrTier: mtRow[1], // Mine Tier — a 1-12 bucket of MineRarity (12 = rarest)
    mrTierLabel: mtRow[2], // UR/SSR/SR/R band — drives the chip colour
    total,
  };
}

let rarityInFlight = null;

// Pull the full metadata mirror, score the collection, and cache the score
// distribution in chrome.storage.local for the draw-panel candidate ranker.
async function refreshRarity(notableTotal) {
  if (rarityInFlight) return rarityInFlight;
  rarityInFlight = (async () => {
    try {
      console.log('[Unipeg Lens] rarity: fetching collection metadata…', UPEGS_FULL_URL);
      const res = await fetch(UPEGS_FULL_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const items = payload.items || [];
      if (!items.length) throw new Error('empty items');
      const t0 = Date.now();
      const rarity = computeRarity(items);
      rarity.notableTotal = typeof notableTotal === 'number' ? notableTotal : null;
      await chrome.storage.local.set({ rarity });
      console.log(
        `[Unipeg Lens] rarity scored ${rarity.total} uPEGs in ${Date.now() - t0}ms`
      );
    } catch (e) {
      console.warn('[Unipeg Lens] rarity refresh failed:', e.message);
    } finally {
      rarityInFlight = null;
    }
  })();
  return rarityInFlight;
}

// Cheap gate, evaluated on every 30s poll: re-pull the ~10 MB mirror and
// recompute only when the collection size moved or the cache aged out.
async function maybeRefreshRarity(notableTotal) {
  if (rarityInFlight) return;
  const { rarity } = await chrome.storage.local.get('rarity');
  const stale =
    !rarity ||
    Date.now() - (rarity.computedAt || 0) > RARITY_MAX_AGE_MS ||
    (typeof notableTotal === 'number' && notableTotal !== rarity.notableTotal);
  if (stale) refreshRarity(notableTotal);
}

// ---------- Index ----------

function buildIndex(p2pegListings, openseaListings) {
  const m = new Map();
  for (const l of p2pegListings) {
    if ((l.paymentToken || '').toLowerCase() !== ETH_TOKEN) continue;
    for (const id of l.upegIds || []) {
      m.set(String(id), l);
    }
  }
  // OpenSea wins ties (rare; sources are mutually exclusive in practice anyway)
  for (const l of openseaListings) {
    for (const id of l.upegIds || []) m.set(String(id), l);
  }
  return m;
}

async function fetchNotable() {
  const res = await fetch(NOTABLE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const p2pegPromise = fetchAllP2peg().catch((e) => {
      console.warn('[Unipeg Lens] p2peg fetch failed:', e.message);
      return [];
    });
    const openseaPromise = fetchAllOpensea().catch((e) => {
      console.warn('[Unipeg Lens] opensea fetch failed:', e.message);
      return [];
    });
    let notableTotal = null;
    const notablePromise = fetchNotable()
      .then((data) => {
        if (data && typeof data.total === 'number') notableTotal = data.total;
        return chrome.storage.local.set({ notable: data });
      })
      .catch((e) => console.warn('[Unipeg Lens] notable fetch failed:', e.message));
    const [p2pegListings, openseaListings] = await Promise.all([p2pegPromise, openseaPromise]);
    await notablePromise; // doesn't block listings if it fails
    // Re-score rarity when the collection moved or the cache aged out.
    // Fire-and-forget — the ~10 MB pull must not stall the 30s listing poll.
    maybeRefreshRarity(notableTotal);
    if (p2pegListings.length === 0 && openseaListings.length === 0) {
      console.warn('[Unipeg Lens] both sources returned empty, keeping previous index');
    } else {
      index = buildIndex(p2pegListings, openseaListings);
      lastRefresh = Date.now();
    }
    const byP2peg = [...index.values()].filter((l) => l.source === 'p2peg').length;
    const byOpensea = [...index.values()].filter((l) => l.source === 'opensea').length;
    console.log(`[Unipeg Lens] indexed ${index.size} ETH listings (p2peg: ${byP2peg}, opensea: ${byOpensea})`);
    inFlight = null;
  })();
  return inFlight;
}

chrome.runtime.onInstalled.addListener(() => refresh());
chrome.runtime.onStartup.addListener(() => refresh());

chrome.alarms.create('refresh', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refresh') refresh();
});

function lookup(ids) {
  return Object.fromEntries(ids.map((id) => [id, index.get(String(id)) ?? null]));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'lookup') return;
  const ids = Array.isArray(msg.ids) ? msg.ids : [];
  const stale = Date.now() - lastRefresh > STALE_MS;
  if (stale) {
    refresh().then(() => sendResponse(lookup(ids)));
    return true;
  }
  sendResponse(lookup(ids));
});

// Draw-panel candidate scoring for the myupeg.art content script.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'scoreCandidate') return;
  (async () => {
    try {
      let { rarity } = await chrome.storage.local.get('rarity');
      if (!rarity || !Array.isArray(rarity.orScores)) {
        // Not scored yet — compute now. Awaiting here (with the message
        // channel held open by `return true`) keeps the service worker
        // alive through the ~10 MB pull + scoring, instead of letting a
        // fire-and-forget compute die when the worker is recycled.
        await refreshRarity(null);
        ({ rarity } = await chrome.storage.local.get('rarity'));
      }
      if (!rarity || !Array.isArray(rarity.orScores)) {
        sendResponse({ ready: false, error: 'collection metadata unavailable' });
        return;
      }
      sendResponse({ ready: true, ...scoreCandidate(rarity, msg.traits, msg.colors) });
    } catch (e) {
      sendResponse({ ready: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async sendResponse
});

// Refetch immediately when user updates their OpenSea key
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.opensea_user_key) refresh();
});
