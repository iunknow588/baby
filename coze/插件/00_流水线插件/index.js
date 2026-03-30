const fs = require('fs');
const os = require('os');
const path = require('path');
const a4PaperExtractPlugin = require('../01_A4纸张提取插件/index');
const a4RectifyPlugin = require('../02_A4纸张矫正插件/index');
const gridOuterRectExtractPlugin = require('../03_字帖外框与内框定位裁剪插件/index');
const segmentationPlugin = require('../05_切分插件/index');
const scoringPlugin = require('../07_评分插件/index');
const gridCountAnnotatePlugin = require('../04_方格数量计算标注插件/index');
const cellLayerExtractPlugin = require('../06_单格背景文字提取插件/index');
const { estimateGridSize } = require('../00_预处理插件/grid_size_estimator');
const {
  DEFAULT_GRID_ROWS,
  DEFAULT_GRID_COLS,
  resolveEffectiveGrid
} = require('../utils/grid_spec');
const { requireSharp } = require('../utils/require_sharp');
const sharp = requireSharp();

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildStageStepArtifacts(stepDirs = null, stepMetaPaths = null) {
  return {
    stepDirs: stepDirs || {},
    stepMetaPaths: stepMetaPaths || {}
  };
}

function buildSegmentationOutputSnapshot(segmentation) {
  const outputs = segmentation?.outputs || {};
  const stepArtifacts = buildStageStepArtifacts(outputs.stepDirs, outputs.stepMetaPaths);
  return {
    artifactLevel: segmentation?.artifactLevel || outputs.artifactLevel || null,
    cellsDir: outputs.cellsDir || null,
    summaryPath: outputs.summaryPath || null,
    debugImagePath: segmentation?.debugOutputPath || null,
    debugMetaPath: segmentation?.debugMetaPath || null,
    ...stepArtifacts
  };
}

function buildCellLayerOutputSnapshot(cellLayerExtraction) {
  const outputs = cellLayerExtraction?.outputs || {};
  const stepArtifacts = buildStageStepArtifacts(outputs.stepDirs || cellLayerExtraction?.stepDirs, null);
  return {
    artifactLevel: cellLayerExtraction?.artifactLevel || outputs.artifactLevel || null,
    outputDir: cellLayerExtraction?.outputDir || null,
    textOnlyDir: cellLayerExtraction?.textOnlyDir || outputs.textOnlyDir || null,
    backgroundOnlyDir: cellLayerExtraction?.backgroundOnlyDir || outputs.backgroundOnlyDir || null,
    summaryPath: cellLayerExtraction?.summaryPath || null,
    stepDirs: stepArtifacts.stepDirs
  };
}

function buildScoringOutputSnapshot(scoring) {
  return {
    artifactLevel: scoring?.artifactLevel || null,
    cellStepsDir: scoring?.outputDir || null,
    cellsRootDir: scoring?.cellsRootDir || null,
    ocrDir: scoring?.ocrOutputDir || null,
    ocr: scoring?.ocr || null
  };
}

function buildGridCountOutputSnapshot(gridCount, options = {}) {
  const {
    dir = null,
    annotatedPath = null,
    carryForwardInputPath = null,
    metaPath = null,
    stageInfoPath = null
  } = options;
  const stepArtifacts = buildStageStepArtifacts(gridCount?.stepDirs, gridCount?.stepMetaPaths);
  return {
    dir,
    annotatedPath: gridCount?.outputAnnotatedPath || annotatedPath || null,
    carryForwardInputPath: gridCount?.carryForwardInputPath || carryForwardInputPath || null,
    metaPath: metaPath || null,
    stageInfoPath: stageInfoPath || null,
    ...stepArtifacts
  };
}

function buildSegmentationStageOutputSnapshot(segmentation, options = {}) {
  const {
    dir = null,
    stageInfoPath = null
  } = options;
  return {
    dir,
    ...buildSegmentationOutputSnapshot(segmentation),
    stageInfoPath: stageInfoPath || null
  };
}

function buildCellLayerStageOutputSnapshot(cellLayerExtraction, options = {}) {
  const {
    dir = null,
    stageInfoPath = null
  } = options;
  const snapshot = buildCellLayerOutputSnapshot(cellLayerExtraction);
  return {
    dir,
    artifactLevel: snapshot.artifactLevel,
    cellsDir: snapshot.textOnlyDir,
    backgroundDir: snapshot.backgroundOnlyDir,
    summaryPath: snapshot.summaryPath,
    stageInfoPath: stageInfoPath || null,
    stepDirs: snapshot.stepDirs
  };
}

function buildScoringStageOutputSnapshot(scoring, options = {}) {
  const {
    dir = null,
    pageRenderDir = null,
    pageResultDir = null,
    annotatedImagePath = null,
    summaryPath = null,
    jsonPath = null,
    stageInfoPath = null
  } = options;
  const snapshot = buildScoringOutputSnapshot(scoring);
  return {
    dir,
    artifactLevel: snapshot.artifactLevel,
    cellStepsDir: snapshot.cellStepsDir,
    ocrDir: snapshot.ocrDir,
    pageRenderDir: pageRenderDir || null,
    pageResultDir: pageResultDir || null,
    annotatedImagePath: annotatedImagePath || null,
    summaryPath: summaryPath || null,
    jsonPath: jsonPath || null,
    stageInfoPath: stageInfoPath || null,
    cellsRootDir: snapshot.cellsRootDir,
    ocr: snapshot.ocr
  };
}

