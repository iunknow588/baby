const CELL_STEP_DEFINITIONS = Object.freeze({
  step07_1: Object.freeze({
    key: 'step07_1',
    processNo: '07_1',
    processName: '07_1_单格特征提取',
    dirName: '07_1_单格特征提取'
  }),
  step07_2: Object.freeze({
    key: 'step07_2',
    processNo: '07_2',
    processName: '07_2_空白格判定',
    dirName: '07_2_空白格判定'
  }),
  step07_3: Object.freeze({
    key: 'step07_3',
    processNo: '07_3',
    processName: '07_3_单格结构评分',
    dirName: '07_3_单格结构评分'
  }),
  step07_4: Object.freeze({
    key: 'step07_4',
    processNo: '07_4',
    processName: '07_4_单格相似度评分',
    dirName: '07_4_单格相似度评分'
  }),
  step07_5: Object.freeze({
    key: 'step07_5',
    processNo: '07_5',
    processName: '07_5_单格总评分',
    dirName: '07_5_单格总评分'
  })
});

const CELL_STEP_KEYS = Object.freeze(Object.keys(CELL_STEP_DEFINITIONS));

const COMPATIBILITY_PLUGIN_DEFINITIONS = Object.freeze({
  singleCellScoring: Object.freeze({
    name: '07_0_单格评分'
  }),
  pageScoringAggregate: Object.freeze({
    name: '07_0_页面评分汇总'
  })
});

const CELL_SCORING_SOURCE_STEPS = Object.freeze({
  inputTextOnly: '06_4_单格文字图',
  blankJudgeFromFeature: CELL_STEP_DEFINITIONS.step07_1.processName,
  structureFromBlankJudge: CELL_STEP_DEFINITIONS.step07_2.processName,
  similarityFromBlankJudge: CELL_STEP_DEFINITIONS.step07_2.processName,
  finalFromBlankJudge: CELL_STEP_DEFINITIONS.step07_2.processName,
  finalFromStructureSimilarity: [
    CELL_STEP_DEFINITIONS.step07_3.processName,
    CELL_STEP_DEFINITIONS.step07_4.processName
  ].join(' + ')
});

function createEmptyStepMetaPaths() {
  return Object.fromEntries(CELL_STEP_KEYS.map((stepKey) => [stepKey, null]));
}

function buildCellStepDirs(outputDir, pathModule = require('path')) {
  if (!outputDir) {
    return {};
  }

  return Object.fromEntries(
    CELL_STEP_KEYS.map((stepKey) => [
      stepKey,
      pathModule.join(outputDir, CELL_STEP_DEFINITIONS[stepKey].dirName)
    ])
  );
}

module.exports = {
  CELL_STEP_DEFINITIONS,
  CELL_STEP_KEYS,
  COMPATIBILITY_PLUGIN_DEFINITIONS,
  CELL_SCORING_SOURCE_STEPS,
  createEmptyStepMetaPaths,
  buildCellStepDirs
};
