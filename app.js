// Web3 Tracker — slim orchestrator. Tum is mantigi lib/*.js icinde.
// CLI flag'leri: --once (tek poll), --dry-run (bildirim atma), --debug (verbose log)
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { env, parseCliFlags } from './lib/config.js';
import { loadState, saveNow } from './lib/state.js';
import { createLogger } from './lib/logger.js';
import { startWalletWatcher } from './lib/wallet.js';
import { startStream, updateStreamConfigs } from './lib/stream.js';
import { startPolling, runOnce } from './lib/poll.js';
import { sendBotInfoStatus, startBackgroundJobs } from './lib/errors.js';
import { sendText } from './lib/telegram.js';
import { initCollectionStore, onCollectionsChanged, startCollectionHotReload } from './lib/collections.js';
import { startDashboard } from './lib/dashboard.js';

const log = createLogger('app');

function summarizeConfig(c) {
  const filter = Array.isArray(c.traitValues) && c.traitValues.length
    ? c.traitValues.join('/')
    : c.traitValue
      ? c.traitValue
      : `${c.traitMin || 0}-${c.traitMax || '∞'}`;
  const priceDesc = c.maxPriceEth !== undefined
    ? `<= ${c.maxPriceEth} ETH`
    : c.maxPriceRelativeToFloor
      ? `<= floor * ${c.maxPriceRelativeToFloor}`
      : '(limitsiz)';
  return `${c.slug}: ${c.traitType || '(her trait)'} = ${filter}, ${priceDesc}`;
}

async function main() {
  const flags = parseCliFlags();
  const configs = initCollectionStore();

  const modeTags = [];
  if (env.DRY_RUN) modeTags.push('DRY-RUN');
  if (flags.once) modeTags.push('--once');
  if (env.DEBUG) modeTags.push('DEBUG');
  log.info(`Baslat | mod: ${modeTags.length ? modeTags.join(' ') + ' | ' : ''}WATCH_MODE=${env.WATCH_MODE}`);

  loadState();

  if (configs.length > 0 && !env.OPENSEA_API_KEY) {
    log.error('OPENSEA_API_KEY eksik');
    process.exit(1);
  }

  for (const c of configs) log.info(`  ${summarizeConfig(c)}`);

  // Cuzdan takibi her durumda baslayabilir (configs olmasa bile)
  startWalletWatcher();

  // Background: error summary + heartbeat
  startBackgroundJobs();
  startCollectionHotReload();
  startDashboard();

  // --once: tek poll yapip cik
  if (flags.once) {
    if (configs.length === 0) {
      log.warn('Hicbir koleksiyon aktif, --once cikis');
      saveNow();
      process.exit(0);
    }
    await runOnce(configs);
    saveNow();
    process.exit(0);
  }

  if (configs.length === 0 && !env.OPENSEA_API_KEY) {
    log.info('Aktif NFT koleksiyonu yok — sadece wallet/dashboard calisiyor');
    return;
  }
  if (configs.length === 0) log.info('Aktif NFT koleksiyonu yok — hot-reload icin watcher bos basliyor');

  // Stream veya poll modu
  if (env.WATCH_MODE === 'poll') {
    startPolling(configs, 'WATCH_MODE=poll');
  } else {
    startStream(configs, (reason) => startPolling(configs, reason));
    onCollectionsChanged((next) => updateStreamConfigs(next));
  }

  // Baslangic Telegram bildirimi (DRY_RUN'da atilir)
  if (!env.DRY_RUN) {
    sendText(
      `✅ Bot aktif (${configs.length} koleksiyon takipte, ${env.WALLET_ADDRESSES.length} cuzdan izleniyor)`,
      env.TELEGRAM_BOT_INFO_THREAD_ID || env.TELEGRAM_HEARTBEAT_THREAD_ID || env.TELEGRAM_NFT_THREAD_ID
    ).catch(() => { /* sessiz */ });
    sendBotInfoStatus('bot basladi').catch(() => { /* sessiz */ });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    log.error(`main fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}