function pickFields(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

const PREPROCESS_OUTPUT_FIELD_KEYS = Object.freeze({
  step1: Object.freeze([
    'locateDir',
    'locateImagePath',
    'locateMetaPath',
    'locateStepMetaPaths',
    'locateStepDirs',
    'locateStageInfoPath',
    'stageOutputImagePath'
  ]),
  step2: Object.freeze([
    'locateDir',
    'locateImagePath',
    'locateMetaPath',
    'locateStepMetaPaths',
    'locateStepDirs',
    'locateStageInfoPath',
    'quadDebugImagePath',
    'quadMetaPath',
    'rectifyDir',
    'imagePath',
    'paperCropImagePath',
    'rectifyA4ConstraintMetaPath',
    'warpedImagePath',
    'guideRemovedImagePath',
    'neutralGuideRemovedImagePath',
    'stageOutputImagePath',
    'metaPath',
    'debugImagePath',
    'rectifyStageInfoPath',
    'step02MetaPaths',
    'step02Dirs'
  ]),
  step3: Object.freeze([
    'locateDir',
    'locateImagePath',
    'locateMetaPath',
    'locateStepMetaPaths',
    'locateStepDirs',
    'locateStageInfoPath',
    'quadDebugImagePath',
    'quadMetaPath',
    'rectifyDir',
    'textRectDir',
    'textRectMetaPath',
    'textRectStepMetaPaths',
    'textRectStepDirs',
    'textRectStageInfoPath',
    'textRectAnnotatedPath',
    'textRectWarpedPath',
    'gridSegmentationInputPath',
    'imagePath',
    'paperCropImagePath',
    'rectifyA4ConstraintMetaPath',
    'warpedImagePath',
    'guideRemovedImagePath',
    'guideRemovedDisplayImagePath',
    'stageOutputImagePath',
    'gridBackgroundMaskImagePath',
    'gridRectifiedImagePath',
    'gridRectifiedMetaPath',
    'gridStageMetaPath',
    'metaPath',
    'debugImagePath',
    'rectifyStageInfoPath'
  ]),
  step4: Object.freeze([
    'locateDir',
    'locateImagePath',
    'locateMetaPath',
    'locateStageInfoPath',
    'rectifyDir',
    'textRectDir',
    'textRectMetaPath',
    'textRectStepMetaPaths',
    'textRectStepDirs',
    'textRectStageInfoPath',
    'textRectAnnotatedPath',
    'textRectWarpedPath',
    'gridSegmentationInputPath',
    'imagePath',
    'stageOutputImagePath',
    'rectifyA4ConstraintMetaPath',
    'guideRemovedImagePath',
    'guideRemovedDisplayImagePath',
    'gridBackgroundMaskImagePath',
    'gridRectifiedImagePath',
    'gridRectifiedMetaPath',
    'gridStageMetaPath',
    'metaPath'
  ]),
  step5: Object.freeze([
    'locateDir',
    'locateImagePath',
    'locateMetaPath',
    'locateStageInfoPath',
    'rectifyDir',
    'textRectDir',
    'textRectMetaPath',
    'textRectStepMetaPaths',
    'textRectStepDirs',
    'textRectStageInfoPath',
    'textRectAnnotatedPath',
    'textRectWarpedPath',
    'gridSegmentationInputPath',
    'imagePath',
    'stageOutputImagePath',
    'rectifyA4ConstraintMetaPath',
    'guideRemovedImagePath',
    'guideRemovedDisplayImagePath',
    'gridBackgroundMaskImagePath',
    'metaPath'
  ]),
  step6: Object.freeze([
    'locateDir',
    'locateImagePath',
    'locateMetaPath',
    'locateStageInfoPath',
    'rectifyDir',
    'textRectDir',
    'textRectMetaPath',
    'textRectStepMetaPaths',
    'textRectStepDirs',
    'textRectStageInfoPath',
    'textRectAnnotatedPath',
    'textRectWarpedPath',
    'gridSegmentationInputPath',
    'imagePath',
    'rectifyA4ConstraintMetaPath',
    'guideRemovedImagePath',
    'guideRemovedDisplayImagePath',
    'gridBackgroundMaskImagePath',
    'gridRectifiedImagePath',
    'gridRectifiedMetaPath',
    'gridStageMetaPath',
    'metaPath'
  ]),
  final: Object.freeze([
    'locateDir',
    'locateImagePath',
    'locateMetaPath',
    'locateStepMetaPaths',
    'locateStepDirs',
    'locateStageInfoPath',
    'quadDebugImagePath',
    'quadMetaPath',
    'rectifyDir',
    'textRectDir',
    'textRectMetaPath',
    'textRectStepMetaPaths',
    'textRectStepDirs',
    'textRectStageInfoPath',
    'textRectAnnotatedPath',
    'textRectWarpedPath',
    'gridSegmentationInputPath',
    'imagePath',
    'paperCropImagePath',
    'stageOutputImagePath',
    'rectifyA4ConstraintMetaPath',
    'warpedImagePath',
    'guideRemovedImagePath',
    'guideRemovedDisplayImagePath',
    'gridBackgroundMaskImagePath',
    'gridRectifiedImagePath',
    'gridRectifiedMetaPath',
    'gridStageMetaPath',
    'metaPath',
    'debugImagePath',
    'rectifyStageInfoPath',
    'step02MetaPaths',
    'step02Dirs'
  ])
});

const A4_RECTIFY_STEP_OUTPUT_FIELDS = Object.freeze([
  Object.freeze({ key: 'step02_0', dirField: 'step02_0Dir', metaField: 'step02_0MetaPath' }),
  Object.freeze({ key: 'step02_1', dirField: 'step02_1Dir', metaField: 'step02_1MetaPath' }),
  Object.freeze({ key: 'step02_2', dirField: 'step02_2Dir', metaField: 'step02_2MetaPath' }),
  Object.freeze({ key: 'step02_3', dirField: 'step02_3Dir', metaField: 'step02_3MetaPath' }),
  Object.freeze({ key: 'step02_3_1', dirField: 'step02_3_1Dir', metaField: 'step02_3_1MetaPath' }),
  Object.freeze({ key: 'step02_3_2', dirField: 'step02_3_2Dir', metaField: 'step02_3_2MetaPath' })
]);

const PIPELINE_RESULT_STATE_KEYS = Object.freeze([
  'preprocessing',
  'estimatedGrid',
  'effectiveGrid',
  'gridCount',
  'segmentation',
  'segmentationModePolicy',
  'cellLayerExtraction',
  'segmentationSelection',
  'scoring'
]);

const PIPELINE_PROGRESS_STATE_PROFILE_KEYS = Object.freeze({
  step1: Object.freeze([]),
  step2: Object.freeze(['preprocessing']),
  step3: Object.freeze(['preprocessing']),
  step4: Object.freeze([
    'preprocessing',
    'estimatedGrid',
    'effectiveGrid',
    'gridCount'
  ]),
  step5: Object.freeze([
    'preprocessing',
    'estimatedGrid',
    'effectiveGrid',
    'gridCount',
    'segmentation',
    'segmentationModePolicy',
    'segmentationSelection'
  ]),
  step6: Object.freeze([
    'preprocessing',
    'estimatedGrid',
    'effectiveGrid',
    'gridCount',
    'segmentation',
    'segmentationModePolicy',
    'cellLayerExtraction',
    'segmentationSelection'
  ]),
  final: Object.freeze([
    'preprocessing',
    'estimatedGrid',
    'effectiveGrid',
    'gridCount',
    'segmentation',
    'segmentationModePolicy',
    'cellLayerExtraction',
    'segmentationSelection',
    'scoring'
  ])
});

const PIPELINE_PROGRESS_OUTPUT_PROFILE_KEYS = Object.freeze({
  step1: Object.freeze(['preprocess']),
  step2: Object.freeze(['preprocess']),
  step3: Object.freeze(['preprocess']),
  step4: Object.freeze(['preprocess', 'gridCount']),
  step5: Object.freeze(['preprocess', 'gridCount', 'segmentation']),
  step6: Object.freeze(['preprocess', 'segmentation', 'gridCount', 'cellLayerExtraction']),
  final: Object.freeze(['preprocess', 'segmentation', 'gridCount', 'cellLayerExtraction', 'scoring'])
});

const PIPELINE_STAGE_DEFINITIONS = Object.freeze({
  locate: Object.freeze({
    processNo: '01',
    processName: '01_稿纸提取',
    displayName: '01 稿纸提取'
  }),
  rectify: Object.freeze({
    processNo: '02',
    processName: '02_A4纸张矫正',
    displayName: '02 A4纸张矫正'
  }),
  textRect: Object.freeze({
    processNo: '03',
    processName: '03_字帖外框与内框定位裁剪',
    displayName: '03 字帖外框与内框定位裁剪'
  }),
  gridCount: Object.freeze({
    processNo: '04',
    processName: '04_方格数量计算标注',
    displayName: '04 总方格数量计算与标注'
  }),
  segmentation: Object.freeze({
    processNo: '05',
    processName: '05_单格切分',
    displayName: '05 单个方格切分'
  }),
  cellLayer: Object.freeze({
    processNo: '06',
    processName: '06_单格背景文字提取',
    displayName: '06 单个方格背景与文字提取'
  }),
  scoring: Object.freeze({
    processNo: '07',
    processName: '07_单格评分',
    displayName: '07 单个方格文字评分'
  })
});

const PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS = Object.freeze({
  locatePaperBoundsImagePath: Object.freeze(['01_1_纸张范围检测', '01_1_纸张范围检测图.png']),
  locatePaperCropPath: Object.freeze(['01_2_纸张裁切导出', '01_2_稿纸裁切图.png']),
  locateMetaPath: Object.freeze(['01_稿纸提取结果.json']),
  rectifyA4ConstraintImagePath: Object.freeze(['02_0_A4规格约束检测', '02_0_2_A4规格约束检测图.png']),
  rectifyA4ConstraintMetaPath: Object.freeze(['02_0_A4规格约束检测', '02_0_A4规格约束检测.json']),
  quadDebugPath: Object.freeze(['02_1_纸张角点检测', '02_1_1_纸张角点调试图.png']),
  quadMetaPath: Object.freeze(['02_1_纸张角点检测', '02_1_纸张角点检测.json']),
  preprocessPath: Object.freeze(['02_3_去底纹', '02_3_2_矫正预处理输出', '02_3_2_1_矫正预处理图.png']),
  preprocessWarpedPath: Object.freeze(['02_2_透视矫正', '02_2_1_透视矫正图.png']),
  preprocessNeutralGuideRemovedPath: Object.freeze(['02_3_去底纹', '02_3_1_去底纹输出', '02_3_1_1_检测去底纹图.png']),
  preprocessMetaPath: Object.freeze(['02_A4纸张矫正结果.json']),
  preprocessGridCornerAnnotatedPath: Object.freeze(['03_1_外框四角定位', '03_1_外框四角定位图.png']),
  preprocessGridBackgroundMaskPath: Object.freeze(['03_2_外框裁剪与矫正', '03_2_外框裁剪与矫正图.png']),
  preprocessGridRectifiedPath: Object.freeze(['03_4_字帖内框裁剪与矫正', '03_4_字帖内框裁剪与矫正图.png']),
  preprocessGridRectifiedMetaPath: Object.freeze(['03_4_字帖内框裁剪与矫正', '03_4_字帖内框裁剪与矫正.json']),
  preprocessGridStageMetaPath: Object.freeze(['03_3_内框四角定位', '03_3_内框四角定位.json']),
  textRectBoundsMetaPath: Object.freeze(['03_字帖外框与内框定位裁剪结果.json']),
  textRectAnnotatedPath: Object.freeze(['03_3_内框四角定位', '03_3_内框四角定位图.png']),
  textRectWarpedPath: Object.freeze(['03_4_字帖内框裁剪与矫正', '03_4_字帖内框裁剪与矫正图.png']),
  gridCountEstimatedImagePath: Object.freeze(['04_1_方格数量估计', '04_1_方格数量估计图.png']),
  gridCountAnnotatedPath: Object.freeze(['04_2_方格数量标注图.png']),
  gridCountMetaPath: Object.freeze(['04_方格数量计算标注结果.json']),
  gridCountCarryForwardPath: Object.freeze(['04_3_单格切分输入', '04_3_单格切分输入图.png']),
  scoringAnnotatedPath: Object.freeze(['07_6_页面评分标注图.png']),
  scoringSummaryPath: Object.freeze(['07_6_页面评分摘要.txt']),
  scoringJsonPath: Object.freeze(['07_7_页面评分结果.json'])
});

const PIPELINE_STAGE_PROCESS_CHAINS = Object.freeze({
  locate: Object.freeze([
    '原始待处理图片 -> 01_1_纸张范围检测图',
    '01_1_纸张范围检测图 -> 01_2_稿纸裁切图'
  ]),
  rectify: Object.freeze([
    '01_2_稿纸裁切图 -> 02 阶段单图输入',
    '02 阶段单图输入 -> 02_0_1_A4内切清边图',
    '02 阶段单图输入 -> 02_0_2_A4规格约束检测图',
    '02 阶段单图输入 -> 02_1_1_纸张角点调试图',
    '02 阶段单图输入 -> 02_2_1_透视矫正图',
    '02 阶段单图输入 -> 02_3_1_1_检测去底纹图',
    '02 阶段单图输入 -> 02_3_2_1_矫正预处理图'
  ]),
  textRect: Object.freeze([
    '02_3_2_1_矫正预处理图 -> 03 阶段单图输入',
    '03 阶段单图输入 -> 03_1_外框四角定位图',
    '03 阶段单图输入 -> 03_2_外框裁剪与矫正图(仅外框存在时输出)',
    '03 阶段单图输入 -> 03_3_内框四角定位图',
    '03 阶段单图输入 -> 03_4_字帖内框裁剪与矫正图'
  ]),
  gridCount: Object.freeze([
    '03_4_字帖内框裁剪与矫正图 -> 04_1_方格数量估计图',
    '04_1_方格数量估计图 -> 04_2_方格数量标注图',
    '03_4_字帖内框裁剪与矫正图 -> 04_3_单格切分输入图'
  ])
});

function buildPreprocessOutputSnapshot(fieldMap, profileKey) {
  return pickFields(fieldMap, PREPROCESS_OUTPUT_FIELD_KEYS[profileKey] || []);
}

function buildPipelineResultStateSnapshot(fieldMap) {
  return pickFields(fieldMap, PIPELINE_RESULT_STATE_KEYS);
}

function buildPipelineProgressStateSnapshot(fieldMap, profileKey) {
  return pickFields(fieldMap, PIPELINE_PROGRESS_STATE_PROFILE_KEYS[profileKey] || []);
}

function buildPipelineProgressOutputsSnapshot(fieldMap, profileKey) {
  return pickFields(fieldMap, PIPELINE_PROGRESS_OUTPUT_PROFILE_KEYS[profileKey] || []);
}

function buildStepOutputFieldMap(source = {}, definitions = [], fieldName) {
  const result = {};
  for (const definition of definitions) {
    result[definition.key] = source[definition[fieldName]];
  }
  return result;
}

function buildStepOutputMaps(source = {}, definitions = []) {
  return {
    stepDirs: buildStepOutputFieldMap(source, definitions, 'dirField'),
    stepMetaPaths: buildStepOutputFieldMap(source, definitions, 'metaField')
  };
}

function buildLocatePreprocessFieldMap(options = {}) {
  const {
    locateDir,
    locateImagePath,
    locateMetaPath,
    locateStepMetaPaths,
    locateStepDirs,
    locateStageInfoPath,
    stageOutputImagePath
  } = options;

  return {
    locateDir,
    locateImagePath,
    locateMetaPath,
    locateStepMetaPaths,
    locateStepDirs,
    locateStageInfoPath,
    stageOutputImagePath
  };
}

function buildRectifyPreprocessFieldMap(options = {}) {
  const {
    locateFieldMap = {},
    quadDebugPath,
    quadMetaPath,
    rectifyDir,
    preprocessPath,
    paperCropImagePath,
    rectifyA4ConstraintMetaPath,
    preprocessWarpedPath,
    preprocessGuideRemovedPath,
    preprocessNeutralGuideRemovedPath,
    stageOutputImagePath,
    preprocessMetaPath,
    rectifyStageInfoPath,
    step02MetaPaths,
    step02Dirs
  } = options;

  return {
    ...locateFieldMap,
    quadDebugImagePath: quadDebugPath,
    quadMetaPath,
    rectifyDir,
    imagePath: preprocessPath,
    paperCropImagePath,
    rectifyA4ConstraintMetaPath,
    warpedImagePath: preprocessWarpedPath,
    guideRemovedImagePath: preprocessGuideRemovedPath,
    neutralGuideRemovedImagePath: preprocessNeutralGuideRemovedPath,
    stageOutputImagePath,
    metaPath: preprocessMetaPath,
    debugImagePath: quadDebugPath,
    rectifyStageInfoPath,
    step02MetaPaths,
    step02Dirs
  };
}

function buildTextRectPreprocessFieldMap(options = {}) {
  const {
    rectifyFieldMap = {},
    textRectDir,
    textRectBoundsMetaPath,
    textRectStepMetaPaths,
    textRectStepDirs,
    textRectStageInfoPath,
    textRectAnnotatedOutputPath,
    textRectWarpedOutputPath,
    gridSegmentationInputOutputPath,
    preprocessGuideRemovedPath,
    preprocessNeutralGuideRemovedPath,
    preprocessGridBackgroundMaskPath,
    preprocessGridRectifiedPath,
    preprocessGridRectifiedMetaPath,
    preprocessGridStageMetaPath
  } = options;

  return {
    ...rectifyFieldMap,
    textRectDir,
    textRectMetaPath: textRectBoundsMetaPath,
    textRectStepMetaPaths,
    textRectStepDirs,
    textRectStageInfoPath,
    textRectAnnotatedPath: textRectAnnotatedOutputPath,
    textRectWarpedPath: textRectWarpedOutputPath,
    gridSegmentationInputPath: gridSegmentationInputOutputPath,
    guideRemovedImagePath: preprocessNeutralGuideRemovedPath,
    guideRemovedDisplayImagePath: preprocessGuideRemovedPath,
    gridBackgroundMaskImagePath: preprocessGridBackgroundMaskPath,
    gridRectifiedImagePath: preprocessGridRectifiedPath,
    gridRectifiedMetaPath: preprocessGridRectifiedMetaPath,
    gridStageMetaPath: preprocessGridStageMetaPath
  };
}

function buildPreprocessProfileSnapshots(baseFieldMap, profileKeys = [], overridesByProfile = {}) {
  const snapshots = {};
  for (const profileKey of profileKeys) {
    snapshots[profileKey] = buildPreprocessOutputSnapshot({
      ...baseFieldMap,
      ...(overridesByProfile[profileKey] || {})
    }, profileKey);
  }
  return snapshots;
}

function buildGridTypeScopedScoringOptions(baseOptions = {}, patternProfile = null, gridType = 'square') {
  const normalizedBaseOptions = baseOptions && typeof baseOptions === 'object' ? baseOptions : {};
  const config = normalizedBaseOptions.config && typeof normalizedBaseOptions.config === 'object'
    ? normalizedBaseOptions.config
    : {};
  const imageConfig = config.image && typeof config.image === 'object'
    ? config.image
    : {};

  return {
    ...normalizedBaseOptions,
    patternProfile,
    config: {
      ...config,
      image: {
        ...imageConfig,
        grid_type: gridType
      }
    }
  };
}

function createPipelineFinishPayload(completedStep, outputs, stateFieldMap = {}, options = {}) {
  const {
    stoppedAtStep = completedStep
  } = options;
  return {
    completedStep,
    stoppedAtStep,
    outputs,
    ...buildPipelineResultStateSnapshot(stateFieldMap)
  };
}

function createPipelineProgressPayload(completedStep, profileKey, outputFieldMap = {}, stateFieldMap = {}, options = {}) {
  return createPipelineFinishPayload(
    completedStep,
    buildPipelineProgressOutputsSnapshot(outputFieldMap, profileKey),
    buildPipelineProgressStateSnapshot(stateFieldMap, profileKey),
    options
  );
}

function fitBoundaryGuidesToImage(boundaryGuides, imageWidth, imageHeight) {
  if (!boundaryGuides || !imageWidth || !imageHeight) {
    return null;
  }
  const sourceWidth = Math.max(1, (boundaryGuides.right ?? 0) - (boundaryGuides.left ?? 0));
  const sourceHeight = Math.max(1, (boundaryGuides.bottom ?? 0) - (boundaryGuides.top ?? 0));
  const scaleX = imageWidth / sourceWidth;
  const scaleY = imageHeight / sourceHeight;
  const mapX = (value) => Math.max(0, Math.min(imageWidth, Math.round(((value ?? 0) - (boundaryGuides.left ?? 0)) * scaleX)));
  const mapY = (value) => Math.max(0, Math.min(imageHeight, Math.round(((value ?? 0) - (boundaryGuides.top ?? 0)) * scaleY)));

  return {
    ...boundaryGuides,
    left: 0,
    top: 0,
    right: imageWidth,
    bottom: imageHeight,
    xPeaks: Array.isArray(boundaryGuides.xPeaks) ? boundaryGuides.xPeaks.map(mapX) : [],
    yPeaks: Array.isArray(boundaryGuides.yPeaks) ? boundaryGuides.yPeaks.map(mapY) : [],
    source: `${boundaryGuides.source || '边界引导'}_适配矫正图`
  };
}

function computeGuideCompleteness(boundaryGuides, gridRows, gridCols) {
  if (!boundaryGuides) {
    return -1;
  }
  const xPeaks = Array.isArray(boundaryGuides.xPeaks) ? boundaryGuides.xPeaks.filter(Number.isFinite).length : 0;
  const yPeaks = Array.isArray(boundaryGuides.yPeaks) ? boundaryGuides.yPeaks.filter(Number.isFinite).length : 0;
  const xTarget = Math.max(1, Number(gridCols) || 1) + 1;
  const yTarget = Math.max(1, Number(gridRows) || 1) + 1;
  const xScore = Math.min(xPeaks, xTarget) / xTarget;
  const yScore = Math.min(yPeaks, yTarget) / yTarget;
  return xScore + yScore;
}

function pickPreferredBoundaryGuides(textRectMeta, gridRows, gridCols) {
  const candidates = [
    textRectMeta?.gridGuideDiagnostics?.normalizedGuides || null,
    textRectMeta?.steps?.step03_0?.gridGuideDiagnostics?.normalizedGuides || null,
    textRectMeta?.localizedBoundaryGuides || null
  ].filter(Boolean);

  if (!candidates.length) {
    return null;
  }

  return candidates
    .map((candidate) => ({
      candidate,
      score: computeGuideCompleteness(candidate, gridRows, gridCols)
    }))
    .sort((left, right) => right.score - left.score)[0].candidate;
}

function inferSegmentationSourceStep(imagePath, context = {}) {
  if (!imagePath) {
    return '03_字帖外框与内框定位裁剪';
  }
  if (context.gridCountCarryForwardPath && imagePath === context.gridCountCarryForwardPath) {
    return '04_方格数量计算标注';
  }
  if (context.gridRectifiedPath && imagePath === context.gridRectifiedPath) {
    return '03_4_字帖内框裁剪与矫正';
  }
  if (context.textRectPreprocessedPath && imagePath === context.textRectPreprocessedPath) {
    return '03_4_字帖内框裁剪与矫正';
  }
  if (context.gridSegmentationInputPath && imagePath === context.gridSegmentationInputPath) {
    return imagePath.includes('/03_4_') ? '03_4_字帖内框裁剪与矫正' : '03_字帖外框与内框定位裁剪';
  }
  return '03_字帖外框与内框定位裁剪';
}

function resolvePatternProfile(textRectMeta) {
  return (
    textRectMeta?.gridGuideDiagnostics?.patternProfile ||
    textRectMeta?.guides?.patternProfile ||
    null
  );
}

function shouldPreferUniformSegmentation(patternProfile) {
  if (!patternProfile) {
    return false;
  }
  if (patternProfile.settings && patternProfile.settings.forceUniformSegmentation) {
    return true;
  }
  return patternProfile.globalMode === 'uniform-boundary-grid';
}

function pickBoundaryGuidesByPriority(candidates, priorityOrder = []) {
  const normalizedPriority = Array.isArray(priorityOrder)
    ? priorityOrder.filter(Boolean)
    : [];
  for (const source of normalizedPriority) {
    if (candidates[source]) {
      return {
        source,
        guides: candidates[source]
      };
    }
  }
  const fallbackSource = Object.keys(candidates).find((key) => Boolean(candidates[key]));
  if (!fallbackSource) {
    return {
      source: 'none',
      guides: null
    };
  }
  return {
    source: fallbackSource,
    guides: candidates[fallbackSource]
  };
}

function resolveSegmentationModePolicy({
  textRectMeta = null,
  rectifiedBoundaryGuides = null,
  preferredBoundaryGuides = null,
  localizedBoundaryGuides = null,
  patternProfile = null,
  segmentationOptions = null
} = {}) {
  void textRectMeta;
  const manualBoundaryGuidesOverride = Object.prototype.hasOwnProperty.call(segmentationOptions || {}, 'boundaryGuides');
  const manualForceUniformOverride = Object.prototype.hasOwnProperty.call(segmentationOptions || {}, 'forceUniformGrid');
  const baseForceUniformGrid = shouldPreferUniformSegmentation(patternProfile);
  const boundaryPriority = ['localized', 'preferred', 'rectified'];
  const boundaryGuideCandidates = {
    rectified: rectifiedBoundaryGuides || null,
    preferred: preferredBoundaryGuides || null,
    localized: localizedBoundaryGuides || null
  };
  const selectedBoundary = manualBoundaryGuidesOverride
    ? {
        source: segmentationOptions.boundaryGuides ? 'manual-override' : 'manual-none',
        guides: segmentationOptions.boundaryGuides || null
      }
    : pickBoundaryGuidesByPriority(boundaryGuideCandidates, boundaryPriority);
  const finalForceUniformGrid = manualForceUniformOverride
    ? Boolean(segmentationOptions.forceUniformGrid)
    : baseForceUniformGrid;

  return {
    boundaryGuides: selectedBoundary.guides,
    boundaryGuideCandidates,
    forceUniformGrid: finalForceUniformGrid,
    policy: {
      strategyScope: 'inner-frame-only',
      strategyLabel: '内框优先切分策略',
      boundaryGuidePriority: boundaryPriority,
      selectedBoundaryGuideSource: selectedBoundary.source,
      manualBoundaryGuidesOverride,
      manualForceUniformOverride,
      baseForceUniformGrid,
      finalForceUniformGrid
    }
  };
}

async function writeStageInfo(stageDir, payload) {
  await fs.promises.mkdir(stageDir, { recursive: true });
  const stepArtifacts = buildStageStepArtifacts(payload.stepDirs, payload.stepMetaPaths);
  const chineseView = {
    阶段编号: payload.processNo || null,
    阶段名称: payload.processName || null,
    显示名称: payload.displayName || null,
    阶段目录: payload.stageDir || stageDir,
    原始图片: payload.imagePath || null,
    阶段输入图: payload.stageInputPath || null,
    关键输出: payload.keyOutputs || {},
    子步骤目录: stepArtifacts.stepDirs,
    子步骤结果JSON: stepArtifacts.stepMetaPaths
  };
  if (payload.variants) {
    chineseView.候选方案 = payload.variants;
  }
  const infoPath = path.join(stageDir, 'stage_info.json');
  await fs.promises.writeFile(
    infoPath,
    `${JSON.stringify({
      ...payload,
      显示信息: chineseView
    }, null, 2)}\n`,
    'utf8'
  );
  return infoPath;
}

function buildPipelineStageInfoPayload(stageKey, options = {}) {
  const stageDefinition = PIPELINE_STAGE_DEFINITIONS[stageKey];
  if (!stageDefinition) {
    throw new Error(`未知流水线阶段定义: ${stageKey}`);
  }

  const {
    stageDir,
    imagePath,
    stageInputPath,
    keyOutputs,
    processChain,
    stepDirs,
    stepMetaPaths,
    variants
  } = options;

  return {
    ...stageDefinition,
    stageDir,
    imagePath,
    stageInputPath,
    keyOutputs,
    processChain,
    stepDirs,
    stepMetaPaths,
    variants
  };
}

async function writePipelineStageInfo(stageKey, options = {}) {
  return writeStageInfo(
    options.stageDir,
    buildPipelineStageInfoPayload(stageKey, options)
  );
}

function buildPipelineLayout(outputRootDir, baseName) {
  const fileRootDir = path.join(outputRootDir, baseName);
  const locateDir = path.join(fileRootDir, PIPELINE_STAGE_DEFINITIONS.locate.processName);
  const rectifyDir = path.join(fileRootDir, PIPELINE_STAGE_DEFINITIONS.rectify.processName);
  const textRectDir = path.join(fileRootDir, PIPELINE_STAGE_DEFINITIONS.textRect.processName);
  const gridCountDir = path.join(fileRootDir, PIPELINE_STAGE_DEFINITIONS.gridCount.processName);
  const segmentationDir = path.join(fileRootDir, PIPELINE_STAGE_DEFINITIONS.segmentation.processName);
  const cellLayerDir = path.join(fileRootDir, PIPELINE_STAGE_DEFINITIONS.cellLayer.processName);
  const scoringDir = path.join(fileRootDir, PIPELINE_STAGE_DEFINITIONS.scoring.processName);
  const scoringCellDir = path.join(scoringDir, '07_1至07_5_单格评分步骤');
  const scoringPageRenderDir = path.join(scoringDir, '07_6_页面评分渲染');
  const scoringResultDir = path.join(scoringDir, '07_7_页面评分结果');

  return {
    fileRootDir,
    locateDir,
    rectifyDir,
    textRectDir,
    gridCountDir,
    segmentationDir,
    cellLayerDir,
    scoringDir,
    scoringCellDir,
    scoringPageRenderDir,
    scoringResultDir,
    locatePaperBoundsImagePath: path.join(locateDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.locatePaperBoundsImagePath),
    locatePaperCropPath: path.join(locateDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.locatePaperCropPath),
    locateMetaPath: path.join(locateDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.locateMetaPath),
    rectifyA4ConstraintImagePath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.rectifyA4ConstraintImagePath),
    rectifyA4ConstraintMetaPath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.rectifyA4ConstraintMetaPath),
    quadDebugPath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.quadDebugPath),
    quadMetaPath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.quadMetaPath),
    preprocessPath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessPath),
    preprocessWarpedPath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessWarpedPath),
    preprocessNeutralGuideRemovedPath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessNeutralGuideRemovedPath),
    preprocessMetaPath: path.join(rectifyDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessMetaPath),
    preprocessGridCornerAnnotatedPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessGridCornerAnnotatedPath),
    preprocessGridBackgroundMaskPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessGridBackgroundMaskPath),
    preprocessGridRectifiedPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessGridRectifiedPath),
    preprocessGridRectifiedMetaPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessGridRectifiedMetaPath),
    preprocessGridStageMetaPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.preprocessGridStageMetaPath),
    textRectBoundsMetaPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.textRectBoundsMetaPath),
    textRectAnnotatedPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.textRectAnnotatedPath),
    textRectWarpedPath: path.join(textRectDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.textRectWarpedPath),
    gridCountEstimatedImagePath: path.join(gridCountDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.gridCountEstimatedImagePath),
    gridCountAnnotatedPath: path.join(gridCountDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.gridCountAnnotatedPath),
    gridCountMetaPath: path.join(gridCountDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.gridCountMetaPath),
    gridCountCarryForwardPath: path.join(gridCountDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.gridCountCarryForwardPath),
    segmentationCellsDir: path.join(segmentationDir, '05_4_单格图'),
    cellLayerOutputDir: path.join(cellLayerDir, '06_0_单格分层总览'),
    scoringAnnotatedPath: path.join(scoringPageRenderDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.scoringAnnotatedPath),
    scoringSummaryPath: path.join(scoringPageRenderDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.scoringSummaryPath),
    scoringJsonPath: path.join(scoringResultDir, ...PIPELINE_STAGE_OUTPUT_RELATIVE_PATHS.scoringJsonPath)
  };
}

