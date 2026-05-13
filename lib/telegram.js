// Telegram bildirim katmani: text + listing mesajlari, thread routing
import { env } from './config.js';
import { createLogger } from './logger.js';
import { fetchWithTimeout } from './http.js';

const log = createLogger('telegram');

export function telegramEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function rawSend(endpoint, body) {
  if (env.DRY_RUN) {
    log.info(`[dry-run] Telegram cagrilmadi: ${JSON.stringify(body).slice(0, 150)}...`);
    return { ok: true, dryRun: true };
  }
  try {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errBody = await response.text();
      log.warn(`send failed (${response.status}): ${errBody}`);
    }
    return response;
  } catch (e) {
    log.error(`send error: ${e.message}`);
    return null;
  }
}

// Basit metin mesaj — istege bagli thread ID
export async function sendText(text, threadId) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (threadId) body.message_thread_id = threadId;
  return rawSend(endpoint, body);
}

// NFT listing match mesaji — USD value, floor karsilastirmasi, link icerir
export async function sendListingMessage({
  name,
  price,
  symbol,
  traitType,
  traitValue,
  slopTraitLines = [],
  url,
  imageUrl,
  threadId,
  usdValue,
  floorInfo
}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const targetThread = threadId ?? env.TELEGRAM_NFT_THREAD_ID;

  const lines = [
    '<b>🎯 OpenSea Listing Match</b>',
    '',
    `<b>NFT:</b> ${telegramEscape(name)}`,
    `<b>Price:</b> ${telegramEscape(price)} ${telegramEscape(symbol)}${formatUsdSuffix(usdValue)}`
  ];

  if (traitType) {
    lines.push(`<b>${telegramEscape(traitType)}:</b> ${telegramEscape(traitValue)}`);
  }

  if (floorInfo) {
    const icon = floorInfo.direction === 'UCUZ' ? '🔥' : '⚠️';
    lines.push(`${icon} <b>Floor:</b> ${floorInfo.floor} ETH (bu listing <b>%${floorInfo.percent.toFixed(1)} ${floorInfo.direction}</b>)`);
  }

  const extraTraitLines = slopTraitLines.filter(line =>
    !line.includes(`<b>${telegramEscape(traitType || '')}:</b>`)
  );
  if (extraTraitLines.length) {
    lines.push(...extraTraitLines);
  }

  lines.push('');
  lines.push(`<a href="${telegramEscape(url)}">OpenSea sayfasini ac</a>`);

  const caption = lines.join('\n');

  const canSendPhoto = env.TELEGRAM_SEND_PHOTO && imageUrl && /^https?:\/\//i.test(imageUrl);
  const endpoint = canSendPhoto
    ? `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`
    : `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = canSendPhoto
    ? { chat_id: env.TELEGRAM_CHAT_ID, photo: imageUrl, caption, parse_mode: 'HTML' }
    : { chat_id: env.TELEGRAM_CHAT_ID, text: caption, parse_mode: 'HTML', disable_web_page_preview: false };
  if (targetThread) body.message_thread_id = targetThread;

  const response = await rawSend(endpoint, body);
  // Foto gondermek hata verirse text olarak tekrar dene
  if (response && response.ok === false && canSendPhoto) {
    log.warn('Photo failed, falling back to text');
    return sendListingMessage({
      name, price, symbol, traitType, traitValue,
      slopTraitLines, url, threadId: targetThread, usdValue, floorInfo
    });
  }
}

function formatUsdSuffix(usdValue) {
  if (!usdValue) return '';
  return ` ($${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`;
}
