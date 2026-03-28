const { executeGridBoundsDetection } = require('../05_切分插件/domain/grid_bounds');

class GridBoundsDetectPlugin {
  constructor() {
    this.name = '05_1_网格范围检测';
    this.version = '1.0.0';
    this.processNo = '05_1';
  }

  execute(params) {
    return executeGridBoundsDetection({
      ...params,
      processNo: this.processNo,
      processName: this.name
    });
  }
}

module.exports = new GridBoundsDetectPlugin();
