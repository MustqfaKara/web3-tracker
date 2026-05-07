import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LogLevel, OpenSeaStreamClient, Network } from '@opensea/stream-js';
import { WebSocket } from 'ws';

const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const NOTIFICATION_TITLE = process.env.NOTIFICATION_TITLE || 'Listing Alert';
const WATCH_MODE = (process.env.WATCH_MODE || 'auto').toLowerCase();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const OPEN_IN_CHROME = (process.env.OPEN_IN_CHROME || 'true').toLowerCase() !== 'false';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_SEND_PHOTO = (process.env.TELEGRAM_SEND_PHOTO || 'false').toLowerCase() === 'true';
const POLL_BACKOFF_MS = Number(process.env.POLL_BACKOFF_MS || 10000);
const ACTIVE_LISTING_SWEEP = (process.env.ACTIVE_LISTING_SWEEP || 'true').toLowerCase() !== 'false';
const LISTING_LOOKBACK_SECONDS = Number(process.env.LISTING_LOOKBACK_SECONDS || 3600);
const EVENT_LOOKBACK_SECONDS = Number(process.env.EVENT_LOOKBACK_SECONDS || 300);

const WALLET_ADDRESS = process.env.WALLET_ADDRESS || '';
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || '';
const WALLET_POLL_INTERVAL_MS = Number(process.env.WALLET_POLL_INTERVAL_MS || 30000);

if (!['auto', 'stream', 'poll'].includes(WATCH_MODE)) {
  console.error('WATCH_MODE must be one of: auto, stream, poll.');
  process.exit(1);
}

const seenOrderHashes = new Set();
const traitCache = new Map();
const collectionContracts = new Map();
let pollingStarted = false;
let currentPollIntervalMs = POLL_INTERVAL_MS;
let nextPollTimer = null;

const configsDir = path.join(process.cwd(), 'collections');
let nftConfigs = [];

function loadConfigs() {
  if (fs.existsSync(configsDir)) {
    const files = fs.readdirSync(configsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(configsDir, file), 'utf8'));
        const envKey = `TRACK_${data.slug.toUpperCase().replace(/-/g, '_')}`;
        const isEnabled = (process.env[envKey] || 'on').toLowerCase();
        if (isEnabled === 'on' || isEnabled === 'true' || isEnabled === '1') {
          nftConfigs.push(data);
        } else {
          console.log(`Skipping collection "${data.slug}" because ${envKey} is off in .env`);
        }
      } catch (e) {
        console.error(`Failed to load config ${file}: ${e.message}`);
      }
    }
  }
}

function normalizeTraitType(value) {
  return String(value || '').trim().toLowerCase();
}

function getTraitValue(traits, traitType) {
  const wantedType = normalizeTraitType(traitType);
  const trait = (traits || []).find((candidate) => {
    const type = candidate.trait_type ?? candidate.traitType ?? candidate.type;
    return normalizeTraitType(type) === wantedType;
  });

  if (!trait) return null;
  const rawValue = trait.value ?? trait.numeric_value ?? trait.max_value;
  const numericValue = Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : String(rawValue).trim();
}

function traitTypeOf(trait = {}) {
  return trait.trait_type ?? trait.traitType ?? trait.type ?? '';
}

function traitValueOf(trait = {}) {
  return trait.value ?? trait.numeric_value ?? trait.max_value ?? '';
}

function formatTraitLines(traits = [], matcher = () => true) {
  return (traits || [])
    .filter((trait) => matcher(traitTypeOf(trait)))
    .map((trait) => {
      const type = traitTypeOf(trait);
      const value = traitValueOf(trait);
      return `<b>${telegramEscape(type)}:</b> ${telegramEscape(value)}`;
    })
    .filter(Boolean);
}

function formatMatchTraitLines(traits = [], config) {
  return formatTraitLines(
    traits,
    (type) => {
      const normType = normalizeTraitType(type);
      return normType.includes(normalizeTraitType(config.traitType)) || normType.includes('rarity') || normType.includes('tier');
    }
  );
}

function isWantedTraitValue(value, config) {
  if (value === null || value === undefined) return false;
  if (config.traitValue !== undefined && config.traitValue !== null && config.traitValue !== '') {
    return String(value).toLowerCase() === String(config.traitValue).toLowerCase();
  }
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (isNaN(numericValue)) return false;
  return numericValue >= (config.traitMin || 0) && numericValue <= (config.traitMax || 999999);
}

