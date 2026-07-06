// upeg-hunter — myupeg.art trait highlighter + opt-in auto-draw.
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
  const PART_COUNT = 7;       // a fully rendered 部件 panel has 7 rows
  const PARTS_REPEAT = 5;     // fire alone when 5+ parts share one number
  const COLOR_REPEAT = 2;     // #4 — colour stack: 2+ colors share one hexcode
  const AUTODRAW_MT_TIER = 12; // fire alone when the uPEG hits Mine Tier 12
  const AUTODRAW_RANK_LIMIT = 30; // #2 — OR & MR rank gate (both ranks ≤ this)
  const AUTODRAW_COLOR_OR_LIMIT = 60; // #4 — OR gate paired with the colour+parts stack (≤)
  const AUTODRAW_COLOR_TT_MIN = 4; // #4 — also require 4+ parts sharing one number (TT)
  // #5 — parts-led stack: 3+ colour stack AND 4+ parts (TT) AND OR ≤ 180.
  // No element or MR gate (looser on colour/element than #4, stricter on TT).
  const AUTODRAW_C5_COLOR_MIN = 3;  // #5 — 3+ colours sharing one hexcode
  const AUTODRAW_C5_TT_MIN = 4;     // #5 — 4+ parts sharing one number (TT)
  const AUTODRAW_C5_OR_LIMIT = 180; // #5 — OR gate (≤)
  // Trait values can take ~1s to finish rendering after a uPEG switch —
  // never draw until the panel data has held still this long.
  const SETTLE_MS = 800;

  // A candidate click takes a moment to register — don't re-click within
  // this window, so we never toggle a card off mid-selection.
  const SELECT_COOLDOWN_MS = 1000;

  let scanTimer = null;
  let enabled = true;
  // Auto-draw is gated behind a local opt-in flag (chrome.storage.local
  // `autodraw`). It stays dormant — the floating toggle never mounts and no
  // ETH is ever spent — unless that flag is explicitly set to true on this
  // machine, so a default (public) install only gets the rarity box + stars.
  // The logic below is intentionally left in the source; enable it yourself
  // if you understand and accept that auto-draw spends real ETH.
  let autodrawUnlocked = false;
  let armed = false;       // session-only — never persisted across reloads
  let autodrawResult = ''; // '', 'fired', 'unavailable'
  let toggleEl = null;
  let lastSelectClick = 0;
  let pendingDraw = null;  // { fingerprint, since } — auto-draw settle gate
  let confirmTimer = null; // re-checks the panel after it goes quiet
  let observer = null;     // MutationObserver — disconnected on context loss

  const ready = (async () => {
    try {
      const r = await chrome.storage.local.get(['enabled', 'autodraw']);
      enabled = r.enabled !== false;
      autodrawUnlocked = r.autodraw === true;
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
    console.log('[upeg-hunter] section 02 had no selection — selecting first uPEG');
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
  // Whether a part row matches its wanted state — the basis for both the
  // star prefix and the star-count auto-draw signal.
  function partMatchesWanted(dt) {
    const wanted = WANTED[(dt.textContent || '').trim()];
    if (!wanted) return false;
    const dd = dt.nextElementSibling;
    if (!dd || dd.tagName !== 'DD') return false;
    return wanted === 'value' ? hasValue(dd) : !hasValue(dd);
  }
  function applyStars(dl) {
    for (const dt of dl.querySelectorAll('dt')) {
      setStar(dt, partMatchesWanted(dt));
    }
  }

  // ---------- auto-draw: reading the panel ----------
  // Reads the 部件 panel: row count and the numeric values (无 / blank
  // ignored — not a number).
  function readParts() {
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
  // Decides whether the current panel warrants a draw. Pure read — returns
  // the reason string (or null) plus a fingerprint of the data it judged,
  // so the caller can tell when the panel has stopped changing.
  function decideAutoDraw() {
    const parts = readParts();
    const partsReady = !!parts && parts.rows >= PART_COUNT;
    const partsRepeat = partsReady ? maxRepeat(parts.nums) : 0;

    const colors = readColorHexes();
    const colorRepeat = maxRepeat(colors || []);

    let reason = null;
    // Rarity signals from the background — `lastRarityResult` is the
    // scoreCandidate response (an object once it has answered). It is async
    // and tracked by a SEPARATE fingerprint (lastRarityFp) than the live
    // parts/colors above, so it can lag a uPEG switch and hold the PREVIOUS
    // candidate's result (e.g. during a partial render where readPanelTraits
    // returns null and updateRarityPanel never clears it). Trust `rar` only
    // when its committed fingerprint matches the panel we're judging now —
    // otherwise a stale element/orRank/mrTier could fire a draw on the wrong
    // card (the forest-drawn-as-lightning bug).
    const curRarityFp = JSON.stringify([readPanelTraits(), readPanelColors()]);
    const rar =
      lastRarityFp === curRarityFp &&
      lastRarityResult &&
      typeof lastRarityResult === 'object'
        ? lastRarityResult
        : null;
    if (rar && rar.mrTier === AUTODRAW_MT_TIER) {
      // Top Mine Tier — the rarest bucket.
      reason = 'Mine Tier ' + AUTODRAW_MT_TIER + '（最稀有）';
    } else if (
      rar &&
      rar.orRank <= AUTODRAW_RANK_LIMIT &&
      rar.mrRank <= AUTODRAW_RANK_LIMIT
    ) {
      // Rare double hit — top ranks by BOTH OpenRarity and MineRarity.
      reason =
        'OR 与 MR 名次同时 ≤ ' + AUTODRAW_RANK_LIMIT +
        '（OR #' + rar.orRank + ' / MR #' + rar.mrRank + '）';
    } else if (partsReady && partsRepeat >= PARTS_REPEAT) {
      // Strong single signal.
      reason = '部件 ' + PARTS_REPEAT + '+ 个相同数字';
    } else if (
      colorRepeat >= COLOR_REPEAT &&
      partsRepeat >= AUTODRAW_COLOR_TT_MIN &&
      rar && rar.orRank <= AUTODRAW_COLOR_OR_LIMIT
    ) {
      // Colour stack AND a strong parts stack AND a very-top-OR uPEG — the
      // tight OR ≤ 60 gate plus the 4+ parts (TT) stack carry the selectivity,
      // so the colour bar only needs 2+ and any element qualifies (the
      // lightning-only gate was dropped per user calibration).
      reason =
        '颜色 ' + COLOR_REPEAT + '+ 个相同 hexcode 且 部件 ' +
        AUTODRAW_COLOR_TT_MIN + '+ 个相同数字 且 OR ≤ ' +
        AUTODRAW_COLOR_OR_LIMIT +
        '（OR #' + rar.orRank + ' / TT ' + partsRepeat + '）';
    } else if (
      colorRepeat >= AUTODRAW_C5_COLOR_MIN &&
      partsRepeat >= AUTODRAW_C5_TT_MIN &&
      rar && rar.orRank <= AUTODRAW_C5_OR_LIMIT
    ) {
      // Parts-led variant of #4: a strong 4+ parts (TT) stack carries the
      // signal, so the colour bar drops to 3+ and the element gate is gone —
      // but the tight OR ≤ 180 gate keeps it to genuinely rare uPEGs. Any
      // element qualifies here (unlike #4's lightning-only gate).
      reason =
        '颜色 ' + AUTODRAW_C5_COLOR_MIN + '+ 个相同 hexcode 且 部件 ' +
        AUTODRAW_C5_TT_MIN + '+ 个相同数字 且 OR ≤ ' + AUTODRAW_C5_OR_LIMIT +
        '（OR #' + rar.orRank + ' / TT ' + partsRepeat + '）';
    }
    // Fingerprint of exactly the data this decision rested on.
    const fingerprint = JSON.stringify([
      parts ? parts.nums : null,
      colors,
    ]);
    return { reason: reason, fingerprint: fingerprint };
  }

  function checkAutoDraw() {
    if (!autodrawUnlocked || !enabled || !armed) {
      pendingDraw = null;
      return;
    }
    // Only evaluate a uPEG that section 02 actually has selected — otherwise
    // section 03 is empty or showing stale data.
    const cards = findCandidateGrid();
    if (cards && cards.length && !cards.some(isCandidateSelected)) {
      pendingDraw = null;
      return;
    }

    const decision = decideAutoDraw();
    if (!decision.reason) {
      pendingDraw = null;
      return;
    }

    // Settle gate: trait values and stars can take ~1s to finish rendering
    // after a uPEG switch. Never draw on a half-settled panel — require the
    // exact same data to hold for SETTLE_MS first.
    const now = Date.now();
    if (pendingDraw && pendingDraw.fingerprint === decision.fingerprint) {
      if (now - pendingDraw.since >= SETTLE_MS) {
        pendingDraw = null;
        clearTimeout(confirmTimer);
        confirmTimer = null;
        fireDraw(decision.reason);
      }
      return;
    }
    // First sighting, or the panel changed — (re)start the settle clock.
    pendingDraw = { fingerprint: decision.fingerprint, since: now };
    // Once the panel goes quiet, no mutation would trigger another scan,
    // so schedule the confirming re-check ourselves.
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(function () {
      confirmTimer = null;
      checkAutoDraw();
    }, SETTLE_MS + 50);
  }
  function fireDraw(reason) {
    const btn = findDrawButton();
    if (!btn) return; // panel still rendering — stay armed, retry next scan
    // One-shot: disarm synchronously *before* clicking, so a re-render
    // driven by the click can never trigger a second draw.
    armed = false;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      console.warn('[upeg-hunter] auto-draw matched (' + reason + ') — 抽取 button disabled, skipped');
      autodrawResult = 'unavailable';
      updateToggleUI();
      return;
    }
    console.log('[upeg-hunter] auto-draw FIRED — ' + reason);
    autodrawResult = 'fired';
    updateToggleUI();
    btn.click();
  }

  // ---------- the floating arm toggle ----------
  function mountToggle() {
    if (!autodrawUnlocked) return; // dormant unless locally unlocked
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
      pendingDraw = null;
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

  // ---------- rarity panel (estimated OR / MR rank) ----------
  // The 抽取 panel exposes the candidate uPEG's 部件 indices and 颜色
  // hexes — exactly the inputs OpenRarity + MineRarity need. We read them,
  // ask the background to rank the candidate against the full collection,
  // and show the estimated OR / MR rank right above the 抽取 button.

  // 部件 panel <dt> label → metadata trait key.
  const PART_LABEL_TO_KEY = {
    '头发': 'hair',
    '犄角': 'horn',
    '翅膀': 'wings',
    '尾巴': 'tail',
    '饰品': 'accessories',
    '前腿': 'legsFront',
    '后腿': 'legsBack',
  };
  // 颜色 panel <dt> label substring → metadata colour key.
  const COLOR_LABEL_RULES = [
    ['背景', 'backGroundColor'],
    ['身体', 'bodyColor'],
    ['眼睛', 'eyesColor'],
    ['头发', 'hairColor'],
    ['犄角', 'hornColor'],
    ['尾巴', 'tailColor'],
    ['饰品', 'accessoriesColor'],
  ];

  let lastRarityFp = '';       // fingerprint of the last-scored candidate
  let lastRarityResult = null; // cached score response for that fingerprint
  // Display settle gate: the 部件 rows update one-at-a-time on a candidate
  // switch, so a scan can read a half-updated panel (some rows still the
  // previous candidate's) — a mixed fingerprint that scores to a wrong,
  // often rarer rank. Like auto-draw, require the panel fingerprint to hold
  // still for SETTLE_MS before we score/show it, so the box never flashes a
  // rank that doesn't belong to the uPEG actually on screen.
  let pendingRarityFp = '';    // fingerprint awaiting the settle window
  let pendingRaritySince = 0;  // when that fingerprint was first seen
  let rarityConfirmTimer = null; // re-checks once the panel goes quiet

  // The 7 部件 rows as { traitKey: index } — null until all 7 have rendered.
  function readPanelTraits() {
    const dls = findPartsLists();
    if (!dls.length) return null;
    const traits = {};
    let mapped = 0;
    for (const dt of dls[0].querySelectorAll('dt')) {
      const key = PART_LABEL_TO_KEY[(dt.textContent || '').trim()];
      if (!key) continue;
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== 'DD') continue;
      const text = (dd.textContent || '').trim();
      const n = Number(text);
      traits[key] = text !== '' && Number.isFinite(n) ? n : 0; // 无 → 0
      mapped++;
    }
    return mapped === 7 ? traits : null;
  }

  // The 颜色 rows as { colorKey: hex }. Gated-off colours aren't rendered,
  // so absent parts naturally drop out.
  function readPanelColors() {
    const section = sectionByHeading('颜色');
    if (!section) return {};
    const colors = {};
    for (const dt of section.querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== 'DD') continue;
      const hex = (dd.textContent || '').match(/#[0-9a-fA-F]{6}/);
      if (!hex) continue;
      const label = (dt.textContent || '').trim();
      for (const [sub, key] of COLOR_LABEL_RULES) {
        if (label.includes(sub)) {
          colors[key] = hex[0].toLowerCase();
          break;
        }
      }
    }
    return colors;
  }

  function removeRarityBox() {
    const box = document.querySelector('.upeg-rarity-box');
    if (box) box.remove();
  }

  // The rank box sits just above the 抽取 button. The panel re-renders on
  // every uPEG switch, so re-create the box whenever it has been wiped.
  function ensureRarityBox() {
    let box = document.querySelector('.upeg-rarity-box');
    if (box && box.isConnected) return box;
    const btn = findDrawButton();
    const row = btn && btn.parentElement;
    if (!row || !row.parentElement) return null;
    box = document.createElement('div');
    box.className = 'upeg-rarity-box';
    row.parentElement.insertBefore(box, row);
    return box;
  }

  function renderRarityBox(box, state) {
    const title =
      '<div class="upeg-rarity-box__title">预估稀有度排名 / Estimated rank</div>';
    let html;
    if (state === 'pending' || state === 'loading' || state === 'unavailable') {
      const msg = {
        pending: '等待面板渲染…',
        loading: '计算中…',
        unavailable: '稀有度数据加载中（首次需下载约 10 MB）…',
      }[state];
      html = title + `<div class="upeg-rarity-box__msg">${msg}</div>`;
    } else {
      const tierEm = (label, kind) =>
        label
          ? ` <em class="upeg-rarity-box__tier upeg-rarity-box__tier--${kind}">${label}</em>`
          : '';
      // MineRarity chip = the Mine Tier (1-12); colour follows the
      // UR/SSR/SR/R band the tier falls in.
      const mtKind = (state.mrTierLabel || '').toLowerCase();
      // Battle-card badges, order TT → OR → CT (= ATK / 暴击 / DEF):
      //   TT 特征撞值 (ATK) — largest trait collision group.
      //   OR OpenRarity 稀有度 (1-5, drives crit) — uPEGDuel's openRarityTierNum.
      //   CT 颜色撞值 (DEF) — largest colour collision group.
      // TT/CT larger = rarer collision; OR5 = rarest. Shown once scored.
      const battle = (state.ttMax || state.ctMax || state.orStat)
        ? '<div class="upeg-rarity-box__row">' +
            '<span class="upeg-rarity-box__k">战卡 ATK / 暴击 / DEF</span>' +
            '<span class="upeg-rarity-box__v">' +
              `<em class="upeg-rarity-box__bt upeg-rarity-box__bt--atk">TT${state.ttMax || 0}</em>` +
              `<em class="upeg-rarity-box__bt upeg-rarity-box__bt--or">OR${state.orStat || 1}</em>` +
              `<em class="upeg-rarity-box__bt upeg-rarity-box__bt--def">CT${state.ctMax || 0}</em>` +
            '</span></div>'
        : '';
      // Element row — the TCG combat class inferred from the body hex
      // (upstream's COLOR_ELEMENT, computed in the background). Capitalise
      // the lowercase class name for display; chip tint follows the class.
      const el = state.element || '';
      const element = el
        ? '<div class="upeg-rarity-box__row">' +
            '<span class="upeg-rarity-box__k">属性 / Element</span>' +
            '<span class="upeg-rarity-box__v">' +
              `<em class="upeg-rarity-box__el upeg-rarity-box__el--${el}">` +
                `${state.elementEmoji || ''} ${el.charAt(0).toUpperCase() + el.slice(1)}` +
              '</em>' +
            '</span></div>'
        : '';
      html =
        title +
        element +
        '<div class="upeg-rarity-box__row">' +
          '<span class="upeg-rarity-box__k">OpenRarity</span>' +
          `<span class="upeg-rarity-box__v">#${state.orRank.toLocaleString()}` +
          // Raw OR score (matches the dashboard's "score x.xxx") — the stable
          // quantity to cross-check when an integer rank looks off in the
          // dense mid-pack.
          `${state.orScore != null ? ` <span class="upeg-rarity-box__score">${state.orScore.toFixed(3)}</span>` : ''}` +
          `${tierEm(state.orTier, 'or')}</span></div>` +
        '<div class="upeg-rarity-box__row">' +
          '<span class="upeg-rarity-box__k">MineRarity</span>' +
          `<span class="upeg-rarity-box__v">#${state.mrRank.toLocaleString()}` +
          `${tierEm('T' + state.mrTier, mtKind || 'mt')}</span></div>` +
        battle +
        `<div class="upeg-rarity-box__foot">共 ${state.total.toLocaleString()} 只 · ` +
          'Mine Tier 分 T1–T12,T12 最稀有 · TT=特征撞值/ATK,OR=稀有度/暴击(OR1–OR5,OR5 最稀有),CT=颜色撞值/DEF</div>';
    }
    // Idempotent — only touch the DOM when the content actually changed, so
    // a stable panel never feeds the MutationObserver another scan.
    if (box.__upegRarityHtml === html) return;
    box.__upegRarityHtml = html;
    box.innerHTML = html;
  }

  // Read the candidate off the panel, ask the background to rank it, paint
  // the box. Runs every scan; only messages when the candidate changed.
  function updateRarityPanel() {
    if (!enabled) {
      removeRarityBox();
      return;
    }
    const box = ensureRarityBox();
    if (!box) return; // 抽取 button not in the DOM yet
    const traits = readPanelTraits();
    if (!traits) {
      renderRarityBox(box, 'pending');
      lastRarityFp = '';
      pendingRarityFp = '';
      return;
    }
    const colors = readPanelColors();
    const fp = JSON.stringify([traits, colors]);
    if (fp === lastRarityFp) {
      // Same candidate already scored — repaint the cached result (a panel
      // re-render may have wiped the box).
      renderRarityBox(box, lastRarityResult || 'loading');
      return;
    }
    // New/changed panel data. Don't score or show a number yet — gate on
    // stability first, so a half-updated panel mid-switch (mixed rows) can't
    // surface a wrong rank. Show 計算中 until the fingerprint has held still.
    const now = Date.now();
    if (fp !== pendingRarityFp) {
      pendingRarityFp = fp;
      pendingRaritySince = now;
    }
    if (now - pendingRaritySince < SETTLE_MS) {
      renderRarityBox(box, 'loading');
      // The panel may now go quiet (no more mutations → no more scans), so
      // schedule the confirming re-check ourselves.
      clearTimeout(rarityConfirmTimer);
      rarityConfirmTimer = setTimeout(updateRarityPanel, SETTLE_MS + 50);
      return;
    }
    // Held still for SETTLE_MS — commit this candidate and score it.
    clearTimeout(rarityConfirmTimer);
    rarityConfirmTimer = null;
    lastRarityFp = fp;
    lastRarityResult = null;
    renderRarityBox(box, 'loading');
    try {
      chrome.runtime.sendMessage(
        { type: 'scoreCandidate', traits, colors },
        (resp) => {
          if (!extensionAlive()) return;
          if (chrome.runtime.lastError) {
            console.warn(
              '[upeg-hunter] scoreCandidate message failed:',
              chrome.runtime.lastError.message
            );
            return;
          }
          if (fp !== lastRarityFp) return; // candidate changed mid-flight
          if (resp && resp.ready) {
            lastRarityResult = resp;
          } else {
            lastRarityResult = 'unavailable';
            console.warn(
              '[upeg-hunter] rarity not ready:',
              (resp && resp.error) || '(no response)'
            );
          }
          const b = ensureRarityBox();
          if (b) renderRarityBox(b, lastRarityResult);
          // MT is only known now (after the round-trip); re-evaluate
          // auto-draw so a Mine Tier 12 hit can trigger.
          checkAutoDraw();
        }
      );
    } catch (e) {
      // Extension reloaded out from under this stale content script.
      teardownStale();
    }
  }

  // ---------- scan loop ----------
  // After the extension is reloaded/updated, this content script keeps
  // running on the already-open tab but its chrome.* APIs are dead —
  // `chrome.runtime.id` goes undefined. Detect that and stop cleanly
  // instead of throwing "Extension context invalidated" on every mutation.
  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }
  let toreDown = false;
  function teardownStale() {
    if (toreDown) return;
    toreDown = true;
    // console.log (not warn) — this is an expected, controlled shutdown of
    // a stale content script; keep it out of the chrome://extensions Errors
    // panel. It still prints to the page console for debugging.
    console.log(
      '[upeg-hunter] extension context invalidated — myupeg.js stopping; reload the tab'
    );
    enabled = false;
    armed = false;
    if (observer) observer.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(confirmTimer);
    clearTimeout(rarityConfirmTimer);
    clearStars();
    removeRarityBox();
    if (toggleEl) toggleEl.remove();
  }

  function scan() {
    if (toreDown) return;
    if (!extensionAlive()) {
      teardownStale();
      return;
    }
    if (!enabled) return;
    for (const dl of findPartsLists()) applyStars(dl);
    ensureSelection();
    // updateRarityPanel first so lastRarityFp/lastRarityResult reflect this
    // pass before checkAutoDraw reads them. Note it does NOT clear
    // lastRarityResult on every switch (a partial render where readPanelTraits
    // returns null leaves the previous result in place) — so checkAutoDraw
    // must, and does, gate `rar` on lastRarityFp matching the current panel.
    updateRarityPanel();
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

  // Honour the toolbar on/off toggle.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (!enabled) armed = false; // disabling the extension also disarms
      updateToggleUI();
      if (enabled) scan();
      else {
        clearStars();
        removeRarityBox();
      }
    }
    // Local auto-draw opt-in flipped — mount/unmount the floating toggle live.
    if (changes.autodraw) {
      autodrawUnlocked = changes.autodraw.newValue === true;
      if (autodrawUnlocked) {
        mountToggle();
      } else {
        armed = false;
        if (toggleEl) { toggleEl.remove(); toggleEl = null; }
      }
    }
    // The background just (re)scored the collection — re-rank the candidate.
    if (changes.rarity) {
      lastRarityFp = '';
      scan();
    }
  });

  ready.then(() => {
    mountToggle();
    scan();
  });
  // The panels render late and re-render on every card / seed change.
  observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  console.log('[upeg-hunter] myupeg.art content script active');
})();
