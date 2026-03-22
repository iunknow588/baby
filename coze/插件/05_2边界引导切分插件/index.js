function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeGuideAxis(values, minValue, maxValue, limit) {
  const rawValues = Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
  const numericMin = Number.isFinite(minValue) ? Number(minValue) : 0;
  const numericMax = Number.isFinite(maxValue) ? Number(maxValue) : limit;
  const referenceMax = Math.max(numericMax, ...rawValues, 1);

  if (referenceMax <= limit) {
    return {
      min: clamp(Math.round(numericMin), 0, limit),
      max: clamp(Math.round(numericMax), 0, limit),
      values: rawValues.map((value) => clamp(Math.round(value), 0, limit))
    };
  }

  const scale = limit / referenceMax;
  return {
    min: clamp(Math.round(numericMin * scale), 0, limit),
    max: clamp(Math.round(numericMax * scale), 0, limit),
    values: rawValues.map((value) => clamp(Math.round(value * scale), 0, limit))
  };
}

class BoundaryGuideSegmentationPlugin {
  constructor() {
    this.name = '05_2_边界引导切分';
    this.version = '1.0.0';
    this.processNo = '05_2';
  }

  execute(params) {
    const { boundaryGuides, gridRows, gridCols, width, height } = params || {};
    if (!boundaryGuides || !gridRows || !gridCols || !width || !height) {
      return null;
    }
    const rawXPeaks = Array.isArray(boundaryGuides.xPeaks) ? boundaryGuides.xPeaks : [];
    const rawYPeaks = Array.isArray(boundaryGuides.yPeaks) ? boundaryGuides.yPeaks : [];
    const normalizedX = normalizeGuideAxis(rawXPeaks, boundaryGuides.left ?? 0, boundaryGuides.right ?? width, width);
    const normalizedY = normalizeGuideAxis(rawYPeaks, boundaryGuides.top ?? 0, boundaryGuides.bottom ?? height, height);
    const guideLeft = normalizedX.min;
    const guideRight = Math.max(guideLeft + 1, normalizedX.max);
    const guideTop = normalizedY.min;
    const guideBottom = Math.max(guideTop + 1, normalizedY.max);
    const hasExactPeaks = rawXPeaks.length === gridCols + 1 && rawYPeaks.length === gridRows + 1;

    const xPeaks = hasExactPeaks
      ? normalizedX.values.map((value) => clamp(value, guideLeft, guideRight)).sort((a, b) => a - b)
      : Array.from({ length: gridCols + 1 }, (_, index) =>
          Math.round(guideLeft + ((guideRight - guideLeft) * index) / Math.max(gridCols, 1))
        );
    const yPeaks = hasExactPeaks
      ? normalizedY.values.map((value) => clamp(value, guideTop, guideBottom)).sort((a, b) => a - b)
      : Array.from({ length: gridRows + 1 }, (_, index) =>
          Math.round(guideTop + ((guideBottom - guideTop) * index) / Math.max(gridRows, 1))
        );

    const xBoundaries = Array.from(
      { length: gridCols },
      (_, index) => [xPeaks[index], Math.max(xPeaks[index] + 1, xPeaks[index + 1])]
    );
    const yBoundaries = Array.from(
      { length: gridRows },
      (_, index) => [yPeaks[index], Math.max(yPeaks[index] + 1, yPeaks[index + 1])]
    );

    return {
      processNo: this.processNo,
      processName: '05_2_边界引导切分',
      mode: '边界引导',
      xBoundaries,
      yBoundaries,
      debug: {
        verticalCandidates: [],
        verticalLines: xPeaks,
        outerRectVerticalLines: [xPeaks[0], xPeaks[xPeaks.length - 1]],
        selectedBoundaryMode: '边界引导',
        directBoundaryQuality: null,
        outerRectBoundaryQuality: {
          source: hasExactPeaks ? '边界引导' : '边界外框均分引导',
          left: xPeaks[0],
          right: xPeaks[xPeaks.length - 1],
          top: yPeaks[0],
          bottom: yPeaks[yPeaks.length - 1]
        },
        horizontalLinesBeforeAnomalousCorrection: yPeaks,
        horizontalLinesBeforeCorrection: yPeaks,
        horizontalLines: yPeaks,
        outerRectHorizontalLines: [yPeaks[0], yPeaks[yPeaks.length - 1]],
        leftHorizontalLines: [],
        rightHorizontalLines: [],
        sideConsensusHorizontalLines: [],
        anomalousHorizontalCorrection: { lines: [], corrections: [] },
        fallbackUsed: false,
        profileVerticalLines: [],
        profileHorizontalLines: [],
        guidePeakMode: hasExactPeaks ? '精确峰值' : '外边界均分'
      }
    };
  }
}

module.exports = new BoundaryGuideSegmentationPlugin();