function formatUnits(rawValue, decimals = 18) {
  if (rawValue === undefined || rawValue === null) return 'unknown';

  const value = BigInt(String(rawValue));
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, 6);

  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

function unitsToNumber(rawValue, decimals = 18) {
  if (rawValue === undefined || rawValue === null) return null;

  const formatted = formatUnits(rawValue, decimals);
  const value = Number(formatted);
  return Number.isFinite(value) ? value : null;
}

function getOrderKey(payload) {
  return payload.order_hash || payload.orderHash || payload.protocol_data?.parameters?.salt || payload.event_id || JSON.stringify([
    payload.item?.nft_id,
    payload.base_price,
    payload.listing_date,
    payload.event_timestamp,
    payload.maker?.address || payload.maker
  ]);
}

function parseListingOffer(listing = {}) {
  const offer = listing.protocol_data?.parameters?.offer || [];
  return offer.find((item) => item.itemType === 2 || item.itemType === 3) || offer[0] || {};
}

function getListingStartTime(listing = {}) {
  const startTime = Number(listing.protocol_data?.parameters?.startTime || listing.listing_date || listing.event_timestamp);
  return Number.isFinite(startTime) ? startTime : null;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0);
}

function extractIdentityFromUrl(url) {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const assetIndex = parts.findIndex((part) => part === 'assets');
    const chain = assetIndex >= 0 ? parts[assetIndex + 1] : undefined;
    const contract = assetIndex >= 0 ? parts[assetIndex + 2] : undefined;
    const identifier = assetIndex >= 0 ? parts[assetIndex + 3] : undefined;
    return { chain, contract, identifier };
  } catch {
    return {};
  }
}

function extractIdentifierFromName(name) {
  const match = String(name || '').match(/#\s*([0-9]+)/);
  return match?.[1];
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

  const urlIdentity = extractIdentityFromUrl(value.opensea_url || value.permalink || value.url);
  const hasIdentifier =
    value.identifier ||
    value.token_id ||
    value.tokenId ||
    value.tokenID ||
    urlIdentity.identifier ||
    extractIdentifierFromName(value.name);
  const hasNftShape =
    hasIdentifier &&
    (
      value.contract ||
      value.contract_address ||
      value.asset_contract ||
      value.collection ||
      urlIdentity.contract
    );

  if (hasNftShape) return value;

  for (const key of ['nft', 'item', 'asset', 'nfts', 'assets', 'nft_asset', 'asset_bundle']) {
    const found = findNftCandidate(value[key], depth + 1);
    if (found) return found;
  }

  return null;
}

async function fetchCollectionContract(config) {
  if (collectionContracts.has(config.slug)) return collectionContracts.get(config.slug);

  const url = new URL(`https://api.opensea.io/api/v2/collections/${config.slug}`);
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-api-key': OPENSEA_API_KEY
    }
  });

  if (!response.ok) {
    collectionContracts.set(config.slug, '');
    return '';
  }

  const body = await response.json();
  const contracts = body.contracts || body.collection?.contracts || [];
  const contract = contracts[0]?.address || contracts[0] || '';
  collectionContracts.set(config.slug, contract);
  return contract;
}

function parseNftIdentity(item = {}, config) {
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
    config.chain || 
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
    contract: typeof contractValue === 'object' ? contractValue.address : contractValue,
    identifier: String(identifier || '')
  };
}

const delay = ms => new Promise(res => setTimeout(res, ms));
let lastOpenSeaApiCall = 0;

