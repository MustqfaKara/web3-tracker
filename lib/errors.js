// Hata aggregasyon + gunluk heartbeat ozeti.
// Hatalar console'a basilirken bir map'te toplaniyor, saatte bir Telegram'a flush.
// Heartbeat her gun HEARTBEAT_HOUR saatinde gunluk istatistik gonderiyor.
import { env } from './config.js';
import { sendText } from './telegram.js';
import { createLogger } from './logger.js';
import { seenOrderHashes, processedTransfers } from './state.js';

const log = createLogger('errors');

const errorCounts = new Map();

export const stats = {
  matches: new Map(),  // slug -> count
  walletTxs: 0,
  errors: 0,
  startedAt: Date.now(),
  recentMatches: [],
  recentWalletTxs: [],
  recentErrors: []
};

function pushRecent(list, item, cap = 30) {
  list.unshift({ at: new Date().toISOString(), ...item });
  if (list.length > cap) list.pop();
}

// Hatayi veya basarili event'i kaydet (Telegram ozeti icin)
export function recordError(category, error, meta = {}) {
  if (error) {
    const key = `${category}: ${(error.message || 'unknown').slice(0, 60)}`;
    errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    stats.errors++;
    pushRecent(stats.recentErrors, { category, message: error.message || 'unknown' });
  } else if (category === 'match' && meta.slug) {
    stats.matches.set(meta.slug, (stats.matches.get(meta.slug) || 0) + 1);
    pushRecent(stats.recentMatches, meta);
  } else if (category === 'wallet_tx') {
    stats.walletTxs++;
    pushRecent(stats.recentWalletTxs, meta);
  }
}

export function getRuntimeStats() {
  return {
    startedAt: new Date(stats.startedAt).toISOString(),
    uptimeMs: Date.now() - stats.startedAt,
    matches: Object.fromEntries(stats.matches.entries()),
    totalMatches: totalMatches(),
    walletTxs: stats.walletTxs,
    errors: stats.errors,
    recentMatches: stats.recentMatches,
    recentWalletTxs: stats.recentWalletTxs,
    recentErrors: stats.recentErrors
  };
}

export async function sendErrorSummary() {
  if (errorCounts.size === 0) return;
  const lines = ['<b>⚠️ Hata Ozeti (son 1 saat)</b>', ''];
  const sorted = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [msg, count] of sorted) {
    lines.push(`• <code>${msg}</code> — ${count}x`);
  }
  await sendText(lines.join('\n'), env.TELEGRAM_BOT_INFO_THREAD_ID || env.TELEGRAM_HEARTBEAT_THREAD_ID || env.TELEGRAM_NFT_THREAD_ID);
  errorCounts.clear();
}

function uptimeText() {
  const uptimeHours = ((Date.now() - stats.startedAt) / 3600000).toFixed(1);
  return `${uptimeHours} saat`;
}

function totalMatches() {
  return [...stats.matches.values()].reduce((a, b) => a + b, 0);
}

export async function sendHeartbeat() {
  const totalMatches = [...stats.matches.values()].reduce((a, b) => a + b, 0);
  const matchLines = [...stats.matches.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug, c]) => `  • ${slug}: ${c} match`);

  const lines = [
    '<b>💚 Bot saglikli — gunluk ozet</b>',
    '',
    `<b>Uptime:</b> ${uptimeText()}`,
    `<b>NFT match:</b> ${totalMatches}`,
    ...matchLines,
    `<b>Wallet tx:</b> ${stats.walletTxs}`,
    `<b>Hata:</b> ${stats.errors}`
  ];
  await sendText(lines.join('\n'), env.TELEGRAM_BOT_INFO_THREAD_ID || env.TELEGRAM_HEARTBEAT_THREAD_ID || env.TELEGRAM_NFT_THREAD_ID);
  log.info('Heartbeat gonderildi');
}

export async function sendBotInfoStatus(reason = 'periyodik') {
  const lines = [
    '<b>🤖 Bot info</b>',
    '',
    `<b>Durum:</b> calisiyor (${reason})`,
    `<b>Uptime:</b> ${uptimeText()}`,
    `<b>NFT match:</b> ${totalMatches()}`,
    `<b>Wallet tx:</b> ${stats.walletTxs}`,
    `<b>Hata:</b> ${stats.errors}`,
    `<b>State:</b> ${seenOrderHashes.size} order / ${processedTransfers.size} tx`
  ];
  await sendText(lines.join('\n'), env.TELEGRAM_BOT_INFO_THREAD_ID || env.TELEGRAM_HEARTBEAT_THREAD_ID || env.TELEGRAM_NFT_THREAD_ID);
}

let errorTimer = null;
let heartbeatTimer = null;
let botInfoTimer = null;

function scheduleNextHeartbeat() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(env.HEARTBEAT_HOUR, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delayMs = target - now;
  heartbeatTimer = setTimeout(async () => {
    try { await sendHeartbeat(); } catch (e) { log.error(`Heartbeat fail: ${e.message}`); }
    scheduleNextHeartbeat();
  }, delayMs);
  log.info(`Sonraki heartbeat: ${target.toLocaleString()}`);
}

export function startBackgroundJobs() {
  if (env.DRY_RUN) {
    log.info('[dry-run] Background jobs disabled');
    return;
  }
  // Saatte bir hata ozeti
  errorTimer = setInterval(() => {
    sendErrorSummary().catch(e => log.error(`Hata ozeti fail: ${e.message}`));
  }, env.ERROR_SUMMARY_INTERVAL_MS);

  // Gunluk heartbeat
  scheduleNextHeartbeat();

  // Bot info topic: 10 dakikada bir canlilik/status bildirimi
  botInfoTimer = setInterval(() => {
    sendBotInfoStatus('10 dk status').catch(e => log.error(`Bot info fail: ${e.message}`));
  }, env.BOT_INFO_INTERVAL_MS);
}

export function stopBackgroundJobs() {
  if (errorTimer) clearInterval(errorTimer);
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  if (botInfoTimer) clearInterval(botInfoTimer);
}
