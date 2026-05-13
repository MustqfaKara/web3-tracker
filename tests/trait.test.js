// lib/trait.js — pure function unit testleri
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWantedTraitValue,
  computeMaxPrice,
  computeCoarseMaxPrice,
  getTraitValue,
  hasTraitFilter,
  matchTraitFilters,
  normalizeTraitType,
  traitTypeOf,
  traitValueOf,
  formatMatchTraitLines
} from '../lib/trait.js';

test('traitValues array — case insensitive match', () => {
  const cfg = { traitValues: ['Lord', 'Noble', 'Merchant'] };
  assert.equal(isWantedTraitValue('Lord', cfg), true);
  assert.equal(isWantedTraitValue('NOBLE', cfg), true);
  assert.equal(isWantedTraitValue('merchant', cfg), true);
  assert.equal(isWantedTraitValue('Peasant', cfg), false);
});

test('traitValue single value', () => {
  assert.equal(isWantedTraitValue('Hoodie', { traitValue: 'hoodie' }), true);
  assert.equal(isWantedTraitValue('Cap', { traitValue: 'hoodie' }), false);
});

test('numeric range with traitMin/traitMax', () => {
  const cfg = { traitMax: 50 };
  assert.equal(isWantedTraitValue(1, cfg), true);
  assert.equal(isWantedTraitValue(50, cfg), true);
  assert.equal(isWantedTraitValue(51, cfg), false);
});

test('numeric range with both min and max', () => {
  const cfg = { traitMin: 2, traitMax: 6 };
  assert.equal(isWantedTraitValue(1, cfg), false);
  assert.equal(isWantedTraitValue(2, cfg), true);
  assert.equal(isWantedTraitValue(6, cfg), true);
  assert.equal(isWantedTraitValue(7, cfg), false);
});

test('null/empty/undefined values rejected', () => {
  assert.equal(isWantedTraitValue(null, {}), false);
  assert.equal(isWantedTraitValue(undefined, {}), false);
  assert.equal(isWantedTraitValue('', {}), false);
});

test('non-numeric string with numeric range rejected', () => {
  assert.equal(isWantedTraitValue('Hoodie', { traitMax: 50 }), false);
});

test('computeMaxPrice — traitPriceLimits override (ferrymanurns senaryosu)', () => {
  const cfg = {
    maxPriceEth: 0.1,
    traitPriceLimits: { Lord: 0.2, Noble: 0.02, Merchant: 0.01 }
  };
  assert.equal(computeMaxPrice(cfg, 'Lord'), 0.2);
  assert.equal(computeMaxPrice(cfg, 'Noble'), 0.02);
  assert.equal(computeMaxPrice(cfg, 'Merchant'), 0.01);
  // Trait listede yoksa global'e duser
  assert.equal(computeMaxPrice(cfg, 'Peasant'), 0.1);
});

test('computeMaxPrice — case insensitive lookup', () => {
  const cfg = { traitPriceLimits: { Lord: 0.2 } };
  assert.equal(computeMaxPrice(cfg, 'lord'), 0.2);
  assert.equal(computeMaxPrice(cfg, 'LORD'), 0.2);
});

test('computeMaxPrice — multi trait degerlerinde eslesen en yuksek override kullanilir', () => {
  const cfg = {
    maxPriceEth: 0.05,
    traitPriceLimits: { Lord: 0.2, Gold: 0.12 }
  };
  assert.equal(computeMaxPrice(cfg, ['Lord', 'Gold']), 0.2);
});

test('computeMaxPrice — no maxPriceEth defaults to high cap', () => {
  assert.equal(computeMaxPrice({}, 'X'), 999999);
});

test('computeCoarseMaxPrice — traitPriceLimits icin en yuksek kaba limiti kullanir', () => {
  const cfg = {
    maxPriceEth: 0.1,
    traitPriceLimits: { Lord: 0.2, Noble: 0.02, Merchant: 0.01 }
  };
  assert.equal(computeCoarseMaxPrice(cfg), 0.2);
});

test('hasTraitFilter — broad search ile trait filtreli config ayrilir', () => {
  assert.equal(hasTraitFilter({ maxPriceEth: 0.1 }), false);
  assert.equal(hasTraitFilter({ traitType: 'Tier', traitValues: ['Lord'] }), true);
  assert.equal(hasTraitFilter({ traitMax: 50 }), true);
  assert.equal(hasTraitFilter({ traitFilters: [{ traitType: 'Tier', traitValues: ['Lord'] }] }), true);
});

