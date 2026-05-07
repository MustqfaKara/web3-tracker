# Web3 Tracker

**Web3 Tracker** is an autonomous, highly customizable Node.js tracking bot designed for crypto-natives and NFT traders. It continuously monitors multiple OpenSea NFT collections for specific, high-value listings and simultaneously tracks all your wallet transactions (on both Ethereum and Base networks) in real-time, delivering instant alerts directly to your Telegram.

By using this bot, you can ensure you never miss an underpriced "Legendary" NFT listing and always stay informed about funds entering or leaving your EVM wallets, including complex smart contract payouts.

## Key Features

- **Multi-Collection NFT Tracking**: Monitor unlimited OpenSea collections concurrently. Instead of hardcoding logic, simply drop a JSON configuration file into the `collections/` directory.
- **Granular Trait & Price Filters**: Customize your tracking criteria. Only get notified when an NFT matches your exact desired traits (e.g., "Legendary", "Slop Level 2-6") AND drops below your specified maximum price limit.
- **Comprehensive Wallet Tracker**: Monitors any specified EVM wallet on both Ethereum and Base networks using the Alchemy API.
- **Internal Transaction Support**: Goes beyond standard ETH/ERC-20 transfers. The bot automatically detects internal smart contract ETH payouts—such as L1-to-L2 bridge deposits, DEX swap returns, or NFT sales—that most standard block scanners miss.
- **Telegram Integration**: Instant, rich-text alerts delivered to your Telegram chat, including direct links to OpenSea and transaction hashes.
- **Dynamic Toggles**: Easily turn the tracker on or off for individual NFT collections directly from the `.env` file without needing to restart the core application or modify the JSON configs.

## Installation

1. Clone the repository and install dependencies:
```bash
git clone https://github.com/zeytzer/web3-tracker.git
cd web3-tracker
npm install
```

2. Copy the example environment file and configure your credentials:
```bash
cp .env.example .env
```
*Open `.env` and fill in your OpenSea API Key, Alchemy API Key, Wallet Address, and Telegram Bot credentials.*

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

You can enable or disable tracking for specific collections by adjusting the variables in your `.env` file. The bot automatically looks for the `TRACK_<COLLECTION_NAME>` variable:
```env
# Enable tracking for 4thereactor and slonks
TRACK_4THEREACTOR=on
TRACK_SLONKS=on

# You can easily turn off a collection to temporarily stop tracking it
TRACK_MUTANT_APE=off
```

## Usage

Start the bot:
```bash
npm start
```

The application will immediately load your collection configs, start polling OpenSea, and establish a connection to Alchemy to watch your wallet.