function buildLocateStageKeyOutputs({
  locatePaperBoundsImagePath,
  stage01OutputImagePath,
  locateMetaPath
}) {
  return {
    paperBoundsImagePath: locatePaperBoundsImagePath,
    paperCropImagePath: stage01OutputImagePath,
    stageOutputImagePath: stage01OutputImagePath,
    metaPath: locateMetaPath
  };
}

function buildRectifyStageKeyOutputs({
  locatePerspectiveInputPath,
  rectifyA4ConstraintMetaPath,
  rectifyA4ConstraintImagePath,
  preprocessPath,
  stage02OutputImagePath,
  preprocessWarpedPath,
  preprocessGuideRemovedPath,
  preprocessNeutralGuideRemovedPath,
  preprocessMetaPath,
  quadMetaPath,
  quadDebugPath
}) {
  return {
    inputPath: locatePerspectiveInputPath,
    a4ConstraintMetaPath: rectifyA4ConstraintMetaPath,
    a4ConstraintImagePath: rectifyA4ConstraintImagePath,
    preprocessPath,
    stageOutputImagePath: stage02OutputImagePath,
    warpedPath: preprocessWarpedPath,
    guideRemovedPath: preprocessGuideRemovedPath,
    neutralGuideRemovedPath: preprocessNeutralGuideRemovedPath,
    metaPath: preprocessMetaPath,
    quadMetaPath,
    quadDebugPath
  };
}

