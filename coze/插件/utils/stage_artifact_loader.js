const fs = require('fs');
const path = require('path');

function formatSegmentationCellFileName(row, col) {
  return `05_单格_row${String(row + 1).padStart(2, '0')}_col${String(col + 1).padStart(2, '0')}.png`;
}

async function readJsonFile(jsonPath, stageName = '当前阶段') {
  if (!jsonPath) {
    throw new Error(`${stageName}缺少JSON描述文件`);
  }
  const raw = await fs.promises.readFile(jsonPath, 'utf8');
  return JSON.parse(raw);
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName}必须是正整数`);
  }
  return value;
}

function buildEmptyMatrix(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

function resolveCellImagePath(cell, cellsDir) {
  if (cell?.imagePath) {
    return path.resolve(cell.imagePath);
  }
  if (cell?.outputs?.textOnlyPath) {
    return path.resolve(cell.outputs.textOnlyPath);
  }
  if (cell?.outputs?.originalPath) {
    return path.resolve(cell.outputs.originalPath);
  }
  if (cellsDir) {
    return path.join(path.resolve(cellsDir), cell?.cellFileName || formatSegmentationCellFileName(cell.row, cell.col));
  }
  return null;
}

async function loadSegmentationFromSummary(summaryPath) {
  const summary = await readJsonFile(summaryPath, '05阶段');
  const gridRows = assertPositiveInteger(Number(summary.gridRows), 'segmentation.gridRows');
  const gridCols = assertPositiveInteger(Number(summary.gridCols), 'segmentation.gridCols');
  const cellsDir = summary.cellsDir || summary.outputs?.cellsDir || null;
  const summaryCells = Array.isArray(summary.cells) ? summary.cells : [];
  const matrix = buildEmptyMatrix(gridRows, gridCols);
  const cells = Array.from({ length: gridRows * gridCols }, () => null);

  for (const cell of summaryCells) {
    const row = Number(cell?.row);
    const col = Number(cell?.col);
    if (!Number.isInteger(row) || row < 0 || row >= gridRows) {
      throw new Error(`05阶段JSON中的row非法: ${cell?.row}`);
    }
    if (!Number.isInteger(col) || col < 0 || col >= gridCols) {
      throw new Error(`05阶段JSON中的col非法: ${cell?.col}`);
    }
    const imagePath = resolveCellImagePath(cell, cellsDir);
    if (!imagePath) {
      throw new Error(`05阶段JSON缺少单格图片路径: row=${row}, col=${col}`);
    }
    matrix[row][col] = await fs.promises.readFile(imagePath);
    cells[row * gridCols + col] = {
      row,
      col,
      cellFileName: cell.cellFileName || formatSegmentationCellFileName(row, col),
      imagePath,
      pageBox: cell.pageBox || null,
      contentBox: cell.contentBox || null
    };
  }

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!matrix[row][col]) {
        throw new Error(`05阶段JSON缺少单格图片描述: row=${row}, col=${col}`);
      }
      const cellIndex = row * gridCols + col;
      if (!cells[cellIndex]) {
        cells[cellIndex] = {
          row,
          col,
          cellFileName: formatSegmentationCellFileName(row, col),
          imagePath: resolveCellImagePath({ row, col }, cellsDir),
          pageBox: null,
          contentBox: null
        };
      }
    }
  }

  return {
    ...summary,
    outputs: {
      ...(summary.outputs || {}),
      cellsDir,
      summaryPath
    },
    matrix,
    cells
  };
}

async function loadCellLayerFromSummary(summaryPath) {
  const summary = await readJsonFile(summaryPath, '06阶段');
  return {
    ...summary,
    summaryPath
  };
}

async function loadScoringInputFromCellLayerSummary(summaryPath) {
  const cellLayerExtraction = await loadCellLayerFromSummary(summaryPath);
  const gridRows = assertPositiveInteger(Number(cellLayerExtraction.gridRows), 'cellLayer.gridRows');
  const gridCols = assertPositiveInteger(Number(cellLayerExtraction.gridCols), 'cellLayer.gridCols');
  const matrix = buildEmptyMatrix(gridRows, gridCols);
  const cells = Array.from({ length: gridRows * gridCols }, () => null);
  const summaryCells = Array.isArray(cellLayerExtraction.cells) ? cellLayerExtraction.cells : [];

  for (const cell of summaryCells) {
    const row = Number(cell?.row);
    const col = Number(cell?.col);
    if (!Number.isInteger(row) || row < 0 || row >= gridRows) {
      throw new Error(`06阶段JSON中的row非法: ${cell?.row}`);
    }
    if (!Number.isInteger(col) || col < 0 || col >= gridCols) {
      throw new Error(`06阶段JSON中的col非法: ${cell?.col}`);
    }
    const imagePath = resolveCellImagePath(cell, null);
    if (!imagePath) {
      throw new Error(`06阶段JSON缺少可评分单格图片: row=${row}, col=${col}`);
    }
    matrix[row][col] = await fs.promises.readFile(imagePath);
    cells[row * gridCols + col] = {
      row,
      col,
      pageBox: cell.pageBox || null,
      contentBox: cell.contentBox || null,
      imagePath
    };
  }

  for (let row = 0; row < gridRows; row += 1) {
    for (let col = 0; col < gridCols; col += 1) {
      if (!matrix[row][col]) {
        throw new Error(`06阶段JSON缺少单格图片描述: row=${row}, col=${col}`);
      }
    }
  }

  return {
    pageImagePath: cellLayerExtraction.stageInputPath || cellLayerExtraction.inputPath || null,
    segmentation: {
      gridRows,
      gridCols,
      matrix,
      cells,
      outputs: {
        summaryPath
      }
    },
    cellLayerExtraction
  };
}

module.exports = {
  formatSegmentationCellFileName,
  readJsonFile,
  loadSegmentationFromSummary,
  loadCellLayerFromSummary,
  loadScoringInputFromCellLayerSummary
};
