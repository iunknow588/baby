class GridBoundaryNormalizePlugin {
  constructor() {
    this.name = '05_0_方格边界规范化';
    this.version = '1.0.0';
  }

  buildUniformGuidePeaks(start, end, cells) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || !cells || cells <= 0) {
      return [];
    }
    const span = end - start;
    if (span <= 0) {
      return [];
    }
    return Array.from({ length: cells + 1 }, (_, index) => Math.round(start + (span * index) / cells));
  }

  execute(params) {
    const { gridRectification, gridRows, gridCols } = params || {};
    const guides = gridRectification && gridRectification.guides;
    if (!guides) {
      throw new Error('gridRectification.guides参数是必需的');
    }

    const rawXPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map((value) => Math.round(value)) : [];
    const rawYPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map((value) => Math.round(value)) : [];
    const xPeaks = rawXPeaks.length === gridCols + 1
      ? rawXPeaks
      : this.buildUniformGuidePeaks(guides.left, guides.right, gridCols);
    const yPeaks = rawYPeaks.length === gridRows + 1
      ? rawYPeaks
      : this.buildUniformGuidePeaks(guides.top, guides.bottom, gridRows);

    return {
      left: Math.round(guides.left),
      right: Math.round(guides.right),
      top: Math.round(guides.top),
      bottom: Math.round(guides.bottom),
      xPeaks,
      yPeaks,
      xSource: rawXPeaks.length === gridCols + 1 ? '检测峰值' : '外边界均分',
      ySource: rawYPeaks.length === gridRows + 1 ? '检测峰值' : '外边界均分'
    };
  }
}

module.exports = new GridBoundaryNormalizePlugin();
