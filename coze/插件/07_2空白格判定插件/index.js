class BlankCellJudgePlugin {
  constructor() {
    this.name = '07_2_空白格判定';
    this.version = '1.0.0';
    this.processNo = '07_2';
  }

  execute(params) {
    const { executeBlankCellJudgeStep } = require('../07_评分插件/application/cell_scoring_steps');
    return executeBlankCellJudgeStep(params);
  }
}

module.exports = new BlankCellJudgePlugin();
