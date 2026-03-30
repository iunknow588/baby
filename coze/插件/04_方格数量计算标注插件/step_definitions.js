const GRID_COUNT_STAGE_DEFINITION = Object.freeze({
  processNo: '04',
  processName: '04_方格数量计算标注'
});

const GRID_COUNT_STEP_DEFINITIONS = Object.freeze({
  step04_1: Object.freeze({
    key: 'step04_1',
    processNo: '04_1',
    processName: '04_1_方格数量估计',
    dirName: '04_1_方格数量估计',
    metaFileName: '04_1_方格数量估计.json',
    imageFileName: '04_1_方格数量估计图.png'
  }),
  step04_2: Object.freeze({
    key: 'step04_2',
    processNo: '04_2',
    processName: '04_2_方格数量标注',
    dirName: '04_2_方格数量标注',
    metaFileName: '04_2_方格数量标注.json'
  }),
  step04_3: Object.freeze({
    key: 'step04_3',
    processNo: '04_3',
    processName: '04_3_单格切分输入',
    dirName: '04_3_单格切分输入',
    metaFileName: '04_3_单格切分输入.json',
    imageFileName: '04_3_单格切分输入图.png'
  })
});

const GRID_COUNT_SOURCE_STEPS = Object.freeze({
  stageInput: '03_4_字帖内框裁剪与矫正',
  step04_2: GRID_COUNT_STEP_DEFINITIONS.step04_1.processName,
  step04_3: GRID_COUNT_STEP_DEFINITIONS.step04_2.processName
});

module.exports = {
  GRID_COUNT_STAGE_DEFINITION,
  GRID_COUNT_STEP_DEFINITIONS,
  GRID_COUNT_SOURCE_STEPS
};
