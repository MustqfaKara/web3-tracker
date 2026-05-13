// Runtime collection store + hot reload. Dashboard JSON yazar, bot restart etmeden alir.
import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS_DIR, loadCollections, validate } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('collections');

const configs = [];
const allConfigs = [];
const listeners = new Set();
let watcher = null;
let reloadTimer = null;
let lastReloadAt = null;
let lastError = null;

function replaceConfigs(next) {
  configs.splice(0, configs.length, ...next);
}

function loadAllCollectionConfigs() {
  const results = [];
  if (!fs.existsSync(COLLECTIONS_DIR)) return results;
  const files = fs.readdirSync(COLLECTIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(COLLECTIONS_DIR, file), 'utf8'));
      if (data.slug) results.push(data);
    } catch (e) {
      log.warn(`${file} parse hatasi: ${e.message}`);
    }
  }
  return results;
}

function replaceAllConfigs(next) {
  allConfigs.splice(0, allConfigs.length, ...next);
}

function notify(change) {
  for (const listener of listeners) {
    try {
      listener(configs, change);
    } catch (e) {
      log.warn(`reload listener failed: ${e.message}`);
    }
  }
}

export function initCollectionStore() {
  replaceAllConfigs(loadAllCollectionConfigs());
  const next = loadCollections();
  validate(next);
  replaceConfigs(next);
  lastReloadAt = new Date().toISOString();
  return configs;
}

export function getCollectionConfigs() {
  return configs;
}

export function getAllCollectionConfigs() {
  return allConfigs;
}

export function getCollectionStoreStatus() {
  return {
    count: configs.length,
    totalCount: allConfigs.length,
    lastReloadAt,
    lastError,
    slugs: configs.map(c => c.slug)
  };
}

export function onCollectionsChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reloadCollections(reason = 'manual') {
  try {
    const before = new Set(configs.map(c => c.slug));
    replaceAllConfigs(loadAllCollectionConfigs());
    const next = loadCollections();
    validate(next);
    replaceConfigs(next);
    const after = new Set(configs.map(c => c.slug));
    const added = [...after].filter(slug => !before.has(slug));
    const removed = [...before].filter(slug => !after.has(slug));
    lastReloadAt = new Date().toISOString();
    lastError = null;
    log.info(`Hot reload (${reason}): ${configs.length} aktif koleksiyon`);
    notify({ reason, added, removed, at: lastReloadAt });
    return { ok: true, configs, added, removed };
  } catch (e) {
    lastError = e.message;
    log.error(`Hot reload failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function startCollectionHotReload() {
  if (watcher) return;
  if (!fs.existsSync(COLLECTIONS_DIR)) fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
  watcher = fs.watch(COLLECTIONS_DIR, (eventType, filename) => {
    if (filename && !String(filename).endsWith('.json')) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      reloadCollections(`fs:${eventType}:${filename || 'unknown'}`);
    }, 250);
    reloadTimer.unref?.();
  });
  watcher.unref?.();
  log.info(`Collection hot-reload aktif: ${COLLECTIONS_DIR}`);
}

export function stopCollectionHotReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  if (watcher) watcher.close();
  reloadTimer = null;
  watcher = null;
}

export function collectionFilePath(slug) {
  const safeSlug = String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!safeSlug) throw new Error('slug zorunlu');
  return path.join(COLLECTIONS_DIR, `${safeSlug}.json`);
}

export function writeCollectionConfig(config) {
  validate([config]);
  if (!fs.existsSync(COLLECTIONS_DIR)) fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
  const target = collectionFilePath(config.slug);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, target);
  return reloadCollections(`write:${config.slug}`);
}
