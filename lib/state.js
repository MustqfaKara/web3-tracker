// Kalici state: seenOrderHashes, processedTransfers, notifiedRevealStarts,
// notifiedTradingOpens. JSON dosyasinda tutulur, periyodik kaydedilir.
// Bot restart oldugunda gecmis bildirimler tekrar atilmaz.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('state');
const STATE_DIR = path.join(process.cwd(), 'state');
const STATE_FILE = path.join(STATE_DIR, 'persistent.json');
const MAX_ITEMS_PER_SET = 10000;
const MAX_REVEAL_ITEMS = 1000;
const SAVE_DEBOUNCE_MS = 5000;

// Singleton Set'ler — modullerden direkt import edilir
export const seenOrderHashes = new Set();
export const processedTransfers = new Set();
export const notifiedRevealStarts = new Set();
export const notifiedTradingOpens = new Set();

// FIFO eviction'li ekleme: kapasiteyi astiginda en eski elemani siler
export function addToSetCapped(set, key, cap = MAX_ITEMS_PER_SET) {
  if (set.has(key)) return;
  if (set.size >= cap) set.delete(set.values().next().value);
  set.add(key);
  scheduleSave();
}

// Map versiyonu — trait/floor cache'leri icin
export function setMapCapped(map, key, value, cap = 5000) {
  if (!map.has(key) && map.size >= cap) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

export function loadState() {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const data = JSON.parse(raw);
      (data.seenOrderHashes || []).forEach(k => seenOrderHashes.add(k));
      (data.processedTransfers || []).forEach(k => processedTransfers.add(k));
      (data.notifiedRevealStarts || []).forEach(k => notifiedRevealStarts.add(k));
      (data.notifiedTradingOpens || []).forEach(k => notifiedTradingOpens.add(k));
      log.info(`Yuklendi: ${seenOrderHashes.size} order, ${processedTransfers.size} tx, ${notifiedRevealStarts.size} reveal, ${notifiedTradingOpens.size} trading`);
    } else {
      log.info('State dosyasi yok, temiz baslat');
    }
  } catch (e) {
    log.warn(`State load failed: ${e.message} (temiz baslat)`);
  }
}

export function saveNow() {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const data = {
      seenOrderHashes: Array.from(seenOrderHashes).slice(-MAX_ITEMS_PER_SET),
      processedTransfers: Array.from(processedTransfers).slice(-MAX_ITEMS_PER_SET),
      notifiedRevealStarts: Array.from(notifiedRevealStarts).slice(-MAX_REVEAL_ITEMS),
      notifiedTradingOpens: Array.from(notifiedTradingOpens).slice(-MAX_REVEAL_ITEMS),
      savedAt: new Date().toISOString()
    };
    // Atomik yazim: once tmp, sonra rename
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.error(`State save failed: ${e.message}`);
  }
}

// Kapanis hook'lari — SIGINT/SIGTERM aldiginda state'i flush et
let exiting = false;
function gracefulExit(signal) {
  if (exiting) return;
  exiting = true;
  log.info(`${signal} alindi, state kaydediliyor...`);
  if (saveTimer) clearTimeout(saveTimer);
  saveNow();
  process.exit(0);
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
