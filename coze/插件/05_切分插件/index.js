const fs = require('fs');
const path = require('path');
const { segmentHanzi, matrixToBase64, saveMatrixToFiles } = require('./hanzi_segmentation');

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

function compactCellMeta(cell) {
  if (!cell) {
    return cell;
  }
  return {
    row: cell.row,
    col: cell.col,
    cellFileName: formatCellFileName(cell.row, cell.col),
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
   * @param {number} params.gridRows - 方格行数，默认11
   * @param {number} params.gridCols - 方格列数，默认7
   * @param {boolean} params.trimContent - 是否将单格继续裁到汉字内容区域，默认false
   * @param {boolean} params.cropToGrid - 是否先裁出整页中的网格区域，默认true
   * @param {Object} params.pageBounds - 手动指定纸面/网格范围，可选
   * @param {string} params.debugOutputPath - 网格调试可视化图保存路径，可选
   * @param {string} params.debugMetaPath - 网格调试元数据JSON保存路径，可选
   * @returns {Promise<Object>} 结果对象
   */
  async execute(params) {
    const {
      imagePath,
      returnBase64 = true,
      outputDir,
      sourceStep = '03_总方格大矩形提取',
      gridRows = 11,
      gridCols = 7,
      trimContent = false,
      cropToGrid = true,
      pageBounds,
      boundaryGuides = null,
      forceUniformGrid = false,
      gridGuideMaskPath = null,
      outputPrefix = '02',
      debugOutputPath,
      debugMetaPath
    } = params;

    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }

    const stageDir = outputDir ? path.dirname(outputDir) : null;
    const step05_1Dir = stageDir ? path.join(stageDir, '05_1_网格范围检测') : null;
    const step05_2Dir = stageDir ? path.join(stageDir, '05_2_边界引导切分') : null;
    const step05_3Dir = stageDir ? path.join(stageDir, '05_3_切分调试渲染') : null;
    const step05_4Dir = stageDir ? path.join(stageDir, '05_4_单格裁切') : null;
    const resolvedCellsDir = step05_4Dir ? path.join(step05_4Dir, path.basename(outputDir)) : outputDir;
    const resolvedDebugOutputPath = debugOutputPath || (step05_3Dir ? path.join(step05_3Dir, `${outputPrefix}_3_切分调试图.png`) : null);
    const resolvedDebugMetaPath = debugMetaPath || (step05_3Dir ? path.join(step05_3Dir, `${outputPrefix}_3_切分调试信息.json`) : null);

    if (step05_1Dir) await fs.promises.mkdir(step05_1Dir, { recursive: true });
    if (step05_2Dir) await fs.promises.mkdir(step05_2Dir, { recursive: true });
    if (step05_3Dir) await fs.promises.mkdir(step05_3Dir, { recursive: true });
    if (step05_4Dir) await fs.promises.mkdir(step05_4Dir, { recursive: true });

    const { matrix, cells, gridBounds, alignmentStats, debug, stepResults = {} } = await segmentHanzi(imagePath, {
      gridRows,
      gridCols,
      trimContent,
      cropToGrid,
      pageBounds,
      boundaryGuides,
      forceUniformGrid,
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

    if (resolvedCellsDir) {
      summaryPath = path.join(step05_4Dir || path.dirname(resolvedCellsDir), `${outputPrefix}_4_切分汇总.json`);
      await fs.promises.writeFile(
        summaryPath,
        `${JSON.stringify({
          processNo: '05',
          processName: '05_单格切分',
          sourceStep,
          stageInputPath: imagePath,
          gridRows,
          gridCols,
          totalCells: gridRows * gridCols,
          gridBounds,
          alignmentStats,
          debug: summaryDebug,
          cellsDir: resolvedCellsDir,
          显示信息: {
            阶段编号: '05',
            阶段名称: '05_单格切分',
            来源步骤: sourceStep,
            阶段输入图: imagePath,
            行数: gridRows,
            列数: gridCols,
            总格数: gridRows * gridCols,
            单格输出目录: resolvedCellsDir
          }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    if (step05_1Dir && stepResults.step05_1) {
      step05_1MetaPath = path.join(step05_1Dir, `${outputPrefix}_1_网格范围检测.json`);
      await fs.promises.writeFile(step05_1MetaPath, `${JSON.stringify(stepResults.step05_1, null, 2)}\n`, 'utf8');
    }
    if (step05_2Dir && stepResults.step05_2) {
      step05_2MetaPath = path.join(step05_2Dir, `${outputPrefix}_2_边界引导切分.json`);
      await fs.promises.writeFile(step05_2MetaPath, `${JSON.stringify(stepResults.step05_2, null, 2)}\n`, 'utf8');
    }
    if (step05_4Dir) {
      step05_4MetaPath = path.join(step05_4Dir, `${outputPrefix}_4_单格裁切.json`);
      const compactCells = cells.map(compactCellMeta);
      await fs.promises.writeFile(
        step05_4MetaPath,
        `${JSON.stringify({
          processNo: '05_4',
          processName: '05_4_单格裁切',
          sourceStep: '05_2_边界引导切分',
          inputPath: imagePath,
          stageInputPath: imagePath,
          totalCells: compactCells.length,
          gridRows,
          gridCols,
          cellsDir: resolvedCellsDir,
          cells: compactCells,
          显示信息: {
            步骤编号: '05_4',
            步骤名称: '05_4_单格裁切',
            阶段输入图: imagePath,
            总格数: compactCells.length,
            单格输出目录: resolvedCellsDir
          }
        }, null, 2)}\n`,
        'utf8'
      );
    }

    return {
      gridRows,
      gridCols,
      totalCells: gridRows * gridCols,
      gridBounds,
      alignmentStats,
      debug,
      boundaryGuides,
      debugOutputPath: resolvedDebugOutputPath || null,
      debugMetaPath: resolvedDebugMetaPath || null,
      outputs: {
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
      cells,
      matrix: returnBase64 ? matrixToBase64(matrix) : matrix
    };
  }
}

// 导出插件实例
module.exports = new HanziSegmentationPlugin();
