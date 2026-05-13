// Gercek koleksiyon config'leriyle uctan uca filtre senaryolari
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWantedTraitValue, computeMaxPrice } from '../lib/trait.js';
import { listingPriceIsWithinLimit } from '../lib/opensea.js';

// Gercek ferrymanurns config'i: Lord/Noble/Merchant + trait-spesifik price limit
const ferry = {
  slug: 'ferrymanurns',
  traitType: 'Tier',
  traitValues: ['Merchant', 'Noble', 'Lord'],
  traitPriceLimits: { Lord: 0.2, Noble: 0.02, Merchant: 0.01 },
  maxPriceEth: 0.1
};

function listingPasses(cfg, traitVal, priceEth) {
  if (!isWantedTraitValue(traitVal, cfg)) return false;
  const max = computeMaxPrice(cfg, traitVal);
  return priceEth <= max;
}

test('ferrymanurns: Lord 0.15 ETH gecer (limit 0.2)', () => {
  assert.equal(listingPasses(ferry, 'Lord', 0.15), true);
});

test('ferrymanurns: Lord 0.25 ETH reddedilir', () => {
  assert.equal(listingPasses(ferry, 'Lord', 0.25), false);
});

test('active listing sweep: Lord global limit ustu ama trait limit iciyse kaba filtreden gecer', () => {
  const listing = {
    price: {
      current: {
        value: '150000000000000000',
        decimals: 18,
        currency: 'ETH'
      }
    }
  };
  assert.equal(listingPriceIsWithinLimit(listing, ferry), true);
});

test('ferrymanurns: Noble 0.01 ETH gecer', () => {
  assert.equal(listingPasses(ferry, 'Noble', 0.01), true);
});

test('ferrymanurns: Noble 0.05 ETH reddedilir (limit 0.02)', () => {
  // BUG: traitPriceLimits olmadan eski kod global 0.1 limitiyle geciriyordu
  assert.equal(listingPasses(ferry, 'Noble', 0.05), false);
});

test('ferrymanurns: Merchant 0.005 ETH gecer', () => {
  assert.equal(listingPasses(ferry, 'Merchant', 0.005), true);
});

test('ferrymanurns: Merchant 0.05 ETH reddedilir (limit 0.01)', () => {
  assert.equal(listingPasses(ferry, 'Merchant', 0.05), false);
});

test('ferrymanurns: Peasant trait reddedilir (traitValues icinde yok)', () => {
  assert.equal(isWantedTraitValue('Peasant', ferry), false);
});

// Gercek satos config'i: numeric Rarity Rank filtresi
const satos = {
  slug: 'satos',
  traitType: 'Rarity Rank',
  traitMax: 50,
  maxPriceRelativeToFloor: 1.2
};

test('satos: Rank 1 (en nadir) gecer', () => {
  assert.equal(isWantedTraitValue(1, satos), true);
});

test('satos: Rank 25 gecer', () => {
  assert.equal(isWantedTraitValue(25, satos), true);
});

test('satos: Rank 50 (sinir) gecer', () => {
  assert.equal(isWantedTraitValue(50, satos), true);
});

test('satos: Rank 51 reddedilir', () => {
  assert.equal(isWantedTraitValue(51, satos), false);
});

test('satos: Rank 9999 reddedilir', () => {
  assert.equal(isWantedTraitValue(9999, satos), false);
});

// Broad search (hicbir trait filtresi yok)
test('Broad search: trait filtresi yoksa pure trait matcher bilincli olarak false kalir', () => {
  // Broad search artik handleListing seviyesinde ozel ele alinir.
  assert.equal(isWantedTraitValue(null, { maxPriceEth: 0.1 }), false);
});
