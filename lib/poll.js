// REST polling fallback: events + active listing sweep, 429 backoff'la
import { env } from './config.js';
import { handleListing } from './listing.js';
import {
  fetchRecentOrderEvents,
  fetchActiveListingsPage,
  normalizeRestOrderEvent,
  normalizeActiveListing,
  listingPriceIsWithinLimit,
  listingIsRecentEnough
} from './opensea.js';
import { recordError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('poll');

let pollingStarted = false;
let currentInterval = env.POLL_INTERVAL_MS;
let nextTimer = null;
let stopRequested = false;
let lastPollAt = null;
let lastPollError = null;
let rateLimitCount = 0;

async function sweepActiveListings(config) {
  if (!env.ACTIVE_LISTING_SWEEP) return;
  let next = null;
  for (let page = 0; page < 3; page++) {
    const body = await fetchActiveListingsPage(config, next);
    const listings = body.listings || [];
    for (const listing of listings) {
      // OpenSea /listings/collection/all fiyata gore sirali donmuyor —
      // pahali listing'e denk gelince DURMA, devam et
      if (!listingPriceIsWithinLimit(listing, config)) continue;
      if (!listingIsRecentEnough(listing)) continue;
      await handleListing(normalizeActiveListing(listing, config), config);
    }
    next = body.next;
    if (!next || listings.length === 0) return;
  }
}

async function pollOnce(configs) {
  for (const config of configs) {
    const events = await fetchRecentOrderEvents(config);
    for (const event of events.reverse()) {
      await handleListing(normalizeRestOrderEvent(event, config), config);
    }
    await sweepActiveListings(config);
  }
}

function scheduleNext(configs, delayMs = currentInterval) {
  if (stopRequested) return;
  nextTimer = setTimeout(() => runPollLoop(configs), delayMs);
}

async function runPollLoop(configs) {
  try {
    await pollOnce(configs);
    lastPollAt = new Date().toISOString();
    lastPollError = null;
    if (currentInterval !== env.POLL_INTERVAL_MS) {
      currentInterval = env.POLL_INTERVAL_MS;
      log.info(`Rate limit kalkti, ${env.POLL_INTERVAL_MS}ms araliga geri donduk`);
    }
  } catch (e) {
    if (e.status === 429) {
      // Exponential backoff (max 60s)
      rateLimitCount++;
      currentInterval = Math.min(Math.max(currentInterval * 2, env.POLL_BACKOFF_MS), 60000);
      log.warn(`429 rate limit, backoff ${currentInterval}ms`);
    } else {
      log.error(e.message);
    }
    lastPollError = e.message;
    recordError('poll', e);
  } finally {
    scheduleNext(configs);
  }
}

export function getPollStatus() {
  return {
    pollingStarted,
    currentInterval,
    lastPollAt,
    lastPollError,
    rateLimitCount,
    stopRequested
  };
}

export function startPolling(configs, reason = 'poll mode') {
  if (pollingStarted) return;
  pollingStarted = true;
  log.info(`REST polling start: ${env.POLL_INTERVAL_MS}ms (${reason})`);
  scheduleNext(configs, 0);
}

export function stopPolling() {
  stopRequested = true;
  if (nextTimer) clearTimeout(nextTimer);
}

// --once CLI flag'i icin: tek poll yapip cik
export async function runOnce(configs) {
  log.info('Tek poll calistiriliyor (--once)');
  try {
    await pollOnce(configs);
  } catch (e) {
    log.error(`runOnce: ${e.message}`);
  }
}
