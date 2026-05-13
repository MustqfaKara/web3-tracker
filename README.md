# Web3 Tracker

**Web3 Tracker** is an autonomous, modular Node.js tracking bot designed for crypto-native NFT traders. It continuously monitors multiple OpenSea collections for high-value listings and tracks EVM wallet transactions on Ethereum + Base in real-time, delivering rich alerts to Telegram.

## Key Features

- **Multi-Collection NFT Tracking** — Drop a JSON config into `collections/`. Filter by trait value (single, list, or numeric range) and price.
- **Trait-Specific Price Limits** — Different max prices per trait value (e.g. `Lord: 0.2 ETH, Merchant: 0.01 ETH`).
- **Relative Floor Pricing** — `maxPriceRelativeToFloor: 1.2` matches anything up to 1.2× current collection floor.
- **Reveal Detection** — `monitorReveal`/`isRevealed` with `specialTraits` for monitoring newly-revealed trait drops.
- **Trading Open Alert** — `monitorTradingOpen: true` sends a one-time alert the moment trading opens on a pre-mint collection.
- **EVM Wallet Tracker** — Ethereum (via Etherscan v2) + Base (via Alchemy). Detects internal contract payouts. Multi-wallet, named via `WALLET_NAME_<address>` env vars.
- **Scam Token Filter** — Whitelist + Unicode homoglyph detection blocks fake `USDС` (Cyrillic) airdrops.
- **USD Value Display** — Live ETH price cached from Binance.
- **Collection Floor Comparison** — Each listing message shows `%X UCUZ/PAHALI 🔥/⚠️` vs floor.
- **Telegram Topic Routing** — Different bildirim turleri kendi forum topic'lerine duser (NFT/Wallet/Heartbeat).
- **Bot Info Topic** — Startup, hourly errors, daily heartbeat, and 10-minute uptime/status messages route to `TELEGRAM_BOT_INFO_THREAD_ID` (default: `427`).
- **Collection Hot-Reload** — `collections/*.json` changes are picked up without restarting the bot.
- **Local Web Dashboard** — Black/white dashboard at `http://127.0.0.1:8787` for status, recent activity, and adding/updating collection configs.
- **Persistent State** — Restart-safe: `state/persistent.json` keeps seen orders & processed txs across restarts.
- **Stream + Auto-Fallback** — OpenSea Stream API for live events; heartbeat detects silent failures and falls back to REST polling.
- **Heartbeat & Error Summary** — Daily Telegram heartbeat at 09:00 + hourly error rollup.
- **Dry-Run Mode** — `--dry-run` logs matches but skips notifications, perfect for tuning filters.
- **Memory-Safe** — FIFO-capped Set/Map caches prevent leaks in long-running deployments.

## Installation

```bash
git clone https://github.com/zeytzer/web3-tracker.git
cd web3-tracker
npm install
cp .env.example .env
```

Open `.env` and fill in your API keys (OpenSea, Alchemy, Etherscan, Telegram bot token & chat ID).

## Collection Config Schema

Drop JSON files in `collections/`. The filename is irrelevant; the `slug` field is what's used.

```json
{
  "slug": "ferrymanurns",
  "chain": "ethereum",
  "traitType": "Tier",
  "traitValues": ["Merchant", "Noble", "Lord"],
  "traitPriceLimits": {
    "Lord": 0.2,
    "Noble": 0.02,
    "Merchant": 0.01
  },
  "maxPriceEth": 0.1
}
```

| Field | Type | Description |
| --- | --- | --- |
| `slug` | string | OpenSea collection slug (required) |
| `name` | string | Display name for Telegram (defaults to slug) |
| `enabled` | bool | Dashboard notification toggle; `false` disables tracking without deleting config |
| `chain` | string | `ethereum`, `base`, etc. |
| `traitType` | string | Which trait to filter on (e.g. `Tier`, `Rarity Rank`) |
| `traitValues` | string[] | Multiple accepted values |
| `traitValue` | string | Single accepted value |
| `traitMin` / `traitMax` | number | Numeric range (e.g. Rarity Rank 1-50) |
| `traitFilters` | object[] | Multiple trait/rank filters; all filters must match |
| `traitPriceLimits` | object | Per-trait max price overrides `maxPriceEth` |
| `maxPriceEth` | number | Global max price in ETH |
| `maxPriceRelativeToFloor` | number | Max price as multiplier of floor (e.g. 1.2) |
| no trait fields | - | Broad search: match by price/floor only |
| `monitorReveal` | bool | Enable reveal logic with `specialTraits` |
| `isRevealed` | bool | Collection already revealed, but watch `specialTraits` |
| `specialTraits` | string[] | Specific trait values to match in reveal mode |
| `monitorTradingOpen` | bool | One-time alert when trading opens |
| `telegramThreadId` | string | Per-collection topic override |

