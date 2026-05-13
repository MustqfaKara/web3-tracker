// lib/config.js — validation smoke testleri
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../lib/config.js';

test('validate — gecerli koleksiyon config kabul edilir', () => {
  assert.doesNotThrow(() => validate([
    { slug: 'ok-collection', chain: 'ethereum', maxPriceEth: 0.1 }
  ]));
});

test('validate — bozuk traitPriceLimits baslangicta yakalanir', () => {
  assert.throws(
    () => validate([
      { slug: 'bad-collection', traitPriceLimits: { Lord: 'pahali' } }
    ]),
    /traitPriceLimits\.Lord/
  );
});

test('validate — multi traitFilters kabul edilir', () => {
  assert.doesNotThrow(() => validate([
    {
      slug: 'multi-filter',
      traitFilters: [
        { traitType: 'Tier', traitValues: ['Lord'] },
        { traitType: 'Rarity Rank', traitMax: 50 }
      ],
      maxPriceEth: 0.1
    }
  ]));
});

test('validate — enabled false koleksiyon config kabul edilir', () => {
  assert.doesNotThrow(() => validate([
    { slug: 'paused-collection', enabled: false, maxPriceEth: 0.1 }
  ]));
});
