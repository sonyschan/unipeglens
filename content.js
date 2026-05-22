(() => {
  const FILTER_KEY = 'upeg-lens-filter';
  const SHOW_P2PEG_KEY = 'upeg-lens-show-p2peg';
  const SHOW_OPENSEA_KEY = 'upeg-lens-show-opensea';
  const OPENSEA_CONTRACT = '0xfd7db13b002f927891ab20ebbca890c1b5a459fd';

  let seen = new WeakMap();
  let modal = null;
  let scanTimer = null;
  let chipEl = null;
  let popoverEl = null;
  let countsEl = { total: null, p2peg: null, opensea: null };
  let enabled = true;
  let notable = null;
  const ready = (async () => {
    try {
      const r = await chrome.storage.local.get(['enabled', 'notable']);
      enabled = r.enabled !== false;
      notable = r.notable || null;
    } catch {}
  })();

  // ---------- formatting ----------
  const fmtEth = (wei) => {
    const eth = Number(BigInt(wei)) / 1e18;
    if (eth >= 100) return eth.toFixed(0);
    if (eth >= 10) return eth.toFixed(1);
    return eth.toFixed(2);
  };
  const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const escapeHtml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  // ---------- prefs ----------
  function readBool(key, def) {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return def;
      return v === '1';
    } catch {
      return def;
    }
  }
  function writeBool(key, val) {
    try { localStorage.setItem(key, val ? '1' : '0'); } catch {}
  }
  const prefs = {
    get filter() { return readBool(FILTER_KEY, false); },
    set filter(v) { writeBool(FILTER_KEY, v); },
    get showP2peg() { return readBool(SHOW_P2PEG_KEY, true); },
    set showP2peg(v) { writeBool(SHOW_P2PEG_KEY, v); },
    get showOpensea() { return readBool(SHOW_OPENSEA_KEY, true); },
    set showOpensea(v) { writeBool(SHOW_OPENSEA_KEY, v); },
  };

  // ---------- card discovery ----------
  function extractDisplayId(card) {
    const el = card.querySelector('.upeg-card__plate-num');
    if (!el) return null;
    const m = (el.textContent || '').match(/(\d+)/);
    return m ? m[1] : null;
  }
  function findCards() {
    return [...document.querySelectorAll('.upeg-card')];
  }

  function lookup(ids) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'lookup', ids }, (r) => resolve(r || {}));
      } catch {
        resolve({});
      }
    });
  }

  // ---------- badge ----------
  function paintBadge(card, listing) {
    const src = listing.source || 'p2peg';
    card.classList.add('upeg-lens-has-listing', `upeg-lens-source-${src}`);
    const host =
      card.querySelector('.upeg-card__plate-row--top') ||
      card.querySelector('.upeg-card__image') ||
      card;
    if (host.querySelector(':scope > .upeg-lens-badge')) return;
    const badge = document.createElement('div');
    badge.className = `upeg-lens-badge upeg-lens-badge--${src}`;
    const eth = fmtEth(listing.priceWei);
    const bundle = listing.upegCount > 1 ? '📦 ' : '';
    badge.textContent = `${bundle}${eth} Ξ`;
    badge.title = `${src === 'opensea' ? 'OpenSea' : 'p2peg'} listing — ${eth} ETH`;
    badge.dataset.listingId = listing.id;
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openModal(listing);
    });
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    host.appendChild(badge);
  }

  // ---------- scan ----------
  let debugLogged = false;
  async function scan() {
    await ready;
    if (!enabled) return;
    const cards = findCards();
    if (!debugLogged) {
      console.log(`[Unipeg Lens] first scan: found ${cards.length} .upeg-card elements`);
      debugLogged = true;
    }
    const todo = [];
    for (const card of cards) {
      if (seen.has(card)) continue;
      const id = extractDisplayId(card);
      if (!id) continue;
      seen.set(card, id);
      todo.push({ card, id });
    }
    let painted = 0;
    if (todo.length) {
      const map = await lookup(todo.map((t) => t.id));
      for (const { card, id } of todo) {
        const l = map[id];
        if (l) {
          paintBadge(card, l);
          painted++;
        } else {
          card.classList.add('upeg-lens-no-listing');
        }
      }
    }
    refreshCounts();
    if (todo.length) {
      console.log(`[Unipeg Lens] scan: ${todo.length} new card${todo.length === 1 ? '' : 's'}, ${painted} listed`);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }

  // ---------- modal ----------
  function closeModal() {
    if (!modal) return;
    modal.remove();
    modal = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') closeModal();
  }

  function buyUrlFor(listing) {
    if (listing.source === 'opensea') {
      const tokenId = listing.tokenId || listing.upegIds?.[0];
      return `https://opensea.io/assets/ethereum/${OPENSEA_CONTRACT}/${tokenId}`;
    }
    return `https://p2peg.app/collections/unipeg?trade=${encodeURIComponent(listing.id)}`;
  }

  function sourceLabel(src) {
    return src === 'opensea' ? 'OpenSea' : 'p2peg';
  }

  function openModal(listing) {
    closeModal();
    const eth = fmtEth(listing.priceWei);
    const otherIds = (listing.upegIds || []).slice(0, 20).map(escapeHtml).join(', ');
    const seller = escapeHtml(shortAddr(listing.seller || ''));
    const headId = escapeHtml(listing.upegIds?.[0] ?? '?');
    const src = listing.source || 'p2peg';
    const srcLabel = sourceLabel(src);
    const buyUrl = buyUrlFor(listing);

    modal = document.createElement('div');
    modal.className = 'upeg-lens-modal-backdrop';
    modal.innerHTML = `
      <div class="upeg-lens-modal" role="dialog" aria-modal="true">
        <button class="upeg-lens-close" aria-label="Close">×</button>
        <div class="upeg-lens-source-tag upeg-lens-source-tag--${src}">${srcLabel}</div>
        <div class="upeg-lens-title">
          uPEG #${headId}${
            listing.upegCount > 1
              ? ` <span class="upeg-lens-bundle">+ ${listing.upegCount - 1} more</span>`
              : ''
          }
        </div>
        <div class="upeg-lens-price">${eth}<span> ETH</span></div>
        <div class="upeg-lens-row"><span>Seller</span><code>${seller}</code></div>
        ${
          src === 'p2peg'
            ? `<div class="upeg-lens-row"><span>Listing ID</span><code>#${escapeHtml(listing.id)}</code></div>`
            : ''
        }
        ${
          listing.rarity
            ? `
          <div class="upeg-lens-row"><span>Combined rank</span><b>#${listing.rarity.combinedRank}</b></div>
          <div class="upeg-lens-row"><span>Color rank</span><b>#${listing.rarity.colorRank}</b></div>
          <div class="upeg-lens-row"><span>Trait rank</span><b>#${listing.rarity.traitRank}</b></div>`
            : ''
        }
        ${
          listing.upegCount > 1
            ? `<div class="upeg-lens-row upeg-lens-row-wrap"><span>Bundle</span><code>${otherIds}</code></div>`
            : ''
        }
        <a class="upeg-lens-buy upeg-lens-buy--${src}" href="${buyUrl}" target="_blank" rel="noopener noreferrer">
          Buy on ${srcLabel} →
        </a>
      </div>
    `;
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.classList.contains('upeg-lens-close')) {
        closeModal();
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
  }

  // ---------- chip + popover ----------
  function applyBodyClasses() {
    document.body.classList.toggle('upeg-lens-filtered', prefs.filter);
    document.body.classList.toggle('upeg-lens-hide-p2peg', !prefs.showP2peg);
    document.body.classList.toggle('upeg-lens-hide-opensea', !prefs.showOpensea);
  }

  // Map current URL filter param to its true total from the notable API.
  // Falls back to the count of loaded .upeg-card-wrap elements when the
  // filter isn't a known notable set (e.g. owner search).
  function getActiveTotal() {
    if (notable) {
      const filter = new URLSearchParams(location.search).get('filter');
      if (filter && notable.sets && notable.sets[filter]) {
        return notable.sets[filter].count;
      }
      // No filter param → "All uPEGs"
      if (!filter && typeof notable.total === 'number') {
        return notable.total;
      }
    }
    return (
      document.querySelectorAll('.upeg-card-wrap').length ||
      document.querySelectorAll('.upeg-card').length
    );
  }

  function refreshCounts() {
    if (!chipEl) return;
    const totalCards = getActiveTotal();
    const p2peg = document.querySelectorAll('.upeg-card.upeg-lens-source-p2peg').length;
    const opensea = document.querySelectorAll('.upeg-card.upeg-lens-source-opensea').length;
    let visible = 0;
    if (prefs.showP2peg) visible += p2peg;
    if (prefs.showOpensea) visible += opensea;

    const fmt = (n) => (totalCards > 0 ? `${n}/${totalCards}` : String(n));
    if (countsEl.p2peg) countsEl.p2peg.textContent = fmt(p2peg);
    if (countsEl.opensea) countsEl.opensea.textContent = fmt(opensea);
    if (countsEl.total) countsEl.total.textContent = fmt(visible);
    chipEl.classList.toggle('upeg-lens-chip--filtered', prefs.filter);
  }

  // Watch URL changes (Vue Router uses pushState/replaceState — popstate
  // alone misses them).
  function watchUrlChanges(cb) {
    const wrap = (orig) =>
      function (...args) {
        const r = orig.apply(this, args);
        cb();
        return r;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', cb);
  }

  function buildPopover() {
    const pop = document.createElement('div');
    pop.className = 'upeg-lens-popover';
    pop.innerHTML = `
      <div class="upeg-lens-popover__title">Sources</div>
      <label class="upeg-lens-popover__row">
        <input type="checkbox" data-pref="p2peg" />
        <span class="upeg-lens-popover__check"></span>
        <span class="upeg-lens-popover__name">
          <span class="upeg-lens-popover__dot upeg-lens-popover__dot--p2peg"></span>
          p2peg
        </span>
        <span class="upeg-lens-popover__count" data-count="p2peg">0</span>
      </label>
      <label class="upeg-lens-popover__row">
        <input type="checkbox" data-pref="opensea" />
        <span class="upeg-lens-popover__check"></span>
        <span class="upeg-lens-popover__name">
          <span class="upeg-lens-popover__dot upeg-lens-popover__dot--opensea"></span>
          OpenSea
        </span>
        <span class="upeg-lens-popover__count" data-count="opensea">0</span>
      </label>
      <div class="upeg-lens-popover__divider"></div>
      <label class="upeg-lens-popover__row">
        <input type="checkbox" data-pref="filter" />
        <span class="upeg-lens-popover__check"></span>
        <span class="upeg-lens-popover__name">Listings only</span>
      </label>
    `;
    const pBox = pop.querySelector('input[data-pref="p2peg"]');
    const oBox = pop.querySelector('input[data-pref="opensea"]');
    const fBox = pop.querySelector('input[data-pref="filter"]');
    pBox.checked = prefs.showP2peg;
    oBox.checked = prefs.showOpensea;
    fBox.checked = prefs.filter;
    pBox.addEventListener('change', () => { prefs.showP2peg = pBox.checked; applyBodyClasses(); refreshCounts(); });
    oBox.addEventListener('change', () => { prefs.showOpensea = oBox.checked; applyBodyClasses(); refreshCounts(); });
    fBox.addEventListener('change', () => { prefs.filter = fBox.checked; applyBodyClasses(); refreshCounts(); });

    countsEl.p2peg = pop.querySelector('[data-count="p2peg"]');
    countsEl.opensea = pop.querySelector('[data-count="opensea"]');
    return pop;
  }

  function togglePopover(force) {
    const open = force ?? !popoverEl;
    if (open && !popoverEl) {
      popoverEl = buildPopover();
      document.body.appendChild(popoverEl);
      positionPopover();
      refreshCounts();
      setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
    } else if (!open && popoverEl) {
      popoverEl.remove();
      popoverEl = null;
      document.removeEventListener('click', onOutsideClick, true);
    }
  }
  function onOutsideClick(e) {
    if (!popoverEl) return;
    if (popoverEl.contains(e.target) || chipEl.contains(e.target)) return;
    togglePopover(false);
  }
  function positionPopover() {
    if (!popoverEl || !chipEl) return;
    const r = chipEl.getBoundingClientRect();
    popoverEl.style.right = `${window.innerWidth - r.right}px`;
    popoverEl.style.bottom = `${window.innerHeight - r.top + 8}px`;
  }

  function mountChip() {
    if (chipEl) return;
    chipEl = document.createElement('button');
    chipEl.className = 'upeg-lens-chip';
    chipEl.type = 'button';
    chipEl.innerHTML = `
      <span class="upeg-lens-chip__dot"></span>
      <span class="upeg-lens-chip__count" data-count="total">0</span>
      <span class="upeg-lens-chip__label">listings</span>
    `;
    chipEl.addEventListener('click', () => togglePopover());
    document.body.appendChild(chipEl);
    countsEl.total = chipEl.querySelector('[data-count="total"]');
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
  }

  // ---------- enable / disable ----------
  function tearDown() {
    document.querySelectorAll('.upeg-lens-badge').forEach((b) => b.remove());
    document.querySelectorAll('.upeg-card').forEach((c) => {
      c.classList.remove(
        'upeg-lens-has-listing',
        'upeg-lens-no-listing',
        'upeg-lens-source-p2peg',
        'upeg-lens-source-opensea'
      );
    });
    document.body.classList.remove(
      'upeg-lens-filtered',
      'upeg-lens-hide-p2peg',
      'upeg-lens-hide-opensea'
    );
    if (chipEl) chipEl.style.display = 'none';
    togglePopover(false);
    closeModal();
    seen = new WeakMap();
  }
  function bringUp() {
    if (chipEl) chipEl.style.display = '';
    applyBodyClasses();
    refreshCounts();
    scan();
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (enabled) bringUp();
      else tearDown();
    }
    if (changes.notable) {
      notable = changes.notable.newValue || null;
      refreshCounts();
    }
  });

  watchUrlChanges(() => refreshCounts());

  ready.then(() => {
    if (!enabled) {
      if (chipEl) chipEl.style.display = 'none';
      return;
    }
    applyBodyClasses();
    refreshCounts();
  });

  mountChip();
  applyBodyClasses();
  scan();
  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('[Unipeg Lens] content script active (v1.3.0)');
})();
