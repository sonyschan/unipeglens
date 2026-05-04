const API_BASE = 'https://server.p2peg.app';
const PAGE_SIZE = 60;
const ETH_TOKEN = '0x0000000000000000000000000000000000000000';
const STALE_MS = 30_000;

let index = new Map();
let lastRefresh = 0;
let inFlight = null;

const listingsUrl = (offset) =>
  `${API_BASE}/listings?limit=${PAGE_SIZE}&offset=${offset}&status=OPEN`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(offset) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(listingsUrl(offset));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(2000);
    }
  }
}

async function fetchAllListings() {
  const all = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { items = [] } = await fetchPage(offset);
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    if (offset > 100_000) break;
  }
  return all;
}

function buildIndex(listings) {
  const m = new Map();
  for (const l of listings) {
    if ((l.paymentToken || '').toLowerCase() !== ETH_TOKEN) continue;
    for (const id of l.upegIds || []) {
      m.set(String(id), l);
    }
  }
  return m;
}

function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const listings = await fetchAllListings();
      index = buildIndex(listings);
      lastRefresh = Date.now();
      console.log(`[uPEG Lens] indexed ${index.size} ETH listings`);
    } catch (e) {
      console.warn('[uPEG Lens] refresh failed (will retry next cycle):', e.message);
    } finally {
      inFlight = null;
    }
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
