// Unipeg Lens — myupeg.art trait highlighter + opt-in auto-draw.
//
// On myupeg.art the "抽取" panel lists the selected uPEG's 部件 (parts)
// and 颜色 (colors). This script:
//   1. Stars each monitored part whose value matches a wanted profile.
//   2. Keeps section 02 fed — re-selects the first candidate whenever the
//      selection is lost (the uPEG set drops it on every refresh).
//   3. Offers an opt-in "auto-draw" — when armed via the floating toggle,
//      it clicks the 抽取 button once the shown uPEG hits a threshold.
//
// Auto-draw spends real ETH and burns a uPEG, so it is OFF by default,
// must be armed manually each session (never persisted), and disarms
// itself after a single click.
(() => {
  // ----- star profile -----
  // Wanted state per monitored part, each judged independently:
  //   'none'  → star when the part value is 无
  //   'value' → star when the part has any value (not 无)
  const WANTED = {
    '头发': 'none',
    '犄角': 'value',
    '翅膀': 'value',
    '尾巴': 'none',
    '饰品': 'value',
  };
  const STAR_CLASS = 'upeg-lens-star';
  const NONE_TEXT = '无';

  // ----- auto-draw thresholds -----
  const PART_COUNT = 7;   // a fully rendered 部件 panel has 7 rows
  const PARTS_REPEAT = 5; // fire when 5+ parts share one number
  const COLOR_REPEAT = 4; // fire when 4+ colors share one hexcode

  // A candidate click takes a moment to register — don't re-click within
  // this window, so we never toggle a card off mid-selection.
  const SELECT_COOLDOWN_MS = 1000;

  let scanTimer = null;
  let enabled = true;
  let armed = false;       // session-only — never persisted across reloads
  let autodrawResult = ''; // '', 'fired', 'unavailable'
  let toggleEl = null;
  let lastSelectClick = 0;

  const ready = (async () => {
    try {
      const r = await chrome.storage.local.get('enabled');
      enabled = r.enabled !== false;
    } catch {}
  })();

  // ---------- panel discovery ----------
  // The panels carry only Tailwind utility classes — no id/data-*. Anchor
  // on the section headings (<h3>部件</h3> / <h3>颜色</h3>) instead.
  function sectionByHeading(title) {
    for (const h of document.querySelectorAll('h3')) {
      if ((h.textContent || '').trim() === title) return h.parentElement;
    }
    return null;
  }
  function findPartsLists() {
    const lists = [];
    for (const h of document.querySelectorAll('h3')) {
      if ((h.textContent || '').trim() !== '部件') continue;
      const dl = h.parentElement && h.parentElement.querySelector('dl');
      if (dl) lists.push(dl);
    }
    return lists;
  }

  // ---------- section 02 candidate grid ----------
  // Candidate cards are <button>s wrapping a uPEG image (<span class="pixel">).
  // The selected card is bordered magenta — its class names reference
  // --color-magenta; unselected cards never do.
  function isCandidateSelected(btn) {
    return String(btn.className).includes('--color-magenta');
  }
  // Returns the candidate buttons in document order, picking the parent
  // that holds the most of them (the real grid) to ignore stray matches.
  function findCandidateGrid() {
    const btns = [];
    for (const b of document.querySelectorAll('button')) {
      if (b.querySelector('span.pixel')) btns.push(b);
    }
    if (!btns.length) return null;
    const byParent = new Map();
    for (const b of btns) {
      const p = b.parentElement;
      if (!p) continue;
      const list = byParent.get(p);
      if (list) list.push(b);
      else byParent.set(p, [b]);
    }
    let best = null;
    for (const list of byParent.values()) {
      if (!best || list.length > best.length) best = list;
    }
    return best;
  }
  // Section 02 drops its selection whenever the uPEG set refreshes, which
  // leaves section 03 (and the stars / auto-draw) with nothing to read.
  // Re-select the first candidate whenever nothing is selected.
  function ensureSelection() {
    const cards = findCandidateGrid();
    if (!cards || !cards.length) return;
    if (cards.some(isCandidateSelected)) return;
    if (Date.now() - lastSelectClick < SELECT_COOLDOWN_MS) return;
    lastSelectClick = Date.now();
    console.log('[Unipeg Lens] section 02 had no selection — selecting first uPEG');
    cards[0].click();
  }

  // ---------- stars ----------
  function hasValue(dd) {
    const text = (dd.textContent || '').trim();
    return text !== '' && text !== NONE_TEXT;
  }
  // The star is drawn with a CSS ::before, so it never enters textContent —
  // the raw <dt> label stays readable on every pass.
  function setStar(dt, on) {
    if (on === dt.classList.contains(STAR_CLASS)) return; // idempotent
    dt.classList.toggle(STAR_CLASS, on);
  }
  function applyStars(dl) {
    for (const dt of dl.querySelectorAll('dt')) {
      const wanted = WANTED[(dt.textContent || '').trim()];
      const dd = dt.nextElementSibling;
      if (!wanted || !dd || dd.tagName !== 'DD') {
        setStar(dt, false);
        continue;
      }
      const match = wanted === 'value' ? hasValue(dd) : !hasValue(dd);
      setStar(dt, match);
    }
  }

  // ---------- auto-draw: reading the panel ----------
  // Numbers from the 部件 panel (无 / blank ignored — not a number).
  function readPartNumbers() {
    const dls = findPartsLists();
    if (!dls.length) return null;
    const nums = [];
    let rows = 0;
    for (const dt of dls[0].querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== 'DD') continue;
      rows++;
      const text = (dd.textContent || '').trim();
      const n = Number(text);
      if (text !== '' && Number.isFinite(n)) nums.push(n);
    }
    return { rows, nums };
  }
  // Hexcodes from the 颜色 panel, lower-cased for comparison. Non-color
  // text (numbers, 无) simply never matches the hex pattern.
  function readColorHexes() {
    const section = sectionByHeading('颜色');
    if (!section) return null;
    const hexes = [];
    for (const dd of section.querySelectorAll('dd')) {
      const m = (dd.textContent || '').match(/#[0-9a-fA-F]{6}/);
      if (m) hexes.push(m[0].toLowerCase());
    }
    return hexes;
  }
  function maxRepeat(arr) {
    const counts = new Map();
    let max = 0;
    for (const v of arr) {
      const c = (counts.get(v) || 0) + 1;
      counts.set(v, c);
      if (c > max) max = c;
    }
    return max;
  }
  function findDrawButton() {
    for (const b of document.querySelectorAll('button')) {
      if ((b.textContent || '').trim() === '抽取') return b;
    }
    return null;
  }

  // ---------- auto-draw: decision + click ----------
  function checkAutoDraw() {
    if (!enabled || !armed) return;
    // Only evaluate a uPEG that section 02 actually has selected — otherwise
    // section 03 is empty or showing stale data.
    const cards = findCandidateGrid();
    if (cards && cards.length && !cards.some(isCandidateSelected)) return;
    const parts = readPartNumbers();
    if (parts && parts.rows >= PART_COUNT && maxRepeat(parts.nums) >= PARTS_REPEAT) {
      fireDraw('部件 ' + PARTS_REPEAT + '+ 个相同数字');
      return;
    }
    const colors = readColorHexes();
    if (colors && maxRepeat(colors) >= COLOR_REPEAT) {
      fireDraw('颜色 ' + COLOR_REPEAT + '+ 个相同 hexcode');
    }
  }
  function fireDraw(reason) {
    const btn = findDrawButton();
    if (!btn) return; // panel still rendering — stay armed, retry next scan
    // One-shot: disarm synchronously *before* clicking, so a re-render
    // driven by the click can never trigger a second draw.
    armed = false;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      console.warn('[Unipeg Lens] auto-draw matched (' + reason + ') — 抽取 button disabled, skipped');
      autodrawResult = 'unavailable';
      updateToggleUI();
      return;
    }
    console.log('[Unipeg Lens] auto-draw FIRED — ' + reason);
    autodrawResult = 'fired';
    updateToggleUI();
    btn.click();
  }

  // ---------- the floating arm toggle ----------
  function mountToggle() {
    if (toggleEl) return;
    toggleEl = document.createElement('button');
    toggleEl.className = 'upeg-autodraw';
    toggleEl.type = 'button';
    toggleEl.innerHTML =
      '<span class="upeg-autodraw__dot"></span>' +
      '<span class="upeg-autodraw__text">' +
      '<span class="upeg-autodraw__title">AUTO-DRAW</span>' +
      '<span class="upeg-autodraw__state"></span>' +
      '</span>';
    toggleEl.addEventListener('click', onToggleClick);
    document.body.appendChild(toggleEl);
    updateToggleUI();
  }
  function onToggleClick() {
    if (armed) {
      armed = false;
    } else {
      armed = true;
      autodrawResult = '';
    }
    updateToggleUI();
    if (armed) checkAutoDraw(); // evaluate the uPEG already on screen
  }
  function updateToggleUI() {
    if (!toggleEl) return;
    toggleEl.style.display = enabled ? '' : 'none';
    toggleEl.classList.toggle('upeg-autodraw--armed', armed);
    toggleEl.classList.toggle('upeg-autodraw--fired', !armed && autodrawResult === 'fired');
    const state = toggleEl.querySelector('.upeg-autodraw__state');
    if (armed) {
      state.textContent = 'ARMED — 待命中';
      toggleEl.title = '已武装：命中条件时自动点击 抽取（花费真实 ETH）。点此解除。';
    } else if (autodrawResult === 'fired') {
      state.textContent = '已抽取 ✓';
      toggleEl.title = '已自动点击 抽取。点此重新武装。';
    } else if (autodrawResult === 'unavailable') {
      state.textContent = '抽取按钮不可用';
      toggleEl.title = '命中条件，但 抽取 按钮当时不可点。点此重新武装。';
    } else {
      state.textContent = 'OFF';
      toggleEl.title = '点此武装自动抽取。';
    }
  }

  // ---------- scan loop ----------
  function scan() {
    if (!enabled) return;
    for (const dl of findPartsLists()) applyStars(dl);
    ensureSelection();
    checkAutoDraw();
  }
  function clearStars() {
    document
      .querySelectorAll('.' + STAR_CLASS)
      .forEach((dt) => dt.classList.remove(STAR_CLASS));
  }
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }

  // Honour the toolbar on/off toggle, same as the unipeg.art content script.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    if (!enabled) armed = false; // disabling the extension also disarms
    updateToggleUI();
    if (enabled) scan();
    else clearStars();
  });

  ready.then(() => {
    mountToggle();
    scan();
  });
  // The panels render late and re-render on every card / seed change.
  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  console.log('[Unipeg Lens] myupeg.art content script active (v1.2.0)');
})();
