// OpenSea API katmani: global queue + fetch wrapper + trait fetch +
// floor fetch + listing/event normalize'lari + NFT identity helpers
import { env } from './config.js';
import { setMapCapped } from './state.js';
import { createLogger } from './logger.js';
import { fetchWithTimeout } from './http.js';
import { computeCoarseMaxPrice } from './trait.js';

const log = createLogger('opensea');

// --- Global API queue ---
// Tum OpenSea cagrilari sirayla, aralarinda min OPENSEA_MIN_GAP_MS ile gidiyor.
// Bu, sweep + events + trait fetch'in 429 spam'i yaratmamasini sagliyor.
let queue = Promise.resolve();
let lastCallAt = 0;
let totalCalls = 0;
let total429 = 0;
let lastStatus = null;
let lastUrl = null;

export async function openseaFetch(url, options = {}) {
  const task = queue.then(async () => {
    const gap = Date.now() - lastCallAt;
    if (gap < env.OPENSEA_MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, env.OPENSEA_MIN_GAP_MS - gap));
    }
    lastCallAt = Date.now();
    const response = await fetchWithTimeout(url, {
      ...options,
      headers: {
        accept: 'application/json',
        'x-api-key': env.OPENSEA_API_KEY,
        ...(options.headers || {})
      }
    });
    totalCalls++;
    lastStatus = response.status;
    lastUrl = String(url);
    if (response.status === 429) total429++;
    return response;
  });
  queue = task.catch(() => {}); // hata olsa bile kuyruk akmaya devam
  return task;
}

export function getOpenSeaStatus() {
  return {
    totalCalls,
    total429,
    lastStatus,
    lastUrl,
    lastCallAt: lastCallAt ? new Date(lastCallAt).toISOString() : null,
    minGapMs: env.OPENSEA_MIN_GAP_MS
  };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// --- NFT Identity helpers ---

export function extractIdentityFromUrl(url) {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const assetIndex = parts.findIndex(p => p === 'assets');
    return {
      chain: assetIndex >= 0 ? parts[assetIndex + 1] : undefined,
      contract: assetIndex >= 0 ? parts[assetIndex + 2] : undefined,
      identifier: assetIndex >= 0 ? parts[assetIndex + 3] : undefined
    };
  } catch {
    return {};
  }
}

