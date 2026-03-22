const fs = require('fs');
const path = require('path');
const { extractCellLayers } = require('../07_评分插件/scoring');
const cellOriginalExportPlugin = require('../06_1单格原图导出插件/index');
const cellForegroundMaskPlugin = require('../06_2单格前景Mask插件/index');
const cellCleanedTextMaskPlugin = require('../06_3单格清洗文字Mask插件/index');
const cellTextOnlyPlugin = require('../06_4单格文字图插件/index');
const cellBackgroundOnlyPlugin = require('../06_5单格背景图插件/index');

function withValue(key, value) {
  if (value === null || value === undefined) {
    return {};
  }
  return { [key]: value };
}

function formatCellDirName(row, col) {
  return `row${String(row + 1).padStart(2, '0')}_col${String(col + 1).padStart(2, '0')}`;
}

function formatCellFileName(row, col) {
  return `05_单格_row${String(row + 1).padStart(2, '0')}_col${String(col + 1).padStart(2, '0')}.png`;
}

class CellLayerExtractPlugin {
  constructor() {
    this.name = '06_单格背景文字提取';
    this.version = '1.0.0';
  }

  async execute(params) {
    const {
      segmentation,
      outputDir,
      inputPath = null,
      outputSummaryPath = null,
      outputPrefix = '06',
      options = {}
    } = params || {};

    if (!segmentation || !Array.isArray(segmentation.matrix) || !Array.isArray(segmentation.cells)) {
      throw new Error('segmentation.matrix 和 segmentation.cells 是必需的');
    }
    if (!outputDir) {
      throw new Error('outputDir参数是必需的');
    }

    await fs.promises.mkdir(outputDir, { recursive: true });
    const resolvedSummaryPath = outputSummaryPath || path.join(outputDir, `${outputPrefix}_单格分层结果.json`);
    const step06_1Dir = path.join(outputDir, '06_1_单格原图导出');
    const step06_2Dir = path.join(outputDir, '06_2_单格前景Mask');
    const step06_3Dir = path.join(outputDir, '06_3_单格清洗文字Mask');
    const step06_4Dir = path.join(outputDir, '06_4_单格文字图');
    const step06_5Dir = path.join(outputDir, '06_5_单格背景图');
    await fs.promises.mkdir(step06_1Dir, { recursive: true });
    await fs.promises.mkdir(step06_2Dir, { recursive: true });
    await fs.promises.mkdir(step06_3Dir, { recursive: true });
    await fs.promises.mkdir(step06_4Dir, { recursive: true });
    await fs.promises.mkdir(step06_5Dir, { recursive: true });
    const results = [];

    for (let row = 0; row < segmentation.matrix.length; row++) {
      for (let col = 0; col < segmentation.matrix[row].length; col++) {
        const cellId = `${row}_${col}`;
        const cellDirName = formatCellDirName(row, col);
        const cellDir = path.join(outputDir, cellDirName);
        await fs.promises.mkdir(cellDir, { recursive: true });

        const layers = await extractCellLayers(segmentation.matrix[row][col], options);
        const cellMeta = segmentation.cells[row * segmentation.gridCols + col] || null;
        const normalizedContentBox = cellMeta
          ? (
              cellMeta.contentBox ||
              (cellMeta.pageBox
                ? {
                    left: 0,
                    top: 0,
                    width: cellMeta.pageBox.width,
                    height: cellMeta.pageBox.height
                  }
                : null)
            )
          : null;
        const baseName = outputPrefix;
        const cellInputPath = segmentation.outputs?.cellsDir
          ? path.join(
              segmentation.outputs.cellsDir,
              formatCellFileName(row, col)
            )
          : inputPath;
        const cellStep06_1Dir = path.join(step06_1Dir, cellDirName);
        const cellStep06_2Dir = path.join(step06_2Dir, cellDirName);
        const cellStep06_3Dir = path.join(step06_3Dir, cellDirName);
        const cellStep06_4Dir = path.join(step06_4Dir, cellDirName);
        const cellStep06_5Dir = path.join(step06_5Dir, cellDirName);
        const step06_1MetaPath = path.join(cellStep06_1Dir, `${outputPrefix}_1_单格原图导出.json`);
        const step06_2MetaPath = path.join(cellStep06_2Dir, `${outputPrefix}_2_单格前景Mask.json`);
        const step06_3MetaPath = path.join(cellStep06_3Dir, `${outputPrefix}_3_单格清洗文字Mask.json`);
        const step06_4MetaPath = path.join(cellStep06_4Dir, `${outputPrefix}_4_单格文字图.json`);
        const step06_5MetaPath = path.join(cellStep06_5Dir, `${outputPrefix}_5_单格背景图.json`);

        const step06_1 = await cellOriginalExportPlugin.execute({
          cellDir: cellStep06_1Dir,
          baseName,
          layers,
          inputPath: cellInputPath,
          sourceStep: '05_4_单格裁切',
          outputMetaPath: step06_1MetaPath
        });
        const step06_2 = await cellForegroundMaskPlugin.execute({
          cellDir: cellStep06_2Dir,
          baseName,
          layers,
          inputPath: step06_1.outputPath,
          sourceStep: '06_1_单格原图导出',
          outputMetaPath: step06_2MetaPath
        });
        const step06_3 = await cellCleanedTextMaskPlugin.execute({
          cellDir: cellStep06_3Dir,
          baseName,
          layers,
          inputPath: step06_2.outputPath,
          sourceStep: '06_2_单格前景Mask',
          outputMetaPath: step06_3MetaPath
        });
        const step06_4 = await cellTextOnlyPlugin.execute({
          cellDir: cellStep06_4Dir,
          baseName,
          layers,
          inputPath: step06_3.outputPath,
          sourceStep: '06_3_单格清洗文字Mask',
          outputMetaPath: step06_4MetaPath
        });
        const step06_5 = await cellBackgroundOnlyPlugin.execute({
          cellDir: cellStep06_5Dir,
          baseName,
          layers,
          inputPath: step06_1.outputPath,
          sourceStep: '06_1_单格原图导出',
          outputMetaPath: step06_5MetaPath
        });
        const paths = {
          originalPath: step06_1.outputPath,
          foregroundMaskPath: step06_2.outputPath,
          cleanedForegroundMaskPath: step06_3.outputPath,
          textOnlyPath: step06_4.outputPath,
          backgroundOnlyPath: step06_5.outputPath
        };
        const cellMetaPath = path.join(cellDir, `${outputPrefix}_单格分层结果.json`);

        const payload = {
          processNo: outputPrefix,
          processName: '06_单格背景文字提取',
          sourceStep: '05_4_单格裁切',
          inputPath: cellInputPath,
          stageInputPath: inputPath,
          cellId,
          cellDirName,
          cellFileName: formatCellFileName(row, col),
          row,
          col,
          pageBox: cellMeta ? cellMeta.pageBox || null : null,
          contentBox: normalizedContentBox,
          imageInfo: layers.info,
          stats: layers.stats,
          outputs: paths
        };
        await fs.promises.writeFile(cellMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        results.push({
          ...payload,
          metaPath: cellMetaPath,
          steps: {
            step06_1,
            step06_2,
            step06_3,
            step06_4,
            step06_5
          }
        });
      }
    }

    const summary = {
      processNo: outputPrefix,
      processName: '06_单格背景文字提取',
      sourceStep: '05_单格切分',
      inputPath,
      stageInputPath: inputPath,
      totalCells: results.length,
      gridRows: segmentation.gridRows,
      gridCols: segmentation.gridCols,
      outputDir,
      stepDirs: {
        step06_1: step06_1Dir,
        step06_2: step06_2Dir,
        step06_3: step06_3Dir,
        step06_4: step06_4Dir,
        step06_5: step06_5Dir
      },
      cells: results.map((item) => ({
        cellId: item.cellId,
        cellDirName: item.cellDirName,
        cellFileName: item.cellFileName,
        row: item.row,
        col: item.col,
        stats: item.stats,
        ...withValue('metaPath', item.metaPath),
        outputs: item.outputs
      }))
    };

    await fs.promises.mkdir(path.dirname(resolvedSummaryPath), { recursive: true });
    await fs.promises.writeFile(resolvedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    return {
      ...summary,
      summaryPath: resolvedSummaryPath
    };
  }
}

module.exports = new CellLayerExtractPlugin();
