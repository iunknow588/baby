const DEFAULT_GRID_ROWS = 7;
const DEFAULT_GRID_COLS = 10;
const GRID_ESTIMATION_CONFIDENCE_THRESHOLD = 0.35;

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function sourceCodeToLabel(sourceCode) {
  switch (sourceCode) {
    case 'estimated':
      return '自动估计';
    case 'provided':
      return '指定值';
    case 'default':
      return '默认值';
    default:
      return sourceCode || '未知';
  }
}

function summarizeGridSource(rowSource, colSource) {
  if (rowSource === colSource) {
    return rowSource;
  }
  return 'mixed';
}

function formatGridSourceLabel(rowSource, colSource) {
  if (rowSource === colSource) {
    return sourceCodeToLabel(rowSource);
  }
  return `混合(行:${sourceCodeToLabel(rowSource)}, 列:${sourceCodeToLabel(colSource)})`;
}

function resolveEffectiveGrid({
  providedRows = DEFAULT_GRID_ROWS,
  providedCols = DEFAULT_GRID_COLS,
  hasProvidedRows = false,
  hasProvidedCols = false,
  estimatedGrid = null,
  autoUseEstimatedGrid = true,
  defaultRows = DEFAULT_GRID_ROWS,
  defaultCols = DEFAULT_GRID_COLS,
  confidenceThreshold = GRID_ESTIMATION_CONFIDENCE_THRESHOLD
} = {}) {
  const canUseEstimatedGrid = Boolean(
    autoUseEstimatedGrid &&
    estimatedGrid &&
    !estimatedGrid.error &&
    Number(estimatedGrid.confidence) >= confidenceThreshold
  );

  let rows = hasProvidedRows ? providedRows : defaultRows;
  let cols = hasProvidedCols ? providedCols : defaultCols;
  let rowSource = hasProvidedRows ? 'provided' : 'default';
  let colSource = hasProvidedCols ? 'provided' : 'default';

  if (canUseEstimatedGrid && !hasProvidedRows && isPositiveInteger(estimatedGrid.estimatedGridRows)) {
    rows = estimatedGrid.estimatedGridRows;
    rowSource = 'estimated';
  }

  if (canUseEstimatedGrid && !hasProvidedCols && isPositiveInteger(estimatedGrid.estimatedGridCols)) {
    cols = estimatedGrid.estimatedGridCols;
    colSource = 'estimated';
  }

  const source = summarizeGridSource(rowSource, colSource);
  return {
    rows,
    cols,
    rowSource,
    colSource,
    source,
    sourceLabel: formatGridSourceLabel(rowSource, colSource),
    confidenceThreshold
  };
}

module.exports = {
  DEFAULT_GRID_ROWS,
  DEFAULT_GRID_COLS,
  GRID_ESTIMATION_CONFIDENCE_THRESHOLD,
  resolveEffectiveGrid,
  sourceCodeToLabel,
  summarizeGridSource,
  formatGridSourceLabel
};
