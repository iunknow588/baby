function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} 必须是正整数`);
  }
  return value;
}

function assertMatrixShape(name, matrix, rows, cols, options = {}) {
  const { allowEmpty = false } = options;

  if (!Array.isArray(matrix)) {
    throw new Error(`${name} 必须是二维数组`);
  }
  if (allowEmpty && matrix.length === 0) {
    return;
  }
  if (matrix.length !== rows) {
    throw new Error(`${name} 行数必须与 segmentation.gridRows 一致，期望 ${rows}，实际 ${matrix.length}`);
  }

  for (let row = 0; row < matrix.length; row++) {
    if (!Array.isArray(matrix[row])) {
      throw new Error(`${name}[${row}] 必须是数组`);
    }
    if (matrix[row].length !== cols) {
      throw new Error(`${name}[${row}] 列数必须与 segmentation.gridCols 一致，期望 ${cols}，实际 ${matrix[row].length}`);
    }
  }
}

function assertCellsShape(cells, rows, cols) {
  if (!Array.isArray(cells)) {
    throw new Error('segmentation.cells 必须是数组');
  }

  const expectedLength = rows * cols;
  if (cells.length !== expectedLength) {
    throw new Error(`segmentation.cells 长度必须等于 gridRows * gridCols，期望 ${expectedLength}，实际 ${cells.length}`);
  }

  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    if (!isPlainObject(cell)) {
      throw new Error(`segmentation.cells[${index}] 必须是对象`);
    }

    const expectedRow = Math.floor(index / cols);
    const expectedCol = index % cols;

    if (Object.prototype.hasOwnProperty.call(cell, 'row') && cell.row !== expectedRow) {
      throw new Error(`segmentation.cells[${index}].row 与网格顺序不一致，期望 ${expectedRow}，实际 ${cell.row}`);
    }
    if (Object.prototype.hasOwnProperty.call(cell, 'col') && cell.col !== expectedCol) {
      throw new Error(`segmentation.cells[${index}].col 与网格顺序不一致，期望 ${expectedCol}，实际 ${cell.col}`);
    }
  }
}

function assertTargetChars(targetChars, rows, cols) {
  if (targetChars === null || targetChars === undefined) {
    return;
  }
  assertMatrixShape('target_chars', targetChars, rows, cols, { allowEmpty: true });
}

function assertRecognizedChars(recognizedChars, rows, cols) {
  if (recognizedChars === null || recognizedChars === undefined) {
    return;
  }

  if (Array.isArray(recognizedChars)) {
    assertMatrixShape('recognized_chars', recognizedChars, rows, cols, { allowEmpty: true });
    return;
  }

  if (!isPlainObject(recognizedChars)) {
    throw new Error('recognized_chars 必须是二维数组或以 "row_col" 为键的对象');
  }

  for (const key of Object.keys(recognizedChars)) {
    const match = /^(\d+)_(\d+)$/.exec(key);
    if (!match) {
      throw new Error(`recognized_chars 键格式非法: ${key}`);
    }

    const row = Number(match[1]);
    const col = Number(match[2]);
    if (row < 0 || row >= rows || col < 0 || col >= cols) {
      throw new Error(`recognized_chars 键超出网格范围: ${key}`);
    }
  }
}

function validateScoringPayload(payload = {}) {
  const {
    segmentation,
    target_chars = [],
    recognized_chars = null
  } = payload;

  if (!isPlainObject(segmentation)) {
    throw new Error('segmentation 参数是必需的');
  }

  const rows = assertPositiveInteger(segmentation.gridRows, 'segmentation.gridRows');
  const cols = assertPositiveInteger(segmentation.gridCols, 'segmentation.gridCols');

  assertMatrixShape('segmentation.matrix', segmentation.matrix, rows, cols);
  assertCellsShape(segmentation.cells, rows, cols);
  assertTargetChars(target_chars, rows, cols);
  assertRecognizedChars(recognized_chars, rows, cols);

  return {
    gridRows: rows,
    gridCols: cols
  };
}

module.exports = {
  validateScoringPayload
};
