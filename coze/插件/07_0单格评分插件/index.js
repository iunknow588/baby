const { scoreCell } = require('../07_评分插件/application/cell_scoring_service');

class SingleCellScoringPlugin {
  constructor() {
    this.name = '07_0_单格评分';
    this.version = '1.0.0';
  }

  async execute(params) {
    const { cell, options = {}, outputDir = null } = params || {};
    if (!cell) {
      throw new Error('cell参数是必需的');
    }
    return scoreCell(cell, options, outputDir);
  }
}

module.exports = new SingleCellScoringPlugin();
