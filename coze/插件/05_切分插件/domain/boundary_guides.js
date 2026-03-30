function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isDiagonalProfileMode(profileMode) {
  return typeof profileMode === 'string' && profileMode.includes('template-diagonal-mi-grid');
}

function isInnerDashedProfileMode(profileMode) {
  return typeof profileMode === 'string' && profileMode.includes('template-inner-dashed-box-grid');
}

function median(values) {
  if (!Array.isArray(values) || !values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function buildPeakDiffs(values) {
  const diffs = [];
  for (let index = 1; index < values.length; index++) {
    diffs.push(values[index] - values[index - 1]);
  }
  return diffs.filter((value) => value > 0);
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

function normalizeMonotonicPeaks(values, minValue, maxValue) {
  const normalized = [];
  for (const value of values) {
    const clamped = clamp(Math.round(value), minValue, maxValue);
    if (!normalized.length || clamped > normalized[normalized.length - 1]) {
      normalized.push(clamped);
    }
  }
  return normalized;
}

function evaluatePeakRegularity(values) {
  const diffs = buildPeakDiffs(values);
  if (!diffs.length) {
    return {
      mean: 0,
      deviation: 0,
      minGap: 0,
      maxGap: 0,
      ratio: 0
    };
  }
  const mean = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const variance = diffs.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / diffs.length;
  const deviation = Math.sqrt(variance);
  const minGap = Math.min(...diffs);
  const maxGap = Math.max(...diffs);
  return {
    mean,
    deviation,
    minGap,
    maxGap,
    ratio: mean > 0 ? deviation / mean : 0
  };
}

function buildUniformPeaks(axisMin, axisMax, expectedGridCount) {
  return Array.from({ length: expectedGridCount + 1 }, (_, index) =>
    Math.round(axisMin + ((axisMax - axisMin) * index) / Math.max(expectedGridCount, 1))
  );
}

function shouldFallbackResolvedPeaksToUniform(peaks, expectedGridCount, options = {}) {
  const {
    patternName = null,
    explicitOuterBounds = false,
    peakMode = null
  } = options;
  if (patternName !== 'uniform-boundary-grid') {
    return false;
  }
  if (!Array.isArray(peaks) || peaks.length !== expectedGridCount + 1 || expectedGridCount < 3) {
    return false;
  }
  if (['模式均分边界', '外边界均分', '峰值包络均分'].includes(peakMode)) {
    return false;
  }
  const gaps = buildPeakDiffs(peaks);
  if (gaps.length !== expectedGridCount) {
    return false;
  }
  const regularity = evaluatePeakRegularity(peaks);
  const interiorGaps = gaps.slice(1, -1).filter((gap) => gap > 0);
  const referenceGap = median(interiorGaps.length ? interiorGaps : gaps) || 0;
  const firstGap = gaps[0] || 0;
  const lastGap = gaps[gaps.length - 1] || 0;
  const edgeGapUnbalanced = explicitOuterBounds
    && referenceGap > 0
    && (
      firstGap / referenceGap >= 1.45
      || firstGap / referenceGap <= 0.7
      || lastGap / referenceGap >= 1.45
      || lastGap / referenceGap <= 0.7
    );
  return (
    regularity.ratio >= 0.2
    || (regularity.minGap > 0 && regularity.maxGap / regularity.minGap >= 1.8)
    || edgeGapUnbalanced
  );
}

function shouldPreferUniformPatternFallback(patternName, patternDiagnostics, values, expectedGridCount) {
  if (patternName !== 'uniform-boundary-grid') {
    return false;
  }
  const normalizedValues = Array.isArray(values)
    ? values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  if (normalizedValues.length < Math.max(3, expectedGridCount - 1)) {
    return false;
  }
  const regularity = evaluatePeakRegularity(normalizedValues);
  const symmetryScore = Number(patternDiagnostics?.symmetry?.symmetryScore);
  const meanSnapRatio = Number(patternDiagnostics?.meanSnapRatio);
  return (
    regularity.ratio >= 0.16
    || (regularity.minGap > 0 && regularity.maxGap / regularity.minGap >= 1.85)
    || (Number.isFinite(meanSnapRatio) && meanSnapRatio >= 0.12)
    || (Number.isFinite(symmetryScore) && symmetryScore <= 0.86)
  );
}

function shouldFallbackExplicitBoundCenterMatchToUniform(values, axisMin, axisMax, expectedGridCount, options = {}) {
  const {
    explicitOuterBounds = false,
    resolvedPeakMode = null
  } = options;
  if (!explicitOuterBounds || resolvedPeakMode !== '显式外边界+中心峰值推断') {
    return false;
  }

  const normalizedValues = normalizeMonotonicPeaks(values, axisMin, axisMax);
  if (normalizedValues.length !== expectedGridCount || expectedGridCount < 3) {
    return false;
  }
  if (
    Math.abs(normalizedValues[0] - axisMin) > 1
    || Math.abs(normalizedValues[normalizedValues.length - 1] - axisMax) > 1
  ) {
    return false;
  }

  const regularity = evaluatePeakRegularity(normalizedValues);
  const gaps = buildPeakDiffs(normalizedValues);
  const referenceGap = median(gaps) || 0;
  const irregularGapCount = referenceGap > 0
    ? gaps.filter((gap) => gap / referenceGap >= 1.35 || gap / referenceGap <= 0.72).length
    : 0;

  return (
    regularity.ratio >= 0.24
    || (regularity.minGap > 0 && regularity.maxGap / regularity.minGap >= 2.2)
    || irregularGapCount >= 2
  );
}

function resolveProfileBoundaryBias(profileMode, axis) {
  if (isDiagonalProfileMode(profileMode)) {
    if (axis === 'x') {
      return { startGapRatio: 0.38, endGapRatio: 0.62 };
    }
    return { startGapRatio: 0.62, endGapRatio: 0.38 };
  }

  if (isInnerDashedProfileMode(profileMode)) {
    if (axis === 'x') {
      return { startGapRatio: 0.34, endGapRatio: 0.58 };
    }
    return { startGapRatio: 0.58, endGapRatio: 0.34 };
  }

  return { startGapRatio: 0.5, endGapRatio: 0.5 };
}

function resolveProfileAnchorPreference(profileMode, axis) {
  if (isDiagonalProfileMode(profileMode) || isInnerDashedProfileMode(profileMode)) {
    return axis === 'x' ? 'start-anchor-left' : 'end-anchor-bottom';
  }
  if (profileMode === 'template-circle-mi-grid-top-bottom-separated-outer-frame') {
    return 'symmetric';
  }
  return 'default';
}

function buildAxisPeaksFromCenters(centers, axisMin, axisMax, options = {}) {
  const { axis = 'x', profileMode = null } = options;
  const sortedCenters = normalizeMonotonicPeaks(centers, axisMin, axisMax);
  if (!sortedCenters.length) {
    return null;
  }

  const diffs = buildPeakDiffs(sortedCenters);
  const fallbackGap = Math.max(1, Math.round(median(diffs) || ((axisMax - axisMin) / Math.max(sortedCenters.length, 1))));
  const bias = resolveProfileBoundaryBias(profileMode, axis);
  const peaks = [clamp(Math.round(sortedCenters[0] - fallbackGap * bias.startGapRatio), axisMin, axisMax)];

  for (let index = 1; index < sortedCenters.length; index++) {
    peaks.push(clamp(Math.round((sortedCenters[index - 1] + sortedCenters[index]) / 2), axisMin, axisMax));
  }

  peaks.push(clamp(Math.round(sortedCenters[sortedCenters.length - 1] + fallbackGap * bias.endGapRatio), axisMin, axisMax));
  return normalizeMonotonicPeaks(peaks, axisMin, axisMax);
}

function buildAxisPeaksFromCentersWithExplicitBounds(centers, axisMin, axisMax) {
  const sortedCenters = normalizeMonotonicPeaks(centers, axisMin, axisMax);
  if (!sortedCenters.length) {
    return null;
  }
  const peaks = [axisMin];
  for (let index = 1; index < sortedCenters.length; index++) {
    peaks.push(clamp(Math.round((sortedCenters[index - 1] + sortedCenters[index]) / 2), axisMin, axisMax));
  }
  peaks.push(axisMax);
  return normalizeMonotonicPeaks(peaks, axisMin, axisMax);
}

function resolveGuideAxisPeaks(values, axisMin, axisMax, expectedGridCount, options = {}) {
  const {
    axis = 'x',
    profileMode = null,
    forceUniformBoundaries = false,
    preferExplicitOuterBounds = false
  } = options;
  const normalizedValues = normalizeMonotonicPeaks(values, axisMin, axisMax);
  if (!normalizedValues.length) {
    return {
      peakMode: '空峰值',
      peaks: Array.from({ length: expectedGridCount + 1 }, (_, index) =>
        Math.round(axisMin + ((axisMax - axisMin) * index) / Math.max(expectedGridCount, 1))
      )
    };
  }

  if (forceUniformBoundaries) {
    return {
      peakMode: '模式均分边界',
      peaks: Array.from({ length: expectedGridCount + 1 }, (_, index) =>
        Math.round(axisMin + ((axisMax - axisMin) * index) / Math.max(expectedGridCount, 1))
      )
    };
  }

  if (normalizedValues.length === expectedGridCount + 1) {
    return {
      peakMode: '精确边界峰值',
      peaks: normalizedValues
    };
  }

  if (normalizedValues.length === expectedGridCount) {
    if (preferExplicitOuterBounds) {
      const explicitBounds = buildAxisPeaksFromCentersWithExplicitBounds(normalizedValues, axisMin, axisMax);
      if (explicitBounds && explicitBounds.length === expectedGridCount + 1) {
        return {
          peakMode: '显式外边界+中心峰值推断',
          peaks: explicitBounds
        };
      }
    }
    const inferred = buildAxisPeaksFromCenters(normalizedValues, axisMin, axisMax, {
      axis,
      profileMode
    });
    if (inferred && inferred.length === expectedGridCount + 1) {
      return {
        peakMode: '中心峰值推断边界',
        peaks: inferred
      };
    }
  }

  if (normalizedValues.length === Math.max(expectedGridCount - 1, 1)) {
    if (preferExplicitOuterBounds) {
      const explicitBounds = normalizeMonotonicPeaks([
        axisMin,
        ...normalizedValues,
        axisMax
      ], axisMin, axisMax);
      if (explicitBounds.length === expectedGridCount + 1) {
        return {
          peakMode: '显式外边界+内部边界峰值',
          peaks: explicitBounds
        };
      }
    }
    const bias = resolveProfileBoundaryBias(profileMode, axis);
    const diffs = buildPeakDiffs(normalizedValues);
    const fallbackGap = Math.max(1, Math.round(median(diffs) || ((axisMax - axisMin) / Math.max(normalizedValues.length, 1))));
    const inferred = normalizeMonotonicPeaks([
      clamp(Math.round(normalizedValues[0] - fallbackGap * bias.startGapRatio), axisMin, axisMax),
      ...normalizedValues,
      clamp(Math.round(normalizedValues[normalizedValues.length - 1] + fallbackGap * bias.endGapRatio), axisMin, axisMax)
    ], axisMin, axisMax);
    if (inferred.length === expectedGridCount + 1) {
      return {
        peakMode: '内部边界峰值补全',
        peaks: inferred
      };
    }
  }

  return {
    peakMode: '外边界均分',
    peaks: Array.from({ length: expectedGridCount + 1 }, (_, index) =>
      Math.round(axisMin + ((axisMax - axisMin) * index) / Math.max(expectedGridCount, 1))
    )
  };
}

function classifyGuideCountRelation(peakCount, expectedGridCount) {
  if (!peakCount) {
    return 'empty';
  }
  if (peakCount === expectedGridCount + 1) {
    return 'boundary-match';
  }
  if (peakCount === expectedGridCount) {
    return 'center-match';
  }
  if (peakCount === Math.max(expectedGridCount - 1, 1)) {
    return 'interior-boundary-match';
  }
  if (peakCount >= Math.max(2, Math.floor(expectedGridCount / 2))) {
    return 'partial-envelope';
  }
  return 'count-mismatch';
}

function resolveProfileEnvelopePadding(profileMode, axis) {
  if (!profileMode) {
    return { startRatio: 0.18, endRatio: 0.18 };
  }

  if (profileMode === 'template-circle-mi-grid-top-bottom-separated-outer-frame') {
    return { startRatio: 0.18, endRatio: 0.18 };
  }

  if (isDiagonalProfileMode(profileMode)) {
    if (axis === 'x') {
      return { startRatio: 0.12, endRatio: 0.24 };
    }
    return { startRatio: 0.24, endRatio: 0.12 };
  }

  if (isInnerDashedProfileMode(profileMode)) {
    if (axis === 'x') {
      return { startRatio: 0.1, endRatio: 0.22 };
    }
    return { startRatio: 0.22, endRatio: 0.1 };
  }

  return { startRatio: 0.18, endRatio: 0.18 };
}

function resolveGuideAxisSpan(normalizedAxis, expectedGridCount, options = {}) {
  const { preferPeakEnvelope = false, axis = 'x', profileMode = null } = options;
  const values = normalizeMonotonicPeaks(normalizedAxis.values || [], normalizedAxis.min, normalizedAxis.max);
  if (!values.length) {
    return {
      min: normalizedAxis.min,
      max: normalizedAxis.max,
      spanMode: 'full-bounds',
      padding: 0,
      startPadding: 0,
      endPadding: 0
    };
  }

  if (values.length >= Math.max(2, Math.floor(expectedGridCount / 2))) {
    const diffs = buildPeakDiffs(values);
    const medianGap = median(diffs) || 0;
    const paddingModel = resolveProfileEnvelopePadding(profileMode, axis);
    const startPadding = preferPeakEnvelope
      ? Math.max(0, Math.round(medianGap * paddingModel.startRatio))
      : 0;
    const endPadding = preferPeakEnvelope
      ? Math.max(0, Math.round(medianGap * paddingModel.endRatio))
      : 0;
    return {
      min: clamp(values[0] - startPadding, normalizedAxis.min, normalizedAxis.max),
      max: clamp(values[values.length - 1] + endPadding, normalizedAxis.min, normalizedAxis.max),
      spanMode: preferPeakEnvelope ? 'preferred-peak-envelope' : 'peak-envelope',
      padding: Math.max(startPadding, endPadding),
      startPadding,
      endPadding
    };
  }

  return {
    min: normalizedAxis.min,
    max: normalizedAxis.max,
    spanMode: 'full-bounds',
    padding: 0,
    startPadding: 0,
    endPadding: 0
  };
}

function summarizeGuideMode(boundaryGuides, xGuide, yGuide) {
  const patternProfile = boundaryGuides?.patternProfile || boundaryGuides?.globalPattern?.patternProfile || null;
  const profileMode = patternProfile?.profileMode || null;
  const xPattern = boundaryGuides?.xPattern || null;
  const yPattern = boundaryGuides?.yPattern || null;
  return {
    profileMode,
    xPattern,
    yPattern,
    xAnchorPreference: resolveProfileAnchorPreference(profileMode, 'x'),
    yAnchorPreference: resolveProfileAnchorPreference(profileMode, 'y'),
    axisMode: `${xGuide.peakMode}/${yGuide.peakMode}`
  };
}

function executeBoundaryGuideSegmentation(params = {}) {
  const {
    boundaryGuides,
    gridRows,
    gridCols,
    width,
    height,
    segmentationProfile = null,
    processNo = '05_2',
    processName = '05_2_边界引导切分'
  } = params;

  if (!boundaryGuides || !gridRows || !gridCols || !width || !height) {
    return null;
  }

  const rawXPeaks = Array.isArray(boundaryGuides.xPeaks) ? boundaryGuides.xPeaks : [];
  const rawYPeaks = Array.isArray(boundaryGuides.yPeaks) ? boundaryGuides.yPeaks : [];
  const normalizedX = normalizeGuideAxis(rawXPeaks, boundaryGuides.left ?? 0, boundaryGuides.right ?? width, width);
  const normalizedY = normalizeGuideAxis(rawYPeaks, boundaryGuides.top ?? 0, boundaryGuides.bottom ?? height, height);
  const forceUniformGuideBounds = Boolean(segmentationProfile?.preferUniform);
  const xPreferUniformPatternFallback = shouldPreferUniformPatternFallback(
    boundaryGuides?.xPattern || null,
    boundaryGuides?.xPatternDiagnostics || null,
    normalizedX.values,
    gridCols
  ) || forceUniformGuideBounds;
  const yPreferUniformPatternFallback = shouldPreferUniformPatternFallback(
    boundaryGuides?.yPattern || null,
    boundaryGuides?.yPatternDiagnostics || null,
    normalizedY.values,
    gridRows
  ) || forceUniformGuideBounds;
  const xSpan = resolveGuideAxisSpan(normalizedX, gridCols, {
    preferPeakEnvelope: Boolean(segmentationProfile?.preferPeakEnvelope),
    axis: 'x',
    profileMode: segmentationProfile?.profileMode || boundaryGuides?.patternProfile?.profileMode || null
  });
  const ySpan = resolveGuideAxisSpan(normalizedY, gridRows, {
    preferPeakEnvelope: Boolean(segmentationProfile?.preferPeakEnvelope),
    axis: 'y',
    profileMode: segmentationProfile?.profileMode || boundaryGuides?.patternProfile?.profileMode || null
  });
  const xUsesExplicitOuterBounds = (
    normalizedX.min <= 1
    && normalizedX.max >= width - 1
    && normalizedX.values.length >= Math.max(gridCols - 1, 1)
    && normalizedX.values.length <= gridCols
  );
  const yUsesExplicitOuterBounds = (
    normalizedY.min <= 1
    && normalizedY.max >= height - 1
    && normalizedY.values.length >= Math.max(gridRows - 1, 1)
    && normalizedY.values.length <= gridRows
  );
  const guideLeft = (xPreferUniformPatternFallback || xUsesExplicitOuterBounds) ? normalizedX.min : xSpan.min;
  const guideRight = Math.max(guideLeft + 1, (xPreferUniformPatternFallback || xUsesExplicitOuterBounds) ? normalizedX.max : xSpan.max);
  const guideTop = (yPreferUniformPatternFallback || yUsesExplicitOuterBounds) ? normalizedY.min : ySpan.min;
  const guideBottom = Math.max(guideTop + 1, (yPreferUniformPatternFallback || yUsesExplicitOuterBounds) ? normalizedY.max : ySpan.max);
  const profileMode = segmentationProfile?.profileMode || boundaryGuides?.patternProfile?.profileMode || null;
  let xGuide = resolveGuideAxisPeaks(normalizedX.values, guideLeft, guideRight, gridCols, {
    axis: 'x',
    profileMode,
    forceUniformBoundaries: xPreferUniformPatternFallback,
    preferExplicitOuterBounds: xUsesExplicitOuterBounds
  });
  let yGuide = resolveGuideAxisPeaks(normalizedY.values, guideTop, guideBottom, gridRows, {
    axis: 'y',
    profileMode,
    forceUniformBoundaries: yPreferUniformPatternFallback,
    preferExplicitOuterBounds: yUsesExplicitOuterBounds
  });
  const xExplicitCenterFallback = shouldFallbackExplicitBoundCenterMatchToUniform(
    normalizedX.values,
    guideLeft,
    guideRight,
    gridCols,
    {
      explicitOuterBounds: xUsesExplicitOuterBounds,
      resolvedPeakMode: xGuide.peakMode
    }
  );
  const yExplicitCenterFallback = shouldFallbackExplicitBoundCenterMatchToUniform(
    normalizedY.values,
    guideTop,
    guideBottom,
    gridRows,
    {
      explicitOuterBounds: yUsesExplicitOuterBounds,
      resolvedPeakMode: yGuide.peakMode
    }
  );
  if (xExplicitCenterFallback) {
    xGuide = {
      peakMode: '显式外边界异常回退均分',
      peaks: buildUniformPeaks(guideLeft, guideRight, gridCols)
    };
  }
  if (yExplicitCenterFallback) {
    yGuide = {
      peakMode: '显式外边界异常回退均分',
      peaks: buildUniformPeaks(guideTop, guideBottom, gridRows)
    };
  }
  const xResolvedPeakFallback = shouldFallbackResolvedPeaksToUniform(xGuide.peaks, gridCols, {
    patternName: boundaryGuides?.xPattern || null,
    explicitOuterBounds: xUsesExplicitOuterBounds,
    peakMode: xGuide.peakMode
  });
  const yResolvedPeakFallback = shouldFallbackResolvedPeaksToUniform(yGuide.peaks, gridRows, {
    patternName: boundaryGuides?.yPattern || null,
    explicitOuterBounds: yUsesExplicitOuterBounds,
    peakMode: yGuide.peakMode
  });
  if (xResolvedPeakFallback) {
    xGuide = {
      peakMode: '异常边界回退均分',
      peaks: buildUniformPeaks(guideLeft, guideRight, gridCols)
    };
  }
  if (yResolvedPeakFallback) {
    yGuide = {
      peakMode: '异常边界回退均分',
      peaks: buildUniformPeaks(guideTop, guideBottom, gridRows)
    };
  }
  const xCountRelation = forceUniformGuideBounds
    ? 'guide-bounds-uniform'
    : classifyGuideCountRelation(normalizedX.values.length, gridCols);
  const yCountRelation = forceUniformGuideBounds
    ? 'guide-bounds-uniform'
    : classifyGuideCountRelation(normalizedY.values.length, gridRows);
  if (xGuide.peakMode === '外边界均分' && xSpan.spanMode.includes('peak-envelope')) {
    xGuide.peakMode = '峰值包络均分';
  }
  if (yGuide.peakMode === '外边界均分' && ySpan.spanMode.includes('peak-envelope')) {
    yGuide.peakMode = '峰值包络均分';
  }
  const xPeaks = xGuide.peaks;
  const yPeaks = yGuide.peaks;
  const hasExactPeaks = xGuide.peakMode === '精确边界峰值' && yGuide.peakMode === '精确边界峰值';
  const guideMode = summarizeGuideMode(boundaryGuides, xGuide, yGuide);

  const xBoundaries = Array.from(
    { length: gridCols },
    (_, index) => [xPeaks[index], Math.max(xPeaks[index] + 1, xPeaks[index + 1])]
  );
  const yBoundaries = Array.from(
    { length: gridRows },
    (_, index) => [yPeaks[index], Math.max(yPeaks[index] + 1, yPeaks[index + 1])]
  );

  return {
    processNo,
    processName,
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
        source: hasExactPeaks ? '边界引导' : `${guideMode.axisMode}`,
        left: xPeaks[0],
        right: xPeaks[xPeaks.length - 1],
        top: yPeaks[0],
        bottom: yPeaks[yPeaks.length - 1],
        xSpanMode: xSpan.spanMode,
        ySpanMode: ySpan.spanMode,
        xSpanPadding: xSpan.padding,
        ySpanPadding: ySpan.padding,
        xStartPadding: xSpan.startPadding,
        xEndPadding: xSpan.endPadding,
        yStartPadding: ySpan.startPadding,
        yEndPadding: ySpan.endPadding
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
      guidePeakMode: guideMode.axisMode,
      guideAxisModes: {
        x: xGuide.peakMode,
        y: yGuide.peakMode
      },
      guideCountRelations: {
        x: xCountRelation,
        y: yCountRelation
      },
      guidePatternProfile: guideMode.profileMode,
      guideAnchorPreference: {
        x: guideMode.xAnchorPreference,
        y: guideMode.yAnchorPreference
      },
      guideSpanModes: {
        x: xSpan.spanMode,
        y: ySpan.spanMode
      },
      guideSpanPadding: {
        x: xSpan.padding,
        y: ySpan.padding
      },
      guideSpanPaddingDetail: {
        xStart: xSpan.startPadding,
        xEnd: xSpan.endPadding,
        yStart: ySpan.startPadding,
        yEnd: ySpan.endPadding
      },
      guidePatternFallback: {
        x: xPreferUniformPatternFallback,
        y: yPreferUniformPatternFallback
      },
      guideResolvedPeakFallback: {
        x: xResolvedPeakFallback,
        y: yResolvedPeakFallback
      },
      guideExplicitCenterFallback: {
        x: xExplicitCenterFallback,
        y: yExplicitCenterFallback
      },
      guideExplicitOuterBounds: {
        x: xUsesExplicitOuterBounds,
        y: yUsesExplicitOuterBounds
      },
      xPattern: guideMode.xPattern,
      yPattern: guideMode.yPattern
    }
  };
}

module.exports = {
  executeBoundaryGuideSegmentation
};
