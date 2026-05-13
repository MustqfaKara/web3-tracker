// OpenSea Stream API client — WebSocket ile listing event'leri
// Heartbeat: belirli sure event gelmezse poll fallback'e tetikleniyor
import { LogLevel, OpenSeaStreamClient, Network } from '@opensea/stream-js';
import { WebSocket } from 'ws';
import { env } from './config.js';
import { handleListing } from './listing.js';
import { recordError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('stream');

let lastEventAt = Date.now();
let heartbeatTimer = null;
const activeConfigs = new Map();
const subscribedSlugs = new Set();
let streamClient = null;
let streamMode = 'stopped';

function subscribeConfig(client, config) {
  if (!client || subscribedSlugs.has(config.slug)) return;
  subscribedSlugs.add(config.slug);
  client.onItemListed(config.slug, (event) => {
    const current = activeConfigs.get(config.slug);
    if (!current) return;
    lastEventAt = Date.now();
    handleListing(event, current).catch(err => {
      log.error(`handleListing ${config.slug}: ${err.message}`);
      recordError('handleListing', err, { slug: config.slug });
    });
  });
  log.info(`Stream watch: ${config.slug}`);
}

function streamErrorMessage(error) {
  const m = error?.message || error?.toString?.() || '';
  const n = error?.error?.message || error?.target?._error?.message || '';
  return `${m} ${n}`.trim();
}

// Stream'i baslat. onFallback callback'i heartbeat veya kalici hata
// durumunda cagrilir; bu durumda app.js poll moduna gecmeli.
export function startStream(configs, onFallback) {
  let switchedToPoll = false;
  let client = null;

  function fallback(reason) {
    if (switchedToPoll) return;
    switchedToPoll = true;
    streamMode = 'fallback';
    try { client?.disconnect?.(); } catch { /* ignore */ }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    log.warn(`Stream'den poll'a gecis: ${reason}`);
    onFallback?.(reason);
  }

  client = new OpenSeaStreamClient({
    network: Network.MAINNET,
    token: env.OPENSEA_API_KEY,
    logLevel: LogLevel.ERROR,
    onError: (error) => {
      const msg = streamErrorMessage(error);
      recordError('stream', error);
      if (msg.includes('403')) {
        log.error('OpenSea Stream 403 — API key Stream API erisimine sahip degil');
        if (env.WATCH_MODE === 'auto') fallback('stream 403');
        return;
      }
      if (/50[234]/.test(msg)) {
        log.error(`OpenSea Stream 5xx (${msg})`);
        if (env.WATCH_MODE === 'auto') fallback('stream 5xx');
        return;
      }
      log.error(msg || 'socket error');
    },
    connectOptions: { transport: WebSocket }
  });
  streamClient = client;
  streamMode = 'stream';

  for (const config of configs) {
    activeConfigs.set(config.slug, config);
    subscribeConfig(client, config);
  }

  // Heartbeat: STREAM_HEARTBEAT_TIMEOUT_MS sure event gelmezse fallback
  // (stream sessizce olabilir, error vermez)
  heartbeatTimer = setInterval(() => {
    const gap = Date.now() - lastEventAt;
    if (gap > env.STREAM_HEARTBEAT_TIMEOUT_MS) {
      log.warn(`Heartbeat timeout (${Math.round(gap / 1000)}s event yok), fallback`);
      fallback('heartbeat timeout');
    }
  }, 60000);

  log.info('OpenSea Stream API kullaniliyor');
  return client;
}

export function updateStreamConfigs(configs) {
  activeConfigs.clear();
  for (const config of configs) {
    activeConfigs.set(config.slug, config);
    subscribeConfig(streamClient, config);
  }
}

export function getStreamStatus() {
  return {
    mode: streamMode,
    lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
    subscribedSlugs: [...subscribedSlugs],
    activeSlugs: [...activeConfigs.keys()]
  };
}
