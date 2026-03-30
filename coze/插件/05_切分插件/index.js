const fs = require('fs');
const path = require('path');
const { segmentHanzi, matrixToBase64, saveMatrixToFiles } = require('./hanzi_segmentation');
const { DEFAULT_GRID_ROWS, DEFAULT_GRID_COLS } = require('../utils/grid_spec');
const { resolveSegmentationArtifactPolicy } = require('../utils/artifact_policy');
const {
  resolveStageImageJsonInput,
  buildStageImageHandoffContract
} = require('../utils/stage_image_contract');
const {
  SEGMENTATION_STAGE_DEFINITION,
  SEGMENTATION_STEP_DEFINITIONS,
  SEGMENTATION_SOURCE_STEPS
} = require('./step_definitions');

function formatCellFileName(row, col) {
  return `05_单格_row${String(row + 1).padStart(2, '0')}_col${String(col + 1).padStart(2, '0')}.png`;
}

function isDefaultContentBox(contentBox, pageBox) {
  if (!contentBox || !pageBox) {
    return false;
  }
  return (
    contentBox.left === 0 &&
    contentBox.top === 0 &&
    contentBox.width === pageBox.width &&
    contentBox.height === pageBox.height
  );
}

function compactCellMeta(cell, cellsDir = null) {
  if (!cell) {
    return cell;
  }
  return {
    row: cell.row,
    col: cell.col,
    cellFileName: formatCellFileName(cell.row, cell.col),
    imagePath: cellsDir ? path.join(cellsDir, formatCellFileName(cell.row, cell.col)) : null,
    pageBox: cell.pageBox,
    ...(isDefaultContentBox(cell.contentBox, cell.pageBox) ? {} : { contentBox: cell.contentBox || null })
  };
}

function withValue(key, value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (Array.isArray(value) && value.length === 0) {
    return {};
  }
  return { [key]: value };
}

function compactDebugMeta(debug) {
  if (!debug) {
    return null;
  }

  return {
    threshold: debug.threshold,
    workingSize: debug.workingSize,
    boundaryGuides: debug.boundaryGuides,
    patternProfile: debug.patternProfile || null,
    segmentationProfile: debug.segmentationProfile || null,
    debugLegend: debug.debugLegend,
    guideMaskUsed: Boolean(debug.guideMaskUsed),
    ...withValue('gridGuideMaskPath', debug.gridGuideMaskPath),
    ...withValue('verticalCandidates', debug.verticalCandidates),
    ...withValue('verticalLines', debug.verticalLines),
    ...withValue('outerRectVerticalLines', debug.outerRectVerticalLines),
    ...withValue('selectedBoundaryMode', debug.selectedBoundaryMode),
    ...withValue('directBoundaryQuality', debug.directBoundaryQuality),
    ...withValue('outerRectBoundaryQuality', debug.outerRectBoundaryQuality),
    ...withValue('horizontalLinesBeforeAnomalousCorrection', debug.horizontalLinesBeforeAnomalousCorrection),
    ...withValue('horizontalLinesBeforeCorrection', debug.horizontalLinesBeforeCorrection),
    ...withValue('horizontalLines', debug.horizontalLines),
    ...withValue('outerRectHorizontalLines', debug.outerRectHorizontalLines),
    ...withValue('leftHorizontalLines', debug.leftHorizontalLines),
    ...withValue('rightHorizontalLines', debug.rightHorizontalLines),
    ...withValue('sideConsensusHorizontalLines', debug.sideConsensusHorizontalLines),
    ...withValue('profileVerticalLines', debug.profileVerticalLines),
    ...withValue('profileHorizontalLines', debug.profileHorizontalLines),
    ...withValue('guidePeakMode', debug.guidePeakMode),
    ...withValue('guideAxisModes', debug.guideAxisModes),
    ...withValue('guideCountRelations', debug.guideCountRelations),
    ...withValue('guideSpanModes', debug.guideSpanModes),
    ...withValue('guideSpanPadding', debug.guideSpanPadding),
    ...withValue('guideSpanPaddingDetail', debug.guideSpanPaddingDetail),
    ...withValue('guidePatternFallback', debug.guidePatternFallback),
    ...withValue('guideResolvedPeakFallback', debug.guideResolvedPeakFallback),
    ...withValue('guideExplicitCenterFallback', debug.guideExplicitCenterFallback),
    ...withValue('guideExplicitOuterBounds', debug.guideExplicitOuterBounds),
    ...withValue('guidePatternProfile', debug.guidePatternProfile),
    ...withValue('guideAnchorPreference', debug.guideAnchorPreference),
    ...withValue('xPattern', debug.xPattern),
    ...withValue('yPattern', debug.yPattern),
    ...withValue('horizontalCorrections', debug.horizontalCorrections),
    fallbackUsed: Boolean(debug.fallbackUsed)
  };
}

