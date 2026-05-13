// .env okuma + collection JSON yukleme + CLI flag parse
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('config');

// Tum env degiskenleri tek yerden — default'larla birlikte
export const env = {
  // OpenSea
  OPENSEA_API_KEY: process.env.OPENSEA_API_KEY || '',
  OPENSEA_MIN_GAP_MS: Number(process.env.OPENSEA_MIN_GAP_MS || 400),

  // Genel davranis
  NOTIFICATION_TITLE: process.env.NOTIFICATION_TITLE || 'Listing Alert',
  WATCH_MODE: (process.env.WATCH_MODE || 'auto').toLowerCase(),
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || 5000),
  POLL_BACKOFF_MS: Number(process.env.POLL_BACKOFF_MS || 15000),
  FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS || 15000),
  ACTIVE_LISTING_SWEEP: (process.env.ACTIVE_LISTING_SWEEP || 'true').toLowerCase() !== 'false',
  EVENT_LOOKBACK_SECONDS: Number(process.env.EVENT_LOOKBACK_SECONDS || 300),
  LISTING_LOOKBACK_SECONDS: Number(process.env.LISTING_LOOKBACK_SECONDS || 3600),
  OPEN_IN_CHROME: (process.env.OPEN_IN_CHROME || 'true').toLowerCase() !== 'false',
  STREAM_HEARTBEAT_TIMEOUT_MS: Number(process.env.STREAM_HEARTBEAT_TIMEOUT_MS || 300000),
  DASHBOARD_ENABLED: (process.env.DASHBOARD_ENABLED || 'true').toLowerCase() !== 'false',
  DASHBOARD_HOST: process.env.DASHBOARD_HOST || '127.0.0.1',
  DASHBOARD_PORT: Number(process.env.DASHBOARD_PORT || 8787),

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TELEGRAM_SEND_PHOTO: (process.env.TELEGRAM_SEND_PHOTO || 'false').toLowerCase() === 'true',
  TELEGRAM_NFT_THREAD_ID: process.env.TELEGRAM_NFT_THREAD_ID || '',
  TELEGRAM_COIN_THREAD_ID: process.env.TELEGRAM_COIN_THREAD_ID || '',
  TELEGRAM_WALLET_THREAD_ID: process.env.TELEGRAM_WALLET_THREAD_ID || '',
  TELEGRAM_HEARTBEAT_THREAD_ID: process.env.TELEGRAM_HEARTBEAT_THREAD_ID || '',
  TELEGRAM_BOT_INFO_THREAD_ID: process.env.TELEGRAM_BOT_INFO_THREAD_ID || '427',

  // Cuzdan takibi
  WALLET_ADDRESSES: (process.env.WALLET_ADDRESSES || process.env.WALLET_ADDRESS || '')
    .split(',').map(a => a.trim().toLowerCase()).filter(Boolean),
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY || '',
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY || '',
  WALLET_POLL_INTERVAL_MS: Number(process.env.WALLET_POLL_INTERVAL_MS || 60000),
  MIN_USD_VALUE: Number(process.env.MIN_USD_VALUE || 0.01),

  // Background jobs
  HEARTBEAT_HOUR: Number(process.env.HEARTBEAT_HOUR || 9),
  ERROR_SUMMARY_INTERVAL_MS: Number(process.env.ERROR_SUMMARY_INTERVAL_MS || 3600000),
  BOT_INFO_INTERVAL_MS: Number(process.env.BOT_INFO_INTERVAL_MS || 600000),

  // Mod
  DRY_RUN: (process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  DEBUG: (process.env.DEBUG || 'false').toLowerCase() === 'true'
};

// CLI flag'leri (--once, --dry-run, --debug)
export function parseCliFlags() {
  const args = process.argv.slice(2);
  const flags = {
    dryRun: args.includes('--dry-run'),
    once: args.includes('--once'),
    debug: args.includes('--debug')
  };
  if (flags.dryRun) env.DRY_RUN = true;
  if (flags.debug) {
    env.DEBUG = true;
    process.env.DEBUG = '1';
  }
  return flags;
}

// Cuzdan ismi haritasi — default'lar + .env override (WALLET_NAME_<adres>=ad)
const DEFAULT_WALLET_NAMES = {
  '0x7befc9c1e5d399404c384b0bc58925228d57aa22': 'zeyt wallet',
  '0xd42a82ffb2815f0d7b25a9371213900bb1127fe7': 'umut wallet',
  '0x3e7576689446ddd7cf6ac8023839f5e9deec235b': 'deleuze wallet',
  '0x51aea644d7b93270491508d5a8296d50c4f6fc71': 'zeyt burner'
};
export const WALLET_NAMES = { ...DEFAULT_WALLET_NAMES };
for (const envKey of Object.keys(process.env)) {
  if (envKey.startsWith('WALLET_NAME_')) {
    const addr = envKey.slice('WALLET_NAME_'.length).toLowerCase();
    WALLET_NAMES[addr] = process.env[envKey];
  }
}
export function walletDisplayName(address) {
  const a = String(address || '').toLowerCase();
  return WALLET_NAMES[a] || (a.slice(0, 6) + '...' + a.slice(-4));
}

// Koleksiyon JSON'larini yukle, TRACK_<SLUG> ile aktiflestir
const COLLECTIONS_DIR = path.join(process.cwd(), 'collections');
export { COLLECTIONS_DIR };

