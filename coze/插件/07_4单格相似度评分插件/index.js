class CellSimilarityScorePlugin {
  constructor() {
    this.name = '07_4_单格相似度评分';
    this.version = '1.0.0';
    this.processNo = '07_4';
  }

  async execute(params) {
    const { cellImage, targetChar, options = {} } = params || {};
    const { calculateSimilarityScore } = require('../07_评分插件/scoring');
    const similarity = await calculateSimilarityScore(cellImage, targetChar, options);
    return {
      processNo: this.processNo,
      processName: '07_4_单格相似度评分',
      similarity
    };
  }
}

module.exports = new CellSimilarityScorePlugin();