async function fetchNftTraits(item, config, retryCount = 0) {
  const identity = parseNftIdentity(item, config);
  if (!identity.contract && identity.identifier) {
    identity.contract = await fetchCollectionContract(config);
  }

  if (!identity.contract || !identity.identifier) {
    throw new Error(`Could not determine NFT identity from listing payload: ${JSON.stringify({
      keys: Object.keys(item || {}),
      name: item?.name || item?.metadata?.name,
      nft_id: item?.nft_id,
      permalink: item?.permalink || item?.opensea_url
    })}`);
  }

  const cacheKey = `${identity.chain}:${identity.contract}:${identity.identifier}`;
  if (traitCache.has(cacheKey)) return traitCache.get(cacheKey);

  const url = new URL(
    `https://api.opensea.io/api/v2/chain/${identity.chain}/contract/${identity.contract}/nfts/${identity.identifier}`
  );

  const now = Date.now();
  if (now - lastOpenSeaApiCall < 250) {
    await delay(250 - (now - lastOpenSeaApiCall));
  }
  lastOpenSeaApiCall = Date.now();

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-api-key': OPENSEA_API_KEY
    }
  });

  if (!response.ok) {
    if (response.status === 429 && retryCount < 3) {
      console.warn(`[warn] Rate limited (429) fetching traits for ${identity.identifier}, retrying in 2s...`);
      await delay(2000 * (retryCount + 1));
      return fetchNftTraits(item, config, retryCount + 1);
    }
    throw new Error(`OpenSea NFT lookup failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const traits = body.nft?.traits || body.traits || [];
  traitCache.set(cacheKey, traits);
  return traits;
}

function notify(title, message, url) {
  const fullMessage = url ? `${message}\n${url}` : message;

  process.stdout.write('\u0007');
  console.log(`\n[ALERT] ${title}`);
  console.log(fullMessage);

  execFile('osascript', [
    '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
  ], () => {});

  if (OPEN_IN_CHROME && url) {
    execFile('open', ['-a', 'Google Chrome', url], (error) => {
      if (error) {
        console.warn(`[warn] Could not open Chrome: ${error.message}`);
      }
    });
  }
}

function telegramEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramMessage({ name, price, symbol, traitType, traitValue, slopTraitLines = [], url, imageUrl }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const caption = [
    '<b>OpenSea Listing Match</b>',
    '',
    `<b>NFT:</b> ${telegramEscape(name)}`,
    `<b>Price:</b> ${telegramEscape(price)} ${telegramEscape(symbol)}`,
    `<b>${telegramEscape(traitType)}:</b> ${telegramEscape(traitValue)}`,
    ...slopTraitLines.filter((line) => !line.includes(`<b>${telegramEscape(traitType)}:</b>`)),
    `<a href="${telegramEscape(url)}">OpenSea sayfasini ac</a>`
  ].join('\n');

  const canSendPhoto = TELEGRAM_SEND_PHOTO && imageUrl && /^https?:\/\//i.test(imageUrl);
  const endpoint = canSendPhoto
    ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`
    : `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = canSendPhoto
    ? {
        chat_id: TELEGRAM_CHAT_ID,
        photo: imageUrl,
        caption,
        parse_mode: 'HTML'
      }
    : {
        chat_id: TELEGRAM_CHAT_ID,
        text: caption,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (canSendPhoto) {
      console.warn(`[warn] Telegram photo failed, retrying as text: ${response.status} ${response.statusText}: ${errorBody}`);
      await sendTelegramMessage({ name, price, symbol, traitType, traitValue, slopTraitLines, url });
      return;
    }

    console.warn(`[warn] Telegram message failed: ${response.status} ${response.statusText}: ${errorBody}`);
  }
}

function itemUrl(item = {}, config) {
  const identity = parseNftIdentity(item, config);
  return item.permalink || `https://opensea.io/assets/${identity.chain}/${identity.contract}/${identity.identifier}`;
}

function normalizeRestOrderEvent(event = {}, config) {
  const nft = event.nft || event.item || event.asset || findNftCandidate(event) || {};
  const payment = event.payment || {};
  const token = payment.token || payment.payment_token || {};
  const price = payment.quantity || payment.amount || event.base_price;
  const identity = parseNftIdentity({
    ...nft,
    chain: nft.chain || event.chain,
    permalink: nft.opensea_url || nft.permalink || event.opensea_url || event.permalink
  }, config);
  const name = firstString(nft.name, nft.metadata?.name, event.name, identity.identifier && `${config.slug} #${identity.identifier}`);
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
        metadata: {
          name,
          traits: nft.traits || nft.metadata?.traits || []
        },
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

function normalizeActiveListing(listing = {}, config) {
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
        chain,
        contract,
        identifier: tokenId,
        metadata: {
          name: tokenId ? `${config.slug} #${tokenId}` : undefined,
          traits: []
        },
        permalink: tokenId && contract ? `https://opensea.io/item/${chain}/${contract}/${tokenId}` : undefined
      },
      base_price: price.value,
      payment_token: {
        symbol: price.currency || 'ETH',
        decimals: Number(price.decimals || 18)
      },
      maker: listing.protocol_data?.parameters?.offerer,
      order_hash: listing.order_hash,
      event_timestamp: String(getListingStartTime(listing) || '')
    }
  };
}