function buildTextRectStageKeyOutputs({
  preprocessPath,
  preprocessGridCornerAnnotatedPath,
  preprocessGridBackgroundMaskPath,
  textRectAnnotatedOutputPath,
  textRectWarpedOutputPath,
  textRectBoundsMetaPath
}) {
  return {
    '02_3_2_1_矫正预处理图': preprocessPath,
    '03_1_外框四角定位图': preprocessGridCornerAnnotatedPath,
    '03_2_外框裁剪与矫正图': preprocessGridBackgroundMaskPath,
    '03_3_内框四角定位图': textRectAnnotatedOutputPath,
    '03_4_字帖内框裁剪与矫正图': textRectWarpedOutputPath,
    '03_字帖外框与内框定位裁剪结果.json': textRectBoundsMetaPath
  };
}

function buildGridCountStageKeyOutputs({
  textRectWarpedOutputPath,
  gridCountEstimatedImagePath,
  gridCountMetaPath,
  gridCount,
  gridCountAnnotatedPath,
  gridCountCarryForwardPath
}) {
  return {
    inputPath: textRectWarpedOutputPath,
    estimatedImagePath: gridCountEstimatedImagePath,
    metaPath: gridCountMetaPath,
    annotatedPath: gridCount.outputAnnotatedPath || gridCountAnnotatedPath,
    carryForwardInputPath: gridCount.carryForwardInputPath || gridCountCarryForwardPath
  };
}

