const fs = require('fs');
const path = require('path');

const defaultsPath = path.join(__dirname, 'config', 'defaults.json');
const DEFAULT_CONFIG = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMerge(base[key], value);
      continue;
    }
    result[key] = value;
  }

  return result;
}

function resolveConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, overrides);
}

module.exports = {
  DEFAULT_CONFIG,
  resolveConfig
};
