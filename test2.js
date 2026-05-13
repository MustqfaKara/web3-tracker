import fs from 'fs';
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
console.log('Value 5504 ->', isWantedTraitValue(5504, config));
console.log('Value "5504" ->', isWantedTraitValue("5504", config));
