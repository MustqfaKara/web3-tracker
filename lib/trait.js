// Trait cikartma + filtreleme + fiyat hesaplama — pure functions, test edilebilir

export function normalizeTraitType(value) {
  return String(value || '').trim().toLowerCase();
}

export function traitTypeOf(trait = {}) {
  return trait.trait_type ?? trait.traitType ?? trait.type ?? '';
}

export function traitValueOf(trait = {}) {
  return trait.value ?? trait.numeric_value ?? trait.max_value ?? '';
}

export function getTraitFilters(config = {}) {
  if (Array.isArray(config.traitFilters) && config.traitFilters.length > 0) {
    return config.traitFilters.filter(f => f && typeof f === 'object');
  }
  if (
    config.traitType ||
    (Array.isArray(config.traitValues) && config.traitValues.length > 0) ||
    config.traitValue !== undefined ||
    config.traitMin !== undefined ||
    config.traitMax !== undefined
  ) {
    return [{
      traitType: config.traitType,
      traitValues: config.traitValues,
      traitValue: config.traitValue,
      traitMin: config.traitMin,
      traitMax: config.traitMax
    }];
  }
  return [];
}

export function hasTraitFilter(config = {}) {
  return getTraitFilters(config).length > 0;
}

// Trait listesinden istenen traitType'in degerini cikar (sayisalsa Number, degilse String)
export function getTraitValue(traits, traitType) {
  if (!traitType) return null;
  const wanted = normalizeTraitType(traitType);
  const trait = (traits || []).find(c => normalizeTraitType(traitTypeOf(c)) === wanted);
  if (!trait) return null;
  const raw = traitValueOf(trait);
  const num = Number(raw);
  return Number.isFinite(num) ? num : String(raw).trim();
}

// Bu trait degeri config'deki kurallara uyuyor mu?
// 3 mod var:
//   1) traitValues array: ['Lord','Noble'] gibi coklu izin
//   2) traitValue: tek deger esitlik
//   3) traitMin/traitMax: sayisal aralik (default min=0, max=999999)
export function isWantedTraitValue(value, config) {
  if (value === null || value === undefined || value === '') return false;

  if (Array.isArray(config.traitValues) && config.traitValues.length > 0) {
    const norm = String(value).toLowerCase();
    return config.traitValues.some(v => String(v).toLowerCase() === norm);
  }

  if (config.traitValue !== undefined && config.traitValue !== null && config.traitValue !== '') {
    return String(value).toLowerCase() === String(config.traitValue).toLowerCase();
  }

  const num = typeof value === 'number' ? value : Number(value);
  if (isNaN(num)) return false;
  return num >= (config.traitMin || 0) && num <= (config.traitMax || 999999);
}

export function matchTraitFilters(traits = [], config = {}) {
  const filters = getTraitFilters(config);
  if (filters.length === 0) {
    return { matched: true, matches: [], primaryTraitType: null, primaryTraitValue: null };
  }

  const matches = [];
  const mode = String(config.traitMatchMode || 'all').toLowerCase();
  for (const filter of filters) {
    const traitValue = getTraitValue(traits, filter.traitType);
    const matched = isWantedTraitValue(traitValue, filter);
    if (!matched && mode !== 'any' && mode !== 'or') {
      return { matched: false, matches, primaryTraitType: filter.traitType, primaryTraitValue: traitValue };
    }
    if (matched) matches.push({ traitType: filter.traitType, traitValue });
  }

  if ((mode === 'any' || mode === 'or') && matches.length === 0) {
    return { matched: false, matches, primaryTraitType: filters[0]?.traitType || null, primaryTraitValue: null };
  }

  return {
    matched: true,
    matches,
    primaryTraitType: matches[0]?.traitType || null,
    primaryTraitValue: matches[0]?.traitValue ?? null
  };
}

// Max fiyat hesabi: traitPriceLimits varsa o traitin ozel limiti, yoksa maxPriceEth
// Ornek: { maxPriceEth: 0.1, traitPriceLimits: { Lord: 0.2 } } ile Lord listing'i 0.2'ye kadar gecer
export function computeMaxPrice(config, traitValue) {
  let maxPrice = config.maxPriceEth !== undefined ? parseFloat(config.maxPriceEth) : 999999;
  const values = Array.isArray(traitValue) ? traitValue : [traitValue];
  if (config.traitPriceLimits) {
    const matchedLimits = [];
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const key = String(value).toLowerCase();
      const found = Object.keys(config.traitPriceLimits).find(k => k.toLowerCase() === key);
      if (found) matchedLimits.push(parseFloat(config.traitPriceLimits[found]));
    }
    const validLimits = matchedLimits.filter(Number.isFinite);
    if (validLimits.length) maxPrice = Math.max(...validLimits);
  }
  return maxPrice;
}

// Trait bilinmeden yapilan kaba fiyat filtresi. Active listing sweep'te trait fetch
// oncesi kullanilir; traitPriceLimits varsa en yuksek limit hesaba katilir.
export function computeCoarseMaxPrice(config) {
  const limits = [];
  if (config.maxPriceEth !== undefined) limits.push(parseFloat(config.maxPriceEth));
  if (config.traitPriceLimits) {
    for (const limit of Object.values(config.traitPriceLimits)) {
      const n = parseFloat(limit);
      if (Number.isFinite(n)) limits.push(n);
    }
  }
  return limits.length ? Math.max(...limits) : 999999;
}

// Telegram mesajinda gosterilecek trait satirlari
// telegramEscape disaridan injection — modulden bagimsiz olsun
export function formatMatchTraitLines(traits = [], config, telegramEscape) {
  const filters = getTraitFilters(config);
  const wantedTypes = filters.map(f => normalizeTraitType(f.traitType)).filter(Boolean);
  return (traits || [])
    .filter(t => {
      const type = normalizeTraitType(traitTypeOf(t));
      if (!type) return false;
      return wantedTypes.some(wanted => type.includes(wanted)) ||
             type.includes('rarity') ||
             type.includes('tier');
    })
    .map(t => `<b>${telegramEscape(traitTypeOf(t))}:</b> ${telegramEscape(traitValueOf(t))}`);
}