function buildSegmentationStageKeyOutputs({
  segmentationSelection,
  segmentationOutputSnapshot,
  effectiveSegmentationModePolicy
}) {
  return {
    inputPath: segmentationSelection.selectedImagePath,
    artifactLevel: segmentationOutputSnapshot.artifactLevel,
    cellsDir: segmentationOutputSnapshot.cellsDir,
    summaryPath: segmentationOutputSnapshot.summaryPath,
    debugImagePath: segmentationOutputSnapshot.debugImagePath,
    debugMetaPath: segmentationOutputSnapshot.debugMetaPath,
    modePolicy: effectiveSegmentationModePolicy
  };
}

function buildCellLayerStageKeyOutputs({
  segmentationSelection,
  cellLayerOutputSnapshot
}) {
  return {
    artifactLevel: cellLayerOutputSnapshot.artifactLevel,
    inputPath: segmentationSelection.selectedImagePath,
    cellsDir: cellLayerOutputSnapshot.textOnlyDir,
    backgroundDir: cellLayerOutputSnapshot.backgroundOnlyDir,
    summaryPath: cellLayerOutputSnapshot.summaryPath
  };
}

function buildScoringStageKeyOutputs({
  segmentationSelection,
  scoringOutputSnapshot,
  scoringPageRenderDir,
  scoringResultDir,
  scoringAnnotatedPath,
  scoringSummaryPath,
  scoringJsonPath
}) {
  return {
    artifactLevel: scoringOutputSnapshot.artifactLevel,
    inputPath: segmentationSelection.selectedImagePath,
    cellStepsDir: scoringOutputSnapshot.cellStepsDir,
    cellsRootDir: scoringOutputSnapshot.cellsRootDir,
    ocrDir: scoringOutputSnapshot.ocrDir,
    pageRenderDir: scoringPageRenderDir,
    pageResultDir: scoringResultDir,
    annotatedImagePath: scoringAnnotatedPath,
    summaryPath: scoringSummaryPath,
    jsonPath: scoringJsonPath
  };
}

async function ensureDir(dirPath) {
  if (!dirPath) {
    return;
  }
  await fs.promises.mkdir(dirPath, { recursive: true });
}


async function estimateSegmentationQuality(scoringImagePath, segmentation) {
  const image = sharp(scoringImagePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const metrics = [];

  for (const cell of segmentation.cells || []) {
    const { left, top, width, height } = cell.pageBox;
    let darkPixels = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        const offset = (y * info.width + x) * info.channels;
        let intensity = 255;
        for (let channel = 0; channel < Math.min(info.channels, 3); channel++) {
          intensity = Math.min(intensity, data[offset + channel]);
        }

        const darkness = 255 - intensity;
        if (darkness < 48) {
          continue;
        }

        darkPixels += 1;
        weightedX += x - left;
        weightedY += y - top;
      }
    }

    const area = width * height;
    const darkRatio = area > 0 ? darkPixels / area : 0;
    const centerX = darkPixels ? weightedX / darkPixels / width : 0.5;
    const centerY = darkPixels ? weightedY / darkPixels / height : 0.5;
    const centerOffset = Math.abs(centerX - 0.5) + Math.abs(centerY - 0.5);

    metrics.push({
      darkRatio,
      blank: darkRatio < 0.012,
      centerOffset
    });
  }

  const blankCount = metrics.filter((item) => item.blank).length;
  const nonBlank = metrics.filter((item) => !item.blank);
  const averageDarkRatio = average(nonBlank.map((item) => item.darkRatio));
  const averageCenterOffset = average(nonBlank.map((item) => item.centerOffset));
  const lineCount = (segmentation.debug.verticalLines || []).length + (segmentation.debug.horizontalLines || []).length;
  const profileLineCount =
    (segmentation.debug.profileVerticalLines || []).length + (segmentation.debug.profileHorizontalLines || []).length;
  const fallbackPenalty = segmentation.debug.fallbackUsed ? 6 : 0;
  const score =
    lineCount * 3 +
    profileLineCount -
    blankCount * 2.2 +
    averageDarkRatio * 900 -
    averageCenterOffset * 120 -
    fallbackPenalty;

  return {
    blankCount,
    averageDarkRatio: Math.round(averageDarkRatio * 10000) / 10000,
    averageCenterOffset: Math.round(averageCenterOffset * 10000) / 10000,
    lineCount,
    profileLineCount,
    fallbackUsed: Boolean(segmentation.debug.fallbackUsed),
    score: Math.round(score * 100) / 100
  };
}

function describeBoundaryGuideSource(source) {
  const sourceMap = {
    rectified: 'rectified',
    preferred: 'preferred',
    localized: 'localized',
    'manual-override': 'manual-override',
    'manual-none': 'manual-none',
    none: 'none'
  };
  return sourceMap[source] || String(source || 'unknown');
}

