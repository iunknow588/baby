class CellStructureScorePlugin {
  constructor() {
    this.name = '07_3_单格结构评分';
    this.version = '1.0.0';
    this.processNo = '07_3';
  }

  async execute(params) {
    const { executeCellStructureScoreStep } = require('../07_评分插件/application/cell_scoring_steps');
    return executeCellStructureScoreStep(params);
  }
}

module.exports = new CellStructureScorePlugin();
