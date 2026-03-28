const { estimateGridCount } = require('../04_方格数量计算标注插件/domain/grid_count');

class GridCountEstimatePlugin {
  constructor() {
    this.name = '04_1_方格数量估计';
    this.version = '1.0.0';
    this.processNo = '04_1';
  }

  async execute(params) {
    return estimateGridCount({
      ...params,
      processNo: this.processNo,
      processName: this.name
    });
  }
}

module.exports = new GridCountEstimatePlugin();
