class CellSimilarityScorePlugin {
  constructor() {
    this.name = '07_4_单格相似度评分';
    this.version = '1.0.0';
    this.processNo = '07_4';
  }

  async execute(params) {
    const { executeCellSimilarityScoreStep } = require('../07_评分插件/application/cell_scoring_steps');
    return executeCellSimilarityScoreStep(params);
  }
}

module.exports = new CellSimilarityScorePlugin();