async function fetchRecentOrderEvents(config) {
  const url = new URL(`https://api.opensea.io/api/v2/events/collection/${config.slug}`);
  url.searchParams.set('event_type', 'listing');
  url.searchParams.set('after', String(Math.floor(Date.now() / 1000) - EVENT_LOOKBACK_SECONDS));
  url.searchParams.set('limit', '100');

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-api-key': OPENSEA_API_KEY
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const error = new Error(`OpenSea events poll failed for ${config.slug}: ${response.status} ${response.statusText}: ${errorBody}`);
    error.status = response.status;
    throw error;
  }

  const body = await response.json();
  return body.asset_events || body.events || [];
}

async function fetchActiveListingsPage(config, next) {
  const url = new URL(`https://api.opensea.io/api/v2/listings/collection/${config.slug}/all`);
  url.searchParams.set('limit', '200');
  if (next) url.searchParams.set('next', next);

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'x-api-key': OPENSEA_API_KEY
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const error = new Error(`OpenSea active listings sweep failed for ${config.slug}: ${response.status} ${response.statusText}: ${errorBody}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function listingIsRecentEnough(listing) {
  if (LISTING_LOOKBACK_SECONDS === 0) return true;

  const startTime = getListingStartTime(listing);
  if (!startTime) return true;

  return startTime >= Math.floor(Date.now() / 1000) - LISTING_LOOKBACK_SECONDS;
}

function listingPriceIsWithinLimit(listing, config) {
  const current = listing.price?.current || {};
  const symbol = current.currency || 'ETH';
  const decimals = Number(current.decimals || 18);
  const price = unitsToNumber(current.value, decimals);

  if (!(symbol === 'ETH' || symbol === 'WETH')) return false;
  return price !== null && price <= (config.maxPriceEth || 999999);
}

async function sweepActiveListings(config) {
  if (!ACTIVE_LISTING_SWEEP) return;

  let next = null;
  for (let page = 0; page < 3; page += 1) {
    const body = await fetchActiveListingsPage(config, next);
    const listings = body.listings || [];

    for (const listing of listings) {
      if (!listingPriceIsWithinLimit(listing, config)) {
        return;
      }

      if (!listingIsRecentEnough(listing)) continue;
      await handleListing(normalizeActiveListing(listing, config), config);
    }

    next = body.next;
    if (!next || listings.length === 0) return;
  }
}

async function pollOnce() {
  for (const config of nftConfigs) {
    const events = await fetchRecentOrderEvents(config);

    for (const event of events.reverse()) {
      await handleListing(normalizeRestOrderEvent(event, config), config);
    }

    await sweepActiveListings(config);
  }
}

function scheduleNextPoll(delayMs = currentPollIntervalMs) {
  nextPollTimer = setTimeout(runPollLoop, delayMs);
}

async function runPollLoop() {
  try {
    await pollOnce();

    if (currentPollIntervalMs !== POLL_INTERVAL_MS) {
      currentPollIntervalMs = POLL_INTERVAL_MS;
      console.log(`[poll] Rate limit cleared; returning to ${POLL_INTERVAL_MS}ms polling.`);
    }
  } catch (error) {
    if (error.status === 429) {
      currentPollIntervalMs = Math.min(
        Math.max(currentPollIntervalMs * 2, POLL_BACKOFF_MS),
        60000
      );
      console.warn(`[poll] Rate limited by OpenSea; backing off to ${currentPollIntervalMs}ms.`);
    } else {
      console.error(`[poll] ${error.message}`);
    }
  } finally {
    scheduleNextPoll();
  }
}

function startPolling(reason = 'poll mode') {
  if (pollingStarted) return;
  pollingStarted = true;

  console.log(`Using REST polling fallback every ${POLL_INTERVAL_MS}ms (${reason}).`);
  scheduleNextPoll(0);
}

function streamErrorMessage(error) {
  const message = error?.message || error?.toString?.() || '';
  const nested = error?.error?.message || error?.target?._error?.message || '';
  return `${message} ${nested}`.trim();
}

function startStream() {
  let switchedToPoll = false;

  const client = new OpenSeaStreamClient({
    network: Network.MAINNET,
    token: OPENSEA_API_KEY,
    logLevel: LogLevel.ERROR,
    onError: (error) => {
      const message = streamErrorMessage(error);

      if (message.includes('403')) {
        console.error(
          '[stream] OpenSea Stream rejected the API key with 403. Rotate the key you pasted in logs, then use a key with Stream API access.'
        );

        if (WATCH_MODE === 'auto' && !switchedToPoll) {
          switchedToPoll = true;
          startPolling('stream returned 403');
        }
        return;
      }

      console.error(`[stream] ${message || 'socket error'}`);
    },
    connectOptions: {
      transport: WebSocket
    }
  });

  for (const config of nftConfigs) {
    client.onItemListed(config.slug, (event) => {
      handleListing(event, config).catch((error) => {
        console.error(`[error] Listing handler failed for ${config.slug}: ${error.stack || error.message}`);
      });
    });
    console.log(`Watching stream for ${config.slug}`);
  }

  console.log('Using OpenSea Stream API.');
}

async function handleListing(event, config) {
  const payload = event.payload || event;
  const item = payload.item || {};
  const orderKey = getOrderKey(payload);

  if (seenOrderHashes.has(orderKey)) return;
  seenOrderHashes.add(orderKey);

  const streamTraits = item.metadata?.traits || item.traits || [];
  let traits = streamTraits;
  let slopLevel = getTraitValue(streamTraits, config.traitType);

  if (!isWantedTraitValue(slopLevel, config)) {
    try {
      const fetchedTraits = await fetchNftTraits(item, config);
      traits = fetchedTraits;
      slopLevel = getTraitValue(fetchedTraits, config.traitType);
    } catch (error) {
      console.warn(`[warn] Could not fetch traits for ${item.name || item.nft_id || 'unknown item'}: ${error.message}`);
      return;
    }
  }

  if (!isWantedTraitValue(slopLevel, config)) return;

  const symbol = payload.payment_token?.symbol || 'ETH';
  const decimals = Number(payload.payment_token?.decimals || 18);
  const priceNumber = unitsToNumber(payload.base_price, decimals);

  if ((symbol === 'ETH' || symbol === 'WETH') && priceNumber !== null && priceNumber > (config.maxPriceEth || 999999)) {
    return;
  }

  const price = formatUnits(payload.base_price, decimals);
  const name = item.metadata?.name || item.name || `${config.slug} #${parseNftIdentity(item, config).identifier}`;
  const url = itemUrl(item, config);
  const imageUrl = item.metadata?.image_url || item.metadata?.image || item.image_url || item.image;
  const matchTraitLines = formatMatchTraitLines(traits, config);

  notify(
    NOTIFICATION_TITLE,
    `${name} listed for ${price} ${symbol} | ${config.traitType}: ${slopLevel}`,
    url
  );

  await sendTelegramMessage({
    name,
    price,
    symbol,
    traitType: config.traitType,
    traitValue: slopLevel,
    slopTraitLines: matchTraitLines,
    url,
    imageUrl
  });
}

async function sendTelegramText(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (error) {
    console.error(`[wallet] Telegram send error: ${error.message}`);
  }
}

let seenWalletTxHashes = new Set();
let isFirstWalletPoll = true;

async function pollAlchemy(network, direction) {
  if (!ALCHEMY_API_KEY) return [];

  const baseUrl = network === 'base' 
    ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
    : `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

  const params = {
    category: ["external", "internal", "erc20", "erc721"],
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: "0x14",
    order: "desc"
  };

  if (direction === 'from') params.fromAddress = WALLET_ADDRESS;
  else params.toAddress = WALLET_ADDRESS;

  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "alchemy_getAssetTransfers",
        params: [params]
      })
    });

    const data = await response.json();
    if (data.result && data.result.transfers) {
      return data.result.transfers.map(tx => ({ ...tx, network }));
    } else if (data.error) {
      console.warn(`[wallet] Alchemy API warning: ${data.error.message}`);
    }
  } catch (error) {
    console.error(`[wallet] Alchemy API error: ${error.message}`);
  }
  return [];
}

async function pollWalletTransactions() {
  try {
    const [ethFrom, ethTo, baseFrom, baseTo] = await Promise.all([
      pollAlchemy('ethereum', 'from'),
      pollAlchemy('ethereum', 'to'),
      pollAlchemy('base', 'from'),
      pollAlchemy('base', 'to')
    ]);

    const allTransfers = [...ethFrom, ...ethTo, ...baseFrom, ...baseTo];
    const txGroups = {};

    for (const tx of allTransfers) {
      if (!tx.hash) continue;
      const key = `${tx.network}-${tx.hash}`;
      const ts = tx.metadata && tx.metadata.blockTimestamp ? new Date(tx.metadata.blockTimestamp).getTime() / 1000 : 0;
      if (!txGroups[key]) txGroups[key] = { hash: tx.hash, network: tx.network, transfers: [], timeStamp: ts };
      txGroups[key].transfers.push(tx);
    }

    const nowSecs = Math.floor(Date.now() / 1000);

    for (const key in txGroups) {
      const group = txGroups[key];
      const maxTs = group.timeStamp;

      if (isFirstWalletPoll) {
        seenWalletTxHashes.add(key);
        if (maxTs < nowSecs - 300) continue;
      } else {
        if (seenWalletTxHashes.has(key)) continue;
        seenWalletTxHashes.add(key);
      }

      const me = WALLET_ADDRESS.toLowerCase();
      const networkIcon = group.network === 'base' ? '🔵' : '🔷';
      const networkName = group.network === 'base' ? 'Base' : 'Ethereum';
      const explorerName = group.network === 'base' ? 'Basescan' : 'Etherscan';
      
      let msg = `<b>${networkIcon} ${networkName} Islemi Tespit Edildi!</b>\n\n`;
      let details = [];

      group.transfers.sort((a, b) => a.category.localeCompare(b.category));

      for (const tx of group.transfers) {
         const val = tx.value !== null ? tx.value : 1; 
         const asset = tx.asset || 'Bilinmeyen Token';

         if (tx.category === 'external' || tx.category === 'internal' || tx.category === 'erc20') {
            if (tx.to && tx.to.toLowerCase() === me) {
               details.push(`🟢 <b>Gelen:</b> ${val} ${asset}`);
            } else if (tx.from && tx.from.toLowerCase() === me) {
               details.push(`🔴 <b>Giden:</b> ${val} ${asset}`);
            }
         } else if (tx.category === 'erc721') {
            const tokenIdHex = tx.tokenId || tx.erc721TokenId;
            const tokenIdDec = tokenIdHex ? BigInt(tokenIdHex).toString() : 'Bilinmeyen';
            if (tx.to && tx.to.toLowerCase() === me) {
               details.push(`🖼️ <b>NFT Alindi:</b> ${asset} #${tokenIdDec}`);
            } else if (tx.from && tx.from.toLowerCase() === me) {
               details.push(`🖼️ <b>NFT Satildi:</b> ${asset} #${tokenIdDec}`);
            }
         }
      }

      const explorerLink = group.network === 'base' 
         ? `https://basescan.org/tx/${group.hash}` 
         : `https://etherscan.io/tx/${group.hash}`;

      if (details.length > 0) {
         msg += details.join('\n');
         msg += `\n\n<a href="${explorerLink}">${explorerName}'de Goruntule</a>`;
         await sendTelegramText(msg);
      }
    }
    isFirstWalletPoll = false;
  } catch (error) {
    console.error(`[wallet] Polling error: ${error.message}`);
  }
}

function startWalletWatcher() {
  if (!WALLET_ADDRESS || !ALCHEMY_API_KEY) {
    console.log('Wallet address or ALCHEMY_API_KEY missing. Wallet tracking disabled.');
    return;
  }
  console.log(`Starting wallet tracker for ${WALLET_ADDRESS} on Ethereum and Base using Alchemy.`);
  setInterval(pollWalletTransactions, WALLET_POLL_INTERVAL_MS);
  pollWalletTransactions();
}

function main() {
  startWalletWatcher();

  loadConfigs();

  if (nftConfigs.length > 0) {
    if (!OPENSEA_API_KEY) {
      console.error('Missing OPENSEA_API_KEY for NFT tracking. Exiting.');
      process.exit(1);
    }

    for (const config of nftConfigs) {
      console.log(
        `Watching OpenSea collection "${config.slug}" for new listings where ${config.traitType} is ${config.traitValue || (config.traitMin + '-' + config.traitMax)} and price is <= ${config.maxPriceEth || 'any'} ETH.`
      );
    }

    if (WATCH_MODE === 'poll') {
      startPolling('WATCH_MODE=poll');
    } else {
      startStream();
    }
  } else {
    console.log('No active NFT collections found or all are disabled in .env. NFT tracking is inactive.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
