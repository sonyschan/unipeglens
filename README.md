<img width="1326" height="1308" alt="image" src="https://github.com/user-attachments/assets/5a950c05-d1bc-4667-8bcd-5ce532aabefd" />

# Unipeg Lens

A Chrome extension that brings [p2peg.app](https://p2peg.app/collections/unipeg) and [OpenSea](https://opensea.io/collection/unipegv4) listings into the [unipeg.art](https://unipeg.art/explore) gallery — letting you browse, filter, and discover offers directly while exploring the artwork.

## Why

The OTC market on [p2peg.app](https://p2peg.app/collections/unipeg) currently has no way to filter by attribute sets such as **fullSpectrum** or other curated collections. To check whether a uPEG you like on [unipeg.art](https://unipeg.art/explore?filter=fullSpectrum) is for sale, you have to copy its ID, switch tabs, paste it into the marketplace's search box, and check manually — one at a time.

Now that uPEGs can also be wrapped and listed on **OpenSea**, the problem is split across two marketplaces.

This extension closes that loop: while browsing the unipeg.art gallery (with any filter applied, including fullSpectrum), every uPEG that has an open ETH listing on either marketplace is marked with a color-coded price badge. One click opens a details panel with the seller, rarity, and a direct link to buy from whichever marketplace it's on.

## Features

- 💰 **Price badge** on every listed uPEG card in `unipeg.art/explore`
  - **Pink** = listed on p2peg
  - **Blue** = listed on OpenSea
- 🔀 **Source filter popover** — toggle p2peg / OpenSea independently from the floating chip
- 🔍 **"Listings only" filter** to instantly hide everything that isn't for sale
- 📋 **Details modal** with seller, source, rarity ranks, listing ID, and bundle info
- 🔗 **One-click deep link** straight to the trade page on p2peg or OpenSea
- 🔄 **Auto-refresh** every 30 seconds — new listings appear without reloading
- 🎚 **Toolbar toggle** to disable the extension instantly without uninstalling
- ⭐ **Trait highlighter on `myupeg.art`** — in the `抽取` panel, each part matching your wanted profile gets a star (⭐) prefix
- 🎯 **Auto-draw on `myupeg.art`** (opt-in) — arm a floating toggle and it auto-clicks `抽取` when a uPEG hits your number/color thresholds

## Installation (Chrome)

The extension is not yet on the Chrome Web Store, so it needs to be installed manually as an unpacked extension.

### 1. Download the source

Either clone the repo:

```bash
git clone https://github.com/sonyschan/unipeglens.git
```

Or download the ZIP from the [GitHub page](https://github.com/sonyschan/unipeglens) (green **Code** button → **Download ZIP**) and unzip it somewhere permanent (don't delete the folder later — Chrome loads files from this path).

### 2. Open the extensions page

In Chrome, go to:

```
chrome://extensions
```

### 3. Enable Developer mode

Toggle the **Developer mode** switch in the top-right corner.

### 4. Load the extension

Click **Load unpacked** in the top-left, then select the `unipeglens` folder you downloaded.

The Unipeg Lens icon (a pixel unicorn with a magnifier) will appear in your Chrome toolbar.

### 5. Use it

Visit [https://unipeg.art/explore](https://unipeg.art/explore) — colored price badges appear on every uPEG that's currently listed (pink for p2peg, blue for OpenSea). Click a badge to see details and jump straight to the trade page.

Click the toolbar icon to toggle the extension on/off, and click the floating chip in the bottom-right corner of the gallery to filter by source.

## OpenSea API key (optional)

OpenSea's API requires a key for every request. To keep things friction-free, the extension automatically requests a free **agent-tier** key on first run (no signup, no wallet) and renews it automatically before it expires.

That free key works fine for casual browsing, but it has lower rate limits and is shared across all users who didn't supply their own. If you browse heavily, **bring your own key** for higher limits:

1. Go to [OpenSea Developer → API keys](https://docs.opensea.io/reference/api-keys) and follow the instructions to get a free key (requires an OpenSea account).
2. Click the extension's toolbar icon → expand **OpenSea API key** → paste your key → **Save**.
3. The extension will use your key from then on. You can clear it any time to fall back to the auto-managed key.

The key is stored only in your browser via `chrome.storage.local`. It is never sent anywhere except to `api.opensea.io`.

## How it works

- **Background service worker** polls both `server.p2peg.app/listings` and `api.opensea.io/v2/listings/collection/unipegv4/all` every 30 seconds and builds an in-memory index keyed by display ID.
- **Content script** scans `unipeg.art/explore` for `.upeg-card` elements, looks up their display ID against the index, and paints a source-colored badge on matches.
- **Popup** controls extension on/off plus the OpenSea API key. **Floating chip** controls source filter and listings-only mode.

No accounts, no tracking, no remote code — everything runs locally in your browser.

## Changelog

Only the three most recent **major or minor** releases are kept here (patches omitted). See [GitHub commits](https://github.com/sonyschan/unipeglens/commits/main) for full history.

### v1.2
- New: on `myupeg.art`, the `抽取` panel's `部件` traits are scanned and a ⭐ is shown before each part matching a wanted profile (`头发`/`尾巴` = 无, `犄角`/`翅膀`/`饰品` = 有值).
- Each part is judged independently, so partial matches stay visible while you pick a uPEG.
- New: opt-in **auto-draw** — arm the floating toggle on `myupeg.art` and it clicks `抽取` for you once the shown uPEG has 5+ parts sharing a number or 4+ colors sharing a hexcode. One-shot; disarms after firing.
- The candidate grid keeps itself fed: when no uPEG is selected (e.g. after a refresh drops the selection), the first candidate is selected automatically so the detail panel stays populated.

### v1.1
- Added OpenSea as a second listing source. Listings from `unipegv4` are merged into the same index as p2peg, keyed by display ID.
- Per-source price badges: **pink** for p2peg, **blue** for OpenSea. Modal "Buy" deep-links to the matching marketplace.
- Floating chip became a popover with independent source toggles plus the existing "Listings only" filter.
- Popup gained an optional **OpenSea API key** field; without one, the extension auto-mints and rotates a free agent-tier key.

### v1.0
- Initial release. Pulls open ETH listings from `server.p2peg.app`, paints a price badge on each matching `.upeg-card` in `unipeg.art/explore`, and opens a details modal with a deep link to the trade page.
- Filter chip to show "Listings only" and a toolbar popup with enable/disable switch.

## Contact

Built by [@h2crypto_eth](https://x.com/h2crypto_eth) — feedback, bug reports, and feature requests welcome on X or via [GitHub Issues](https://github.com/sonyschan/unipeglens/issues).
