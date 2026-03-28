class CellFeatureExtractPlugin {
  constructor() {
    this.name = '07_1_单格特征提取';
    this.version = '1.0.0';
    this.processNo = '07_1';
  }

  async execute(params) {
    const { executeCellFeatureExtractionStep } = require('../07_评分插件/application/cell_scoring_steps');
    return executeCellFeatureExtractionStep(params);
  }
}

module.exports = new CellFeatureExtractPlugin();
