// handleListing — bir listing event'inin tum filtre + bildirim pipeline'i
import { env } from './config.js';
import { seenOrderHashes, notifiedTradingOpens, addToSetCapped } from './state.js';
import { bell, notifyMacOS, openInChrome } from './notify.js';
import { sendListingMessage, sendText, telegramEscape } from './telegram.js';
import { recordError } from './errors.js';
import { getEthPrice } from './price.js';
import {
  parseNftIdentity,
  fetchNftTraits,
  itemUrl,
  getOrderKey,
  unitsToNumber,
  formatUnits,
  getCollectionFloorPrice
} from './opensea.js';
import {
  hasTraitFilter,
  matchTraitFilters,
  computeMaxPrice,
  formatMatchTraitLines
} from './trait.js';
import { createLogger } from './logger.js';

const log = createLogger('listing');

export async function handleListing(event, config) {
  const payload = event.payload || event;
  const item = payload.item || {};
  const orderKey = getOrderKey(payload);
  const displayName = config.name || config.slug;

  // -- Trading-open detection (seenOrderHashes kontrolunden ONCE)
  // Bot calistigi surece bu koleksiyonun ilk listing'ini gorunce tek seferlik bildirim
  if (config.monitorTradingOpen && !notifiedTradingOpens.has(config.slug)) {
    addToSetCapped(notifiedTradingOpens, config.slug, 100);
    const collUrl = `https://opensea.io/collection/${config.slug}`;
    sendText(
      `🚀 <b>TRADING ACILDI: ${telegramEscape(displayName)}</b>\n\nIlk listing gorundu. Bot artik <b>${config.maxPriceEth || 'limitsiz'} ETH</b> alti listing'leri tariyor.\n\n<a href="${collUrl}">OpenSea koleksiyon sayfasi</a>`,
      config.telegramThreadId || env.TELEGRAM_NFT_THREAD_ID
    ).catch(e => log.warn(`trading-open Telegram fail: ${e.message}`));
    log.info(`${config.slug} TRADING ACILDI bildirildi`);
  }

  // -- Dedup
  if (seenOrderHashes.has(orderKey)) return;
  addToSetCapped(seenOrderHashes, orderKey, 20000);

  // -- Trait extraction (stream'den geldiyse direkt, yoksa API'den fetch)
  const streamTraits = item.metadata?.traits || item.traits || [];
  let traits = streamTraits;
  let traitMatch = { matched: true, matches: [], primaryTraitType: null, primaryTraitValue: null };
  if (hasTraitFilter(config)) {
    traitMatch = matchTraitFilters(streamTraits, config);

    if (!traitMatch.matched) {
      try {
        const fetched = await fetchNftTraits(item, config);
        traits = fetched;
        traitMatch = matchTraitFilters(fetched, config);
      } catch (e) {
        log.debug(`Trait fetch atildi (${item.name || item.nft_id || 'unknown'}): ${e.message}`);
        return;
      }
    }

    if (!traitMatch.matched) return;
  }

  // -- Price extraction & gate
  const symbol = payload.payment_token?.symbol || 'ETH';
  const decimals = Number(payload.payment_token?.decimals || 18);
  const priceNumber = unitsToNumber(payload.base_price, decimals);

  // traitPriceLimits varsa o trait icin ozel limit, yoksa maxPriceEth
  const matchedTraitValues = traitMatch.matches.map(m => m.traitValue);
  let maxPrice = computeMaxPrice(config, matchedTraitValues);

  // maxPriceRelativeToFloor varsa floor'a gore daha sikilastir
  if (config.maxPriceRelativeToFloor) {
    const floor = await getCollectionFloorPrice(config.slug);
    if (floor) {
      const relMax = floor * config.maxPriceRelativeToFloor;
      if (relMax < maxPrice) maxPrice = relMax;
    } else if (config.maxPriceEth === undefined) {
      log.warn(`${config.slug}: floor alinmadi, listing drop`);
      return;
    }
  }

  if ((symbol === 'ETH' || symbol === 'WETH') && priceNumber !== null && priceNumber > maxPrice) {
    return;
  }

  // -- Match! Bildirim verilerini hazirla
  const price = formatUnits(payload.base_price, decimals);
  const name = item.metadata?.name || item.name || `${config.slug} #${parseNftIdentity(item, config).identifier}`;
  const url = itemUrl(item, config);
  const imageUrl = item.metadata?.image_url || item.metadata?.image || item.image_url || item.image;
  const slopTraitLines = formatMatchTraitLines(traits, config, telegramEscape);

  // USD value (sadece ETH/WETH)
  let usdValue = null;
  let ethPrice = null;
  if (symbol === 'ETH' || symbol === 'WETH') {
    ethPrice = await getEthPrice();
    if (ethPrice && priceNumber !== null) usdValue = priceNumber * ethPrice;
  }

  // Collection floor karsilastirmasi (hizli, cache'li)
  let floorInfo = null;
  if (symbol === 'ETH' || symbol === 'WETH') {
    const floor = await getCollectionFloorPrice(config.slug);
    if (floor && priceNumber !== null && floor > 0) {
      const diff = priceNumber - floor;
      const percent = (Math.abs(diff) / floor) * 100;
      floorInfo = {
        floor,
        diff,
        percent,
        direction: diff < 0 ? 'UCUZ' : 'PAHALI'
      };
    }
  }

  recordError('match', null, {
    slug: config.slug,
    name,
    price,
    symbol,
    traitType: traitMatch.primaryTraitType || config.traitType,
    traitValue: traitMatch.primaryTraitValue,
    traitMatches: traitMatch.matches,
    url
  });
  bell();
  const matchSummary = traitMatch.matches.length
    ? traitMatch.matches.map(m => `${m.traitType}: ${m.traitValue}`).join(' | ')
    : 'any';
  log.info(`MATCH ${config.slug}: ${name} @ ${price} ${symbol} | ${matchSummary}`);

  if (env.DRY_RUN) {
    log.info(`[dry-run] bildirim atlandi (${url})`);
    return;
  }

  notifyMacOS(env.NOTIFICATION_TITLE, `${name} @ ${price} ${symbol}`);
  openInChrome(url);

  await sendListingMessage({
    name,
    price,
    symbol,
    traitType: traitMatch.primaryTraitType || config.traitType,
    traitValue: traitMatch.primaryTraitValue,
    slopTraitLines,
    url,
    imageUrl,
    threadId: config.telegramThreadId || env.TELEGRAM_NFT_THREAD_ID,
    usdValue,
    floorInfo
  });
}
