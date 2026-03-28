const {
  clamp,
  normalizeAxisPeaks,
  buildUniformGuidePeaks,
  normalizeGridBoundaryGuides
} = require('../05_切分插件/domain/guide_normalization');

class GridBoundaryNormalizePlugin {
  constructor() {
    this.name = '05_0_方格边界规范化';
    this.version = '1.0.0';
  }

  clamp(value, min, max) {
    return clamp(value, min, max);
  }

  normalizeAxisPeaks(values, min, max) {
    return normalizeAxisPeaks(values, min, max);
  }

  buildUniformGuidePeaks(start, end, cells) {
    return buildUniformGuidePeaks(start, end, cells);
  }

  execute(params) {
    return normalizeGridBoundaryGuides(params);
  }
}

module.exports = new GridBoundaryNormalizePlugin();
