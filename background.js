// p2peg
const P2PEG_BASE = 'https://server.p2peg.app';
const P2PEG_PAGE_SIZE = 60;

// unipeg.art metadata (notable sets total counts)
const NOTABLE_URL = 'https://server.unipeg.art/api/rarity/notable';

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
  console.log('[uPEG Lens] minted new OpenSea agent key, expires', expires_at);
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
      console.warn('[uPEG Lens] opensea page error, stopping pagination:', e.message);
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
      console.warn('[uPEG Lens] p2peg fetch failed:', e.message);
      return [];
    });
    const openseaPromise = fetchAllOpensea().catch((e) => {
      console.warn('[uPEG Lens] opensea fetch failed:', e.message);
      return [];
    });
    const notablePromise = fetchNotable()
      .then((data) => chrome.storage.local.set({ notable: data }))
      .catch((e) => console.warn('[uPEG Lens] notable fetch failed:', e.message));
    const [p2pegListings, openseaListings] = await Promise.all([p2pegPromise, openseaPromise]);
    await notablePromise; // doesn't block listings if it fails
    if (p2pegListings.length === 0 && openseaListings.length === 0) {
      console.warn('[uPEG Lens] both sources returned empty, keeping previous index');
    } else {
      index = buildIndex(p2pegListings, openseaListings);
      lastRefresh = Date.now();
    }
    const byP2peg = [...index.values()].filter((l) => l.source === 'p2peg').length;
    const byOpensea = [...index.values()].filter((l) => l.source === 'opensea').length;
    console.log(`[uPEG Lens] indexed ${index.size} ETH listings (p2peg: ${byP2peg}, opensea: ${byOpensea})`);
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

// Refetch immediately when user updates their OpenSea key
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.opensea_user_key) refresh();
});