export function extractIdentifierFromName(name) {
  const m = String(name || '').match(/#\s*([0-9]+)/);
  return m?.[1];
}

export function parseNftIdentity(item = {}, config) {
  const nftId = item.nft_id || item.nftId || '';
  const nftIdParts = String(nftId).split('/');
  const urlIdentity = extractIdentityFromUrl(item.permalink || item.opensea_url || item.url);

  const contractValue =
    item.contract ||
    item.contract?.address ||
    item.contract_address ||
    item.asset_contract?.address ||
    urlIdentity.contract ||
    nftIdParts[1];

  const chain =
    item.chain?.identifier ||
    item.chain?.name ||
    item.chain ||
    urlIdentity.chain ||
    nftIdParts[0] ||
    config?.chain ||
    'ethereum';

  const identifier =
    item.identifier ||
    item.token_id ||
    item.tokenId ||
    item.tokenID ||
    urlIdentity.identifier ||
    extractIdentifierFromName(item.name || item.metadata?.name) ||
    nftIdParts[2];

  return {
    chain: String(chain).toLowerCase(),
    contract: typeof contractValue === 'object' ? contractValue?.address : contractValue,
    identifier: String(identifier || '')
  };
}

function firstString(...values) {
  return values.find(v => typeof v === 'string' && v.length > 0);
}

function findNftCandidate(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNftCandidate(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const urlId = extractIdentityFromUrl(value.opensea_url || value.permalink || value.url);
  const hasId = value.identifier || value.token_id || value.tokenId || value.tokenID || urlId.identifier || extractIdentifierFromName(value.name);
  const hasShape = hasId && (value.contract || value.contract_address || value.asset_contract || value.collection || urlId.contract);
  if (hasShape) return value;
  for (const k of ['nft', 'item', 'asset', 'nfts', 'assets', 'nft_asset', 'asset_bundle']) {
    const found = findNftCandidate(value[k], depth + 1);
    if (found) return found;
  }
  return null;
}

// --- Unit conversion (wei -> human readable) ---

export function formatUnits(rawValue, decimals = 18) {
  if (rawValue === undefined || rawValue === null) return 'unknown';
  const value = BigInt(String(rawValue));
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6);
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

export function unitsToNumber(rawValue, decimals = 18) {
  if (rawValue === undefined || rawValue === null) return null;
  const formatted = formatUnits(rawValue, decimals);
  const value = Number(formatted);
  return Number.isFinite(value) ? value : null;
}

// --- Order/Listing helpers ---

export function getOrderKey(payload) {
  return payload.order_hash || payload.orderHash || payload.protocol_data?.parameters?.salt || payload.event_id || JSON.stringify([
    payload.item?.nft_id,
    payload.base_price,
    payload.listing_date,
    payload.event_timestamp,
    payload.maker?.address || payload.maker
  ]);
}

export function parseListingOffer(listing = {}) {
  const offer = listing.protocol_data?.parameters?.offer || [];
  return offer.find(it => it.itemType === 2 || it.itemType === 3) || offer[0] || {};
}

export function getListingStartTime(listing = {}) {
  const t = Number(listing.protocol_data?.parameters?.startTime || listing.listing_date || listing.event_timestamp);
  return Number.isFinite(t) ? t : null;
}

export function listingIsRecentEnough(listing) {
  if (env.LISTING_LOOKBACK_SECONDS === 0) return true;
  const t = getListingStartTime(listing);
  if (!t) return true;
  return t >= Math.floor(Date.now() / 1000) - env.LISTING_LOOKBACK_SECONDS;
}

export function listingPriceIsWithinLimit(listing, config) {
  const current = listing.price?.current || {};
  const symbol = current.currency || 'ETH';
  const decimals = Number(current.decimals || 18);
  const price = unitsToNumber(current.value, decimals);
  if (!(symbol === 'ETH' || symbol === 'WETH')) return false;
  return price !== null && price <= computeCoarseMaxPrice(config);
}

// --- API call wrappers ---

const collectionContracts = new Map();

export async function fetchCollectionContract(slug) {
  if (collectionContracts.has(slug)) return collectionContracts.get(slug);
  const url = new URL(`https://api.opensea.io/api/v2/collections/${slug}`);
  const response = await openseaFetch(url);
  if (!response.ok) {
    collectionContracts.set(slug, '');
    return '';
  }
  const body = await response.json();
  const contracts = body.contracts || body.collection?.contracts || [];
  const contract = contracts[0]?.address || contracts[0] || '';
  collectionContracts.set(slug, contract);
  return contract;
}

const traitCache = new Map();
const collectionTraitsCache = new Map();

function normalizeCollectionTraits(body = {}) {
  const rawTraits = body.traits || body.counts || body.categories || {};
  const traits = [];

  if (Array.isArray(rawTraits)) {
    for (const trait of rawTraits) {
      const traitType = trait.trait_type || trait.traitType || trait.type || trait.name;
      if (!traitType) continue;
      const rawValues = trait.values || trait.trait_values || trait.counts || [];
      const values = Array.isArray(rawValues)
        ? rawValues.map(v => ({
            value: String(v.value ?? v.name ?? v.trait_value ?? v),
            count: Number(v.count ?? v.total ?? 0)
          }))
        : Object.entries(rawValues).map(([value, count]) => ({ value: String(value), count: Number(count || 0) }));
      traits.push({ traitType: String(traitType), values });
    }
    return traits;
  }

  for (const [traitType, rawValues] of Object.entries(rawTraits)) {
    const values = Array.isArray(rawValues)
      ? rawValues.map(v => ({
          value: String(v.value ?? v.name ?? v.trait_value ?? v),
          count: Number(v.count ?? v.total ?? 0)
        }))
      : Object.entries(rawValues || {}).map(([value, count]) => ({ value: String(value), count: Number(count || 0) }));
    traits.push({ traitType, values });
  }
  return traits.sort((a, b) => a.traitType.localeCompare(b.traitType));
}

export async function fetchCollectionTraits(slug, { force = false } = {}) {
  const key = String(slug || '').trim().toLowerCase();
  if (!key) throw new Error('collection slug required');
  const cached = collectionTraitsCache.get(key);
  const now = Date.now();
  if (!force && cached && now < cached.expires) return cached.data;

  const url = new URL(`https://api.opensea.io/api/v2/traits/${key}`);
  const response = await openseaFetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenSea traits ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  const body = await response.json();
  const traits = normalizeCollectionTraits(body);
  const data = {
    slug: key,
    traits,
    fetchedAt: new Date().toISOString()
  };
  collectionTraitsCache.set(key, { data, expires: now + 10 * 60 * 1000 });
  return data;
}

export async function fetchNftTraits(item, config, retryCount = 0) {
  const identity = parseNftIdentity(item, config);
  if (!identity.contract && identity.identifier) {
    identity.contract = await fetchCollectionContract(config.slug);
  }
  if (!identity.contract || !identity.identifier) {
    throw new Error(`NFT kimligi cikarilamadi: ${item?.nft_id || item?.permalink || 'unknown'}`);
  }

  const cacheKey = `${identity.chain}:${identity.contract}:${identity.identifier}`;
  if (traitCache.has(cacheKey)) return traitCache.get(cacheKey);

  const url = new URL(`https://api.opensea.io/api/v2/chain/${identity.chain}/contract/${identity.contract}/nfts/${identity.identifier}`);
  const response = await openseaFetch(url);

  if (!response.ok) {
    if (response.status === 429 && retryCount < 3) {
      log.warn(`429 trait (${identity.identifier}), retry ${retryCount + 1}`);
      await delay(3000 * (retryCount + 1));
      return fetchNftTraits(item, config, retryCount + 1);
    }
    throw new Error(`OpenSea trait ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const traits = body.nft?.traits || body.traits || [];
  // Rarity rank ozelligini de trait olarak inject et (satos vb. icin)
  if (body.nft?.rarity?.rank) {
    traits.push({ trait_type: 'Rarity Rank', value: body.nft.rarity.rank });
  }
  setMapCapped(traitCache, cacheKey, traits, 5000);
  return traits;
}

const collectionFloorCache = new Map();

export async function getCollectionFloorPrice(slug) {
  const cached = collectionFloorCache.get(slug);
  const now = Date.now();
  if (cached && now < cached.expires) return cached.price;
  try {
    const url = `https://api.opensea.io/api/v2/collections/${slug}/stats`;
    const res = await openseaFetch(url);
    if (res.ok) {
      const data = await res.json();
      const floorPrice = data.total?.floor_price;
      if (typeof floorPrice === 'number') {
        setMapCapped(collectionFloorCache, slug, { price: floorPrice, expires: now + (5 * 60 * 1000) }, 500);
        return floorPrice;
      }
    }
  } catch (e) {
    log.error(`Floor ${slug}: ${e.message}`);
  }
  return null;
}

export async function fetchRecentOrderEvents(config) {
  const url = new URL(`https://api.opensea.io/api/v2/events/collection/${config.slug}`);
  url.searchParams.set('event_type', 'listing');
  url.searchParams.set('after', String(Math.floor(Date.now() / 1000) - env.EVENT_LOOKBACK_SECONDS));
  url.searchParams.set('limit', '100');
  const response = await openseaFetch(url);
  if (!response.ok) {
    const err = new Error(`Events ${config.slug}: ${response.status} ${response.statusText}`);
    err.status = response.status;
    throw err;
  }
  const body = await response.json();
  return body.asset_events || body.events || [];
}

export async function fetchActiveListingsPage(config, next) {
  const url = new URL(`https://api.opensea.io/api/v2/listings/collection/${config.slug}/all`);
  url.searchParams.set('limit', '200');
  if (next) url.searchParams.set('next', next);
  const response = await openseaFetch(url);
  if (!response.ok) {
    const err = new Error(`Listings ${config.slug}: ${response.status} ${response.statusText}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

// --- Event/Listing normalize'lari (Stream API & REST farklarini sariyor) ---

export function normalizeRestOrderEvent(event = {}, config) {
  const nft = event.nft || event.item || event.asset || findNftCandidate(event) || {};
  const payment = event.payment || {};
  const token = payment.token || payment.payment_token || {};
  const price = payment.quantity || payment.amount || event.base_price;
  const identity = parseNftIdentity({
    ...nft,
    chain: nft.chain || event.chain,
    permalink: nft.opensea_url || nft.permalink || event.opensea_url || event.permalink
  }, config);
  const name = firstString(
    nft.name,
    nft.metadata?.name,
    event.name,
    identity.identifier && `${config.slug} #${identity.identifier}`
  );
  const permalink = nft.opensea_url || nft.permalink || event.opensea_url || event.permalink;

  return {
    event_type: 'item_listed',
    payload: {
      ...event,
      item: {
        ...nft,
        nft_id: nft.nft_id || `${identity.chain}/${identity.contract || ''}/${identity.identifier || ''}`,
        chain: identity.chain,
        contract: identity.contract,
        identifier: identity.identifier,
        metadata: { name, traits: nft.traits || nft.metadata?.traits || [] },
        permalink
      },
      base_price: price,
      payment_token: {
        symbol: token.symbol || payment.symbol || 'ETH',
        decimals: Number(token.decimals || payment.decimals || 18)
      },
      maker: event.maker,
      order_hash: event.order_hash,
      event_timestamp: event.event_timestamp || event.created_date
    }
  };
}

export function normalizeActiveListing(listing = {}, config) {
  const offer = parseListingOffer(listing);
  const price = listing.price?.current || {};
  const tokenId = offer.identifierOrCriteria || listing.identifier || listing.token_id;
  const contract = offer.token || listing.contract || listing.contract_address || collectionContracts.get(config.slug);
  const chain = listing.chain || config.chain || 'ethereum';

  return {
    event_type: 'item_listed',
    payload: {
      ...listing,
      item: {
        nft_id: `${chain}/${contract || ''}/${tokenId || ''}`,
        chain, contract, identifier: tokenId,
        metadata: { name: tokenId ? `${config.slug} #${tokenId}` : undefined, traits: [] },
        permalink: tokenId && contract ? `https://opensea.io/item/${chain}/${contract}/${tokenId}` : undefined
      },
      base_price: price.value,
      payment_token: { symbol: price.currency || 'ETH', decimals: Number(price.decimals || 18) },
      maker: listing.protocol_data?.parameters?.offerer,
      order_hash: listing.order_hash,
      event_timestamp: String(getListingStartTime(listing) || '')
    }
  };
}

export function itemUrl(item = {}, config) {
  const identity = parseNftIdentity(item, config);
  return item.permalink || `https://opensea.io/assets/${identity.chain}/${identity.contract}/${identity.identifier}`;
}
