// ETH/USD fiyat cache — Binance API kullaniyor (auth gerekmez)
import { createLogger } from './logger.js';
import { fetchWithTimeout } from './http.js';

const log = createLogger('price');
const CACHE_TTL_MS = 60 * 1000; // 1 dakikalik cache

let cached = null;
let lastFetch = 0;

export async function getEthPrice() {
  const now = Date.now();
  if (cached !== null && (now - lastFetch) < CACHE_TTL_MS) return cached;
  try {
    const res = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    if (!res.ok) {
      log.warn(`Binance API ${res.status}`);
      return cached;
    }
    const data = await res.json();
    if (data && data.price) {
      cached = parseFloat(data.price);
      lastFetch = now;
      return cached;
    }
  } catch (e) {
    log.warn(`ETH price fetch failed: ${e.message}`);
  }
  return cached;
}

export function formatUsd(value, ethPrice) {
  if (!ethPrice || value === null || value === undefined) return '';
  const usd = value * ethPrice;
  return ` ($${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
}
