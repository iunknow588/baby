const fs = require('fs');
const path = require('path');
const { extractCellLayers } = require('../utils/cell_image_analysis');
const { resolveCellLayerArtifactPolicy } = require('../utils/artifact_policy');
const {
  cellOriginalExportPlugin,
  cellForegroundMaskPlugin,
  cellCleanedTextMaskPlugin,
  cellTextOnlyPlugin,
  cellBackgroundOnlyPlugin
} = require('./application/cell_layer_step_plugins');

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

function pickFirstAvailablePath(...candidates) {
  return candidates.find((item) => Boolean(item)) || null;
}

function createSuppressedStepResult({ processNo, processName, sourceStep, inputPath = null }) {
  return {
    processNo,
    processName,
    sourceStep,
    inputPath,
    outputPath: null
  };
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
      patternProfile = null,
      options = {},
      artifactLevel,
      artifact_level
    } = params || {};

    if (!segmentation || !Array.isArray(segmentation.matrix) || !Array.isArray(segmentation.cells)) {
      throw new Error('segmentation.matrix 和 segmentation.cells 是必需的');
    }
    if (!outputDir) {
      throw new Error('outputDir参数是必需的');
    }

    await fs.promises.mkdir(outputDir, { recursive: true });
    const artifactPolicy = resolveCellLayerArtifactPolicy({ artifactLevel, artifact_level, options });
    const resolvedSummaryPath = outputSummaryPath || path.join(outputDir, `${outputPrefix}_单格分层结果.json`);
    const step06_1Dir = artifactPolicy.emitStep06_1 ? path.join(outputDir, '06_1_单格原图导出') : null;
    const step06_2Dir = artifactPolicy.emitStep06_2 ? path.join(outputDir, '06_2_单格前景Mask') : null;
    const step06_3Dir = artifactPolicy.emitStep06_3 ? path.join(outputDir, '06_3_单格清洗文字Mask') : null;
    const step06_4Dir = artifactPolicy.emitStep06_4 ? path.join(outputDir, '06_4_单格文字图') : null;
    const step06_5Dir = artifactPolicy.emitStep06_5 ? path.join(outputDir, '06_5_单格背景图') : null;

    await Promise.all(
      [
        step06_1Dir,
        step06_2Dir,
        step06_3Dir,
        step06_4Dir,
        step06_5Dir
      ]
        .filter(Boolean)
        .map((dirPath) => fs.promises.mkdir(dirPath, { recursive: true }))
    );
    const results = [];

    for (let row = 0; row < segmentation.matrix.length; row++) {
      for (let col = 0; col < segmentation.matrix[row].length; col++) {
        const cellId = `${row}_${col}`;
        const cellDirName = formatCellDirName(row, col);
        const cellDir = artifactPolicy.emitPerCellMeta ? path.join(outputDir, cellDirName) : null;
        if (cellDir) {
          await fs.promises.mkdir(cellDir, { recursive: true });
        }

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
        const cellStep06_1Dir = step06_1Dir ? path.join(step06_1Dir, cellDirName) : null;
        const cellStep06_2Dir = step06_2Dir ? path.join(step06_2Dir, cellDirName) : null;
        const cellStep06_3Dir = step06_3Dir ? path.join(step06_3Dir, cellDirName) : null;
        const cellStep06_4Dir = step06_4Dir ? path.join(step06_4Dir, cellDirName) : null;
        const cellStep06_5Dir = step06_5Dir ? path.join(step06_5Dir, cellDirName) : null;
        const step06_1MetaPath = artifactPolicy.emitLayerStepMeta && cellStep06_1Dir
          ? path.join(cellStep06_1Dir, `${outputPrefix}_1_单格原图导出.json`)
          : null;
        const step06_2MetaPath = artifactPolicy.emitLayerStepMeta && cellStep06_2Dir
          ? path.join(cellStep06_2Dir, `${outputPrefix}_2_单格前景Mask.json`)
          : null;
        const step06_3MetaPath = artifactPolicy.emitLayerStepMeta && cellStep06_3Dir
          ? path.join(cellStep06_3Dir, `${outputPrefix}_3_单格清洗文字Mask.json`)
          : null;
        const step06_4MetaPath = artifactPolicy.emitLayerStepMeta && cellStep06_4Dir
          ? path.join(cellStep06_4Dir, `${outputPrefix}_4_单格文字图.json`)
          : null;
        const step06_5MetaPath = artifactPolicy.emitLayerStepMeta && cellStep06_5Dir
          ? path.join(cellStep06_5Dir, `${outputPrefix}_5_单格背景图.json`)
          : null;

        const step06_1 = artifactPolicy.emitStep06_1
          ? await cellOriginalExportPlugin.execute({
              cellDir: cellStep06_1Dir,
              baseName,
              layers,
              inputPath: cellInputPath,
              sourceStep: '05_4_单格裁切',
              outputMetaPath: step06_1MetaPath
            })
          : createSuppressedStepResult({
              processNo: '06_1',
              processName: '06_1_单格原图导出',
              sourceStep: '05_4_单格裁切',
              inputPath: cellInputPath
            });
        const step06_2InputPath = step06_1.outputPath || cellInputPath;
        const step06_2 = artifactPolicy.emitStep06_2
          ? await cellForegroundMaskPlugin.execute({
              cellDir: cellStep06_2Dir,
              baseName,
              layers,
              inputPath: step06_2InputPath,
              sourceStep: '06_1_单格原图导出',
              outputMetaPath: step06_2MetaPath
            })
          : createSuppressedStepResult({
              processNo: '06_2',
              processName: '06_2_单格前景Mask',
              sourceStep: '06_1_单格原图导出',
              inputPath: step06_2InputPath
            });
        const step06_3InputPath = step06_2.outputPath || step06_2InputPath;
        const step06_3 = artifactPolicy.emitStep06_3
          ? await cellCleanedTextMaskPlugin.execute({
              cellDir: cellStep06_3Dir,
              baseName,
              layers,
              inputPath: step06_3InputPath,
              sourceStep: '06_2_单格前景Mask',
              outputMetaPath: step06_3MetaPath
            })
          : createSuppressedStepResult({
              processNo: '06_3',
              processName: '06_3_单格清洗文字Mask',
              sourceStep: '06_2_单格前景Mask',
              inputPath: step06_3InputPath
            });
        const step06_4InputPath = pickFirstAvailablePath(
          step06_3.outputPath,
          step06_2.outputPath,
          step06_1.outputPath,
          cellInputPath
        );
        const step06_4 = await cellTextOnlyPlugin.execute({
          cellDir: cellStep06_4Dir,
          baseName,
          layers,
          inputPath: step06_4InputPath,
          sourceStep: '06_3_单格清洗文字Mask',
          outputMetaPath: step06_4MetaPath
        });
        const step06_5InputPath = step06_1.outputPath || cellInputPath;
        const step06_5 = artifactPolicy.emitStep06_5
          ? await cellBackgroundOnlyPlugin.execute({
              cellDir: cellStep06_5Dir,
              baseName,
              layers,
              inputPath: step06_5InputPath,
              sourceStep: '06_1_单格原图导出',
              outputMetaPath: step06_5MetaPath
            })
          : createSuppressedStepResult({
              processNo: '06_5',
              processName: '06_5_单格背景图',
              sourceStep: '06_1_单格原图导出',
              inputPath: step06_5InputPath
            });
        const paths = {
          originalPath: step06_1.outputPath || null,
          foregroundMaskPath: step06_2.outputPath || null,
          cleanedForegroundMaskPath: step06_3.outputPath || null,
          textOnlyPath: step06_4.outputPath || null,
          backgroundOnlyPath: step06_5.outputPath || null
        };
        const cellMetaPath = cellDir ? path.join(cellDir, `${outputPrefix}_单格分层结果.json`) : null;

        const payload = {
          processNo: outputPrefix,
          processName: '06_单格背景文字提取',
          artifactLevel: artifactPolicy.artifactLevel,
          sourceStep: '05_4_单格裁切',
          inputPath: cellInputPath,
          stageInputPath: inputPath,
          patternProfile,
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
        if (cellMetaPath) {
          await fs.promises.writeFile(cellMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        }
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
      artifactLevel: artifactPolicy.artifactLevel,
      sourceStep: '05_单格切分',
      inputPath,
      stageInputPath: inputPath,
      totalCells: results.length,
      gridRows: segmentation.gridRows,
      gridCols: segmentation.gridCols,
      patternProfile,
      outputDir,
      textOnlyDir: step06_4Dir,
      backgroundOnlyDir: step06_5Dir,
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
      summaryPath: resolvedSummaryPath,
      outputs: {
        artifactLevel: artifactPolicy.artifactLevel,
        textOnlyDir: step06_4Dir,
        backgroundOnlyDir: step06_5Dir,
        stepDirs: summary.stepDirs
      }
    };
  }
}

module.exports = new CellLayerExtractPlugin();
