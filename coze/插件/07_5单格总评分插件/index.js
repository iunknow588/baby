class CellFinalScorePlugin {
  constructor() {
    this.name = '07_5_单格总评分';
    this.version = '1.0.0';
    this.processNo = '07_5';
  }

  execute(params) {
    const { executeCellFinalScoreStep } = require('../07_评分插件/application/cell_scoring_steps');
    return executeCellFinalScoreStep(params);
  }
}

module.exports = new CellFinalScorePlugin();
