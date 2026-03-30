const SEGMENTATION_STAGE_DEFINITION = Object.freeze({
  processNo: '05',
  processName: '05_单格切分'
});

const SEGMENTATION_STEP_DEFINITIONS = Object.freeze({
  step05_1: Object.freeze({
    key: 'step05_1',
    processNo: '05_1',
    processName: '05_1_网格范围检测',
    dirName: '05_1_网格范围检测'
  }),
  step05_2: Object.freeze({
    key: 'step05_2',
    processNo: '05_2',
    processName: '05_2_边界引导切分',
    dirName: '05_2_边界引导切分'
  }),
  step05_3: Object.freeze({
    key: 'step05_3',
    processNo: '05_3',
    processName: '05_3_切分调试渲染',
    dirName: '05_3_切分调试渲染'
  }),
  step05_4: Object.freeze({
    key: 'step05_4',
    processNo: '05_4',
    processName: '05_4_单格裁切',
    dirName: '05_4_单格裁切'
  })
});

const SEGMENTATION_SOURCE_STEPS = Object.freeze({
  stageInput: '03_字帖外框与内框定位裁剪',
  step05_2: SEGMENTATION_STEP_DEFINITIONS.step05_1.processName,
  step05_3: SEGMENTATION_STEP_DEFINITIONS.step05_2.processName,
  step05_4: SEGMENTATION_STEP_DEFINITIONS.step05_2.processName
});

module.exports = {
  SEGMENTATION_STAGE_DEFINITION,
  SEGMENTATION_STEP_DEFINITIONS,
  SEGMENTATION_SOURCE_STEPS
};
