class CellFeatureExtractPlugin {
  constructor() {
    this.name = '07_1_单格特征提取';
    this.version = '1.0.0';
    this.processNo = '07_1';
  }

  async execute(params) {
    const { cellImage, options = {} } = params || {};
    if (!cellImage) {
      throw new Error('cellImage参数是必需的');
    }
    const { extractFeatures } = require('../07_评分插件/scoring');
    const features = await extractFeatures(cellImage, options);
    return {
      processNo: this.processNo,
      processName: '07_1_单格特征提取',
      features
    };
  }
}

module.exports = new CellFeatureExtractPlugin();