export function loadCollections() {
  const configs = [];
  if (!fs.existsSync(COLLECTIONS_DIR)) {
    log.warn(`Collections klasoru bulunamadi: ${COLLECTIONS_DIR}`);
    return configs;
  }
  const files = fs.readdirSync(COLLECTIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(COLLECTIONS_DIR, file), 'utf8'));
      if (!data.slug) {
        log.warn(`${file}: 'slug' alani yok, atlaniyor`);
        continue;
      }
      const envKey = `TRACK_${data.slug.toUpperCase().replace(/-/g, '_')}`;
      const isEnabled = (process.env[envKey] || 'on').toLowerCase();
      if (data.enabled === false) {
        log.info(`${data.slug} kapali (config: enabled=false)`);
      } else if (isEnabled === 'on' || isEnabled === 'true' || isEnabled === '1') {
        configs.push(data);
      } else {
        log.info(`${data.slug} kapali (.env: ${envKey})`);
      }
    } catch (e) {
      log.error(`${file} parse hatasi: ${e.message}`);
    }
  }
  return configs;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function collectionErrors(config, fileLabel = config.slug || 'collection') {
  const errors = [];
  if (!config.slug || typeof config.slug !== 'string') {
    errors.push(`${fileLabel}: slug zorunlu ve string olmali`);
  }
  if (config.chain !== undefined && typeof config.chain !== 'string') {
    errors.push(`${fileLabel}: chain string olmali`);
  }
  if (config.traitType !== undefined && typeof config.traitType !== 'string') {
    errors.push(`${fileLabel}: traitType string olmali`);
  }
  if (config.traitValues !== undefined && !Array.isArray(config.traitValues)) {
    errors.push(`${fileLabel}: traitValues array olmali`);
  }
  if (config.traitFilters !== undefined) {
    if (!Array.isArray(config.traitFilters)) {
      errors.push(`${fileLabel}: traitFilters array olmali`);
    } else {
      config.traitFilters.forEach((filter, index) => {
        errors.push(...collectionErrors(filter, `${fileLabel}.traitFilters[${index}]`).filter(err =>
          !err.includes('slug zorunlu')
        ));
        if (!filter.traitType || typeof filter.traitType !== 'string') {
          errors.push(`${fileLabel}.traitFilters[${index}]: traitType zorunlu ve string olmali`);
        }
      });
    }
  }
  if (config.traitValue !== undefined && typeof config.traitValue !== 'string' && typeof config.traitValue !== 'number') {
    errors.push(`${fileLabel}: traitValue string veya number olmali`);
  }
  for (const key of ['traitMin', 'traitMax', 'maxPriceEth', 'maxPriceRelativeToFloor']) {
    if (config[key] !== undefined && !Number.isFinite(Number(config[key]))) {
      errors.push(`${fileLabel}: ${key} sayisal olmali`);
    }
  }
  if (config.maxPriceEth !== undefined && Number(config.maxPriceEth) < 0) {
    errors.push(`${fileLabel}: maxPriceEth negatif olamaz`);
  }
  if (config.maxPriceRelativeToFloor !== undefined && Number(config.maxPriceRelativeToFloor) <= 0) {
    errors.push(`${fileLabel}: maxPriceRelativeToFloor pozitif olmali`);
  }
  if (config.traitPriceLimits !== undefined) {
    if (!config.traitPriceLimits || typeof config.traitPriceLimits !== 'object' || Array.isArray(config.traitPriceLimits)) {
      errors.push(`${fileLabel}: traitPriceLimits object olmali`);
    } else {
      for (const [trait, limit] of Object.entries(config.traitPriceLimits)) {
        if (!trait) errors.push(`${fileLabel}: traitPriceLimits bos trait adi iceriyor`);
        if (!Number.isFinite(Number(limit)) || Number(limit) < 0) {
          errors.push(`${fileLabel}: traitPriceLimits.${trait} negatif olmayan sayi olmali`);
        }
      }
    }
  }
  if (config.telegramThreadId !== undefined && typeof config.telegramThreadId !== 'string' && typeof config.telegramThreadId !== 'number') {
    errors.push(`${fileLabel}: telegramThreadId string veya number olmali`);
  }
  if (config.traitMatchMode !== undefined && !['all', 'any', 'or'].includes(String(config.traitMatchMode).toLowerCase())) {
    errors.push(`${fileLabel}: traitMatchMode all/any olmali`);
  }
  return errors;
}

// Env + koleksiyon validation (baslangicta cagrilir)
export function validate(configs = []) {
  const errors = [];
  if (!['auto', 'stream', 'poll'].includes(env.WATCH_MODE)) {
    errors.push(`WATCH_MODE 'auto'/'stream'/'poll' olmali (su an: "${env.WATCH_MODE}")`);
  }
  for (const key of [
    'OPENSEA_MIN_GAP_MS',
    'POLL_INTERVAL_MS',
    'POLL_BACKOFF_MS',
    'FETCH_TIMEOUT_MS',
    'STREAM_HEARTBEAT_TIMEOUT_MS',
    'WALLET_POLL_INTERVAL_MS',
    'ERROR_SUMMARY_INTERVAL_MS',
    'BOT_INFO_INTERVAL_MS',
    'DASHBOARD_PORT'
  ]) {
    if (!isPositiveNumber(env[key])) errors.push(`${key} pozitif sayi olmali`);
  }
  if (!Number.isInteger(env.HEARTBEAT_HOUR) || env.HEARTBEAT_HOUR < 0 || env.HEARTBEAT_HOUR > 23) {
    errors.push('HEARTBEAT_HOUR 0-23 arasinda integer olmali');
  }
  for (const config of configs) errors.push(...collectionErrors(config));
  if (errors.length) throw new Error(`Config validation failed:\n- ${errors.join('\n- ')}`);
}
