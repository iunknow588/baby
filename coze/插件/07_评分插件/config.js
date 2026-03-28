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
  const normalizedOverrides = deepMerge({}, overrides || {});

  if (isPlainObject(normalizedOverrides.layout) && normalizedOverrides.layout.center_penalty_scale !== undefined) {
    normalizedOverrides.structure_accuracy = deepMerge(
      normalizedOverrides.structure_accuracy || {},
      {
        center_penalty_scale: normalizedOverrides.layout.center_penalty_scale
      }
    );
  }
  if (isPlainObject(normalizedOverrides.size)) {
    const mapped = {};
    if (normalizedOverrides.size.ideal_bbox_ratio_low !== undefined) {
      mapped.ideal_bbox_ratio_low = normalizedOverrides.size.ideal_bbox_ratio_low;
    }
    if (normalizedOverrides.size.ideal_bbox_ratio_high !== undefined) {
      mapped.ideal_bbox_ratio_high = normalizedOverrides.size.ideal_bbox_ratio_high;
    }
    if (normalizedOverrides.size.penalty_scale !== undefined) {
      mapped.bbox_penalty_scale = normalizedOverrides.size.penalty_scale;
    }
    normalizedOverrides.structure_accuracy = deepMerge(
      normalizedOverrides.structure_accuracy || {},
      mapped
    );
  }
  if (isPlainObject(normalizedOverrides.stability)) {
    const mapped = {};
    if (normalizedOverrides.stability.noise_component_penalty !== undefined) {
      mapped.fragment_penalty_scale = normalizedOverrides.stability.noise_component_penalty;
    }
    if (normalizedOverrides.stability.component_overflow_penalty !== undefined) {
      mapped.component_penalty_scale = normalizedOverrides.stability.component_overflow_penalty;
    }
    if (normalizedOverrides.stability.stroke_density_penalty_scale !== undefined) {
      mapped.stroke_density_penalty_scale = normalizedOverrides.stability.stroke_density_penalty_scale;
    }
    if (normalizedOverrides.stability.stroke_density_target !== undefined) {
      mapped.ideal_stroke_density = normalizedOverrides.stability.stroke_density_target;
    }
    normalizedOverrides.stroke_quality = deepMerge(
      normalizedOverrides.stroke_quality || {},
      mapped
    );
  }

  return deepMerge(DEFAULT_CONFIG, normalizedOverrides);
}

module.exports = {
  DEFAULT_CONFIG,
  resolveConfig
};