function shouldEnableSegmentationModeProbe(modePolicy = null, segmentationOptions = null) {
  if (Object.prototype.hasOwnProperty.call(segmentationOptions || {}, 'modePolicyProbe')) {
    return Boolean(segmentationOptions.modePolicyProbe);
  }
  if (!modePolicy || modePolicy.manualBoundaryGuidesOverride || modePolicy.manualForceUniformOverride) {
    return false;
  }
  return true;
}

function pickSecondaryBoundaryGuideSource(modePolicy = null, boundaryGuideCandidates = {}) {
  if (!modePolicy || !Array.isArray(modePolicy.boundaryGuidePriority)) {
    return null;
  }
  for (const source of modePolicy.boundaryGuidePriority) {
    if (!source || source === modePolicy.selectedBoundaryGuideSource) {
      continue;
    }
    if (boundaryGuideCandidates[source]) {
      return source;
    }
  }
  return null;
}

function shouldReplaceWithSecondaryCandidate(primaryQuality, secondaryQuality) {
  if (!secondaryQuality) {
    return false;
  }
  if (!primaryQuality) {
    return true;
  }
  if (secondaryQuality.score > primaryQuality.score + 2) {
    return true;
  }
  if (
    primaryQuality.fallbackUsed
    && !secondaryQuality.fallbackUsed
    && secondaryQuality.score >= primaryQuality.score - 1
  ) {
    return true;
  }
  if (
    secondaryQuality.blankCount + 2 <= primaryQuality.blankCount
    && secondaryQuality.score >= primaryQuality.score - 0.5
  ) {
    return true;
  }
  return false;
}

class HanziPipelinePlugin {
  constructor() {
    this.name = '00_hanzi_pipeline';
    this.version = '1.0.0';
  }

  async execute(params) {
    const hasProvidedGridRows = Object.prototype.hasOwnProperty.call(params || {}, 'gridRows');
    const hasProvidedGridCols = Object.prototype.hasOwnProperty.call(params || {}, 'gridCols');
    const {
      imagePath,
      outputRootDir,
      gridRows = DEFAULT_GRID_ROWS,
      gridCols = DEFAULT_GRID_COLS,
      gridType = 'square',
      target_chars = [],
      recognized_chars = null,
      task_id = null,
      image_id = null,
      trimContent = false,
      cropToGrid = true,
      pageBounds = null,
      scoringOptions = {},
      preprocessOptions = {},
      segmentationOptions = {},
      autoUseEstimatedGrid = true,
      maxStep = 7
    } = params || {};

    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }
    if (!outputRootDir) {
      throw new Error('outputRootDir参数是必需的');
    }

    const baseName = path.basename(imagePath, path.extname(imagePath));
    const layout = buildPipelineLayout(outputRootDir, baseName);
    const {
      fileRootDir,
      locateDir,
      rectifyDir,
      textRectDir,
      gridCountDir,
      segmentationDir,
      cellLayerDir,
      scoringDir,
      scoringCellDir,
      scoringPageRenderDir,
      scoringResultDir,
      locatePaperBoundsImagePath,
      locatePaperCropPath,
      locateMetaPath,
      rectifyA4ConstraintImagePath,
      rectifyA4ConstraintMetaPath,
      quadDebugPath,
      quadMetaPath,
      preprocessPath,
      preprocessWarpedPath,
      preprocessNeutralGuideRemovedPath,
      preprocessMetaPath,
      preprocessGridCornerAnnotatedPath,
      preprocessGridBackgroundMaskPath,
      preprocessGridRectifiedPath,
      preprocessGridRectifiedMetaPath,
      preprocessGridStageMetaPath,
      textRectBoundsMetaPath,
      textRectAnnotatedPath,
      textRectWarpedPath,
      gridCountEstimatedImagePath,
      gridCountAnnotatedPath,
      gridCountMetaPath,
      gridCountCarryForwardPath,
      segmentationCellsDir,
      cellLayerOutputDir,
      scoringAnnotatedPath,
      scoringSummaryPath,
      scoringJsonPath
    } = layout;

    await ensureDir(fileRootDir);
    await ensureDir(locateDir);
    await ensureDir(rectifyDir);
    await ensureDir(textRectDir);
    const preprocessGuideRemovedPath = preprocessNeutralGuideRemovedPath;

    const finish = async (payload = {}) => {
      const result = {
        imagePath,
        baseName,
        completedStep: payload.completedStep ?? 0,
        stoppedAtStep: payload.stoppedAtStep ?? null,
        outputs: {
          rootDir: outputRootDir,
          fileRootDir,
          ...(payload.outputs || {})
        },
        preprocessing: payload.preprocessing ?? null,
        estimatedGrid: payload.estimatedGrid ?? null,
        effectiveGrid: payload.effectiveGrid ?? null,
        gridCount: payload.gridCount ?? null,
        segmentation: payload.segmentation ?? null,
        segmentationModePolicy: payload.segmentationModePolicy ?? null,
        cellLayerExtraction: payload.cellLayerExtraction ?? null,
        segmentationSelection: payload.segmentationSelection ?? null,
        scoring: payload.scoring ?? null
      };
      await fs.promises.writeFile(
        path.join(fileRootDir, 'pipeline_result.json'),
        `${JSON.stringify(result, null, 2)}\n`,
        'utf8'
      );
      return result;
    };

    const a4Extract = await a4PaperExtractPlugin.execute({
      stageInputPath: imagePath,
      outputDir: locateDir,
      paperCropOutputPath: locatePaperCropPath
    });
    const stage01OutputImagePath = a4Extract.stageOutputImagePath || a4Extract.paperCropOutputPath || locatePaperCropPath;
    if (!stage01OutputImagePath || !fs.existsSync(stage01OutputImagePath)) {
      throw new Error('01阶段未产出唯一标准输出图，禁止进入02阶段');
    }
    const locateStepArtifacts = buildStageStepArtifacts(a4Extract.stepDirs, a4Extract.stepMetaPaths);
    const locateStageInfoPath = await writePipelineStageInfo('locate', {
      stageDir: locateDir,
      imagePath,
      keyOutputs: buildLocateStageKeyOutputs({
        locatePaperBoundsImagePath,
        stage01OutputImagePath,
        locateMetaPath
      }),
      processChain: PIPELINE_STAGE_PROCESS_CHAINS.locate,
      ...locateStepArtifacts
    });
    const { stepMetaPaths: locateStepMetaPaths, stepDirs: locateStepDirs } = locateStepArtifacts;
    const locatePreprocessFieldMap = buildLocatePreprocessFieldMap({
      locateDir,
      locateImagePath: stage01OutputImagePath,
      locateMetaPath,
      locateStepMetaPaths,
      locateStepDirs,
      locateStageInfoPath,
      stageOutputImagePath: stage01OutputImagePath
    });
    const preprocessOutputStep1 = buildPreprocessOutputSnapshot(locatePreprocessFieldMap, 'step1');
    if (maxStep <= 1) {
      return finish(createPipelineProgressPayload(
        1,
        'step1',
        {
          preprocess: preprocessOutputStep1
        }
      ));
    }

    const locatePerspectiveInputPath = stage01OutputImagePath;
    const a4Rectify = await a4RectifyPlugin.execute({
      stageInputPath: locatePerspectiveInputPath,
      outputDir: rectifyDir,
      gridRows,
      gridCols,
      gridType,
      preprocessOptions: {
        outputPath: preprocessPath,
        warpedOutputPath: preprocessWarpedPath,
        guideRemovedOutputPath: preprocessGuideRemovedPath,
        neutralGuideRemovedOutputPath: preprocessNeutralGuideRemovedPath,
        outputMetaPath: preprocessMetaPath,
        outputDebugPath: quadDebugPath,
        cropToPaper: false,
        ...preprocessOptions
      }
    });
    const preprocessing = a4Rectify.result;
    const stage02OutputImagePath = a4Rectify.stageOutputImagePath || a4Rectify.outputs?.stageOutputImagePath || a4Rectify.outputs?.outputPath || preprocessPath;
    if (!stage02OutputImagePath || !fs.existsSync(stage02OutputImagePath)) {
      throw new Error('02阶段未产出唯一标准输出图，禁止进入03阶段');
    }
    const {
      stepDirs: step02Dirs,
      stepMetaPaths: step02MetaPaths
    } = buildStepOutputMaps(a4Rectify.outputs || {}, A4_RECTIFY_STEP_OUTPUT_FIELDS);

    const rectifyStageInfoPath = await writePipelineStageInfo('rectify', {
      stageDir: rectifyDir,
      imagePath,
      stageInputPath: locatePerspectiveInputPath,
      keyOutputs: buildRectifyStageKeyOutputs({
        locatePerspectiveInputPath,
        rectifyA4ConstraintMetaPath,
        rectifyA4ConstraintImagePath,
        preprocessPath,
        stage02OutputImagePath,
        preprocessWarpedPath,
        preprocessGuideRemovedPath,
        preprocessNeutralGuideRemovedPath,
        preprocessMetaPath,
        quadMetaPath,
        quadDebugPath
      }),
      stepDirs: step02Dirs,
      stepMetaPaths: step02MetaPaths,
      processChain: PIPELINE_STAGE_PROCESS_CHAINS.rectify
    });
    const rectifyPreprocessFieldMap = buildRectifyPreprocessFieldMap({
      locateFieldMap: locatePreprocessFieldMap,
      quadDebugPath,
      quadMetaPath,
      rectifyDir,
      paperCropImagePath: stage01OutputImagePath,
      preprocessPath,
      rectifyA4ConstraintMetaPath,
      preprocessWarpedPath,
      preprocessGuideRemovedPath,
      preprocessNeutralGuideRemovedPath,
      stageOutputImagePath: stage02OutputImagePath,
      preprocessMetaPath,
      rectifyStageInfoPath,
      step02MetaPaths,
      step02Dirs
    });
    const preprocessOutputStep2 = buildPreprocessOutputSnapshot(rectifyPreprocessFieldMap, 'step2');
    if (maxStep <= 2) {
      return finish(createPipelineProgressPayload(
        2,
        'step2',
        {
          preprocess: preprocessOutputStep2
        },
        {
          preprocessing
        }
      ));
    }

