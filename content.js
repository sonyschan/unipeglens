(() => {
  const FILTER_KEY = 'upeg-lens-filter';
  let seen = new WeakMap();
  let modal = null;
  let scanTimer = null;
  let listedCount = 0;
  let toggleEl = null;
  let enabled = true;
  const ready = (async () => {
    try {
      const r = await chrome.storage.local.get('enabled');
      enabled = r.enabled !== false;
    } catch {}
  })();

  const fmtEth = (wei) => {
    const eth = Number(BigInt(wei)) / 1e18;
    if (eth >= 100) return eth.toFixed(0);
    if (eth >= 10) return eth.toFixed(1);
    return eth.toFixed(2);
  };

  const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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
        chrome.runtime.sendMessage({ type: 'lookup', ids }, (resp) =>
          resolve(resp || {})
        );
      } catch {
        resolve({});
      }
    });
  }

  function paintBadge(card, listing) {
    card.classList.add('upeg-lens-has-listing');
    const host =
      card.querySelector('.upeg-card__plate-row--top') ||
      card.querySelector('.upeg-card__image') ||
      card;
    if (host.querySelector(':scope > .upeg-lens-badge')) return;
    const badge = document.createElement('div');
    badge.className = 'upeg-lens-badge';
    const eth = fmtEth(listing.priceWei);
    const bundle = listing.upegCount > 1 ? '📦 ' : '';
    badge.textContent = `${bundle}${eth} Ξ`;
    badge.title = `Listed on p2peg for ${eth} ETH${
      listing.upegCount > 1 ? ` (bundle of ${listing.upegCount})` : ''
    } — click for details`;
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

  let debugLogged = false;
  async function scan() {
    await ready;
    if (!enabled) return;
    const cards = findCards();
    if (!debugLogged) {
      console.log(`[uPEG Lens] first scan: found ${cards.length} .upeg-card elements`);
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
    if (!todo.length) return;
    const map = await lookup(todo.map((t) => t.id));
    let painted = 0;
    for (const { card, id } of todo) {
      const l = map[id];
      if (l) {
        paintBadge(card, l);
        painted++;
      } else {
        card.classList.add('upeg-lens-no-listing');
      }
    }
    listedCount += painted;
    updateToggleLabel();
    console.log(
      `[uPEG Lens] scan: ${todo.length} new card${todo.length === 1 ? '' : 's'}, ${painted} listed on p2peg`
    );
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[c])
    );
  }

  function closeModal() {
    if (!modal) return;
    modal.remove();
    modal = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') closeModal();
  }

  function openModal(listing) {
    closeModal();
    const eth = fmtEth(listing.priceWei);
    const otherIds = (listing.upegIds || []).slice(0, 20).map(escapeHtml).join(', ');
    const seller = escapeHtml(shortAddr(listing.seller || ''));
    const headId = escapeHtml(listing.upegIds?.[0] ?? '?');
    const lid = escapeHtml(listing.id);
    const tradeUrl = `https://p2peg.app/collections/unipeg?trade=${encodeURIComponent(
      listing.id
    )}`;

    modal = document.createElement('div');
    modal.className = 'upeg-lens-modal-backdrop';
    modal.innerHTML = `
      <div class="upeg-lens-modal" role="dialog" aria-modal="true">
        <button class="upeg-lens-close" aria-label="Close">×</button>
        <div class="upeg-lens-title">
          uPEG #${headId}${
            listing.upegCount > 1
              ? ` <span class="upeg-lens-bundle">+ ${listing.upegCount - 1} more</span>`
              : ''
          }
        </div>
        <div class="upeg-lens-price">${eth}<span> ETH</span></div>
        <div class="upeg-lens-row"><span>Seller</span><code>${seller}</code></div>
        <div class="upeg-lens-row"><span>Listing ID</span><code>#${lid}</code></div>
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
        <a class="upeg-lens-buy" href="${tradeUrl}" target="_blank" rel="noopener noreferrer">
          Buy on p2peg →
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

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }

  function isFilterOn() {
    try {
      return localStorage.getItem(FILTER_KEY) === '1';
    } catch {
      return false;
    }
  }

  function applyFilterClass() {
    document.body.classList.toggle('upeg-lens-filtered', isFilterOn());
  }

  function updateToggleLabel() {
    if (!toggleEl) return;
    const on = isFilterOn();
    toggleEl.classList.toggle('upeg-lens-toggle--on', on);
    toggleEl.querySelector('.upeg-lens-toggle__count').textContent = String(listedCount);
    toggleEl.querySelector('.upeg-lens-toggle__label').textContent = on
      ? 'Showing listings'
      : 'Listings only';
  }

  function mountToggle() {
    if (toggleEl) return;
    toggleEl = document.createElement('button');
    toggleEl.className = 'upeg-lens-toggle';
    toggleEl.type = 'button';
    toggleEl.innerHTML = `
      <span class="upeg-lens-toggle__dot"></span>
      <span class="upeg-lens-toggle__label">Listings only</span>
      <span class="upeg-lens-toggle__count">0</span>
    `;
    toggleEl.addEventListener('click', () => {
      const next = !isFilterOn();
      try { localStorage.setItem(FILTER_KEY, next ? '1' : '0'); } catch {}
      applyFilterClass();
      updateToggleLabel();
    });
    document.body.appendChild(toggleEl);
    updateToggleLabel();
  }

  function tearDown() {
    document.querySelectorAll('.upeg-lens-badge').forEach((b) => b.remove());
    document.querySelectorAll('.upeg-card').forEach((c) => {
      c.classList.remove('upeg-lens-has-listing', 'upeg-lens-no-listing');
    });
    document.body.classList.remove('upeg-lens-filtered');
    if (toggleEl) toggleEl.style.display = 'none';
    closeModal();
    seen = new WeakMap();
    listedCount = 0;
  }

  function bringUp() {
    if (toggleEl) toggleEl.style.display = '';
    applyFilterClass();
    updateToggleLabel();
    scan();
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    if (enabled) bringUp();
    else tearDown();
  });

  ready.then(() => {
    if (!enabled) {
      if (toggleEl) toggleEl.style.display = 'none';
      return;
    }
    applyFilterClass();
  });

  mountToggle();
  scan();
  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log('[uPEG Lens] content script active');
})();
