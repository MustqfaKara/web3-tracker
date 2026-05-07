# Web3 Sentinel

Web3 Sentinel is an autonomous Node.js tracking bot that monitors multiple OpenSea NFT collections for specific listings and tracks all wallet transactions (Ethereum & Base) in real-time, delivering alerts directly to your Telegram.

## Features

- **Multi-Collection NFT Tracking**: Monitor multiple OpenSea collections simultaneously via specific JSON config files.
- **Trait & Price Filters**: Only get notified when an NFT matching your desired traits (e.g., "Legendary") drops below your maximum price limit.
- **Wallet Tracker**: Monitors any specified EVM wallet (Ethereum & Base networks) via Alchemy API.
- **Internal Transactions**: Automatically detects standard transfers, ERC-20, NFTs, and internal smart contract ETH payouts (like cross-chain bridges or DEX swaps).
- **Telegram Integration**: Instant alerts delivered to your Telegram chat.
- **Dynamic Toggles**: Easily turn the tracker on or off for individual collections directly from the `.env` file.

## Installation

1. Clone the repository and install dependencies:
```bash
npm install
```

2. Copy the example environment file and configure it:
```bash
cp .env.example .env
```
Open `.env` and fill in your OpenSea API Key, Alchemy API Key, Wallet Address, and Telegram credentials.

3. Create collection configuration files inside the `collections/` folder. Example (`collections/slonks.json`):
```json
{
  "slug": "slonks",
  "chain": "ethereum",
  "traitType": "Slop Level",
  "traitMin": 2,
  "traitMax": 6,
  "maxPriceEth": 0.14
}
```

## Configuration Toggles

You can enable or disable tracking for specific collections by adjusting the variables in your `.env` file:
```env
TRACK_SLONKS=on
TRACK_4THEREACTOR=off
```

## Usage

Start the bot:
```bash
npm start
```