## Toggles in `.env`

Enable/disable per collection via `TRACK_<SLUG>` (uppercase, dashes → underscores):

```env
TRACK_FERRYMANURNS=on
TRACK_SATOS=on
TRACK_BACKPUNKS=off
TRACK_365_703882509=on
```

## Wallet Names

```env
WALLET_ADDRESS=0xabc...,0xdef...
WALLET_NAME_0xabc...=zeyt wallet
WALLET_NAME_0xdef...=umut wallet
```

Telegram bildirimi: `🔷 zeyt wallet bir islem yapti`

## Telegram Topics

```env
TELEGRAM_NFT_THREAD_ID=45
TELEGRAM_WALLET_THREAD_ID=53
TELEGRAM_BOT_INFO_THREAD_ID=427
TELEGRAM_HEARTBEAT_THREAD_ID=
```

`TELEGRAM_BOT_INFO_THREAD_ID` bot lifecycle/status kanali olarak kullanilir: bot basladi, 10 dakikalik uptime/status, saatlik hata ozeti ve gunluk heartbeat.

## Local Dashboard

```env
DASHBOARD_ENABLED=true
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8787
```

Dashboard `http://127.0.0.1:8787` adresinde calisir. Buradan:

- aktif koleksiyonlari, son match'leri, wallet tx'lerini ve hata durumunu izleyebilirsin
- OpenSea 429 sayisi, poll backoff ve state boyutunu gorebilirsin
- yeni koleksiyon ekleyebilir veya ayni slug ile mevcut config'i guncelleyebilirsin
- koleksiyona tiklayinca `/collections/<slug>` sayfasinda o koleksiyonun filtrelerini duzenleyebilirsin
- OpenSea trait datasini `Fetch Traits` ile cekip trait type/value chip'lerinden filtre olusturabilirsin
- `Notifications enabled` switch'i ile koleksiyonu silmeden bildirimleri acip kapatabilirsin
- birden fazla `Trait / Rarity Filter` ekleyebilirsin; filtreler AND mantigiyla calisir
- `Trait Type`, `Trait Values`, `Trait Min/Max`, `traitPriceLimits`, `maxPriceEth` ve `maxPriceRelativeToFloor` alanlariyla rarity/trait bazli bildirim kurallari yazabilirsin

Dashboard collection kaydettiginde JSON dosyasi `collections/<slug>.json` olarak yazilir ve bot hot-reload ile restart olmadan yeni config'i kullanir.

## Usage

```bash
npm start              # Normal mod
npm run once           # Tek poll cevrimini calistir ve cik
npm run dry-run        # Filtre testi: match yakala ama bildirim atma
npm run debug          # Verbose log
npm test               # Unit testleri calistir
```

CLI flag'leri direkt de gecirilebilir: `node app.js --once --dry-run --debug`.

## Architecture

```
app.js                 # Slim orchestrator
lib/
  logger.js            # Yapilandirilmis loglama
  config.js            # .env + collection JSON yukleme + CLI flag parse
  collections.js       # Runtime config store + collections/*.json hot-reload
  dashboard.js         # Local status + collection editor web UI
  state.js             # Kalici state (state/persistent.json)
  http.js              # Timeout'lu fetch helper
  price.js             # ETH/USD cache (Binance)
  scam.js              # Token whitelist + Unicode filtresi
  notify.js            # macOS notification + Chrome auto-open
  trait.js             # Pure filter fonksiyonlari (test edilebilir)
  opensea.js           # Queue + fetch wrappers + normalize'lar
  telegram.js          # Telegram API + thread routing
  errors.js            # Hata aggregasyon + gunluk heartbeat
  listing.js           # handleListing pipeline (trait + price + bildirim)
  wallet.js            # Alchemy + Etherscan + tx gruplama
  stream.js            # OpenSea Stream + heartbeat fallback
  poll.js              # REST polling + 429 backoff
tests/
  trait.test.js        # Trait filter unit testleri
  scam.test.js         # Scam filter testleri (12 case)
  filter.test.js       # Uctan uca koleksiyon senaryolari
  listing.test.js      # handleListing pipeline testleri
collections/           # Koleksiyon config JSON'lari
state/                 # Kalici state (gitignored)
```

## Notes

- `.env` is gitignored. Live keys never enter git.
- State file (`state/persistent.json`) auto-creates on first run, flushes on SIGINT/SIGTERM.
- macOS-only: `osascript` notifications and Chrome auto-open. Cross-platform users can set `OPEN_IN_CHROME=false`.
