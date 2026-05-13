// Local dashboard: status + collection CRUD. Dis dependency yok, server'a kolay tasinir.
import http from 'node:http';
import { env } from './config.js';
import { getAllCollectionConfigs, getCollectionConfigs, getCollectionStoreStatus, writeCollectionConfig } from './collections.js';
import { getRuntimeStats } from './errors.js';
import { seenOrderHashes, processedTransfers } from './state.js';
import { fetchCollectionTraits, getOpenSeaStatus } from './opensea.js';
import { getPollStatus } from './poll.js';
import { getStreamStatus } from './stream.js';
import { createLogger } from './logger.js';
import { sendText, telegramEscape } from './telegram.js';

const log = createLogger('dashboard');

let server = null;

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(html);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function statusPayload() {
  return {
    now: new Date().toISOString(),
    env: {
      watchMode: env.WATCH_MODE,
      dryRun: env.DRY_RUN,
      pollIntervalMs: env.POLL_INTERVAL_MS,
      dashboardPort: env.DASHBOARD_PORT,
      botInfoThreadId: env.TELEGRAM_BOT_INFO_THREAD_ID
    },
    collections: getAllCollectionConfigs(),
    activeCollections: getCollectionConfigs(),
    collectionStore: getCollectionStoreStatus(),
    runtime: getRuntimeStats(),
    opensea: getOpenSeaStatus(),
    poll: getPollStatus(),
    stream: getStreamStatus(),
    state: {
      seenOrderHashes: seenOrderHashes.size,
      processedTransfers: processedTransfers.size
    }
  };
}

function normalizeCollectionInput(input) {
  const config = {
    slug: String(input.slug || '').trim(),
    name: String(input.name || '').trim() || undefined,
    chain: String(input.chain || 'ethereum').trim() || 'ethereum',
    enabled: input.enabled === false || input.enabled === 'false' || input.enabled === 'off' ? false : true,
    traitMatchMode: String(input.traitMatchMode || 'all').trim() || 'all',
    maxPriceEth: input.maxPriceEth === '' || input.maxPriceEth === undefined ? undefined : Number(input.maxPriceEth),
    maxPriceRelativeToFloor: input.maxPriceRelativeToFloor === '' || input.maxPriceRelativeToFloor === undefined
      ? undefined
      : Number(input.maxPriceRelativeToFloor),
    telegramThreadId: String(input.telegramThreadId || '').trim() || undefined
  };

  if (Array.isArray(input.traitFilters)) {
    const filters = input.traitFilters
      .map(filter => {
        const out = {
          traitType: String(filter.traitType || '').trim()
        };
        const values = Array.isArray(filter.traitValues)
          ? filter.traitValues
          : String(filter.traitValues || '').split(',');
        const cleanValues = values.map(v => String(v).trim()).filter(Boolean);
        if (cleanValues.length) out.traitValues = cleanValues;
        if (filter.traitValue !== undefined && String(filter.traitValue).trim()) out.traitValue = String(filter.traitValue).trim();
        if (filter.traitMin !== '' && filter.traitMin !== undefined) out.traitMin = Number(filter.traitMin);
        if (filter.traitMax !== '' && filter.traitMax !== undefined) out.traitMax = Number(filter.traitMax);
        return out;
      })
      .filter(filter => filter.traitType);
    if (filters.length) config.traitFilters = filters;
  } else {
    config.traitType = String(input.traitType || '').trim() || undefined;
    const traitValues = Array.isArray(input.traitValues)
      ? input.traitValues
      : String(input.traitValues || '').split(',');
    const cleanTraitValues = traitValues.map(v => String(v).trim()).filter(Boolean);
    if (cleanTraitValues.length) config.traitValues = cleanTraitValues;

    if (input.traitValue !== undefined && String(input.traitValue).trim()) {
      config.traitValue = String(input.traitValue).trim();
    }
    if (input.traitMin !== '' && input.traitMin !== undefined) config.traitMin = Number(input.traitMin);
    if (input.traitMax !== '' && input.traitMax !== undefined) config.traitMax = Number(input.traitMax);
  }

  const limits = {};
  const rawLimits = input.traitPriceLimits || {};
  if (typeof rawLimits === 'string') {
    for (const part of rawLimits.split(',')) {
      const [trait, value] = part.split(':').map(s => s?.trim());
      if (trait && value !== undefined && value !== '') limits[trait] = Number(value);
    }
  } else if (rawLimits && typeof rawLimits === 'object') {
    for (const [trait, value] of Object.entries(rawLimits)) {
      if (trait && value !== '') limits[trait] = Number(value);
    }
  }
  if (Object.keys(limits).length) config.traitPriceLimits = limits;

  for (const key of Object.keys(config)) {
    if (config[key] === undefined || config[key] === '') delete config[key];
  }
  return config;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, statusPayload());
  }
  if (req.method === 'GET' && url.pathname === '/api/collections') {
    return sendJson(res, 200, { collections: getAllCollectionConfigs(), activeCollections: getCollectionConfigs() });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/traits/')) {
    try {
      const slug = decodeURIComponent(url.pathname.slice('/api/traits/'.length));
      const traits = await fetchCollectionTraits(slug, { force: url.searchParams.get('force') === '1' });
      return sendJson(res, 200, { ok: true, ...traits });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/collections') {
    try {
      const body = await readJson(req);
      const config = normalizeCollectionInput(body);
      const previous = getAllCollectionConfigs().find(c => c.slug === config.slug);
      const result = writeCollectionConfig(config);
      if (!result.ok) return sendJson(res, 400, result);
      const previousEnabled = previous ? previous.enabled !== false : null;
      const currentEnabled = config.enabled !== false;
      if (previous && previousEnabled !== currentEnabled) {
        const label = config.name || previous.name || config.slug;
        const stateText = currentEnabled ? 'acildi' : 'kapatildi';
        sendText(
          `${currentEnabled ? '🔔' : '🔕'} <b>${telegramEscape(label)}</b> bildirimleri ${stateText}`,
          env.TELEGRAM_BOT_INFO_THREAD_ID || env.TELEGRAM_HEARTBEAT_THREAD_ID || env.TELEGRAM_NFT_THREAD_ID
        ).catch(e => log.warn(`toggle Telegram fail: ${e.message}`));
      }
      return sendJson(res, 200, { ok: true, config, collections: getAllCollectionConfigs(), activeCollections: getCollectionConfigs() });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}

export function startDashboard() {
  if (!env.DASHBOARD_ENABLED || server) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname.startsWith('/collections/')) {
      sendHtml(res, dashboardHtml());
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  });
  server.listen(env.DASHBOARD_PORT, env.DASHBOARD_HOST, () => {
    log.info(`Dashboard: http://${env.DASHBOARD_HOST}:${env.DASHBOARD_PORT}`);
  });
}

