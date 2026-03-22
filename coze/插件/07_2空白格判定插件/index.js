class BlankCellJudgePlugin {
  constructor() {
    this.name = '07_2_空白格判定';
    this.version = '1.0.0';
    this.processNo = '07_2';
  }

  execute(params) {
    const { features, config } = params || {};
    if (!features || !config) {
      throw new Error('features 和 config 参数是必需的');
    }
    const { detectBlank, blankReasonFromFeatures } = require('../07_评分插件/scoring');
    const blankResult = detectBlank(features, config);
    return {
      processNo: this.processNo,
      processName: '07_2_空白格判定',
      blankResult,
      blankReason: blankReasonFromFeatures(features)
    };
  }
}

module.exports = new BlankCellJudgePlugin();
