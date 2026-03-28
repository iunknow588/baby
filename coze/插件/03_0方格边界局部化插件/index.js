function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeLocalizedPeaks(values, maxValue) {
  const normalized = [];
  for (const value of Array.isArray(values) ? values : []) {
    const rounded = clamp(Math.round(Number(value)), 0, maxValue);
    if (!Number.isFinite(rounded)) {
      continue;
    }
    if (!normalized.length || rounded > normalized[normalized.length - 1]) {
      normalized.push(rounded);
    }
  }
  return normalized;
}

function shouldUseGuideBoundsForLocalization(guideStart, guideEnd, boundStart, boundSize) {
  const guideSpan = Number(guideEnd) - Number(guideStart);
  const localStart = Number(boundStart);
  const localSize = Number(boundSize);
  const localEnd = localStart + localSize;
  if (!Number.isFinite(guideSpan) || guideSpan <= 0 || !Number.isFinite(localSize) || localSize <= 0) {
    return false;
  }

  const sameSpan = Math.abs(guideSpan - localSize) <= 4;
  const sameWindow = Math.abs(Number(guideStart) - localStart) <= 4 && Math.abs(Number(guideEnd) - localEnd) <= 4;
  const rectifiedLikeWindow = localStart === 0 && (Math.abs(Number(guideStart)) > 2 || !sameSpan);
  return sameWindow || rectifiedLikeWindow || sameSpan;
}

function localizeAxisPeaks(values, guideStart, guideEnd, boundStart, boundSize) {
  const sourceStart = shouldUseGuideBoundsForLocalization(guideStart, guideEnd, boundStart, boundSize)
    ? Number(guideStart)
    : Number(boundStart);
  const sourceEnd = shouldUseGuideBoundsForLocalization(guideStart, guideEnd, boundStart, boundSize)
    ? Number(guideEnd)
    : Number(boundStart) + Number(boundSize);
  const sourceSpan = Math.max(1, sourceEnd - sourceStart);
  const targetSize = Math.max(1, Number(boundSize) || 0);

  return normalizeLocalizedPeaks(
    (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter(Number.isFinite)
    .map((value) => clamp(Math.round(((value - sourceStart) / sourceSpan) * targetSize), 0, targetSize))
    .sort((a, b) => a - b),
    targetSize
  );
}

class GridBoundaryLocalizePlugin {
  constructor() {
    this.name = '03_0_方格边界局部化';
    this.version = '1.0.0';
  }

  execute(params) {
    const { guides, bounds } = params || {};
    if (!guides || !bounds) {
      throw new Error('guides 和 bounds 参数是必需的');
    }

    const localXPeaks = localizeAxisPeaks(
      guides.xPeaks || [],
      guides.left ?? bounds.left ?? 0,
      guides.right ?? ((bounds.left ?? 0) + (bounds.width ?? 0)),
      bounds.left ?? 0,
      bounds.width ?? 0
    );
    const localYPeaks = localizeAxisPeaks(
      guides.yPeaks || [],
      guides.top ?? bounds.top ?? 0,
      guides.bottom ?? ((bounds.top ?? 0) + (bounds.height ?? 0)),
      bounds.top ?? 0,
      bounds.height ?? 0
    );

    return {
      left: 0,
      top: 0,
      right: bounds.width,
      bottom: bounds.height,
      xPeaks: localXPeaks,
      yPeaks: localYPeaks,
      xSource: guides.xSource || null,
      ySource: guides.ySource || null,
      xPattern: guides.xPattern || null,
      yPattern: guides.yPattern || null,
      xPatternDiagnostics: guides.xPatternDiagnostics || null,
      yPatternDiagnostics: guides.yPatternDiagnostics || null,
      globalPattern: guides.globalPattern || null,
      specificMode: guides.specificMode || guides.globalPattern?.specificMode || null,
      patternProfile: guides.patternProfile || guides.globalPattern?.patternProfile || null,
      source: '真实边界检测局部化'
    };
  }
}

module.exports = new GridBoundaryLocalizePlugin();
