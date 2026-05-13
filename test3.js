import fs from 'fs';

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

function isWantedTraitValue(value, config) {
  if (value === null || value === undefined) return false;
  if (config.traitValue !== undefined && config.traitValue !== null && config.traitValue !== '') {
    return String(value).toLowerCase() === String(config.traitValue).toLowerCase();
  }
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (isNaN(numericValue)) return false;
  return numericValue >= (config.traitMin || 0) && numericValue <= (config.traitMax || 999999);
}

const config = JSON.parse(fs.readFileSync('./collections/satos.json', 'utf8'));

const fetchedTraits = [
  { trait_type: 'Rarity Rank', value: 5504 }
];

let slopLevel = getTraitValue(fetchedTraits, config.traitType);

if (!isWantedTraitValue(slopLevel, config)) {
  console.log("IT RETURNED EARLY! No notification sent.");
} else {
  console.log("IT SENT A NOTIFICATION!");
}
