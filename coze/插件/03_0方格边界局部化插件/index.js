class GridBoundaryLocalizePlugin {
  constructor() {
    this.name = '03_0_方格边界局部化';
    this.version = '1.0.0';
  }

  execute(params) {
    const { guides, bounds } = params || {};
    if (!guides || !bounds) {
      throw new Error('guides 和 bounds 参数是必需的');
    }

    const shiftX = bounds.left;
    const shiftY = bounds.top;
    const localXPeaks = (guides.xPeaks || [])
      .map((value) => Math.round(value - shiftX))
      .filter((value) => value >= 0 && value <= bounds.width)
      .sort((a, b) => a - b);
    const localYPeaks = (guides.yPeaks || [])
      .map((value) => Math.round(value - shiftY))
      .filter((value) => value >= 0 && value <= bounds.height)
      .sort((a, b) => a - b);

    return {
      left: 0,
      top: 0,
      right: bounds.width,
      bottom: bounds.height,
      xPeaks: localXPeaks,
      yPeaks: localYPeaks,
      xSource: guides.xSource || null,
      ySource: guides.ySource || null,
      source: '真实边界检测局部化'
    };
  }
}

module.exports = new GridBoundaryLocalizePlugin();
