// lib/scam.js — scam token filter testleri
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegitimateToken,
  hasUnicodeLookalikes,
  isStablecoin,
  isKnownToken,
  transferUsdValue,
  KNOWN_TOKENS,
  STABLECOINS
} from '../lib/scam.js';

test('legitimate tokens passed', () => {
  assert.equal(isLegitimateToken('USDC'), true);
  assert.equal(isLegitimateToken('eth'), true);
  assert.equal(isLegitimateToken('PEPE'), true);
  assert.equal(isLegitimateToken('WBTC'), true);
});

test('Unicode homoglyph (Cyrillic) blocked', () => {
  // 'С' (U+0421 Cyrillic Es) ile 'C' (U+0043) ayni gorunur
  assert.equal(isLegitimateToken('USDС'), false);
  assert.equal(hasUnicodeLookalikes('USDС'), true);
  assert.equal(hasUnicodeLookalikes('USDC'), false);
});

test('Unicode special chars blocked', () => {
  assert.equal(hasUnicodeLookalikes('US-DC'), true);
  assert.equal(hasUnicodeLookalikes('USDC '), true);  // trailing space
  assert.equal(hasUnicodeLookalikes('1USDC'), false); // basic ASCII OK
});

test('unknown tokens blocked', () => {
  assert.equal(isLegitimateToken('FakeAirdrop'), false);
  assert.equal(isLegitimateToken('ScamCoin'), false);
  assert.equal(isLegitimateToken(''), false);
  assert.equal(isLegitimateToken(null), false);
  assert.equal(isLegitimateToken(undefined), false);
});

test('stablecoin detection', () => {
  assert.equal(isStablecoin('USDC'), true);
  assert.equal(isStablecoin('usdt'), true);
  assert.equal(isStablecoin('DAI'), true);
  assert.equal(isStablecoin('eth'), false);
  assert.equal(isStablecoin('PEPE'), false);
});

test('known token (case insensitive)', () => {
  assert.equal(isKnownToken('ETH'), true);
  assert.equal(isKnownToken('eth'), true);
  assert.equal(isKnownToken('SCAMTOKEN'), false);
});

test('transferUsdValue — ETH and WETH', () => {
  assert.equal(transferUsdValue(2, 'ETH', 3000), 6000);
  assert.equal(transferUsdValue(1.5, 'WETH', 4000), 6000);
});

test('transferUsdValue — stablecoins', () => {
  assert.equal(transferUsdValue(100, 'USDC', 3000), 100);
  assert.equal(transferUsdValue(50, 'USDT', 3000), 50);
});

test('transferUsdValue — unknown asset returns null', () => {
  assert.equal(transferUsdValue(1000, 'PEPE', 3000), null);
});

test('transferUsdValue — null inputs handled', () => {
  assert.equal(transferUsdValue(null, 'ETH', 3000), null);
  assert.equal(transferUsdValue(2, 'ETH', null), null);
});

test('transferUsdValue — negative values use absolute', () => {
  assert.equal(transferUsdValue(-2, 'ETH', 3000), 6000);
});

test('KNOWN_TOKENS contains stablecoins (superset)', () => {
  for (const stable of STABLECOINS) {
    assert.ok(KNOWN_TOKENS.has(stable), `KNOWN_TOKENS missing stablecoin: ${stable}`);
  }
});
