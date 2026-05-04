# uPEG OTC Lens

A Chrome extension that brings [p2peg.app](https://p2peg.app/collections/unipeg) OTC market data into the [unipeg.art](https://unipeg.art/explore) gallery — letting you browse, filter, and discover listings directly while exploring the artwork.

## Why

The OTC market on [p2peg.app](https://p2peg.app/collections/unipeg) currently has no way to filter by attribute sets such as **fullSpectrum** or other curated collections. To check whether a uPEG you like on [unipeg.art](https://unipeg.art/explore?filter=fullSpectrum) is for sale, you have to copy its ID, switch tabs, paste it into p2peg's search box, and check manually — one at a time.

This extension closes that loop: while browsing the unipeg.art gallery (with any filter applied, including fullSpectrum), every uPEG that has an open ETH listing on p2peg is marked with a price badge. One click opens a details panel with the seller, rarity, and a direct link to buy on p2peg.

## Features

- 💰 **Price badge** on every listed uPEG card in `unipeg.art/explore`
- 🔍 **"Listings only" filter** to instantly hide everything that isn't for sale
- 📋 **Details modal** with seller, rarity ranks, listing ID, and bundle info
- 🔗 **One-click deep link** to the exact trade page on p2peg.app
- 🔄 **Auto-refresh** every 30 seconds — new listings appear without reloading
- 🎚 **Toolbar toggle** to disable the extension instantly without uninstalling

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

The uPEG OTC Lens icon (a pixel unicorn with a magnifier) will appear in your Chrome toolbar.

### 5. Use it

Visit [https://unipeg.art/explore](https://unipeg.art/explore) — green price badges appear on every uPEG that's currently listed on p2peg. Click a badge to see details and jump straight to the trade page.

Click the toolbar icon to toggle the extension on/off.

## How it works

- **Background service worker** polls `server.p2peg.app/listings?status=OPEN` every 30 seconds and builds an in-memory index keyed by display ID.
- **Content script** scans `unipeg.art/explore` for `.upeg-card` elements, looks up their display ID against the index, and paints a badge on matches.
- **Popup** controls a single `chrome.storage.local` flag that the content script reacts to in real time.

No accounts, no tracking, no remote code — everything runs locally in your browser.

## Contact

Built by [@h2crypto_eth](https://x.com/h2crypto_eth) — feedback, bug reports, and feature requests welcome on X or via [GitHub Issues](https://github.com/sonyschan/unipeglens/issues).
