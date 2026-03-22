class CellStructureScorePlugin {
  constructor() {
    this.name = '07_3_单格结构评分';
    this.version = '1.0.0';
    this.processNo = '07_3';
  }

  async execute(params) {
    const { cellImage, targetChar, options = {} } = params || {};
    const { calculateStructureScore } = require('../07_评分插件/scoring');
    const structure = await calculateStructureScore(cellImage, targetChar, options);
    return {
      processNo: this.processNo,
      processName: '07_3_单格结构评分',
      structure
    };
  }
}

module.exports = new CellStructureScorePlugin();