    const textRectMeta = await gridOuterRectExtractPlugin.execute({
      baseName,
      stageInputPath: stage02OutputImagePath,
      gridRows,
      gridCols,
      outputDir: textRectDir,
      gridStageMetaPath: preprocessGridStageMetaPath,
      gridStageMaskPath: preprocessGridBackgroundMaskPath,
      gridStageRectifiedPath: preprocessGridRectifiedPath,
      gridStageRectifiedMetaPath: preprocessGridRectifiedMetaPath,
      textRectMetaPath: textRectBoundsMetaPath,
      textRectAnnotatedPath,
      textRectWarpedPath
    });
    const localizedBoundaryGuides = textRectMeta.localizedBoundaryGuides || null;
    const preferredBoundaryGuides = pickPreferredBoundaryGuides(textRectMeta, gridRows, gridCols);
    const patternProfile = resolvePatternProfile(textRectMeta);
    const runtimeScoringOptions = buildGridTypeScopedScoringOptions(scoringOptions, patternProfile, gridType);
    let rectifiedBoundaryGuides = null;
    if (preprocessGridRectifiedPath) {
      const rectifiedMeta = await sharp(preprocessGridRectifiedPath).metadata();
      rectifiedBoundaryGuides = fitBoundaryGuidesToImage(
        preferredBoundaryGuides,
        rectifiedMeta.width || 0,
        rectifiedMeta.height || 0
      );
    }
    const textRectAnnotatedOutputPath = textRectMeta.annotatedImagePath;
    const textRectWarpedOutputPath = textRectMeta.warpedCropPath;
    const gridSegmentationInputOutputPath = textRectMeta.gridSegmentationInputPath;
    if (
      !textRectAnnotatedOutputPath ||
      !textRectWarpedOutputPath ||
      !gridSegmentationInputOutputPath
    ) {
      throw new Error('03阶段未完整产出后续所需文件，禁止回退到预设默认路径');
    }
    const textRectStepArtifacts = buildStageStepArtifacts(textRectMeta.stepDirs, textRectMeta.stepMetaPaths);
    const textRectStageInfoPath = await writePipelineStageInfo('textRect', {
      stageDir: textRectDir,
      imagePath,
      stageInputPath: stage02OutputImagePath,
      keyOutputs: buildTextRectStageKeyOutputs({
        preprocessPath,
        preprocessGridCornerAnnotatedPath,
        preprocessGridBackgroundMaskPath,
        textRectAnnotatedOutputPath,
        textRectWarpedOutputPath,
        textRectBoundsMetaPath
      }),
      processChain: PIPELINE_STAGE_PROCESS_CHAINS.textRect,
      ...textRectStepArtifacts
    });
    const { stepMetaPaths: textRectStepMetaPaths, stepDirs: textRectStepDirs } = textRectStepArtifacts;
    const textRectPreprocessFieldMap = buildTextRectPreprocessFieldMap({
      rectifyFieldMap: rectifyPreprocessFieldMap,
      textRectDir,
      textRectBoundsMetaPath,
      textRectStepMetaPaths,
      textRectStepDirs,
      textRectStageInfoPath,
      textRectAnnotatedOutputPath,
      textRectWarpedOutputPath,
      gridSegmentationInputOutputPath,
      preprocessGuideRemovedPath,
      preprocessNeutralGuideRemovedPath,
      preprocessGridBackgroundMaskPath,
      preprocessGridRectifiedPath,
      preprocessGridRectifiedMetaPath,
      preprocessGridStageMetaPath
    });
    const preprocessSnapshots = buildPreprocessProfileSnapshots(
      textRectPreprocessFieldMap,
      ['step3', 'step4', 'step5', 'step6', 'final'],
      {
        step6: {
          locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath
        }
      }
    );
    const preprocessOutputStep3 = preprocessSnapshots.step3;
    const preprocessOutputStep4 = preprocessSnapshots.step4;
    const preprocessOutputStep5 = preprocessSnapshots.step5;
    const preprocessOutputStep6 = preprocessSnapshots.step6;
    const preprocessOutputFinal = preprocessSnapshots.final;
    if (maxStep <= 3) {
      return finish(createPipelineProgressPayload(
        3,
        'step3',
        {
          preprocess: preprocessOutputStep3
        },
        {
          preprocessing
        }
      ));
    }

    let estimatedGrid = null;
    try {
      estimatedGrid = await estimateGridSize(textRectWarpedOutputPath);
    } catch (error) {
      estimatedGrid = preprocessing.gridEstimation || {
        error: error.message
      };
    }

    const effectiveGrid = resolveEffectiveGrid({
      providedRows: gridRows,
      providedCols: gridCols,
      hasProvidedRows: hasProvidedGridRows,
      hasProvidedCols: hasProvidedGridCols,
      estimatedGrid,
      autoUseEstimatedGrid
    });
    const effectiveGridRows = effectiveGrid.rows;
    const effectiveGridCols = effectiveGrid.cols;

    await ensureDir(gridCountDir);
    const gridCount = await gridCountAnnotatePlugin.execute({
      imagePath: textRectWarpedOutputPath,
      outputAnnotatedPath: gridCountAnnotatedPath,
      outputMetaPath: gridCountMetaPath,
      outputCarryForwardPath: gridCountCarryForwardPath,
      gridRows: effectiveGridRows,
      gridCols: effectiveGridCols,
      source: effectiveGrid.sourceLabel,
      processNo: '04'
    });
    const gridCountStepArtifacts = buildStageStepArtifacts(gridCount.stepDirs, gridCount.stepMetaPaths);
    const gridCountStageInfoPath = await writePipelineStageInfo('gridCount', {
      stageDir: gridCountDir,
      imagePath,
      stageInputPath: textRectWarpedOutputPath,
      keyOutputs: buildGridCountStageKeyOutputs({
        textRectWarpedOutputPath,
        gridCountEstimatedImagePath,
        gridCountMetaPath,
        gridCount,
        gridCountAnnotatedPath,
        gridCountCarryForwardPath
      }),
      processChain: PIPELINE_STAGE_PROCESS_CHAINS.gridCount,
      ...gridCountStepArtifacts
    });
    const gridCountOutputSnapshot = buildGridCountOutputSnapshot(gridCount, {
      dir: gridCountDir,
      annotatedPath: gridCountAnnotatedPath,
      carryForwardInputPath: gridCountCarryForwardPath,
      metaPath: gridCountMetaPath,
      stageInfoPath: gridCountStageInfoPath
    });
    if (maxStep <= 4) {
      return finish(createPipelineProgressPayload(
        4,
        'step4',
        {
          preprocess: preprocessOutputStep4,
          gridCount: gridCountOutputSnapshot
        },
        {
          preprocessing,
          estimatedGrid,
          effectiveGrid,
          gridCount
        }
      ));
    }

