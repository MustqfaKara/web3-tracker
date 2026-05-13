// Scam token filtresi: whitelist disindaki tokenlari ve Unicode lookalike
// (Cyrillic harfli sahte USDC vb.) sembolleri eliyor.

export const STABLECOINS = new Set([
  'usdc', 'usdt', 'dai', 'usdv', 'busd', 'tusd', 'frax', 'lusd', 'gusd', 'pyusd', 'usdbc'
]);

export const KNOWN_TOKENS = new Set([
  'eth', 'weth',
  ...STABLECOINS,
  'wbtc', 'cbbtc', 'tbtc',
  'link', 'uni', 'aave', 'mkr', 'snx', 'comp', 'crv', 'ldo', 'rpl',
  'matic', 'pol', 'arb', 'op',
  'pepe', 'shib', 'doge', 'floki', 'bonk',
  'ape', 'blur', 'ens', 'grt', 'rndr',
  'steth', 'reth', 'cbeth', 'wsteth',
  'degen', 'brett', 'toshi', 'higher', 'enjoy'
]);

// Sadece basit ASCII harf ve rakam — Unicode lookalike'lar engelleniyor
export function hasUnicodeLookalikes(symbol) {
  return /[^A-Za-z0-9]/.test(String(symbol || ''));
}

export function isStablecoin(symbol) {
  return STABLECOINS.has(String(symbol || '').toLowerCase());
}

export function isKnownToken(symbol) {
  return KNOWN_TOKENS.has(String(symbol || '').toLowerCase());
}

export function isLegitimateToken(symbol) {
  if (!symbol) return false;
  if (hasUnicodeLookalikes(symbol)) return false;
  return isKnownToken(symbol);
}

// Bir transfer'in USD karsiligini hesapla — sadece ETH/stablecoin biliyoruz
export function transferUsdValue(value, asset, ethPrice) {
  if (value === null || value === undefined) return null;
  const absVal = Math.abs(value);
  const a = String(asset || '').toLowerCase();
  if (a === 'eth' || a === 'weth') return ethPrice ? absVal * ethPrice : null;
  if (isStablecoin(a)) return absVal;
  return null; // bilinmeyen token — degeri hesaplanamaz
}
