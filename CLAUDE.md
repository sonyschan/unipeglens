# Maintenance notes for Claude Code

## README changelog

The `## Changelog` section in `README.md` tracks **major and minor** releases only — patches are deliberately omitted.

- **Triggers an entry**: `v1.1.0 → v1.2.0`, `v1.0.0 → v2.0.0`.
- **Does NOT trigger an entry**: `v1.1.1 → v1.1.2` (patches), even if user-visible.

When releasing a new minor or major version, prepend the new entry and trim the list back to **the three most recent major/minor versions**. Each entry should include the version number as a sub-heading and 1–4 bullets describing user-visible changes (not internal refactors).

Patch-level fixes still ship to users via `manifest.json` `version` and git history; they just don't earn a README entry.

## 犯錯區 / Lessons learned

Mistakes worth not repeating. Append, don't rewrite.

### Don't invent algorithm variants — match upstream exactly

**2026-05-23.** When porting OpenRarity from the `unipeg-lens` dashboard (`js/shared.js` `computeOpenRarity`), the canonical algorithm uses palette **indices** for the 7 colour dimensions. The `myupeg.art` 抽取 panel only exposes **hexes**, which would have meant building a hex→index conversion (main palette is constant; bg palette must be derived from collection data). To skip that work, a "gated-hex" variant shipped: colours scored by hex, with `'∅'` for gated-off slots. It was documented in a code comment as "a deliberate variant" rather than asked.

**Why this was wrong:** OR / MR / MT numbers in this extension drive real-ETH **draw decisions** on `myupeg.art`. A divergent indicator is worse than no indicator. The mistake surfaced when uPEG `#232164` showed dashboard `OR #490` but the extension produced a much rarer-looking rank — the gated-hex variant over-rewards uPEGs with all parts present. User feedback: *"指標數字肯定是最重要的,你沒清楚我的意圖就去做簡化的事情,這是本末倒置"*.

**Rule going forward:**

- **Default = match upstream (`unipeg-lens`) exactly,** even when matching costs extra plumbing on the candidate side (hex→index conversion, palette derivation, etc.). Do the hard thing.
- **Any deviation — even "cleaner", "more correct in spirit", or "negligible delta" — requires an explicit ASK before writing code.** Phrasing template: *"Upstream does X. Doing X here costs Y. Alternative Z is simpler but produces slightly different numbers — which do you want?"*
- Don't bury the choice in a code comment as a fait-accompli. A comment that says "deliberate variant, defensible deviation" is not approval — it's dodging the question.
- Applies to: scoring algorithms, tier buckets, palette handling, gating, null treatment, fetch shortcuts — anything that affects the produced number.
- **Indicator accuracy ≫ implementation convenience.**
- Schema bumps (`RARITY_SCHEMA` in `background.js`) are mandatory whenever the scoring algorithm or cached blob shape changes, so the user's stale cache auto-invalidates on the next run.