    const segmentationInputImagePath = gridCount.carryForwardInputPath || gridCountCarryForwardPath;
    const segmentationModeResolution = resolveSegmentationModePolicy({
      textRectMeta,
      rectifiedBoundaryGuides,
      preferredBoundaryGuides,
      localizedBoundaryGuides,
      patternProfile,
      segmentationOptions
    });
    const segmentationModePolicy = segmentationModeResolution.policy;
    const boundaryGuideCandidates = segmentationModeResolution.boundaryGuideCandidates || {};
    const {
      boundaryGuides: _ignoredBoundaryGuides,
      forceUniformGrid: _ignoredForceUniformGrid,
      modePolicyProbe: _ignoredModePolicyProbe,
      ...segmentationRuntimeOptions
    } = segmentationOptions || {};
    const segmentationSourceStep = inferSegmentationSourceStep(
      segmentationInputImagePath,
      {
        gridCountCarryForwardPath,
        gridRectifiedPath: preprocessGridRectifiedPath,
        gridSegmentationInputPath: gridSegmentationInputOutputPath
      }
    );
    const runSegmentationCandidate = async ({ outputDir, boundaryGuides, forceUniformGrid }) => {
      return segmentationPlugin.execute({
        imagePath: segmentationInputImagePath,
        sourceStep: segmentationSourceStep,
        returnBase64: false,
        outputDir,
        gridRows: effectiveGridRows,
        gridCols: effectiveGridCols,
        trimContent,
        cropToGrid: true,
        pageBounds,
        boundaryGuides,
        patternProfile,
        forceUniformGrid,
        gridGuideMaskPath: null,
        outputPrefix: '05',
        ...segmentationRuntimeOptions
      });
    };
    await ensureDir(segmentationDir);
    let segmentation = await runSegmentationCandidate({
      outputDir: segmentationCellsDir,
      boundaryGuides: segmentationModeResolution.boundaryGuides,
      forceUniformGrid: segmentationModeResolution.forceUniformGrid
    });
    const primaryQuality = await estimateSegmentationQuality(
      segmentationInputImagePath,
      segmentation
    );
    let selectedCandidate = {
      source: segmentationModePolicy.selectedBoundaryGuideSource || 'primary',
      sourceLabel: describeBoundaryGuideSource(segmentationModePolicy.selectedBoundaryGuideSource || 'primary'),
      forceUniformGrid: segmentationModeResolution.forceUniformGrid,
      quality: primaryQuality,
      selected: true
    };
    const candidateList = [
      {
        ...selectedCandidate
      }
    ];
    const modeProbeEnabled = shouldEnableSegmentationModeProbe(segmentationModePolicy, segmentationOptions);
    let modeProbeCompared = false;
    let modeProbePromoted = false;
    if (modeProbeEnabled) {
      const secondarySource = pickSecondaryBoundaryGuideSource(
        segmentationModePolicy,
        boundaryGuideCandidates
      );
      if (secondarySource && boundaryGuideCandidates[secondarySource]) {
        modeProbeCompared = true;
        const probeTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'seg-mode-probe-'));
        try {
          const secondarySegmentation = await runSegmentationCandidate({
            outputDir: path.join(probeTempDir, '05_4_单格图'),
            boundaryGuides: boundaryGuideCandidates[secondarySource],
            forceUniformGrid: segmentationModeResolution.forceUniformGrid
          });
          const secondaryQuality = await estimateSegmentationQuality(
            segmentationInputImagePath,
            secondarySegmentation
          );
          const secondaryCandidate = {
            source: secondarySource,
            sourceLabel: describeBoundaryGuideSource(secondarySource),
            forceUniformGrid: segmentationModeResolution.forceUniformGrid,
            quality: secondaryQuality,
            selected: false
          };
          candidateList.push(secondaryCandidate);
          if (shouldReplaceWithSecondaryCandidate(primaryQuality, secondaryQuality)) {
            modeProbePromoted = true;
            segmentation = await runSegmentationCandidate({
              outputDir: segmentationCellsDir,
              boundaryGuides: boundaryGuideCandidates[secondarySource],
              forceUniformGrid: segmentationModeResolution.forceUniformGrid
            });
            selectedCandidate = {
              ...secondaryCandidate,
              selected: true
            };
          }
        } catch (probeError) {
          candidateList.push({
            source: secondarySource,
            sourceLabel: describeBoundaryGuideSource(secondarySource),
            forceUniformGrid: segmentationModeResolution.forceUniformGrid,
            quality: {
              blankCount: -1,
              averageDarkRatio: 0,
              averageCenterOffset: 0,
              lineCount: 0,
              profileLineCount: 0,
              fallbackUsed: true,
              score: -9999
            },
            error: probeError.message,
            selected: false
          });
        } finally {
          await fs.promises.rm(probeTempDir, { recursive: true, force: true });
        }
      }
    }
    const effectiveSegmentationModePolicy = {
      ...segmentationModePolicy,
      modeProbeEnabled,
      modeProbeCompared,
      modeProbePromoted,
      selectedBoundaryGuideSource: selectedCandidate.source,
      selectedForceUniformGrid: selectedCandidate.forceUniformGrid
    };
    const segmentationSelection = {
      selectedSource: selectedCandidate.sourceLabel,
      selectedImagePath: segmentationInputImagePath,
      quality: selectedCandidate.quality,
      candidates: candidateList.map((candidate) => ({
        ...candidate,
        selected: candidate.source === selectedCandidate.source
      })),
      modePolicy: effectiveSegmentationModePolicy
    };
    const segmentationOutputSnapshot = buildSegmentationOutputSnapshot(segmentation);

    const segmentationStageInfoPath = await writePipelineStageInfo('segmentation', {
      stageDir: segmentationDir,
      imagePath,
      stageInputPath: segmentationSelection.selectedImagePath,
      keyOutputs: buildSegmentationStageKeyOutputs({
        segmentationSelection,
        segmentationOutputSnapshot,
        effectiveSegmentationModePolicy
      }),
      stepDirs: segmentationOutputSnapshot.stepDirs,
      stepMetaPaths: segmentationOutputSnapshot.stepMetaPaths
    });
    const segmentationStageOutputSnapshot = buildSegmentationStageOutputSnapshot(segmentation, {
      dir: segmentationDir,
      stageInfoPath: segmentationStageInfoPath
    });
    if (maxStep <= 5) {
      return finish(createPipelineProgressPayload(
        5,
        'step5',
        {
          preprocess: preprocessOutputStep5,
          gridCount: gridCountOutputSnapshot,
          segmentation: segmentationStageOutputSnapshot
        },
        {
          preprocessing,
          estimatedGrid,
          effectiveGrid,
          gridCount,
          segmentation,
          segmentationModePolicy: effectiveSegmentationModePolicy,
          segmentationSelection
        }
      ));
    }

    await ensureDir(cellLayerDir);
    const cellLayerExtraction = await cellLayerExtractPlugin.execute({
      segmentation,
      inputPath: segmentationSelection.selectedImagePath,
      outputDir: cellLayerOutputDir,
      outputPrefix: '06',
      patternProfile,
      options: runtimeScoringOptions
    });
    const cellLayerOutputSnapshot = buildCellLayerOutputSnapshot(cellLayerExtraction);
    const cellLayerStageInfoPath = await writePipelineStageInfo('cellLayer', {
      stageDir: cellLayerDir,
      imagePath,
      stageInputPath: segmentationSelection.selectedImagePath,
      keyOutputs: buildCellLayerStageKeyOutputs({
        segmentationSelection,
        cellLayerOutputSnapshot
      }),
      stepDirs: cellLayerOutputSnapshot.stepDirs
    });
    const cellLayerStageOutputSnapshot = buildCellLayerStageOutputSnapshot(cellLayerExtraction, {
      dir: cellLayerDir,
      stageInfoPath: cellLayerStageInfoPath
    });
    if (maxStep <= 6) {
      return finish(createPipelineProgressPayload(
        6,
        'step6',
        {
          preprocess: preprocessOutputStep6,
          segmentation: segmentationStageOutputSnapshot,
          gridCount: gridCountOutputSnapshot,
          cellLayerExtraction: cellLayerStageOutputSnapshot
        },
        {
          preprocessing,
          estimatedGrid,
          effectiveGrid,
          gridCount,
          segmentation,
          segmentationModePolicy: effectiveSegmentationModePolicy,
          cellLayerExtraction,
          segmentationSelection
        }
      ));
    }

    await ensureDir(scoringPageRenderDir);
    await ensureDir(scoringResultDir);
    const scoring = await scoringPlugin.execute({
      task_id: task_id || `pipeline-${baseName}`,
      image_id: image_id || baseName,
      imagePath: segmentationSelection.selectedImagePath,
      outputDir: scoringCellDir,
      outputAnnotatedPath: scoringAnnotatedPath,
      outputSummaryPath: scoringSummaryPath,
      target_chars,
      recognized_chars,
      segmentation,
      cellLayerExtraction,
      options: runtimeScoringOptions
    });
    const scoringOutputSnapshot = buildScoringOutputSnapshot(scoring);

    await fs.promises.writeFile(scoringJsonPath, JSON.stringify(scoring, null, 2), 'utf8');
    const scoringStageInfoPath = await writePipelineStageInfo('scoring', {
      stageDir: scoringDir,
      imagePath,
      stageInputPath: segmentationSelection.selectedImagePath,
      keyOutputs: buildScoringStageKeyOutputs({
        segmentationSelection,
        scoringOutputSnapshot,
        scoringPageRenderDir,
        scoringResultDir,
        scoringAnnotatedPath,
        scoringSummaryPath,
        scoringJsonPath
      })
    });
    const scoringStageOutputSnapshot = buildScoringStageOutputSnapshot(scoring, {
      dir: scoringDir,
      pageRenderDir: scoringPageRenderDir,
      pageResultDir: scoringResultDir,
      annotatedImagePath: scoringAnnotatedPath,
      summaryPath: scoringSummaryPath,
      jsonPath: scoringJsonPath,
      stageInfoPath: scoringStageInfoPath
    });
    return finish(createPipelineProgressPayload(
      7,
      'final',
      {
        preprocess: preprocessOutputFinal,
        segmentation: segmentationStageOutputSnapshot,
        gridCount: gridCountOutputSnapshot,
        cellLayerExtraction: cellLayerStageOutputSnapshot,
        scoring: scoringStageOutputSnapshot
      },
      {
        preprocessing,
        estimatedGrid,
        effectiveGrid,
        gridCount,
        segmentation,
        segmentationModePolicy: effectiveSegmentationModePolicy,
        cellLayerExtraction,
        segmentationSelection,
        scoring
      },
      {
        stoppedAtStep: null
      }
    ));
  }
}

module.exports = new HanziPipelinePlugin();