export function stopDashboard() {
  if (server) server.close();
  server = null;
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Web3 Tracker</title>
  <style>
    :root { color-scheme: dark; --bg: #000; --fg: #fff; --muted: rgba(255,255,255,.62); --line: rgba(255,255,255,.18); --line-strong: rgba(255,255,255,.34); --soft: rgba(255,255,255,.08); --softer: rgba(255,255,255,.045); --field: rgba(255,255,255,.095); }
    * { box-sizing: border-box; }
    body { margin: 0; background: #000; color: var(--fg); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    button, input, select, textarea { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 280px minmax(0, 1fr); }
    aside { border-right: 1px solid var(--line); padding: 24px; position: sticky; top: 0; height: 100vh; background: #000; display: flex; flex-direction: column; }
    main { padding: 26px; display: grid; gap: 20px; align-content: start; max-width: 1500px; width: 100%; }
    h1 { margin: 0 0 6px; font-size: 25px; font-weight: 850; }
    h2 { margin: 0 0 12px; font-size: 15px; font-weight: 780; }
    .muted { color: var(--muted); }
    .topline { display: flex; justify-content: space-between; align-items: end; gap: 16px; border-bottom: 1px solid var(--line); padding-bottom: 18px; }
    .eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 760; }
    .nav { display: grid; gap: 8px; margin-top: 28px; }
    .nav button, .primary, .ghost { border: 1px solid var(--line); color: var(--fg); background: var(--field); border-radius: 8px; min-height: 40px; padding: 0 13px; cursor: pointer; transition: border-color .16s ease, background .16s ease, color .16s ease; }
    .nav button { text-align: left; }
    .nav button.active, .primary { background: #fff; color: #000; border-color: #fff; font-weight: 780; }
    .ghost { background: rgba(255,255,255,.055); }
    .ghost:hover, .nav button:hover { border-color: var(--line-strong); background: rgba(255,255,255,.12); }
    .primary:hover { background: rgba(255,255,255,.86); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 12px; }
    .metric, .panel, .row { border: 1px solid var(--line); background: var(--softer); border-radius: 8px; }
    .metric { padding: 16px; min-height: 92px; display: grid; align-content: space-between; }
    .metric strong { display: block; font-size: 30px; line-height: 1.05; }
    .panel { padding: 18px; }
    .split { display: grid; grid-template-columns: minmax(320px, .78fr) minmax(520px, 1.22fr); gap: 16px; align-items: start; }
    .rows { display: grid; gap: 9px; }
    .row { padding: 13px; display: grid; gap: 5px; }
    .row[data-slug] { cursor: pointer; }
    .row[data-slug]:hover { background: var(--soft); border-color: rgba(255,255,255,.42); }
    .rowhead { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    code, .pill { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; color: var(--fg); background: rgba(255,255,255,.07); }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; color: var(--muted); font-size: 12px; font-weight: 650; }
    input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); background: var(--field); min-height: 40px; padding: 9px 11px; outline: none; }
    textarea { min-height: 82px; resize: vertical; }
    input::placeholder, textarea::placeholder { color: rgba(255,255,255,.4); }
    input:focus, textarea:focus, select:focus { border-color: #fff; background: rgba(255,255,255,.13); }
    .twocol { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .threecol { display: grid; grid-template-columns: 1fr 150px 1fr; gap: 12px; }
    .form-section { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: rgba(255,255,255,.035); display: grid; gap: 12px; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 2px; }
    .section-title h2 { margin: 0; }
    .editor-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .switch { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
    .switch input { display: none; }
    .slider { width: 42px; height: 24px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,.08); position: relative; transition: background .16s ease, border-color .16s ease; }
    .slider::after { content: ''; width: 18px; height: 18px; border-radius: 999px; background: #fff; position: absolute; left: 2px; top: 2px; transition: transform .16s ease; }
    .switch input:checked + .slider { background: #fff; border-color: #fff; }
    .switch input:checked + .slider::after { transform: translateX(18px); background: #000; }
    .watchlist { display: grid; gap: 10px; }
    .watch-item { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.04); padding: 14px; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 12px; align-items: center; cursor: pointer; }
    .watch-item:hover, .watch-item.active { border-color: var(--line-strong); background: rgba(255,255,255,.08); }
    .watch-name { font-size: 15px; font-weight: 800; display: flex; align-items: center; gap: 8px; min-width: 0; }
    .watch-meta { color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mini-switch { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
    .mini-switch input { display: none; }
    .mini-switch .slider { width: 46px; height: 26px; }
    .mini-switch .slider::after { width: 20px; height: 20px; }
    .mini-switch input:checked + .slider::after { transform: translateX(20px); }
    .setup-strip { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: end; }
    .selected-box { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.035); padding: 12px; display: grid; gap: 8px; }
    .selected-chips { display: flex; gap: 8px; flex-wrap: wrap; min-height: 34px; align-items: center; }
    .selected-chip { display: inline-flex; align-items: center; gap: 8px; border: 1px solid #fff; background: #fff; color: #000; border-radius: 999px; min-height: 32px; padding: 0 10px; font-weight: 760; }
    .selected-chip button { border: 0; background: rgba(0,0,0,.12); color: #000; border-radius: 999px; width: 20px; height: 20px; cursor: pointer; }
    .empty-state { border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); padding: 12px; }
    .trait-library { border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.035); padding: 12px; display: grid; gap: 10px; }
    .trait-search { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    .trait-types, .trait-values { display: flex; gap: 7px; flex-wrap: wrap; max-height: 150px; overflow: auto; padding-right: 2px; }
    .trait-chip { border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,.07); color: var(--fg); min-height: 30px; padding: 0 10px; cursor: pointer; }
    .trait-chip:hover { border-color: var(--line-strong); background: rgba(255,255,255,.13); }
    .trait-chip.active { background: #fff; color: #000; border-color: #fff; font-weight: 780; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: rgba(255,255,255,.35); margin-right: 6px; }
    .status-dot.on { background: #fff; }
    .filter-row { border: 1px solid var(--line); background: rgba(255,255,255,.055); border-radius: 8px; padding: 13px; display: grid; gap: 12px; }
    .filter-row:hover { border-color: var(--line-strong); }
    .filter-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .filter-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .filter-summary { color: var(--muted); font-size: 12px; }
    .rule-index { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; background: #fff; color: #000; font-size: 12px; font-weight: 800; }
    .filter-grid { display: grid; grid-template-columns: minmax(170px, 1fr) minmax(0, 1.2fr); gap: 12px; align-items: end; }
    .range-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .segmented { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: rgba(255,255,255,.055); }
    .segmented button { min-height: 38px; border: 0; border-right: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
    .segmented button:last-child { border-right: 0; }
    .segmented button.active { background: #fff; color: #000; font-weight: 780; }
    .quick-traits { display: flex; gap: 7px; flex-wrap: wrap; }
    .quick-traits button { min-height: 30px; border-radius: 999px; border: 1px solid var(--line); color: var(--fg); background: rgba(255,255,255,.07); padding: 0 10px; cursor: pointer; }
    .quick-traits button:hover { border-color: var(--line-strong); background: rgba(255,255,255,.13); }
    .rule-preview { border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px; color: var(--muted); background: rgba(0,0,0,.32); }
    .rule-preview strong { color: var(--fg); }
    .actionbar { position: sticky; bottom: 0; border: 1px solid var(--line); border-radius: 8px; background: rgba(0,0,0,.92); padding: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .hidden { display: none; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
    .ok { color: #fff; }
    .warn { color: rgba(255,255,255,.7); }
    @media (max-width: 1180px) { .filter-grid { grid-template-columns: 1fr; } .split { grid-template-columns: 1fr; } }
    @media (max-width: 980px) { .shell { grid-template-columns: 1fr; } aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); } .grid, .split, .twocol, .threecol { grid-template-columns: 1fr; } main { padding: 18px; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Web3 Tracker</h1>
      <div class="muted">OpenSea + wallet monitor</div>
      <div class="nav">
        <button class="active" data-tab="overview">Overview</button>
        <button data-tab="collections">Collections</button>
        <button data-tab="activity">Activity</button>
      </div>
      <div class="muted" style="margin-top:auto">Local control panel</div>
    </aside>
    <main>
      <section id="overview">
        <div class="topline">
          <div>
            <div class="eyebrow">Live Operations</div>
            <h1>Tracker status</h1>
          </div>
          <span class="pill" id="modePill">-</span>
        </div>
        <div class="grid">
          <div class="metric"><span class="muted">Collections</span><strong id="mCollections">-</strong></div>
          <div class="metric"><span class="muted">NFT Match</span><strong id="mMatches">-</strong></div>
          <div class="metric"><span class="muted">Wallet Tx</span><strong id="mWallet">-</strong></div>
          <div class="metric"><span class="muted">OpenSea 429</span><strong id="m429">-</strong></div>
        </div>
        <div class="panel" style="margin-top:14px">
          <h2>Runtime</h2>
          <div id="runtime" class="rows"></div>
        </div>
      </section>

      <section id="collections" class="hidden">
        <div class="topline">
          <div>
            <div class="eyebrow">Collection Rules</div>
            <h1>NFT alert filters</h1>
          </div>
          <span class="pill">Hot reload enabled</span>
        </div>
        <div class="split">
          <div class="panel">
            <div class="section-title">
              <h2>Watchlist</h2>
              <button class="primary" id="newCollectionBtn" type="button">New Collection</button>
            </div>
            <div id="collectionRows" class="watchlist"></div>
          </div>
          <div class="panel">
            <div class="editor-title">
              <div>
                <div class="eyebrow">Rule Editor</div>
                <h2 id="editorHeading">Collection Page</h2>
              </div>
              <span class="pill" id="editorState">Ready</span>
            </div>
            <form id="collectionForm">
              <div class="form-section">
                <div class="section-title">
                  <div>
                    <h2>Setup</h2>
                    <div class="muted">Paste an OpenSea URL once; traits load from OpenSea.</div>
                  </div>
                  <label class="switch"><input name="enabled" type="checkbox" checked><span class="slider"></span><span>Notifications</span></label>
                </div>
                <div class="setup-strip">
                  <label>OpenSea URL or slug <input id="collectionLookup" placeholder="https://opensea.io/collection/the-florentines?status=all"></label>
                  <button class="primary" id="fetchTraitsBtn" type="button">Load Traits</button>
                </div>
                <div class="twocol">
                  <label>Slug <input name="slug" placeholder="the-florentines" required></label>
                  <label>Name <input name="name" placeholder="The Florentines"></label>
                </div>
                <div class="twocol">
                  <label>Chain <select name="chain"><option>ethereum</option><option>base</option></select></label>
                  <label>Telegram Thread <input name="telegramThreadId" placeholder="45"></label>
                </div>
              </div>
              <div class="form-section">
                <div class="section-title">
                  <div>
                    <h2>Pick Traits</h2>
                    <div class="muted">Choose values below. Selected chips become alert filters.</div>
                  </div>
                  <button class="ghost" id="addRangeBtn" type="button">Add Rarity Range</button>
                </div>
                <label>Match Mode
                  <select name="traitMatchMode">
                    <option value="all">All selected filters must match</option>
                    <option value="any">Any selected filter can match</option>
                  </select>
                </label>
                <div class="trait-library">
                  <div class="muted" id="traitLibraryStatus">Open a collection or fetch traits to browse OpenSea trait data.</div>
                  <div class="trait-types" id="traitTypeChips"></div>
                  <div class="trait-values" id="traitValueChips"></div>
                </div>
                <div class="selected-box">
                  <div class="section-title"><h2>Selected Filters</h2><span class="pill" id="filterCount">0 filters</span></div>
                  <div class="selected-chips" id="selectedFilters"></div>
                  <div id="filterRows" class="hidden"></div>
                  <div class="muted" id="ruleSetSummary">No active rules</div>
                </div>
              </div>
              <div class="form-section">
                <div class="section-title"><h2>Pricing</h2></div>
                <div class="twocol">
                  <label>Max Price ETH <input name="maxPriceEth" type="number" step="any" placeholder="0.1"></label>
                  <label>Max Floor Multiplier <input name="maxPriceRelativeToFloor" type="number" step="any" placeholder="1.2"></label>
                </div>
                <label>Trait Price Limits <textarea name="traitPriceLimits" placeholder="Lord:0.2, Noble:0.02, Merchant:0.01"></textarea></label>
              </div>
              <div class="actionbar">
                <div id="formMsg" class="muted"></div>
                <div class="toolbar"><button class="ghost" type="reset">Clear</button><button class="primary" type="submit">Save Collection</button></div>
              </div>
            </form>
          </div>
        </div>
      </section>

      <section id="activity" class="hidden">
        <div class="topline">
          <div>
            <div class="eyebrow">Recent Events</div>
            <h1>Activity feed</h1>
          </div>
        </div>
        <div class="split">
          <div class="panel"><h2>Recent Matches</h2><div id="matches" class="rows"></div></div>
          <div class="panel"><h2>Recent Wallet / Errors</h2><div id="events" class="rows"></div></div>
        </div>
      </section>
    </main>
  </div>
  <script>
    let latest = null;
    let traitLibrary = null;
    let selectedTraitType = null;
    const $ = (s) => document.querySelector(s);
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    function row(title, sub, right = '', attrs = '') { return '<div class="row" ' + attrs + '><div class="rowhead"><b>' + esc(title) + '</b><span class="muted">' + esc(right) + '</span></div><div class="muted">' + esc(sub) + '</div></div>'; }
    function fmtMs(ms) { const m = Math.floor(ms / 60000); if (m < 60) return m + 'm'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
    async function load() {
      const res = await fetch('/api/status');
      latest = await res.json();
      render();
    }
    function render() {
      $('#mCollections').textContent = latest.collections.length;
      $('#mMatches').textContent = latest.runtime.totalMatches;
      $('#mWallet').textContent = latest.runtime.walletTxs;
      $('#m429').textContent = latest.opensea.total429;
      $('#modePill').textContent = latest.env.watchMode + (latest.env.dryRun ? ' / dry-run' : '');
      $('#runtime').innerHTML = [
        row('Uptime', fmtMs(latest.runtime.uptimeMs), latest.env.watchMode),
        row('Poll', 'interval ' + latest.poll.currentInterval + 'ms' + (latest.poll.lastPollError ? ' / ' + latest.poll.lastPollError : ''), latest.poll.lastPollAt || '-'),
        row('Stream', 'active: ' + latest.stream.activeSlugs.join(', '), latest.stream.mode),
        row('State', latest.state.seenOrderHashes + ' orders / ' + latest.state.processedTransfers + ' tx', latest.collectionStore.lastReloadAt || '-')
      ].join('');
      $('#collectionRows').innerHTML = latest.collections.map(c => watchItem(c)).join('') || '<div class="empty-state">Add your first collection.</div>';
      document.querySelectorAll('.watch-item').forEach(el => el.addEventListener('click', () => openCollectionPage(el.dataset.slug)));
      document.querySelectorAll('[data-toggle-slug]').forEach(input => input.addEventListener('click', e => e.stopPropagation()));
      document.querySelectorAll('[data-toggle-slug]').forEach(input => input.addEventListener('change', e => toggleCollection(e.target.dataset.toggleSlug, e.target.checked)));
      $('#matches').innerHTML = latest.runtime.recentMatches.map(m => row(m.name || m.slug, (m.price || '') + ' ' + (m.symbol || '') + ' / ' + (m.traitType || 'any') + ': ' + (m.traitValue ?? 'any'), m.slug)).join('') || row('No matches yet', 'Waiting for listings');
      const walletRows = latest.runtime.recentWalletTxs.map(w => row(w.wallet || 'wallet', w.hash || '', w.network || ''));
      const errorRows = latest.runtime.recentErrors.map(e => row(e.category, e.message, e.at));
      $('#events').innerHTML = walletRows.concat(errorRows).join('') || row('No events yet', 'Clean slate');
    }
    function describeCollection(c) {
      const filters = filtersFromCollection(c);
      const traits = filters.length ? filters.map(f => {
        const v = f.traitValues?.length ? f.traitValues.join('|') : f.traitValue || ((f.traitMin || f.traitMax) ? (f.traitMin || 0) + '-' + (f.traitMax || '∞') : 'any');
        return (f.traitType || 'trait') + '=' + v;
      }).join(' + ') : 'broad';
      const price = c.maxPriceEth !== undefined ? '<= ' + c.maxPriceEth + ' ETH' : (c.maxPriceRelativeToFloor ? '<= floor * ' + c.maxPriceRelativeToFloor : 'no price cap');
      return traits + ' / ' + price;
    }
    function watchItem(c) {
      const isOn = c.enabled !== false;
      return '<div class="watch-item" data-slug="' + esc(c.slug) + '">' +
        '<div><div class="watch-name"><span class="status-dot ' + (isOn ? 'on' : '') + '"></span>' + esc(c.name || c.slug) + '</div><div class="watch-meta">' + esc(describeCollection(c)) + '</div></div>' +
        '<label class="mini-switch"><input data-toggle-slug="' + esc(c.slug) + '" type="checkbox" ' + (isOn ? 'checked' : '') + '><span class="slider"></span></label>' +
        '</div>';
    }
    function filtersFromCollection(c) {
      if (Array.isArray(c.traitFilters) && c.traitFilters.length) return c.traitFilters;
      if (c.traitType || c.traitValues?.length || c.traitValue || c.traitMin !== undefined || c.traitMax !== undefined) {
        return [{ traitType: c.traitType, traitValues: c.traitValues, traitValue: c.traitValue, traitMin: c.traitMin, traitMax: c.traitMax }];
      }
      return [];
    }
    function slugFromInput(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        const u = new URL(raw);
        const parts = u.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('collection');
        if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
      } catch { /* slug */ }
      return raw.replace(/^https?:\\/\\/opensea\\.io\\/collection\\//, '').split(/[?#/]/)[0].trim();
    }
    async function fetchTraitLibrary(force = false) {
      const form = $('#collectionForm');
      const slug = slugFromInput($('#collectionLookup').value || form.slug.value);
      if (!slug) {
        $('#traitLibraryStatus').textContent = 'Enter an OpenSea URL or collection slug first.';
        return;
      }
      form.slug.value = slug;
      $('#collectionLookup').value = slug;
      $('#traitLibraryStatus').textContent = 'Fetching traits from OpenSea...';
      $('#traitTypeChips').innerHTML = '';
      $('#traitValueChips').innerHTML = '';
      try {
        const res = await fetch('/api/traits/' + encodeURIComponent(slug) + (force ? '?force=1' : ''));
        const body = await res.json();
        if (!body.ok) throw new Error(body.error || 'traits fetch failed');
        traitLibrary = body;
        selectedTraitType = body.traits[0]?.traitType || null;
        renderTraitLibrary();
      } catch (e) {
        traitLibrary = null;
        selectedTraitType = null;
        $('#traitLibraryStatus').textContent = e.message;
      }
    }
    function renderTraitLibrary() {
      const traits = traitLibrary?.traits || [];
      $('#traitLibraryStatus').textContent = traits.length
        ? traits.length + ' trait groups loaded from OpenSea.'
        : 'No traits returned by OpenSea.';
      $('#traitTypeChips').innerHTML = traits.map(t => '<button type="button" class="trait-chip ' + (t.traitType === selectedTraitType ? 'active' : '') + '" data-trait-type="' + esc(t.traitType) + '">' + esc(t.traitType) + '</button>').join('');
      document.querySelectorAll('[data-trait-type]').forEach(btn => btn.addEventListener('click', () => {
        selectedTraitType = btn.dataset.traitType;
        renderTraitLibrary();
      }));
      const selected = traits.find(t => t.traitType === selectedTraitType);
      $('#traitValueChips').innerHTML = (selected?.values || []).slice(0, 80).map(v => '<button type="button" class="trait-chip" data-trait-value="' + esc(v.value) + '">' + esc(v.value) + (v.count ? ' · ' + esc(v.count) : '') + '</button>').join('');
      document.querySelectorAll('[data-trait-value]').forEach(btn => btn.addEventListener('click', () => {
        addValueFilter(selectedTraitType, btn.dataset.traitValue);
      }));
    }
    function addValueFilter(traitType, value) {
      if (!traitType || !value) return;
      const existing = [...document.querySelectorAll('.filter-row')].find(row =>
        row.querySelector('[data-filter="traitType"]').value.trim().toLowerCase() === traitType.toLowerCase() &&
        row.querySelector('[data-filter="mode"]').value === 'values'
      );
      if (existing) {
        const input = existing.querySelector('[data-filter="traitValues"]');
        const values = input.value.split(',').map(v => v.trim()).filter(Boolean);
        if (!values.some(v => v.toLowerCase() === value.toLowerCase())) values.push(value);
        input.value = values.join(', ');
        refreshFilterMeta();
        return;
      }
      addFilterRow({ traitType, traitValues: [value] });
    }
    function addFilterRow(filter = {}) {
      const wrap = document.createElement('div');
      wrap.className = 'filter-row';
      wrap.innerHTML = '<div class="filter-head"><div><div class="filter-title"><span class="rule-index">Rule</span><b class="rule-name">Trait condition</b></div><div class="filter-summary">Waiting for trait</div></div><button class="ghost remove-filter" type="button">Remove</button></div>' +
        '<div class="filter-grid">' +
        '<label>Trait Type <input data-filter="traitType" placeholder="Tier, Background, Rarity Rank"></label>' +
        '<div><label>Mode</label><div class="segmented"><button type="button" data-mode-btn="values">Values</button><button type="button" data-mode-btn="range">Range</button></div><input type="hidden" data-filter="mode"></div>' +
        '</div>' +
        '<div class="values-area"><label>Allowed Values <input data-filter="traitValues" placeholder="Lord, Noble, Merchant"></label></div>' +
        '<div class="range-area"><div class="range-grid"><label>Min <input data-filter="traitMin" type="number" step="any" placeholder="1"></label><label>Max <input data-filter="traitMax" type="number" step="any" placeholder="50"></label></div></div>' +
        '<div class="rule-preview"><strong>Preview:</strong> <span data-filter-preview>Any trait</span></div>';
      wrap.querySelector('[data-filter="traitType"]').value = filter.traitType || '';
      wrap.querySelector('[data-filter="traitValues"]').value = (filter.traitValues || (filter.traitValue ? [filter.traitValue] : [])).join(', ');
      wrap.querySelector('[data-filter="traitMin"]').value = filter.traitMin ?? '';
      wrap.querySelector('[data-filter="traitMax"]').value = filter.traitMax ?? '';
      const initialMode = (filter.traitMin !== undefined || filter.traitMax !== undefined) ? 'range' : 'values';
      setFilterMode(wrap, initialMode);
      wrap.querySelector('.remove-filter').addEventListener('click', () => {
        wrap.remove();
        refreshFilterMeta();
      });
      wrap.querySelectorAll('[data-mode-btn]').forEach(btn => {
        btn.addEventListener('click', () => setFilterMode(wrap, btn.dataset.modeBtn));
      });
      wrap.querySelectorAll('input').forEach(input => {
        input.addEventListener('input', () => refreshFilterMeta());
      });
      $('#filterRows').appendChild(wrap);
      refreshFilterMeta();
    }
    function setFilterMode(row, mode) {
      row.querySelector('[data-filter="mode"]').value = mode;
      row.querySelectorAll('[data-mode-btn]').forEach(btn => btn.classList.toggle('active', btn.dataset.modeBtn === mode));
      row.querySelector('.values-area').classList.toggle('hidden', mode !== 'values');
      row.querySelector('.range-area').classList.toggle('hidden', mode !== 'range');
      refreshFilterMeta();
    }
    function resetFilters(filters = []) {
      $('#filterRows').innerHTML = '';
      if (!filters.length) addFilterRow();
      else filters.forEach(addFilterRow);
      refreshFilterMeta();
    }
    function refreshFilterMeta() {
      const rows = [...document.querySelectorAll('.filter-row')];
      rows.forEach((row, index) => {
        const badge = row.querySelector('.rule-index');
        if (badge) badge.textContent = 'Rule ' + (index + 1);
        const summary = filterSummary(row);
        const name = row.querySelector('.rule-name');
        const preview = row.querySelector('[data-filter-preview]');
        const subtitle = row.querySelector('.filter-summary');
        if (name) name.textContent = summary.name;
        if (preview) preview.textContent = summary.preview;
        if (subtitle) subtitle.textContent = summary.subtitle;
      });
      $('#filterCount').textContent = rows.length + (rows.length === 1 ? ' filter' : ' filters');
      $('#ruleSetSummary').textContent = rows.length
        ? rows.map(row => filterSummary(row).compact).join(' + ')
        : 'No active rules';
      $('#selectedFilters').innerHTML = rows.length
        ? rows.map((row, index) => selectedChip(row, index)).join('')
        : '<div class="empty-state">Pick trait values from OpenSea. They will appear here.</div>';
      document.querySelectorAll('[data-remove-filter]').forEach(btn => btn.addEventListener('click', () => {
        const row = rows[Number(btn.dataset.removeFilter)];
        row?.remove();
        refreshFilterMeta();
      }));
    }
    function selectedChip(row, index) {
      const summary = filterSummary(row);
      return '<span class="selected-chip">' + esc(summary.compact) + '<button type="button" data-remove-filter="' + index + '">×</button></span>';
    }
    function filterSummary(row) {
      const type = row.querySelector('[data-filter="traitType"]').value.trim();
      const mode = row.querySelector('[data-filter="mode"]').value;
      const values = row.querySelector('[data-filter="traitValues"]').value.trim();
      const min = row.querySelector('[data-filter="traitMin"]').value.trim();
      const max = row.querySelector('[data-filter="traitMax"]').value.trim();
      const name = type || 'Trait condition';
      if (!type) return { name, preview: 'Choose a trait type', subtitle: 'Waiting for trait', compact: 'any trait' };
      if (mode === 'range') {
        const range = (min || '0') + ' - ' + (max || '∞');
        return { name, preview: type + ' between ' + range, subtitle: 'Numeric range', compact: type + ':' + range };
      }
      const valueText = values || 'any value';
      return { name, preview: type + ' is ' + valueText, subtitle: 'Allowed values', compact: type + ':' + valueText };
    }
    function editCollection(slug) {
      const c = latest.collections.find(x => x.slug === slug);
      if (!c) return;
      const form = $('#collectionForm');
      form.slug.value = c.slug || '';
      form.name.value = c.name || '';
      form.enabled.checked = c.enabled !== false;
      $('#editorHeading').textContent = c.name || c.slug || 'Collection Page';
      form.chain.value = c.chain || 'ethereum';
      form.telegramThreadId.value = c.telegramThreadId || '';
      form.traitMatchMode.value = c.traitMatchMode || 'all';
      resetFilters(filtersFromCollection(c));
      form.maxPriceEth.value = c.maxPriceEth ?? '';
      form.maxPriceRelativeToFloor.value = c.maxPriceRelativeToFloor ?? '';
      form.traitPriceLimits.value = c.traitPriceLimits
        ? Object.entries(c.traitPriceLimits).map(([k, v]) => k + ':' + v).join(', ')
        : '';
      $('#formMsg').textContent = slug + ' editing';
      $('#collectionLookup').value = c.slug || '';
      fetchTraitLibrary(false).catch(() => {});
      document.querySelector('[data-tab="collections"]').click();
      form.slug.focus();
    }
    function openCollectionPage(slug) {
      history.pushState({ slug }, '', '/collections/' + encodeURIComponent(slug));
      editCollection(slug);
    }
    function newCollection() {
      $('#collectionForm').reset();
      $('#collectionForm').enabled.checked = true;
      resetFilters([]);
      traitLibrary = null;
      selectedTraitType = null;
      $('#collectionLookup').value = '';
      $('#traitTypeChips').innerHTML = '';
      $('#traitValueChips').innerHTML = '';
      $('#traitLibraryStatus').textContent = 'Paste an OpenSea collection URL, then fetch traits.';
      $('#formMsg').textContent = 'new collection';
      $('#editorHeading').textContent = 'New Collection';
      document.querySelector('[data-tab="collections"]').click();
    }
    document.querySelectorAll('.nav button').forEach(btn => btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'collections') history.pushState({}, '', '/dashboard');
      document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
      $('#' + btn.dataset.tab).classList.remove('hidden');
    }));
    $('#collectionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = formPayload(e.target);
      const res = await fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      const body = await res.json();
      $('#formMsg').textContent = body.ok ? 'Saved and hot-reloaded.' : body.error;
      if (body.ok) { e.target.reset(); await load(); }
    });
    $('#collectionForm').addEventListener('reset', () => {
      setTimeout(() => {
        resetFilters([]);
        $('#editorHeading').textContent = 'New Collection';
        $('#formMsg').textContent = '';
      }, 0);
    });
    $('#newCollectionBtn').addEventListener('click', newCollection);
    $('#fetchTraitsBtn').addEventListener('click', () => fetchTraitLibrary(true));
    $('#addRangeBtn').addEventListener('click', () => addFilterRow({ traitType: 'Rarity Rank', traitMin: 1, traitMax: 50 }));
    function formPayload(form) {
      const data = Object.fromEntries(new FormData(form).entries());
      data.enabled = form.enabled.checked;
      data.traitFilters = [...document.querySelectorAll('.filter-row')].map(row => ({
        traitType: row.querySelector('[data-filter="traitType"]').value,
        traitValues: row.querySelector('[data-filter="mode"]').value === 'values'
          ? row.querySelector('[data-filter="traitValues"]').value
          : '',
        traitMin: row.querySelector('[data-filter="mode"]').value === 'range'
          ? row.querySelector('[data-filter="traitMin"]').value
          : '',
        traitMax: row.querySelector('[data-filter="mode"]').value === 'range'
          ? row.querySelector('[data-filter="traitMax"]').value
          : ''
      })).filter(f => f.traitType.trim());
      return data;
    }
    async function savePayload(data) {
      const res = await fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      return res.json();
    }
    async function toggleCollection(slug, enabled) {
      const c = latest.collections.find(x => x.slug === slug);
      if (!c) return;
      const body = await savePayload({ ...c, enabled });
      if (!body.ok) {
        $('#formMsg').textContent = body.error || 'toggle failed';
        await load();
        return;
      }
      await load();
    }
    window.addEventListener('popstate', () => {
      const slug = decodeURIComponent(location.pathname.split('/collections/')[1] || '');
      if (slug) editCollection(slug);
    });
    resetFilters([]);
    load().then(() => {
      const slug = decodeURIComponent(location.pathname.split('/collections/')[1] || '');
      if (slug) editCollection(slug);
    });
    setInterval(load, 5000);
  </script>
</body>
</html>`;
}
