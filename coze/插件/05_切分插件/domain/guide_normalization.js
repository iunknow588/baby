function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeAxisPeaks(values, min, max) {
  const lower = Number.isFinite(min) ? Math.round(min) : 0;
  const upper = Number.isFinite(max) ? Math.round(max) : lower;
  const normalized = [];

  for (const value of Array.isArray(values) ? values : []) {
    const rounded = clamp(Math.round(Number(value)), lower, upper);
    if (!Number.isFinite(rounded)) {
      continue;
    }
    if (!normalized.length || rounded > normalized[normalized.length - 1]) {
      normalized.push(rounded);
    }
  }

  return normalized;
}

function buildUniformGuidePeaks(start, end, cells) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !cells || cells <= 0) {
    return [];
  }

  const span = end - start;
  if (span <= 0) {
    return [];
  }

  return Array.from(
    { length: cells + 1 },
    (_, index) => Math.round(start + (span * index) / cells)
  );
}

function normalizeGridBoundaryGuides(params) {
  const { gridRectification, gridRows, gridCols } = params || {};
  const guides = gridRectification && gridRectification.guides;

  if (!guides) {
    throw new Error('gridRectification.guides参数是必需的');
  }

  const rawXPeaks = normalizeAxisPeaks(guides.xPeaks, guides.left, guides.right);
  const rawYPeaks = normalizeAxisPeaks(guides.yPeaks, guides.top, guides.bottom);
  const xPeaks = rawXPeaks.length === gridCols + 1
    ? rawXPeaks
    : buildUniformGuidePeaks(guides.left, guides.right, gridCols);
  const yPeaks = rawYPeaks.length === gridRows + 1
    ? rawYPeaks
    : buildUniformGuidePeaks(guides.top, guides.bottom, gridRows);

  return {
    left: Math.round(guides.left),
    right: Math.round(guides.right),
    top: Math.round(guides.top),
    bottom: Math.round(guides.bottom),
    xPeaks,
    yPeaks,
    xSource: rawXPeaks.length === gridCols + 1 ? '检测峰值' : '外边界均分',
    ySource: rawYPeaks.length === gridRows + 1 ? '检测峰值' : '外边界均分'
  };
}

module.exports = {
  clamp,
  normalizeAxisPeaks,
  buildUniformGuidePeaks,
  normalizeGridBoundaryGuides
};