/**
 * Coze插件：汉字切分
 * 用于书法评分中的汉字图像提取
 */
class HanziSegmentationPlugin {
  constructor() {
    this.name = '05_单格切分';
    this.version = '1.0.0';
  }

  /**
   * 执行插件
   * @param {Object} params - 参数对象
   * @param {string} params.imagePath - 图像路径
   * @param {boolean} params.returnBase64 - 是否返回base64（默认true）
   * @param {string} params.outputDir - 输出目录（可选，用于调试）
   * @param {number} params.gridRows - 方格行数，默认7
   * @param {number} params.gridCols - 方格列数，默认10
   * @param {boolean} params.trimContent - 是否将单格继续裁到汉字内容区域，默认false
   * @param {boolean} params.cropToGrid - 是否先裁出整页中的网格区域，默认true
   * @param {Object} params.pageBounds - 手动指定纸面/网格范围，可选
   * @param {string} params.debugOutputPath - 网格调试可视化图保存路径，可选
   * @param {string} params.debugMetaPath - 网格调试元数据JSON保存路径，可选
   * @param {string} params.artifactLevel - 产物级别：minimal/standard/debug
   * @returns {Promise<Object>} 结果对象
   */
  async execute(params) {
    const {
      stageInput = null,
      imagePath,
      stageInputMetaPath = null,
      returnBase64 = true,
      outputDir,
      sourceStep = SEGMENTATION_SOURCE_STEPS.stageInput,
      gridRows,
      gridCols,
      trimContent = false,
      cropToGrid = true,
      pageBounds,
      boundaryGuides = null,
      forceUniformGrid = false,
      patternProfile = null,
      gridGuideMaskPath = null,
      outputPrefix = '02',
      debugOutputPath,
      debugMetaPath,
      artifactLevel,
      artifact_level
    } = params;

    const resolvedStageInput = resolveStageImageJsonInput({
      stageName: '05阶段',
      stageInput,
      imagePath,
      metaPath: stageInputMetaPath
    });
    const resolvedImagePath = resolvedStageInput.imagePath;
    let resolvedGridRows = Number.isInteger(gridRows) ? gridRows : null;
    let resolvedGridCols = Number.isInteger(gridCols) ? gridCols : null;

    if ((resolvedGridRows === null || resolvedGridCols === null) && resolvedStageInput.metaPath) {
      try {
        const inputMeta = JSON.parse(await fs.promises.readFile(resolvedStageInput.metaPath, 'utf8'));
        if (resolvedGridRows === null && Number.isInteger(inputMeta?.gridRows)) {
          resolvedGridRows = inputMeta.gridRows;
        }
        if (resolvedGridCols === null && Number.isInteger(inputMeta?.gridCols)) {
          resolvedGridCols = inputMeta.gridCols;
        }
      } catch (error) {
        // Keep defaults when the upstream JSON is missing or unreadable.
      }
    }
    resolvedGridRows = resolvedGridRows || DEFAULT_GRID_ROWS;
    resolvedGridCols = resolvedGridCols || DEFAULT_GRID_COLS;

    const artifactPolicy = resolveSegmentationArtifactPolicy({ artifactLevel, artifact_level });
    const stageDir = outputDir ? path.dirname(outputDir) : null;
    const step05_1Definition = SEGMENTATION_STEP_DEFINITIONS.step05_1;
    const step05_2Definition = SEGMENTATION_STEP_DEFINITIONS.step05_2;
    const step05_3Definition = SEGMENTATION_STEP_DEFINITIONS.step05_3;
    const step05_4Definition = SEGMENTATION_STEP_DEFINITIONS.step05_4;
    const step05_1Dir = stageDir && artifactPolicy.emitStep05_1
      ? path.join(stageDir, step05_1Definition.dirName)
      : null;
    const step05_2Dir = stageDir && artifactPolicy.emitStep05_2
      ? path.join(stageDir, step05_2Definition.dirName)
      : null;
    const step05_3Dir = stageDir && artifactPolicy.emitStep05_3
      ? path.join(stageDir, step05_3Definition.dirName)
      : null;
    const step05_4Dir = stageDir && artifactPolicy.emitStep05_4
      ? path.join(stageDir, step05_4Definition.dirName)
      : null;
    const resolvedCellsDir = step05_4Dir ? path.join(step05_4Dir, path.basename(outputDir)) : outputDir;
    const resolvedDebugOutputPath = artifactPolicy.emitStep05_3
      ? (debugOutputPath || (step05_3Dir ? path.join(step05_3Dir, `${outputPrefix}_3_切分调试图.png`) : null))
      : null;
    const resolvedDebugMetaPath = artifactPolicy.emitStep05_3
      ? (debugMetaPath || (step05_3Dir ? path.join(step05_3Dir, `${outputPrefix}_3_切分调试信息.json`) : null))
      : null;

    if (step05_1Dir) await fs.promises.mkdir(step05_1Dir, { recursive: true });
    if (step05_2Dir) await fs.promises.mkdir(step05_2Dir, { recursive: true });
    if (step05_3Dir) await fs.promises.mkdir(step05_3Dir, { recursive: true });
    if (step05_4Dir) await fs.promises.mkdir(step05_4Dir, { recursive: true });
    if (resolvedCellsDir) await fs.promises.mkdir(resolvedCellsDir, { recursive: true });

    const { matrix, cells, gridBounds, alignmentStats, debug, stepResults = {} } = await segmentHanzi(resolvedImagePath, {
      gridRows: resolvedGridRows,
      gridCols: resolvedGridCols,
      trimContent,
      cropToGrid,
      pageBounds,
      boundaryGuides,
      forceUniformGrid,
      patternProfile,
      gridGuideMaskPath,
      debugOutputPath: resolvedDebugOutputPath,
      debugMetaPath: resolvedDebugMetaPath
    });

    if (resolvedCellsDir) {
      await saveMatrixToFiles(matrix, resolvedCellsDir);
    }

    let summaryPath = null;
    let step05_1MetaPath = null;
    let step05_2MetaPath = null;
    let step05_4MetaPath = null;
    const summaryDebug = compactDebugMeta(debug);
    const compactCells = cells.map((cell) => compactCellMeta(cell, resolvedCellsDir));

    if (resolvedCellsDir) {
      summaryPath = path.join(step05_4Dir || path.dirname(resolvedCellsDir), `${outputPrefix}_4_切分汇总.json`);
      const handoffContract = buildStageImageHandoffContract({
        stageName: '05阶段',
        processNo: SEGMENTATION_STAGE_DEFINITION.processNo,
        processName: SEGMENTATION_STAGE_DEFINITION.processName,
        stageInputPath: resolvedImagePath,
        stageInputMetaPath: resolvedStageInput.metaPath,
        stageOutputImagePath: resolvedImagePath,
        stageOutputMetaPath: summaryPath,
        nextStageInputPath: resolvedImagePath,
        nextStageInputMetaPath: summaryPath
      });
      await fs.promises.writeFile(
        summaryPath,
        `${JSON.stringify({
          processNo: SEGMENTATION_STAGE_DEFINITION.processNo,
          processName: SEGMENTATION_STAGE_DEFINITION.processName,
          sourceStep,
          stageInputPath: resolvedImagePath,
          stageInputMetaPath: resolvedStageInput.metaPath,
          gridRows: resolvedGridRows,
          gridCols: resolvedGridCols,
          totalCells: resolvedGridRows * resolvedGridCols,
          gridBounds,
          alignmentStats,
          patternProfile,
          debug: summaryDebug,
          cellsDir: resolvedCellsDir,
          cells: compactCells,
          stageOutputImagePath: resolvedImagePath,
          stageOutputMetaPath: summaryPath,
          nextStageInputPath: resolvedImagePath,
          nextStageInputMetaPath: summaryPath,
          stageInput: handoffContract.stageInput,
          stageOutput: handoffContract.stageOutput,
          nextStageInput: handoffContract.nextStageInput,
          handoffContract,
          显示信息: {
            阶段编号: SEGMENTATION_STAGE_DEFINITION.processNo,
            阶段名称: SEGMENTATION_STAGE_DEFINITION.processName,
            来源步骤: sourceStep,
            阶段输入图: resolvedImagePath,
            阶段输入JSON: resolvedStageInput.metaPath,
            行数: resolvedGridRows,
            列数: resolvedGridCols,
            总格数: resolvedGridRows * resolvedGridCols,
            单格输出目录: resolvedCellsDir
          }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    if (artifactPolicy.emitStep05_1 && step05_1Dir && stepResults.step05_1) {
      step05_1MetaPath = path.join(step05_1Dir, `${outputPrefix}_1_网格范围检测.json`);
      await fs.promises.writeFile(step05_1MetaPath, `${JSON.stringify(stepResults.step05_1, null, 2)}\n`, 'utf8');
    }
    if (artifactPolicy.emitStep05_2 && step05_2Dir && stepResults.step05_2) {
      step05_2MetaPath = path.join(step05_2Dir, `${outputPrefix}_2_边界引导切分.json`);
      await fs.promises.writeFile(step05_2MetaPath, `${JSON.stringify(stepResults.step05_2, null, 2)}\n`, 'utf8');
    }
    if (artifactPolicy.emitStep05_4 && step05_4Dir) {
      step05_4MetaPath = path.join(step05_4Dir, `${outputPrefix}_4_单格裁切.json`);
      await fs.promises.writeFile(
        step05_4MetaPath,
        `${JSON.stringify({
          processNo: step05_4Definition.processNo,
          processName: step05_4Definition.processName,
          sourceStep: SEGMENTATION_SOURCE_STEPS.step05_4,
          inputPath: resolvedImagePath,
          stageInputPath: resolvedImagePath,
          stageInputMetaPath: resolvedStageInput.metaPath,
          totalCells: compactCells.length,
          gridRows: resolvedGridRows,
          gridCols: resolvedGridCols,
          patternProfile,
          cellsDir: resolvedCellsDir,
          cells: compactCells,
          显示信息: {
            步骤编号: step05_4Definition.processNo,
            步骤名称: step05_4Definition.processName,
            阶段输入图: resolvedImagePath,
            总格数: compactCells.length,
            单格输出目录: resolvedCellsDir
          }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    return {
      artifactLevel: artifactPolicy.artifactLevel,
      processNo: SEGMENTATION_STAGE_DEFINITION.processNo,
      processName: SEGMENTATION_STAGE_DEFINITION.processName,
      sourceStep,
      stageInputPath: resolvedImagePath,
      stageInputMetaPath: resolvedStageInput.metaPath,
      gridRows: resolvedGridRows,
      gridCols: resolvedGridCols,
      totalCells: resolvedGridRows * resolvedGridCols,
      gridBounds,
      alignmentStats,
      debug,
      boundaryGuides,
      patternProfile,
      debugOutputPath: resolvedDebugOutputPath || null,
      debugMetaPath: resolvedDebugMetaPath || null,
      outputs: {
        artifactLevel: artifactPolicy.artifactLevel,
        stageInputPath: resolvedImagePath,
        stageInputMetaPath: resolvedStageInput.metaPath,
        stageOutputImagePath: resolvedImagePath,
        stageOutputMetaPath: summaryPath,
        nextStageInputPath: resolvedImagePath,
        nextStageInputMetaPath: summaryPath,
        cellsDir: resolvedCellsDir || null,
        summaryPath,
        stepDirs: {
          step05_1: step05_1Dir,
          step05_2: step05_2Dir,
          step05_3: step05_3Dir,
          step05_4: step05_4Dir
        },
        stepMetaPaths: {
          step05_1: step05_1MetaPath,
          step05_2: step05_2MetaPath,
          step05_3: resolvedDebugMetaPath || null,
          step05_4: step05_4MetaPath
        }
      },
      stageInput: buildStageImageHandoffContract({
        stageName: '05阶段',
        processNo: SEGMENTATION_STAGE_DEFINITION.processNo,
        processName: SEGMENTATION_STAGE_DEFINITION.processName,
        stageInputPath: resolvedImagePath,
        stageInputMetaPath: resolvedStageInput.metaPath,
        stageOutputImagePath: resolvedImagePath,
        stageOutputMetaPath: summaryPath,
        nextStageInputPath: resolvedImagePath,
        nextStageInputMetaPath: summaryPath
      }).stageInput,
      stageOutput: buildStageImageHandoffContract({
        stageName: '05阶段',
        processNo: SEGMENTATION_STAGE_DEFINITION.processNo,
        processName: SEGMENTATION_STAGE_DEFINITION.processName,
        stageInputPath: resolvedImagePath,
        stageInputMetaPath: resolvedStageInput.metaPath,
        stageOutputImagePath: resolvedImagePath,
        stageOutputMetaPath: summaryPath,
        nextStageInputPath: resolvedImagePath,
        nextStageInputMetaPath: summaryPath
      }).stageOutput,
      nextStageInput: buildStageImageHandoffContract({
        stageName: '05阶段',
        processNo: SEGMENTATION_STAGE_DEFINITION.processNo,
        processName: SEGMENTATION_STAGE_DEFINITION.processName,
        stageInputPath: resolvedImagePath,
        stageInputMetaPath: resolvedStageInput.metaPath,
        stageOutputImagePath: resolvedImagePath,
        stageOutputMetaPath: summaryPath,
        nextStageInputPath: resolvedImagePath,
        nextStageInputMetaPath: summaryPath
      }).nextStageInput,
      handoffContract: buildStageImageHandoffContract({
        stageName: '05阶段',
        processNo: SEGMENTATION_STAGE_DEFINITION.processNo,
        processName: SEGMENTATION_STAGE_DEFINITION.processName,
        stageInputPath: resolvedImagePath,
        stageInputMetaPath: resolvedStageInput.metaPath,
        stageOutputImagePath: resolvedImagePath,
        stageOutputMetaPath: summaryPath,
        nextStageInputPath: resolvedImagePath,
        nextStageInputMetaPath: summaryPath
      }),
      cells,
      matrix: returnBase64 ? matrixToBase64(matrix) : matrix
    };
  }
}

// 导出插件实例
module.exports = new HanziSegmentationPlugin();
