# upeg-hunter

**English** · [简体中文](#简体中文)

A Chrome extension for the [myupeg.art](https://myupeg.art/) draw (`抽取`) panel. It estimates a candidate uPEG's **OpenRarity** and **MineRarity** rank before you spend ETH, and stars the traits you're hunting.

## Install

1. Download the source — either clone it:
   ```bash
   git clone https://github.com/sonyschan/unipeglens.git
   ```
   or grab the ZIP from the [GitHub page](https://github.com/sonyschan/unipeglens) (**Code → Download ZIP**) and unzip it somewhere permanent (don't delete the folder — Chrome loads from this path).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** (top-left) and select the folder.

The upeg-hunter icon (a pixel unicorn with a magnifier) appears in your toolbar.

## How to use

1. Go to [myupeg.art](https://myupeg.art/) and open the `抽取` panel.
2. **Read the rank box** above the `抽取` button — it shows the candidate's estimated **OpenRarity** and **MineRarity** rank and tier, updating live as you switch uPEGs or the seed changes. (First run downloads ~10 MB of collection data; the box says `计算中` until it's ready.)
3. **Watch the stars** — parts matching your wanted profile get a ⭐ (`头发`/`尾巴` = 无, `犄角`/`翅膀`/`饰品` = 有值).
4. **Toggle on/off** — click the toolbar icon any time to enable or disable the extension.

Everything runs locally in your browser — no accounts, no tracking, only public data is fetched.

---

## 简体中文

[English](#upeg-hunter) · **简体中文**

一个用于 [myupeg.art](https://myupeg.art/) `抽取` 面板的 Chrome 扩展。它会在你花费 ETH 之前，估算候选 uPEG 的 **OpenRarity** 与 **MineRarity** 排名，并为你想要的部件加星标。

### 安装

1. 下载源码——可以克隆仓库：
   ```bash
   git clone https://github.com/sonyschan/unipeglens.git
   ```
   或从 [GitHub 页面](https://github.com/sonyschan/unipeglens)（**Code → Download ZIP**）下载 ZIP，解压到一个固定的位置（不要之后删除这个文件夹——Chrome 会从该路径加载）。
2. 打开 `chrome://extensions`。
3. 打开右上角的 **开发者模式（Developer mode）**。
4. 点击左上角的 **加载已解压的扩展程序（Load unpacked）**，选择该文件夹。

工具栏会出现 upeg-hunter 图标（带放大镜的像素独角兽）。

### 使用方法

1. 打开 [myupeg.art](https://myupeg.art/) 并进入 `抽取` 面板。
2. **查看排名框**——它位于 `抽取` 按钮上方，显示候选 uPEG 的 **OpenRarity** 与 **MineRarity** 预估排名和等级，会随着切换 uPEG 或种子变化而实时更新。（首次运行需下载约 10 MB 的藏品数据，在准备好之前会显示 `计算中`。）
3. **留意星标**——符合你目标条件的部件会显示 ⭐（`头发`/`尾巴` = 无，`犄角`/`翅膀`/`饰品` = 有值）。
4. **开启 / 关闭**——随时点击工具栏图标即可启用或停用扩展。

所有计算都在你的浏览器本地进行——无需账号、不做追踪，只获取公开数据。

---

## Changelog

Only the three most recent **major or minor** releases are kept here (patches omitted). See [GitHub commits](https://github.com/sonyschan/unipeglens/commits/main) for full history.

### v2.0
- Renamed to **upeg-hunter** and narrowed to `myupeg.art` only.
- Removed the `unipeg.art/explore` listing monitor and display (p2peg + OpenSea price badges, source filter, listings-only filter, details modal, OpenSea API-key management).
- The OpenRarity / MineRarity rank estimate and trait highlighter on `myupeg.art` are unchanged — the rarity numbers are identical to before.

### v1.3
- New: on `myupeg.art`, the `抽取` panel shows the candidate uPEG's **estimated OpenRarity and MineRarity rank** — judge how rare a roll would be before spending ETH.
- Ranks update live as you switch uPEGs or the seed changes; OpenRarity shows its percentile tier (TOP 1% / 3% / 10% / 25%) and MineRarity its **Mine Tier** (T1–T12, T12 rarest).

### v1.2
- New: on `myupeg.art`, the `抽取` panel's `部件` traits are scanned and a ⭐ is shown before each part matching a wanted profile.

## Contact

Built by [@h2crypto_eth](https://x.com/h2crypto_eth) — feedback, bug reports, and feature requests welcome on X or via [GitHub Issues](https://github.com/sonyschan/unipeglens/issues).
