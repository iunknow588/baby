const path = require('path');

function buildOcrCells({ segmentation, targetChars = [], cellLayerExtraction = null }) {
  const cellLayerMap = new Map(
    Array.isArray(cellLayerExtraction?.cells)
      ? cellLayerExtraction.cells.map((item) => [`${item.row}_${item.col}`, item])
      : []
  );
  const ocrCells = [];

  for (let row = 0; row < segmentation.matrix.length; row++) {
    for (let col = 0; col < segmentation.matrix[row].length; col++) {
      const cellLayerMeta = cellLayerMap.get(`${row}_${col}`) || null;
      ocrCells.push({
        cell_id: `${row}_${col}`,
        row,
        col,
        target_char: targetChars[row] && targetChars[row][col] ? targetChars[row][col] : null,
        image_path: cellLayerMeta?.outputs?.textOnlyPath || null
      });
    }
  }

  return ocrCells;
}

async function resolveRecognizedCharsWithOcr({
  segmentation,
  targetChars = [],
  recognizedChars = null,
  cellLayerExtraction = null,
  outputDir = null,
  ocrOptions = null
}) {
  if (recognizedChars || !ocrOptions?.enabled) {
    return {
      recognizedChars,
      ocrDiagnostics: null
    };
  }

  const cellOcrPlugin = require('../../08_OCR识别插件/index');
  const ocrDiagnostics = await cellOcrPlugin.execute({
    cells: buildOcrCells({ segmentation, targetChars, cellLayerExtraction }),
    gridRows: segmentation.gridRows,
    gridCols: segmentation.gridCols,
    outputDir: outputDir ? path.join(outputDir, '07_0_OCR识别') : null,
    options: ocrOptions || {}
  });

  return {
    recognizedChars: ocrDiagnostics?.supported && ocrDiagnostics?.recognized_chars
      ? ocrDiagnostics.recognized_chars
      : recognizedChars,
    ocrDiagnostics
  };
}

module.exports = {
  buildOcrCells,
  resolveRecognizedCharsWithOcr
};