test('matchTraitFilters — birden fazla trait filtresi AND olarak calisir', () => {
  const traits = [
    { trait_type: 'Tier', value: 'Lord' },
    { trait_type: 'Background', value: 'Gold' },
    { trait_type: 'Rarity Rank', value: 12 }
  ];
  const cfg = {
    traitFilters: [
      { traitType: 'Tier', traitValues: ['Lord'] },
      { traitType: 'Background', traitValues: ['Gold'] },
      { traitType: 'Rarity Rank', traitMax: 20 }
    ]
  };
  const result = matchTraitFilters(traits, cfg);
  assert.equal(result.matched, true);
  assert.equal(result.matches.length, 3);
});

test('matchTraitFilters — filtrelerden biri tutmazsa reddeder', () => {
  const traits = [
    { trait_type: 'Tier', value: 'Lord' },
    { trait_type: 'Background', value: 'Blue' }
  ];
  const cfg = {
    traitFilters: [
      { traitType: 'Tier', traitValues: ['Lord'] },
      { traitType: 'Background', traitValues: ['Gold'] }
    ]
  };
  assert.equal(matchTraitFilters(traits, cfg).matched, false);
});

test('matchTraitFilters — traitMatchMode any ile filtrelerden biri tutarsa gecer', () => {
  const traits = [
    { trait_type: 'Background', value: 'Blue' },
    { trait_type: 'Eyes', value: 'Lasers' }
  ];
  const cfg = {
    traitMatchMode: 'any',
    traitFilters: [
      { traitType: 'Background', traitValues: ['Gold'] },
      { traitType: 'Eyes', traitValues: ['Lasers'] }
    ]
  };
  const result = matchTraitFilters(traits, cfg);
  assert.equal(result.matched, true);
  assert.equal(result.primaryTraitType, 'Eyes');
  assert.equal(result.primaryTraitValue, 'Lasers');
});

test('getTraitValue — numeric trait returns number', () => {
  const traits = [{ trait_type: 'Rarity Rank', value: '25' }];
  assert.equal(getTraitValue(traits, 'Rarity Rank'), 25);
});

test('getTraitValue — string trait returns string', () => {
  const traits = [{ trait_type: 'Tier', value: 'Lord' }];
  assert.equal(getTraitValue(traits, 'Tier'), 'Lord');
});

test('getTraitValue — undefined traitType returns null', () => {
  const traits = [{ trait_type: 'Tier', value: 'Lord' }];
  assert.equal(getTraitValue(traits, undefined), null);
  assert.equal(getTraitValue(traits, ''), null);
});

test('getTraitValue — alternative field names (traitType/type)', () => {
  assert.equal(getTraitValue([{ traitType: 'X', value: 'y' }], 'X'), 'y');
  assert.equal(getTraitValue([{ type: 'X', value: 'y' }], 'X'), 'y');
});

test('normalizeTraitType — lowercases and trims', () => {
  assert.equal(normalizeTraitType('  Rarity Rank  '), 'rarity rank');
  assert.equal(normalizeTraitType(null), '');
  assert.equal(normalizeTraitType(undefined), '');
});

test('traitTypeOf / traitValueOf fallback chain', () => {
  assert.equal(traitTypeOf({ trait_type: 'A' }), 'A');
  assert.equal(traitTypeOf({ traitType: 'B' }), 'B');
  assert.equal(traitTypeOf({ type: 'C' }), 'C');
  assert.equal(traitTypeOf({}), '');
  assert.equal(traitValueOf({ value: 'V' }), 'V');
  assert.equal(traitValueOf({ numeric_value: 5 }), 5);
  assert.equal(traitValueOf({}), '');
});

test('formatMatchTraitLines — filters by traitType + rarity/tier', () => {
  const traits = [
    { trait_type: 'Tier', value: 'Lord' },
    { trait_type: 'Background', value: 'Blue' },
    { trait_type: 'Rarity Rank', value: 42 }
  ];
  const escape = s => String(s);
  const lines = formatMatchTraitLines(traits, { traitType: 'Tier' }, escape);
  // Tier + Rarity Rank (rarity icerdigi icin) gelir, Background gelmez
  assert.ok(lines.some(l => l.includes('Tier')));
  assert.ok(lines.some(l => l.includes('Rarity Rank')));
  assert.ok(!lines.some(l => l.includes('Background')));
});
