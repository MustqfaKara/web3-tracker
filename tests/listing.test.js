// lib/listing.js — kritik pipeline davranislari
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../lib/config.js';
import { handleListing } from '../lib/listing.js';
import { seenOrderHashes } from '../lib/state.js';
import { stats } from '../lib/errors.js';

const originalFetch = global.fetch;
const originalDryRun = env.DRY_RUN;

before(() => {
  env.DRY_RUN = true;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ price: '3000' }),
    text: async () => ''
  });
});

after(() => {
  env.DRY_RUN = originalDryRun;
  global.fetch = originalFetch;
});

function listedEvent(orderHash, priceWei, traits = []) {
  return {
    payload: {
      order_hash: orderHash,
      base_price: priceWei,
      payment_token: { symbol: 'ETH', decimals: 18 },
      item: {
        nft_id: `ethereum/0xabc/${orderHash}`,
        chain: 'ethereum',
        contract: '0xabc',
        identifier: orderHash,
        metadata: {
          name: `Test NFT #${orderHash}`,
          traits
        },
        permalink: `https://opensea.io/assets/ethereum/0xabc/${orderHash}`
      }
    }
  };
}

function matchCount(slug) {
  return stats.matches.get(slug) || 0;
}

test('handleListing — broad search trait fetch gerektirmeden fiyat filtresiyle match olur', async () => {
  const slug = 'broad-test';
  const order = 'broad-order-1';
  seenOrderHashes.delete(order);
  const beforeCount = matchCount(slug);

  await handleListing(
    listedEvent(order, '50000000000000000'),
    { slug, chain: 'ethereum', maxPriceEth: 0.1 }
  );

  assert.equal(seenOrderHashes.has(order), true);
  assert.equal(matchCount(slug), beforeCount + 1);
});

test('handleListing — duplicate order ikinci kez match sayilmaz', async () => {
  const slug = 'dedup-test';
  const order = 'dedup-order-1';
  seenOrderHashes.delete(order);
  const beforeCount = matchCount(slug);
  const config = {
    slug,
    chain: 'ethereum',
    traitType: 'Tier',
    traitValues: ['Lord'],
    maxPriceEth: 0.1
  };
  const event = listedEvent(order, '50000000000000000', [
    { trait_type: 'Tier', value: 'Lord' }
  ]);

  await handleListing(event, config);
  await handleListing(event, config);

  assert.equal(matchCount(slug), beforeCount + 1);
});
