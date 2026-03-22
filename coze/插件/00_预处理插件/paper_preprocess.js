const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

const execFileAsync = promisify(execFile);
const gridBoundaryNormalizePlugin = require('../05_0方格边界规范化插件/index');

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function cornerScoreEstimate(xScore, yScore) {
  return (Number(xScore) + Number(yScore)) / 2;
}

function normalizeCornerQuad(corners) {
  const points = (Array.isArray(corners) ? corners : [])
    .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : null)
    .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length !== 4) {
    return null;
  }
  const sums = points.map((point) => point[0] + point[1]);
  const diffs = points.map((point) => point[0] - point[1]);
  return [
    points[sums.indexOf(Math.min(...sums))],
    points[diffs.indexOf(Math.max(...diffs))],
    points[sums.indexOf(Math.max(...sums))],
    points[diffs.indexOf(Math.min(...diffs))]
  ];
}

function buildCornerPointsFromGuides(guides) {
  if (!guides) {
    return null;
  }
  const left = Number(guides.left);
  const right = Number(guides.right);
  const top = Number(guides.top);
  const bottom = Number(guides.bottom);
  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
    return null;
  }
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom]
  ];
}

function syncCornerQuadToGuides(corners, guides) {
  const guideQuad = buildCornerPointsFromGuides(guides);
  if (!guideQuad) {
    return normalizeCornerQuad(corners);
  }
  return guideQuad;
}

function buildGuidesFromCornerQuad(corners, fallbackGuides, gridRows, gridCols) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return fallbackGuides || null;
  }
  const [leftTop, rightTop, rightBottom, leftBottom] = quad;
  const left = Math.round((leftTop[0] + leftBottom[0]) / 2);
  const right = Math.round((rightTop[0] + rightBottom[0]) / 2);
  const top = Math.round((leftTop[1] + rightTop[1]) / 2);
  const bottom = Math.round((rightBottom[1] + leftBottom[1]) / 2);
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return fallbackGuides || null;
  }
  return {
    ...(fallbackGuides || {}),
    left,
    right,
    top,
    bottom,
    xPeaks: buildUniformGuidePeaks(left, right, Math.max(1, Number(gridCols) || 1)),
    yPeaks: buildUniformGuidePeaks(top, bottom, Math.max(1, Number(gridRows) || 1))
  };
}

function adjustCornerQuadByGuideBounds(corners, beforeGuides, afterGuides) {
  const quad = normalizeCornerQuad(corners);
  if (!quad || !beforeGuides || !afterGuides) {
    return normalizeCornerQuad(corners);
  }
  const [leftTop, rightTop, rightBottom, leftBottom] = quad.map((point) => [...point]);
  const beforeLeft = Number(beforeGuides.left);
  const beforeRight = Number(beforeGuides.right);
  const beforeTop = Number(beforeGuides.top);
  const beforeBottom = Number(beforeGuides.bottom);
  const afterLeft = Number(afterGuides.left);
  const afterRight = Number(afterGuides.right);
  const afterTop = Number(afterGuides.top);
  const afterBottom = Number(afterGuides.bottom);
  if (
    ![beforeLeft, beforeRight, beforeTop, beforeBottom, afterLeft, afterRight, afterTop, afterBottom].every(Number.isFinite)
  ) {
    return quad;
  }

  const deltaLeft = afterLeft - beforeLeft;
  const deltaRight = afterRight - beforeRight;
  const deltaTop = afterTop - beforeTop;
  const deltaBottom = afterBottom - beforeBottom;

  leftTop[0] += deltaLeft;
  leftBottom[0] += deltaLeft;
  rightTop[0] += deltaRight;
  rightBottom[0] += deltaRight;
  leftTop[1] += deltaTop;
  rightTop[1] += deltaTop;
  leftBottom[1] += deltaBottom;
  rightBottom[1] += deltaBottom;

  return [leftTop, rightTop, rightBottom, leftBottom];
}

function clampCornerQuad(corners, width, height) {
  const quad = normalizeCornerQuad(corners);
  if (!quad || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return quad;
  }
  return quad.map(([x, y]) => [
    clamp(x, 0, Math.max(0, width - 1)),
    clamp(y, 0, Math.max(0, height - 1))
  ]);
}

function buildGridCornerAnchors(corners, guides) {
  const quad = normalizeCornerQuad(corners) || buildCornerPointsFromGuides(guides);
  if (!quad) {
    return null;
  }
  const [leftTop, rightTop, rightBottom, leftBottom] = quad;
  return {
    corners: quad,
    namedCorners: {
      leftTop,
      rightTop,
      rightBottom,
      leftBottom
    },
    diagonalPairs: {
      leftTopToRightBottom: [leftTop, rightBottom],
      rightTopToLeftBottom: [rightTop, leftBottom]
    }
  };
}

function getCornerEdgeBounds(corners) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  const [leftTop, rightTop, rightBottom, leftBottom] = quad;
  return {
    top: average([leftTop[1], rightTop[1]]),
    bottom: average([leftBottom[1], rightBottom[1]]),
    left: average([leftTop[0], leftBottom[0]]),
    right: average([rightTop[0], rightBottom[0]])
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function repairTopHalfCellOffset(guides, corners, height) {
  const yPeaks = Array.isArray(guides?.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const quad = normalizeCornerQuad(corners);
  if (yPeaks.length < 4 || !quad) {
    return { guides, corners: quad || corners, applied: false, shift: 0 };
  }

  const gaps = yPeaks.slice(1).map((value, index) => value - yPeaks[index]).filter((gap) => gap > 0);
  if (gaps.length < 3) {
    return { guides, corners: quad, applied: false, shift: 0 };
  }

  const firstGap = gaps[0];
  const referenceGap = median(gaps.slice(1));
  const secondGap = gaps[1];
  const looksLikeHalfCell =
    referenceGap > 0 &&
    firstGap < referenceGap * 0.68 &&
    secondGap > referenceGap * 1.18;

  if (!looksLikeHalfCell) {
    return { guides, corners: quad, applied: false, shift: 0 };
  }

  const shift = Math.min(firstGap, yPeaks[0]);
  const repairedYPeaks = [...yPeaks];
  repairedYPeaks[0] = clamp(yPeaks[0] - shift, 0, Math.max(0, height - 1));
  const repairedCorners = quad.map(([x, y], index) => (
    index < 2
      ? [x, clamp(y - shift, 0, Math.max(0, height - 1))]
      : [x, y]
  ));

  return {
    guides: {
      ...guides,
      top: repairedYPeaks[0],
      yPeaks: repairedYPeaks,
      ySource: `${guides.ySource || '检测峰值筛选'} + 顶部半格修正`
    },
    corners: repairedCorners,
    applied: true,
    shift
  };
}

function repairVerticalCumulativeGapOffset(guides, corners, height) {
  const yPeaks = Array.isArray(guides?.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const quad = normalizeCornerQuad(corners);
  if (yPeaks.length < 5 || !quad) {
    return { guides, corners: quad || corners, applied: false, shift: 0, index: -1 };
  }

  const gaps = yPeaks.slice(1).map((value, index) => value - yPeaks[index]).filter((gap) => gap > 0);
  if (gaps.length < 4) {
    return { guides, corners: quad, applied: false, shift: 0, index: -1 };
  }

  const referenceGap = median(gaps.slice(2));
  if (referenceGap <= 0) {
    return { guides, corners: quad, applied: false, shift: 0, index: -1 };
  }

  let anomalyIndex = -1;
  let anomalyShift = 0;
  for (let i = 1; i < gaps.length - 1; i += 1) {
    const gap = gaps[i];
    if (gap <= referenceGap * 1.28) {
      continue;
    }
    const excess = gap - referenceGap;
    if (excess < referenceGap * 0.22) {
      continue;
    }
    anomalyIndex = i;
    anomalyShift = Math.round(Math.min(excess, referenceGap * 0.55));
    break;
  }

  if (anomalyIndex < 0 || anomalyShift <= 0) {
    return { guides, corners: quad, applied: false, shift: 0, index: -1 };
  }

  const repairedYPeaks = [...yPeaks];
  for (let i = anomalyIndex + 1; i < repairedYPeaks.length; i += 1) {
    repairedYPeaks[i] = clamp(repairedYPeaks[i] - anomalyShift, repairedYPeaks[i - 1] + 1, Math.max(0, height - 1));
  }

  const repairedCorners = quad.map(([x, y], index) => (
    index >= 2
      ? [x, clamp(y - anomalyShift, 0, Math.max(0, height - 1))]
      : [x, y]
  ));

  return {
    guides: {
      ...guides,
      bottom: repairedYPeaks[repairedYPeaks.length - 1],
      yPeaks: repairedYPeaks,
      ySource: `${guides.ySource || '检测峰值筛选'} + 纵向累计偏移修正`
    },
    corners: repairedCorners,
    applied: true,
    shift: anomalyShift,
    index: anomalyIndex
  };
}

function buildUniformGuidePeaks(start, end, cells) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !cells || cells <= 0) {
    return [];
  }
  return Array.from({ length: cells + 1 }, (_, index) => start + ((end - start) * index) / Math.max(cells, 1));
}

function sanitizeGuidePeaks(peaks) {
  const values = (Array.isArray(peaks) ? peaks : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const deduped = [];
  for (const value of values) {
    if (!deduped.length || Math.abs(value - deduped[deduped.length - 1]) > 2) {
      deduped.push(value);
    }
  }
  return deduped;
}

function selectRepresentativeGuidePeaks(rawPeaks, start, end, cells) {
  const targetCount = (cells || 0) + 1;
  if (!targetCount || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {
      peaks: [],
      source: '外边界均分'
    };
  }

  const sanitized = sanitizeGuidePeaks(rawPeaks).filter((value) => value >= start - 4 && value <= end + 4);
  if (!sanitized.length) {
    return {
      peaks: buildUniformGuidePeaks(start, end, cells),
      source: '外边界均分'
    };
  }

  const expected = buildUniformGuidePeaks(start, end, cells);
  const gap = (end - start) / Math.max(cells, 1);
  const minSpacing = Math.max(2, gap * 0.18);
  const maxSnapDistance = Math.max(16, gap * 0.8);
  const selected = [start];
  let cursor = 0;

  for (let index = 1; index < targetCount - 1; index += 1) {
    const target = expected[index];
    let bestValue = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let rawIndex = cursor; rawIndex < sanitized.length; rawIndex += 1) {
      const candidate = sanitized[rawIndex];
      if (candidate <= selected[selected.length - 1] + minSpacing) {
        continue;
      }
      const distance = Math.abs(candidate - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestValue = candidate;
        cursor = rawIndex + 1;
      }
      if (candidate > target && distance > bestDistance) {
        break;
      }
    }

    if (bestValue !== null && bestDistance <= maxSnapDistance) {
      selected.push(bestValue);
      continue;
    }

    const fallback = Math.max(selected[selected.length - 1] + minSpacing, target);
    selected.push(Math.min(fallback, end));
  }

  selected.push(end);
  return {
    peaks: selected,
    source: '检测峰值筛选'
  };
}

function buildGuidesFromRawPeaks(guides, gridRows, gridCols, boundsOverride = null) {
  if (!guides) {
    return null;
  }
  const left = Number(boundsOverride?.left ?? guides.left);
  const right = Number(boundsOverride?.right ?? guides.right);
  const top = Number(boundsOverride?.top ?? guides.top);
  const bottom = Number(boundsOverride?.bottom ?? guides.bottom);
  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
    return null;
  }

  const xSelection = selectRepresentativeGuidePeaks(guides.xPeaks, left, right, gridCols);
  const ySelection = selectRepresentativeGuidePeaks(guides.yPeaks, top, bottom, gridRows);

  return {
    left,
    right,
    top,
    bottom,
    xPeaks: xSelection.peaks,
    yPeaks: ySelection.peaks,
    xSource: xSelection.source,
    ySource: ySelection.source
  };
}

function buildNormalizedGuideSet(guides, gridRows, gridCols) {
  if (!guides) {
    return null;
  }
  const left = Number(guides.left);
  const right = Number(guides.right);
  const top = Number(guides.top);
  const bottom = Number(guides.bottom);
  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
    return null;
  }

  const rawPeakGuides = buildGuidesFromRawPeaks(guides, gridRows, gridCols, { left, right, top, bottom });
  const normalizedX = rawPeakGuides?.xPeaks || buildUniformGuidePeaks(left, right, gridCols);
  const normalizedY = rawPeakGuides?.yPeaks || buildUniformGuidePeaks(top, bottom, gridRows);

  return {
    left,
    right,
    top,
    bottom,
    xPeaks: normalizedX,
    yPeaks: normalizedY
  };
}

function inferGridOuterBoundHints(rawGuides, cellWidth, cellHeight, width, height) {
  if (!rawGuides) {
    return null;
  }
  const left = Number(rawGuides.left);
  const right = Number(rawGuides.right);
  const top = Number(rawGuides.top);
  const bottom = Number(rawGuides.bottom);
  if (![left, right, top, bottom].every(Number.isFinite)) {
    return null;
  }
  const rawX = Array.isArray(rawGuides.xPeaks) ? rawGuides.xPeaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const rawY = Array.isArray(rawGuides.yPeaks) ? rawGuides.yPeaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const innerX = rawX.filter((value) => value > left + 1 && value < right - 1);
  const innerY = rawY.filter((value) => value > top + 1 && value < bottom - 1);
  const medianXGap = median(innerX.slice(1).map((value, index) => value - innerX[index]).filter((gap) => gap > 0)) || cellWidth;
  const medianYGap = median(innerY.slice(1).map((value, index) => value - innerY[index]).filter((gap) => gap > 0)) || cellHeight;
  let hintedLeft = left;
  let hintedRight = right;
  let hintedTop = top;
  let hintedBottom = bottom;
  let leftReason = 'raw-bound';
  let rightReason = 'raw-bound';
  let topReason = 'raw-bound';
  let bottomReason = 'raw-bound';
  const diagnostics = {
    firstInnerX: innerX[0] ?? null,
    secondInnerX: innerX[1] ?? null,
    lastInnerX: innerX.length ? innerX[innerX.length - 1] : null,
    prevInnerX: innerX.length > 1 ? innerX[innerX.length - 2] : null,
    firstInnerY: innerY[0] ?? null,
    secondInnerY: innerY[1] ?? null,
    lastInnerY: innerY.length ? innerY[innerY.length - 1] : null,
    prevInnerY: innerY.length > 1 ? innerY[innerY.length - 2] : null
  };

  const countStableGaps = (values, medianGap, fromStart = true) => {
    if (!Array.isArray(values) || values.length < 3 || !Number.isFinite(medianGap) || medianGap <= 0) {
      return 0;
    }
    const gaps = values.slice(1).map((value, index) => value - values[index]).filter((gap) => gap > 0);
    if (!gaps.length) {
      return 0;
    }
    const ordered = fromStart ? gaps : [...gaps].reverse();
    let stable = 0;
    for (const gap of ordered) {
      if (gap >= medianGap * 0.45 && gap <= medianGap * 1.85) {
        stable += 1;
      } else {
        break;
      }
    }
    return stable;
  };

  if (innerX.length >= 2) {
    const firstGap = innerX[0] - left;
    const secondGap = innerX[1] - innerX[0];
    const stableInnerRun = countStableGaps(innerX, medianXGap, true);
    diagnostics.leftFirstGap = firstGap;
    diagnostics.leftSecondGap = secondGap;
    diagnostics.leftStableInnerRun = stableInnerRun;
    if (
      firstGap > 0
      && firstGap <= medianXGap * 0.25
      && secondGap >= medianXGap * 0.45
      && stableInnerRun >= 1
    ) {
      hintedLeft = innerX[0];
      leftReason = 'drop-outer-frame';
    }
    const lastGap = right - innerX[innerX.length - 1];
    const prevGap = innerX[innerX.length - 1] - innerX[Math.max(0, innerX.length - 2)];
    const stableOuterRun = countStableGaps(innerX, medianXGap, false);
    diagnostics.rightLastGap = lastGap;
    diagnostics.rightPrevGap = prevGap;
    diagnostics.rightStableInnerRun = stableOuterRun;
    if (
      lastGap > 0
      && lastGap <= medianXGap * 0.25
      && prevGap >= medianXGap * 0.45
      && stableOuterRun >= 1
    ) {
      hintedRight = innerX[innerX.length - 1];
      rightReason = 'drop-outer-frame';
    }
  }

  if (innerY.length >= 2) {
    const firstGap = innerY[0] - top;
    const secondGap = innerY[1] - innerY[0];
    const stableTopRun = countStableGaps(innerY, medianYGap, true);
    diagnostics.topFirstGap = firstGap;
    diagnostics.topSecondGap = secondGap;
    diagnostics.topStableInnerRun = stableTopRun;
    if (
      firstGap > 0
      && firstGap <= medianYGap * 0.25
      && secondGap >= medianYGap * 0.45
      && stableTopRun >= 1
    ) {
      hintedTop = innerY[0];
      topReason = 'drop-outer-frame';
    } else if (
      firstGap >= medianYGap * 0.55
      && firstGap <= medianYGap * 1.8
      && (
        secondGap >= medianYGap * 1.75
        || stableTopRun === 0
      )
    ) {
      hintedTop = clamp(innerY[0] - medianYGap, 0, Math.max(0, height - 1));
      topReason = 'infer-missing-top-line';
    }

    const lastGap = bottom - innerY[innerY.length - 1];
    const prevGap = innerY[innerY.length - 1] - innerY[Math.max(0, innerY.length - 2)];
    const stableBottomRun = countStableGaps(innerY, medianYGap, false);
    diagnostics.bottomLastGap = lastGap;
    diagnostics.bottomPrevGap = prevGap;
    diagnostics.bottomStableInnerRun = stableBottomRun;
    if (
      lastGap > 0
      && lastGap <= medianYGap * 0.25
      && prevGap >= medianYGap * 0.45
      && stableBottomRun >= 1
    ) {
      hintedBottom = innerY[innerY.length - 1];
      bottomReason = 'drop-outer-frame';
    }
  }

  return {
    left: clamp(hintedLeft, 0, Math.max(0, width - 1)),
    right: clamp(hintedRight, 0, Math.max(0, width - 1)),
    top: clamp(hintedTop, 0, Math.max(0, height - 1)),
    bottom: clamp(hintedBottom, 0, Math.max(0, height - 1)),
    reasons: {
      left: leftReason,
      right: rightReason,
      top: topReason,
      bottom: bottomReason
    },
    medianXGap,
    medianYGap,
    diagnostics
  };
}

function deriveA4ConstraintFromBounds(paperBounds) {
  if (!paperBounds) {
    return {
      enabled: true,
      standardRatio: Number(Math.sqrt(2).toFixed(4)),
      detectedRatio: 0,
      ratioError: 0,
      ratioErrorPercent: 0,
      isLikelyA4: false,
      confidence: 0,
      recommendedPerspectiveTarget: null
    };
  }

  const width = Number(paperBounds.width || 0);
  const height = Number(paperBounds.height || 0);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.max(1, Math.min(width, height));
  const detectedRatio = Number((longEdge / shortEdge).toFixed(4));
  const standardRatio = Number(Math.sqrt(2).toFixed(4));
  const ratioError = Number(Math.abs(detectedRatio - standardRatio).toFixed(4));
  const ratioErrorPercent = Number(((ratioError / standardRatio) * 100).toFixed(2));
  const isLikelyA4 = width > 0 && height > 0 && ratioErrorPercent <= 12;
  const confidence = width > 0 && height > 0
    ? Number(Math.max(0, Math.min(1, 1 - ratioErrorPercent / 12)).toFixed(4))
    : 0;

  return {
    enabled: true,
    standardRatio,
    detectedRatio,
    ratioError,
    ratioErrorPercent,
    isLikelyA4,
    confidence,
    recommendedPerspectiveTarget: width > 0 && height > 0
      ? {
          longEdge,
          shortEdge,
          standardRatio
        }
      : null
  };
}

function orientSquareGridCounts(gridRows, gridCols, outputInfo, gridType) {
  if (
    gridType !== 'square' ||
    !outputInfo ||
    !Number.isFinite(Number(outputInfo.width)) ||
    !Number.isFinite(Number(outputInfo.height)) ||
    !gridRows ||
    !gridCols
  ) {
    return { gridRows, gridCols, swapped: false };
  }

  const width = Number(outputInfo.width);
  const height = Number(outputInfo.height);
  if (height > width * 1.05 && gridRows < gridCols) {
    return {
      gridRows: gridCols,
      gridCols: gridRows,
      swapped: true
    };
  }
  if (width > height * 1.05 && gridRows > gridCols) {
    return {
      gridRows: gridCols,
      gridCols: gridRows,
      swapped: true
    };
  }
  return { gridRows, gridCols, swapped: false };
}

function applyA4GuideConstraint(gridBoundaryDetection, outputInfo, a4Constraint, gridRows, gridCols) {
  if (!gridBoundaryDetection?.guides || !outputInfo || !a4Constraint?.isLikelyA4 || !gridRows || !gridCols) {
    return {
      gridBoundaryDetection,
      guideConstraintRepair: {
        applied: false,
        reason: 'A4约束未启用或边界信息不足'
      }
    };
  }

  const normalized = buildNormalizedGuideSet(gridBoundaryDetection.guides, gridRows, gridCols);
  if (!normalized) {
    return {
      gridBoundaryDetection,
      guideConstraintRepair: {
        applied: false,
        reason: '方格引导线归一化失败'
      }
    };
  }

  const width = Number(outputInfo.width || 0);
  const height = Number(outputInfo.height || 0);
  const rawGuides = gridBoundaryDetection.rawGuides || gridBoundaryDetection.guides;
  const detectedRawTop = Number(rawGuides?.top);
  const hasDetectedRawTop = Number.isFinite(detectedRawTop);
  if (!width || !height) {
    return {
      gridBoundaryDetection,
      guideConstraintRepair: {
        applied: false,
        reason: '输出尺寸信息缺失'
      }
    };
  }

  const contentHeight = normalized.bottom - normalized.top;
  const contentWidth = normalized.right - normalized.left;
  const cellHeight = contentHeight / Math.max(gridRows, 1);
  const cellWidth = contentWidth / Math.max(gridCols, 1);
  const topMargin = normalized.top;
  const bottomMargin = Math.max(0, height - normalized.bottom);
  const leftMargin = normalized.left;
  const rightMargin = Math.max(0, width - normalized.right);
  const verticalDiff = topMargin - bottomMargin;
  const horizontalDiff = Math.abs(leftMargin - rightMargin);
  const verticalThreshold = Math.max(36, cellHeight * 0.25);
  const horizontalThreshold = Math.max(24, cellWidth * 0.35);

  const repair = {
    applied: false,
    mode: 'A4约束边界修正',
    a4Confidence: a4Constraint.confidence,
    before: {
      top: normalized.top,
      bottom: normalized.bottom,
      left: normalized.left,
      right: normalized.right,
      topMargin,
      bottomMargin,
      leftMargin,
      rightMargin,
      cellHeight: Number(cellHeight.toFixed(2)),
      cellWidth: Number(cellWidth.toFixed(2))
    }
  };

  let repairedTop = normalized.top;
  let repairedLeft = normalized.left;
  let repairedRight = normalized.right;
  let repairedGridRows = gridRows;
  let repairedGridCols = gridCols;
  const reasons = [];
  const cornerBounds = getCornerEdgeBounds(gridBoundaryDetection.corners || gridBoundaryDetection.cornerAnchors?.corners || null);

  if (verticalDiff > verticalThreshold && !hasDetectedRawTop) {
    const shift = Math.min(verticalDiff, cellHeight * 0.7);
    repairedTop = clamp(Math.round(normalized.top - shift), 0, Math.max(0, normalized.bottom - gridRows));
    repair.applied = repairedTop !== normalized.top;
    if (repair.applied) {
      reasons.push('顶部留白明显大于底部留白，按A4版面约束上移顶部边界');
    }
  }

  if (cornerBounds && Number.isFinite(cornerBounds.top) && !hasDetectedRawTop) {
    const cornerTop = clamp(Math.round(cornerBounds.top), 0, Math.max(0, height - 1));
    if (cornerTop > 0 && cornerTop < normalized.top && repairedTop < cornerTop) {
      repairedTop = cornerTop;
      repair.applied = true;
      reasons.push('顶部优先贴合四角点上边界，避免A4修正将顶边抬得过高');
    }
  }

  if (horizontalDiff > horizontalThreshold) {
    const targetMargin = Math.round((leftMargin + rightMargin) / 2);
    const maxLeft = Math.max(0, width - Math.round(contentWidth) - 1);
    repairedLeft = clamp(targetMargin, 0, maxLeft);
    repairedRight = clamp(repairedLeft + Math.round(contentWidth), repairedLeft + 1, width);
    if (repairedLeft !== normalized.left || repairedRight !== normalized.right) {
      repair.applied = true;
      reasons.push('左右留白差异过大，按A4版面约束重新平衡水平边界');
    }
  }

  if (!repair.applied) {
    repair.reason = '当前边界已通过A4版面一致性检查';
    return {
      gridBoundaryDetection,
      guideConstraintRepair: repair
    };
  }

  const repairedGuideSelection = buildGuidesFromRawPeaks(rawGuides, repairedGridRows, repairedGridCols, {
    left: repairedLeft,
    right: repairedRight,
    top: repairedTop,
    bottom: normalized.bottom
  });
  const repairedGuides = {
    left: repairedLeft,
    right: repairedRight,
    top: repairedTop,
    bottom: normalized.bottom,
    xPeaks: buildUniformGuidePeaks(repairedLeft, repairedRight, repairedGridCols),
    yPeaks: buildUniformGuidePeaks(repairedTop, normalized.bottom, repairedGridRows),
    xSource: repairedGuideSelection?.xPeaks?.length ? '外边界固定 + 内部均分' : 'A4约束修正均分',
    ySource: repairedGuideSelection?.yPeaks?.length ? '外边界固定 + 内部均分' : 'A4约束修正均分'
  };

  const repairedCorners = (
    cornerBounds
      ? normalizeCornerQuad(gridBoundaryDetection.corners || gridBoundaryDetection.cornerAnchors?.corners || null)
      : adjustCornerQuadByGuideBounds(
          gridBoundaryDetection.corners || gridBoundaryDetection.cornerAnchors?.corners || null,
          normalized,
          repairedGuides
        )
  ) || buildCornerPointsFromGuides(repairedGuides);
  const topHalfCellRepaired = repairTopHalfCellOffset(repairedGuides, repairedCorners, height);
  const finalTop = Number.isFinite(Number(topHalfCellRepaired?.guides?.top))
    ? Number(topHalfCellRepaired.guides.top)
    : repairedGuides.top;
  const finalGuides = {
    ...repairedGuides,
    top: finalTop,
    xPeaks: buildUniformGuidePeaks(repairedGuides.left, repairedGuides.right, repairedGridCols),
    yPeaks: buildUniformGuidePeaks(finalTop, repairedGuides.bottom, repairedGridRows),
    xSource: repairedGuides.xSource,
    ySource: topHalfCellRepaired?.applied
      ? `${repairedGuides.ySource || 'A4约束修正均分'} + 顶部半格修正后均分`
      : repairedGuides.ySource
  };
  const clampedRepairedCorners = clampCornerQuad(
    syncCornerQuadToGuides(
      topHalfCellRepaired?.corners || repairedCorners,
      finalGuides
    ),
    width,
    height
  ) || buildCornerPointsFromGuides(finalGuides);

  repair.reason = reasons.join('；');
  repair.after = {
    top: repairedTop,
    bottom: normalized.bottom,
    left: repairedLeft,
    right: repairedRight,
    topMargin: repairedTop,
    bottomMargin: Math.max(0, height - normalized.bottom),
    leftMargin: repairedLeft,
    rightMargin: Math.max(0, width - repairedRight)
  };
  repair.delta = {
    topShift: repairedTop - normalized.top,
    leftShift: repairedLeft - normalized.left,
    rightShift: repairedRight - normalized.right
  };
  repair.gridSize = {
    before: {
      rows: gridRows,
      cols: gridCols
    },
    after: {
      rows: repairedGridRows,
      cols: repairedGridCols
    }
  };

  return {
    gridBoundaryDetection: {
      ...gridBoundaryDetection,
      source: `${gridBoundaryDetection.source || '真实方格边界识别'} + A4约束修正`,
      corners: clampedRepairedCorners,
      cornerAnchors: buildGridCornerAnchors(clampedRepairedCorners, finalGuides),
      rawGuides: {
        ...(gridBoundaryDetection.rawGuides || gridBoundaryDetection.guides || {}),
        normalizedCandidate: repairedGuideSelection || null
      },
      guides: finalGuides
    },
    guideConstraintRepair: repair
  };
}

async function loadRgbImage(imagePath) {
  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

async function blurRgbChannels(rgbData, info, sigma) {
  const { data } = await sharp(rgbData, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels
    }
  })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function computeGray(rgbData, channels) {
  const pixelCount = Math.floor(rgbData.length / channels);
  const gray = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    const r = rgbData[offset];
    const g = rgbData[offset + 1];
    const b = rgbData[offset + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

function getMedianGap(peaks, fallback) {
  const gaps = (Array.isArray(peaks) ? peaks : [])
    .map(Number)
    .filter(Number.isFinite)
    .slice(1)
    .map((value, index, array) => value - (Array.isArray(peaks) ? Number(peaks[index]) : 0))
    .filter((gap) => gap > 0);
  return gaps.length ? median(gaps) : fallback;
}

function scoreVerticalLineAt(gray, width, height, centerX, startY, endY) {
  const x = clamp(Math.round(centerX), 0, Math.max(0, width - 1));
  const y0 = clamp(Math.round(startY), 0, Math.max(0, height - 1));
  const y1 = clamp(Math.round(endY), y0, Math.max(0, height - 1));
  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    let centerPixel = 0;
    let centerSamples = 0;
    for (let dx = -1; dx <= 1; dx += 1) {
      const sampleX = clamp(x + dx, 0, Math.max(0, width - 1));
      centerPixel += gray[y * width + sampleX];
      centerSamples += 1;
    }
    let sidePixel = 0;
    let sideSamples = 0;
    for (let dx = -5; dx <= -2; dx += 1) {
      const sampleX = clamp(x + dx, 0, Math.max(0, width - 1));
      sidePixel += gray[y * width + sampleX];
      sideSamples += 1;
    }
    for (let dx = 2; dx <= 5; dx += 1) {
      const sampleX = clamp(x + dx, 0, Math.max(0, width - 1));
      sidePixel += gray[y * width + sampleX];
      sideSamples += 1;
    }
    const centerGray = centerPixel / Math.max(1, centerSamples);
    const sideGray = sidePixel / Math.max(1, sideSamples);
    const darkness = 255 - centerGray;
    const contrast = Math.max(0, sideGray - centerGray);
    sum += contrast * 0.72 + darkness * 0.28;
    count += 1;
  }
  return count ? sum / count : 0;
}

function scoreHorizontalLineAt(gray, width, height, centerY, startX, endX) {
  const y = clamp(Math.round(centerY), 0, Math.max(0, height - 1));
  const x0 = clamp(Math.round(startX), 0, Math.max(0, width - 1));
  const x1 = clamp(Math.round(endX), x0, Math.max(0, width - 1));
  let sum = 0;
  let count = 0;
  for (let x = x0; x <= x1; x += 1) {
    let centerPixel = 0;
    let centerSamples = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      const sampleY = clamp(y + dy, 0, Math.max(0, height - 1));
      centerPixel += gray[sampleY * width + x];
      centerSamples += 1;
    }
    let sidePixel = 0;
    let sideSamples = 0;
    for (let dy = -5; dy <= -2; dy += 1) {
      const sampleY = clamp(y + dy, 0, Math.max(0, height - 1));
      sidePixel += gray[sampleY * width + x];
      sideSamples += 1;
    }
    for (let dy = 2; dy <= 5; dy += 1) {
      const sampleY = clamp(y + dy, 0, Math.max(0, height - 1));
      sidePixel += gray[sampleY * width + x];
      sideSamples += 1;
    }
    const centerGray = centerPixel / Math.max(1, centerSamples);
    const sideGray = sidePixel / Math.max(1, sideSamples);
    const darkness = 255 - centerGray;
    const contrast = Math.max(0, sideGray - centerGray);
    sum += contrast * 0.72 + darkness * 0.28;
    count += 1;
  }
  return count ? sum / count : 0;
}

function scoreOuterVerticalBoundaryAt(gray, width, height, centerX, startY, endY, inwardDir) {
  const x = clamp(Math.round(centerX), 0, Math.max(0, width - 1));
  const y0 = clamp(Math.round(startY), 0, Math.max(0, height - 1));
  const y1 = clamp(Math.round(endY), y0, Math.max(0, height - 1));
  let sum = 0;
  let count = 0;
  let strongCount = 0;
  let continuityRun = 0;
  let bestContinuityRun = 0;
  for (let y = y0; y <= y1; y += 1) {
    let linePixel = 0;
    let lineSamples = 0;
    for (let dx = -1; dx <= 1; dx += 1) {
      const sampleX = clamp(x + dx, 0, Math.max(0, width - 1));
      linePixel += gray[y * width + sampleX];
      lineSamples += 1;
    }
    let insidePixel = 0;
    let insideSamples = 0;
    for (let step = 3; step <= 8; step += 1) {
      const sampleX = clamp(x + inwardDir * step, 0, Math.max(0, width - 1));
      insidePixel += gray[y * width + sampleX];
      insideSamples += 1;
    }
    let outsidePixel = 0;
    let outsideSamples = 0;
    for (let step = 3; step <= 8; step += 1) {
      const sampleX = clamp(x - inwardDir * step, 0, Math.max(0, width - 1));
      outsidePixel += gray[y * width + sampleX];
      outsideSamples += 1;
    }
    const lineGray = linePixel / Math.max(1, lineSamples);
    const insideGray = insidePixel / Math.max(1, insideSamples);
    const outsideGray = outsidePixel / Math.max(1, outsideSamples);
    const darkness = 255 - lineGray;
    const insideContrast = Math.max(0, insideGray - lineGray);
    const outsideContrast = Math.max(0, outsideGray - lineGray);
    const localScore = darkness * 0.34 + insideContrast * 0.36 + outsideContrast * 0.3;
    if (darkness >= 30 && (insideContrast + outsideContrast) >= 18) {
      strongCount += 1;
      continuityRun += 1;
      bestContinuityRun = Math.max(bestContinuityRun, continuityRun);
    } else {
      continuityRun = 0;
    }
    sum += localScore;
    count += 1;
  }
  if (!count) {
    return 0;
  }
  const continuityRatio = strongCount / count;
  const continuityBonus = continuityRatio * 26 + bestContinuityRun * 1.8;
  return (sum / count) + continuityBonus;
}

function scoreOuterHorizontalBoundaryAt(gray, width, height, centerY, startX, endX, inwardDir) {
  const y = clamp(Math.round(centerY), 0, Math.max(0, height - 1));
  const x0 = clamp(Math.round(startX), 0, Math.max(0, width - 1));
  const x1 = clamp(Math.round(endX), x0, Math.max(0, width - 1));
  let sum = 0;
  let count = 0;
  let strongCount = 0;
  let continuityRun = 0;
  let bestContinuityRun = 0;
  for (let x = x0; x <= x1; x += 1) {
    let linePixel = 0;
    let lineSamples = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      const sampleY = clamp(y + dy, 0, Math.max(0, height - 1));
      linePixel += gray[sampleY * width + x];
      lineSamples += 1;
    }
    let insidePixel = 0;
    let insideSamples = 0;
    for (let step = 3; step <= 8; step += 1) {
      const sampleY = clamp(y + inwardDir * step, 0, Math.max(0, height - 1));
      insidePixel += gray[sampleY * width + x];
      insideSamples += 1;
    }
    let outsidePixel = 0;
    let outsideSamples = 0;
    for (let step = 3; step <= 8; step += 1) {
      const sampleY = clamp(y - inwardDir * step, 0, Math.max(0, height - 1));
      outsidePixel += gray[sampleY * width + x];
      outsideSamples += 1;
    }
    const lineGray = linePixel / Math.max(1, lineSamples);
    const insideGray = insidePixel / Math.max(1, insideSamples);
    const outsideGray = outsidePixel / Math.max(1, outsideSamples);
    const darkness = 255 - lineGray;
    const insideContrast = Math.max(0, insideGray - lineGray);
    const outsideContrast = Math.max(0, outsideGray - lineGray);
    const localScore = darkness * 0.34 + insideContrast * 0.36 + outsideContrast * 0.3;
    if (darkness >= 30 && (insideContrast + outsideContrast) >= 18) {
      strongCount += 1;
      continuityRun += 1;
      bestContinuityRun = Math.max(bestContinuityRun, continuityRun);
    } else {
      continuityRun = 0;
    }
    sum += localScore;
    count += 1;
  }
  if (!count) {
    return 0;
  }
  const continuityRatio = strongCount / count;
  const continuityBonus = continuityRatio * 26 + bestContinuityRun * 1.8;
  return (sum / count) + continuityBonus;
}

function scoreVerticalTerminationAt(gray, width, height, centerX, centerY) {
  const x = clamp(Math.round(centerX), 0, Math.max(0, width - 1));
  const y = clamp(Math.round(centerY), 0, Math.max(0, height - 1));
  let abovePixel = 0;
  let aboveSamples = 0;
  for (let sampleY = y - 12; sampleY <= y - 3; sampleY += 1) {
    const py = clamp(sampleY, 0, Math.max(0, height - 1));
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = clamp(x + dx, 0, Math.max(0, width - 1));
      abovePixel += gray[py * width + px];
      aboveSamples += 1;
    }
  }
  let centerPixel = 0;
  let centerSamples = 0;
  for (let sampleY = y - 2; sampleY <= y + 2; sampleY += 1) {
    const py = clamp(sampleY, 0, Math.max(0, height - 1));
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = clamp(x + dx, 0, Math.max(0, width - 1));
      centerPixel += gray[py * width + px];
      centerSamples += 1;
    }
  }
  let belowPixel = 0;
  let belowSamples = 0;
  for (let sampleY = y + 3; sampleY <= y + 12; sampleY += 1) {
    const py = clamp(sampleY, 0, Math.max(0, height - 1));
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = clamp(x + dx, 0, Math.max(0, width - 1));
      belowPixel += gray[py * width + px];
      belowSamples += 1;
    }
  }
  const aboveGray = abovePixel / Math.max(1, aboveSamples);
  const centerGray = centerPixel / Math.max(1, centerSamples);
  const belowGray = belowPixel / Math.max(1, belowSamples);
  const centerDarkness = 255 - centerGray;
  const aboveSupport = Math.max(0, aboveGray - centerGray);
  const belowRelease = Math.max(0, belowGray - centerGray);
  return centerDarkness * 0.26 + aboveSupport * 0.28 + belowRelease * 0.46;
}

function pickBestLocalIndex(start, end, expected, scoreAt, distancePenalty = 0.85) {
  const from = Math.round(Math.min(start, end));
  const to = Math.round(Math.max(start, end));
  let bestIndex = clamp(Math.round(expected), from, to);
  let bestScore = -Infinity;
  for (let index = from; index <= to; index += 1) {
    const distance = Math.abs(index - expected);
    const score = scoreAt(index) - distance * distancePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return { index: bestIndex, score: bestScore };
}

function pickBestDirectionalIndex(start, end, expected, scoreAt, options = {}) {
  const {
    distancePenalty = 0.85,
    outwardTarget = expected,
    outwardBias = 0
  } = options;
  const from = Math.round(Math.min(start, end));
  const to = Math.round(Math.max(start, end));
  let bestIndex = clamp(Math.round(expected), from, to);
  let bestScore = -Infinity;
  for (let index = from; index <= to; index += 1) {
    const distance = Math.abs(index - expected);
    const outwardDistance = Math.abs(index - outwardTarget);
    const score = scoreAt(index) - distance * distancePenalty - outwardDistance * outwardBias;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return { index: bestIndex, score: bestScore };
}

async function refineTopGuideByVerticalAnchors(imagePath, guides) {
  if (!imagePath || !guides) {
    return null;
  }

  const left = Number(guides.left);
  const right = Number(guides.right);
  const top = Number(guides.top);
  const bottom = Number(guides.bottom);
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return null;
  }

  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const gray = computeGray(rgbData, info.channels);
  const cellWidth = Math.max(24, Math.round(getMedianGap(xPeaks, info.width * 0.12)));
  const cellHeight = Math.max(24, Math.round(getMedianGap(yPeaks, info.height * 0.08)));
  const searchUp = Math.max(8, Math.round(cellHeight * 0.55));
  const searchDown = Math.max(6, Math.round(cellHeight * 0.45));
  const verticalSpan = Math.max(18, Math.round(cellHeight * 1.15));
  const horizontalSpan = Math.max(18, Math.round(cellWidth * 1.1));

  const buildAnchor = (name, anchorX, inwardDir) => {
    const yStart = clamp(top - searchUp, 0, Math.max(0, info.height - 1));
    const yEnd = clamp(top + searchDown, 0, Math.max(0, info.height - 1));
    const horizontalX0 = clamp(inwardDir > 0 ? anchorX : (anchorX - horizontalSpan), 0, Math.max(0, info.width - 1));
    const horizontalX1 = clamp(inwardDir > 0 ? (anchorX + horizontalSpan) : anchorX, 0, Math.max(0, info.width - 1));
    const yPick = pickBestLocalIndex(
      yStart,
      yEnd,
      top,
      (candidateY) => {
        const verticalScore = scoreVerticalLineAt(gray, info.width, info.height, anchorX, candidateY, candidateY + verticalSpan);
        const horizontalScore = scoreHorizontalLineAt(gray, info.width, info.height, candidateY, horizontalX0, horizontalX1);
        const centerScore = scoreCornerIntersection(gray, info.width, info.height, anchorX, candidateY);
        return verticalScore * 0.45 + horizontalScore * 0.35 + centerScore * 0.2;
      },
      0.9
    );
    return {
      name,
      x: anchorX,
      y: yPick.index,
      score: yPick.score,
      searchWindow: {
        x: [anchorX, anchorX],
        y: [yStart, yEnd]
      }
    };
  };

  const leftAnchor = buildAnchor('leftTop', Math.round(left), 1);
  const rightAnchor = buildAnchor('rightTop', Math.round(right), -1);
  const refinedTop = Math.round((leftAnchor.y + rightAnchor.y) / 2);

  return {
    method: 'top-guide vertical-anchor confirmation',
    cellWidth,
    cellHeight,
    refinedTop,
    anchors: {
      leftTop: leftAnchor,
      rightTop: rightAnchor
    }
  };
}

function pickBestLocalCorner(options = {}) {
  const {
    xStart,
    xEnd,
    yStart,
    yEnd,
    expectedX,
    expectedY,
    scoreAt,
    distancePenalty = 0.85
  } = options;

  const fromX = Math.round(Math.min(xStart, xEnd));
  const toX = Math.round(Math.max(xStart, xEnd));
  const fromY = Math.round(Math.min(yStart, yEnd));
  const toY = Math.round(Math.max(yStart, yEnd));
  let best = {
    x: clamp(Math.round(expectedX), fromX, toX),
    y: clamp(Math.round(expectedY), fromY, toY),
    score: -Infinity
  };

  for (let y = fromY; y <= toY; y += 1) {
    for (let x = fromX; x <= toX; x += 1) {
      const distance = Math.hypot(x - expectedX, y - expectedY);
      const score = scoreAt(x, y) - distance * distancePenalty;
      if (score > best.score) {
        best = { x, y, score };
      }
    }
  }

  return best;
}

function scoreCornerIntersection(gray, width, height, x, y) {
  const cx = clamp(Math.round(x), 0, Math.max(0, width - 1));
  const cy = clamp(Math.round(y), 0, Math.max(0, height - 1));
  let sum = 0;
  let count = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const px = clamp(cx + dx, 0, Math.max(0, width - 1));
      const py = clamp(cy + dy, 0, Math.max(0, height - 1));
      sum += 255 - gray[py * width + px];
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function averageGrayInBox(gray, width, height, x0, y0, x1, y1) {
  const left = clamp(Math.round(Math.min(x0, x1)), 0, Math.max(0, width - 1));
  const right = clamp(Math.round(Math.max(x0, x1)), left, Math.max(0, width - 1));
  const top = clamp(Math.round(Math.min(y0, y1)), 0, Math.max(0, height - 1));
  const bottom = clamp(Math.round(Math.max(y0, y1)), top, Math.max(0, height - 1));
  let sum = 0;
  let count = 0;
  for (let y = top; y <= bottom; y += 1) {
    const offset = y * width;
    for (let x = left; x <= right; x += 1) {
      sum += gray[offset + x];
      count += 1;
    }
  }
  return count ? sum / count : 255;
}

function scoreHorizontalDashedGuideAt(gray, width, height, centerY, startX, endX) {
  const x0 = Math.round(Math.min(startX, endX));
  const x1 = Math.round(Math.max(startX, endX));
  if (x1 - x0 < 12) {
    return scoreHorizontalLineAt(gray, width, height, centerY, startX, endX);
  }
  const span = x1 - x0;
  const leftA = x0 + Math.round(span * 0.08);
  const leftB = x0 + Math.round(span * 0.32);
  const rightA = x0 + Math.round(span * 0.68);
  const rightB = x0 + Math.round(span * 0.92);
  const leftScore = scoreHorizontalLineAt(gray, width, height, centerY, leftA, leftB);
  const rightScore = scoreHorizontalLineAt(gray, width, height, centerY, rightA, rightB);
  return leftScore * 0.5 + rightScore * 0.5;
}

function scoreVerticalDashedGuideAt(gray, width, height, centerX, startY, endY) {
  const y0 = Math.round(Math.min(startY, endY));
  const y1 = Math.round(Math.max(startY, endY));
  if (y1 - y0 < 12) {
    return scoreVerticalLineAt(gray, width, height, centerX, startY, endY);
  }
  const span = y1 - y0;
  const topA = y0 + Math.round(span * 0.08);
  const topB = y0 + Math.round(span * 0.32);
  const bottomA = y0 + Math.round(span * 0.68);
  const bottomB = y0 + Math.round(span * 0.92);
  const topScore = scoreVerticalLineAt(gray, width, height, centerX, topA, topB);
  const bottomScore = scoreVerticalLineAt(gray, width, height, centerX, bottomA, bottomB);
  return topScore * 0.5 + bottomScore * 0.5;
}

async function recoverTopCornersByInnerGuide(imagePath, corners, guides) {
  const quad = normalizeCornerQuad(corners);
  if (!imagePath || !quad || !guides) {
    return { corners: quad, applied: false, diagnostics: null };
  }

  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const baseGray = computeGray(rgbData, info.channels);
  const gray = await buildOuterFrameEnhancedGray(baseGray, info.width, info.height, guides);
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(24, Math.round(getMedianGap(xPeaks, info.width * 0.12)));
  const cellHeight = Math.max(24, Math.round(getMedianGap(yPeaks, info.height * 0.08)));
  const diagnostics = {};
  const recovered = quad.map((point) => [...point]);

  const topSpecs = [
    { name: 'leftTop', index: 0, inward: 1 },
    { name: 'rightTop', index: 1, inward: -1 }
  ];

  for (const spec of topSpecs) {
    const expected = quad[spec.index];
    const outerX = Number(expected[0]);
    const outerY = Number(expected[1]);
    const dashedXStart = clamp(
      outerX + spec.inward * Math.round(cellWidth * 0.05),
      0,
      Math.max(0, info.width - 1)
    );
    const dashedXEnd = clamp(
      outerX + spec.inward * Math.round(cellWidth * 0.22),
      0,
      Math.max(0, info.width - 1)
    );
    const dashedExpectedX = outerX + spec.inward * Math.round(cellWidth * 0.12);
    const dashedXPick = pickBestLocalIndex(
      dashedXStart,
      dashedXEnd,
      dashedExpectedX,
      (candidateX) => {
        const score = scoreVerticalDashedGuideAt(
          gray,
          info.width,
          info.height,
          candidateX,
          outerY - Math.round(cellHeight * 0.22),
          outerY + Math.round(cellHeight * 0.42)
        );
        return score;
      },
      0.38
    );
    const dashedX = dashedXPick.index;
    const inset = Math.abs(dashedX - outerX);
    const dashedYStart = clamp(outerY - Math.round(cellHeight * 0.48), 0, Math.max(0, info.height - 1));
    const dashedYEnd = clamp(outerY - Math.round(cellHeight * 0.04), dashedYStart, Math.max(0, info.height - 1));
    const dashedExpectedY = clamp(outerY - inset, dashedYStart, dashedYEnd);
    const horizSpan = Math.round(cellWidth * 0.72);
    const dashedYPick = pickBestLocalIndex(
      dashedYStart,
      dashedYEnd,
      dashedExpectedY,
      (candidateY) => {
        const horizontalScore = scoreHorizontalDashedGuideAt(
          gray,
          info.width,
          info.height,
          candidateY,
          spec.inward > 0 ? dashedX : dashedX - horizSpan,
          spec.inward > 0 ? dashedX + horizSpan : dashedX
        );
        const aboveGray = averageGrayInBox(
          gray,
          info.width,
          info.height,
          spec.inward > 0 ? dashedX : dashedX - horizSpan,
          candidateY - 10,
          spec.inward > 0 ? dashedX + horizSpan : dashedX,
          candidateY - 3
        );
        const belowGray = averageGrayInBox(
          gray,
          info.width,
          info.height,
          spec.inward > 0 ? dashedX : dashedX - horizSpan,
          candidateY + 3,
          spec.inward > 0 ? dashedX + horizSpan : dashedX,
          candidateY + 10
        );
        const bandContrast = Math.max(0, ((aboveGray + belowGray) / 2) - averageGrayInBox(
          gray,
          info.width,
          info.height,
          spec.inward > 0 ? dashedX : dashedX - horizSpan,
          candidateY - 1,
          spec.inward > 0 ? dashedX + horizSpan : dashedX,
          candidateY + 1
        ));
        return horizontalScore * 0.72 + bandContrast * 0.28;
      },
      0.3
    );
    const dashedY = dashedYPick.index;
    const inferredOuterY = clamp(dashedY - inset, 0, Math.max(0, info.height - 1));
    const outerSearchStart = clamp(inferredOuterY - 8, 0, Math.max(0, info.height - 1));
    const outerSearchEnd = clamp(inferredOuterY + 8, outerSearchStart, Math.max(0, info.height - 1));
    const refinedOuterYPick = pickBestLocalIndex(
      outerSearchStart,
      outerSearchEnd,
      inferredOuterY,
      (candidateY) => {
        const horizontalScore = scoreHorizontalLineAt(
          gray,
          info.width,
          info.height,
          candidateY,
          spec.inward > 0 ? outerX : outerX - Math.round(cellWidth * 0.88),
          spec.inward > 0 ? outerX + Math.round(cellWidth * 0.88) : outerX
        );
        const verticalScore = scoreVerticalLineAt(
          gray,
          info.width,
          info.height,
          outerX,
          candidateY,
          candidateY + Math.round(cellHeight * 0.85)
        );
        const aboveGray = averageGrayInBox(
          gray,
          info.width,
          info.height,
          spec.inward > 0 ? outerX + 6 : outerX - Math.round(cellWidth * 0.5),
          candidateY - 12,
          spec.inward > 0 ? outerX + Math.round(cellWidth * 0.5) : outerX - 6,
          candidateY - 3
        );
        const aboveBrightScore = Math.max(0, aboveGray - 170);
        return horizontalScore * 0.38 + verticalScore * 0.38 + aboveBrightScore * 0.24;
      },
      0.45
    );
    const refinedOuterY = refinedOuterYPick.index;
    const shouldApply = refinedOuterY < outerY - Math.round(cellHeight * 0.1);
    diagnostics[spec.name] = {
      expected: [outerX, outerY],
      dashedX,
      dashedY,
      inset,
      inferredOuterY,
      refinedOuterY,
      dashedXScore: Number(dashedXPick.score.toFixed(3)),
      dashedYScore: Number(dashedYPick.score.toFixed(3)),
      refinedOuterScore: Number(refinedOuterYPick.score.toFixed(3)),
      applied: shouldApply
    };
    if (shouldApply) {
      recovered[spec.index] = [outerX, refinedOuterY];
    }
  }

  const normalizedRecovered = normalizeCornerQuad(recovered);
  const applied = normalizedRecovered
    ? normalizedRecovered.some((point, index) => (
      Math.abs(point[0] - quad[index][0]) >= 1 || Math.abs(point[1] - quad[index][1]) >= 1
    ))
    : false;

  return {
    corners: normalizedRecovered || quad,
    applied,
    diagnostics: {
      method: 'top-corner recovery by inner dashed guide',
      cellWidth,
      cellHeight,
      corners: diagnostics
    }
  };
}

function pickBottomCornerAnchor(options = {}) {
  const {
    gray,
    width,
    height,
    expectedX,
    expectedY,
    xStart,
    xEnd,
    yStart,
    yEnd,
    verticalY0,
    verticalY1,
    horizontalX0,
    horizontalX1
  } = options;

  let best = {
    x: clamp(Math.round(expectedX), Math.round(Math.min(xStart, xEnd)), Math.round(Math.max(xStart, xEnd))),
    y: clamp(Math.round(expectedY), Math.round(Math.min(yStart, yEnd)), Math.round(Math.max(yStart, yEnd))),
    score: -Infinity
  };

  for (let y = Math.round(Math.min(yStart, yEnd)); y <= Math.round(Math.max(yStart, yEnd)); y += 1) {
    for (let x = Math.round(Math.min(xStart, xEnd)); x <= Math.round(Math.max(xStart, xEnd)); x += 1) {
      const verticalScore = scoreVerticalLineAt(gray, width, height, x, verticalY0, verticalY1);
      const horizontalScore = scoreHorizontalLineAt(gray, width, height, y, horizontalX0, horizontalX1);
      const centerScore = scoreCornerIntersection(gray, width, height, x, y);
      const distancePenalty = Math.hypot(x - expectedX, y - expectedY) * 0.85;
      const score = verticalScore * 0.3 + horizontalScore * 0.5 + centerScore * 0.2 - distancePenalty;
      if (score > best.score) {
        best = { x, y, score };
      }
    }
  }

  return best;
}

function collectLocalVerticalBoundaryPoints(gray, width, height, options = {}) {
  const {
    expectedX,
    xStart,
    xEnd,
    yStart,
    yEnd,
    inwardDir,
    outwardBias = 0.18
  } = options;
  const xFrom = Math.round(Math.min(xStart, xEnd));
  const xTo = Math.round(Math.max(xStart, xEnd));
  const yFrom = Math.round(Math.min(yStart, yEnd));
  const yTo = Math.round(Math.max(yStart, yEnd));
  const outwardTargetX = inwardDir > 0
    ? Math.round(expectedX + (xFrom - expectedX) * 0.62)
    : Math.round(expectedX + (xTo - expectedX) * 0.62);
  const points = [];
  for (let y = yFrom; y <= yTo; y += 2) {
    const xPick = pickBestDirectionalIndex(
      xFrom,
      xTo,
      Math.round(expectedX),
      (candidateX) => scoreOuterVerticalBoundaryAt(gray, width, height, candidateX, y - 8, y + 8, inwardDir),
      {
        distancePenalty: 0.56,
        outwardTarget: outwardTargetX,
        outwardBias
      }
    );
    points.push([xPick.index, y]);
  }
  return points;
}

function collectLocalHorizontalBoundaryPoints(gray, width, height, options = {}) {
  const {
    expectedY,
    xStart,
    xEnd,
    yStart,
    yEnd,
    inwardDir,
    outwardBias = 0.16
  } = options;
  const xFrom = Math.round(Math.min(xStart, xEnd));
  const xTo = Math.round(Math.max(xStart, xEnd));
  const yFrom = Math.round(Math.min(yStart, yEnd));
  const yTo = Math.round(Math.max(yStart, yEnd));
  const outwardTargetY = inwardDir > 0
    ? Math.round(expectedY + (yFrom - expectedY) * 0.62)
    : Math.round(expectedY + (yTo - expectedY) * 0.62);
  const points = [];
  for (let x = xFrom; x <= xTo; x += 2) {
    const yPick = pickBestDirectionalIndex(
      yFrom,
      yTo,
      Math.round(expectedY),
      (candidateY) => scoreOuterHorizontalBoundaryAt(gray, width, height, candidateY, x - 8, x + 8, inwardDir),
      {
        distancePenalty: 0.62,
        outwardTarget: outwardTargetY,
        outwardBias
      }
    );
    points.push([x, yPick.index]);
  }
  return points;
}

function collectGlobalVerticalBoundaryPoints(gray, width, height, options = {}) {
  const {
    expectedX,
    xStart,
    xEnd,
    yStart,
    yEnd,
    inwardDir,
    step = 6,
    outwardBias = 0.18
  } = options;
  const xFrom = Math.round(Math.min(xStart, xEnd));
  const xTo = Math.round(Math.max(xStart, xEnd));
  const yFrom = Math.round(Math.min(yStart, yEnd));
  const yTo = Math.round(Math.max(yStart, yEnd));
  const outwardTargetX = inwardDir > 0
    ? Math.round(expectedX + (xFrom - expectedX) * 0.62)
    : Math.round(expectedX + (xTo - expectedX) * 0.62);
  const points = [];
  for (let y = yFrom; y <= yTo; y += step) {
    const xPick = pickBestDirectionalIndex(
      xFrom,
      xTo,
      Math.round(expectedX),
      (candidateX) => scoreOuterVerticalBoundaryAt(gray, width, height, candidateX, y - 10, y + 10, inwardDir),
      {
        distancePenalty: 0.56,
        outwardTarget: outwardTargetX,
        outwardBias
      }
    );
    points.push([xPick.index, y]);
  }
  return points;
}

function findStrongDirectionalLine(from, to, scoreAt, minSpacing = 6) {
  let best = { index: null, score: -Infinity };
  for (let i = Math.round(from); i <= Math.round(to); i += 1) {
    const score = scoreAt(i);
    if (score > best.score) {
      best = { index: i, score };
    }
  }
  if (!Number.isFinite(best.score) || best.index === null) {
    return null;
  }
  const left = Math.max(Math.round(from), best.index - minSpacing);
  const right = Math.min(Math.round(to), best.index + minSpacing);
  let refined = best;
  for (let i = left; i <= right; i += 1) {
    const score = scoreAt(i);
    if (score > refined.score) {
      refined = { index: i, score };
    }
  }
  return refined;
}

function findNearestDirectionalPeak(from, to, scoreAt, options = {}) {
  const {
    direction = 'forward',
    minScore = 18,
    relativeFloor = 0
  } = options;
  const start = Math.round(from);
  const end = Math.round(to);
  const step = direction === 'backward' ? -1 : 1;
  if ((step > 0 && start > end) || (step < 0 && start < end)) {
    return null;
  }
  let best = null;
  for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
    const score = scoreAt(i);
    if (!Number.isFinite(score) || score < minScore || score < relativeFloor) {
      continue;
    }
    const prev = scoreAt(i - 1);
    const next = scoreAt(i + 1);
    const isPeak = score >= (Number.isFinite(prev) ? prev : -Infinity) && score >= (Number.isFinite(next) ? next : -Infinity);
    if (!isPeak) {
      continue;
    }
    best = { index: i, score };
    break;
  }
  return best;
}

async function removeObviousOuterFrameLines(imagePath, outputPath) {
  if (!imagePath || !outputPath) {
    return null;
  }
  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const width = info.width || 0;
  const height = info.height || 0;
  if (width < 200 || height < 200) {
    return {
      applied: false,
      reason: 'image-too-small'
    };
  }
  const gray = computeGray(rgbData, info.channels);
  const darkMask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    darkMask[i] = gray[i] < 152 ? 1 : 0;
  }
  const expandedDarkMask = dilateMask(darkMask, width, height, 1);
  const imageArea = Math.max(1, width * height);
  const componentCandidates = extractConnectedComponents(expandedDarkMask, width, height, {
    minArea: Math.max(120, Math.round(width * height * 0.0002))
  })
    .map((component) => {
      const bboxWidth = component.maxX - component.minX + 1;
      const bboxHeight = component.maxY - component.minY + 1;
      const bboxArea = bboxWidth * bboxHeight;
      const enriched = {
        ...component,
        bboxWidth,
        bboxHeight,
        bboxArea,
        fillRatio: component.area / Math.max(1, bboxArea)
      };
      const structure = evaluateOuterFrameCandidateStructure(enriched, width, height);
      return {
        ...enriched,
        structure,
        structureScore: scoreOuterFrameCandidate(enriched, structure, imageArea)
      };
    })
    .filter((component) => (
      component.bboxWidth >= width * 0.68
      && component.bboxHeight >= height * 0.68
      && component.fillRatio <= 0.14
      && component.minX > Math.max(10, Math.round(width * 0.02))
      && component.minY > Math.max(10, Math.round(height * 0.02))
      && component.maxX < width - Math.max(11, Math.round(width * 0.02))
      && component.maxY < height - Math.max(11, Math.round(height * 0.02))
    ))
    // Prefer "looks like a closed frame" over raw area, so a large but wrong dark block
    // does not outrank a slightly smaller independent outer frame.
    .sort((a, b) => (
      Number(Boolean(b.structure?.eligible)) - Number(Boolean(a.structure?.eligible))
      || (b.structureScore - a.structureScore)
      || (b.bboxArea - a.bboxArea)
    ));

  if (componentCandidates.length) {
    const candidate = componentCandidates[0];
    const candidateStructure = candidate.structure || evaluateOuterFrameCandidateStructure(candidate, width, height);
    const candidateRankSummary = buildOuterFrameCandidateRankSummary(componentCandidates, 3);
    if (!candidateStructure.eligible) {
      return {
        applied: false,
        reason: `candidate-structure-${candidateStructure.reason}`,
        component: {
          area: candidate.area,
          bbox: {
            left: candidate.minX,
            top: candidate.minY,
            right: candidate.maxX,
            bottom: candidate.maxY,
            width: candidate.bboxWidth,
            height: candidate.bboxHeight
          },
          fillRatio: Number(candidate.fillRatio.toFixed(4)),
          structure: candidateStructure,
          structureScore: Number((candidate.structureScore || 0).toFixed(4)),
          candidateRankSummary
        }
      };
    }
    const refineOuterBand = Math.max(14, Math.round(Math.min(candidate.bboxWidth, candidate.bboxHeight) * 0.02));
    const refineInsetX = Math.max(16, Math.round(candidate.bboxWidth * 0.045));
    const refineInsetY = Math.max(16, Math.round(candidate.bboxHeight * 0.045));
    const refineSpanX0 = clamp(candidate.minX + refineInsetX, 0, width - 1);
    const refineSpanX1 = clamp(candidate.maxX - refineInsetX, refineSpanX0 + 1, width - 1);
    const refineSpanY0 = clamp(candidate.minY + refineInsetY, 0, height - 1);
    const refineSpanY1 = clamp(candidate.maxY - refineInsetY, refineSpanY0 + 1, height - 1);
    const refinedTopLine = findStrongDirectionalLine(
      Math.max(0, candidate.minY - refineOuterBand),
      Math.min(height - 1, candidate.minY + refineOuterBand),
      (y) => scoreHorizontalLineAt(gray, width, height, y, refineSpanX0, refineSpanX1)
    );
    const refinedTopOuterLineWide = findStrongDirectionalLine(
      Math.max(0, candidate.minY - Math.max(40, refineOuterBand * 3)),
      Math.min(height - 1, candidate.minY + 6),
      (y) => scoreHorizontalLineAt(gray, width, height, y, refineSpanX0, refineSpanX1)
    );
    const refinedTopOuterLine = (
      refinedTopOuterLineWide
      && refinedTopLine
      && refinedTopOuterLineWide.index <= refinedTopLine.index - 6
      && refinedTopOuterLineWide.score >= refinedTopLine.score * 0.55
    )
      ? refinedTopOuterLineWide
      : refinedTopLine;
    const refinedBottomLine = findStrongDirectionalLine(
      Math.max(0, candidate.maxY - refineOuterBand),
      Math.min(height - 1, candidate.maxY + refineOuterBand),
      (y) => scoreHorizontalLineAt(gray, width, height, y, refineSpanX0, refineSpanX1)
    );
    const refinedLeftLine = findStrongDirectionalLine(
      Math.max(0, candidate.minX - refineOuterBand),
      Math.min(width - 1, candidate.minX + refineOuterBand),
      (x) => scoreVerticalLineAt(gray, width, height, x, refineSpanY0, refineSpanY1)
    );
    const refinedRightLine = findStrongDirectionalLine(
      Math.max(0, candidate.maxX - refineOuterBand),
      Math.min(width - 1, candidate.maxX + refineOuterBand),
      (x) => scoreVerticalLineAt(gray, width, height, x, refineSpanY0, refineSpanY1)
    );
    const outerFrame = {
      top: refinedTopOuterLine?.index ?? candidate.minY,
      bottom: refinedBottomLine?.index ?? candidate.maxY,
      left: refinedLeftLine?.index ?? candidate.minX,
      right: refinedRightLine?.index ?? candidate.maxX
    };
    const topDarkBandLine = (() => {
      const fromY = Math.max(0, candidate.minY - Math.max(40, refineOuterBand * 3));
      const toY = Math.min(height - 1, candidate.minY + 8);
      let best = null;
      for (let y = fromY; y <= toY; y += 1) {
        let darkCount = 0;
        for (let x = refineSpanX0; x <= refineSpanX1; x += 1) {
          if (darkMask[y * width + x]) {
            darkCount += 1;
          }
        }
        if (!best || darkCount > best.darkCount) {
          best = { index: y, darkCount };
        }
      }
      return best;
    })();
    const innerInsetX = Math.max(18, Math.round(candidate.bboxWidth * 0.04));
    const innerInsetY = Math.max(18, Math.round(candidate.bboxHeight * 0.04));
    const innerTop = findStrongDirectionalLine(
      candidate.minY + innerInsetY,
      Math.min(candidate.maxY - innerInsetY, candidate.minY + Math.round(candidate.bboxHeight * 0.22)),
      (y) => scoreHorizontalLineAt(gray, width, height, y, candidate.minX + innerInsetX, candidate.maxX - innerInsetX)
    );
    const innerBottom = findStrongDirectionalLine(
      Math.max(candidate.minY + innerInsetY, candidate.maxY - Math.round(candidate.bboxHeight * 0.22)),
      candidate.maxY - innerInsetY,
      (y) => scoreHorizontalLineAt(gray, width, height, y, candidate.minX + innerInsetX, candidate.maxX - innerInsetX)
    );
    const innerLeft = findStrongDirectionalLine(
      candidate.minX + innerInsetX,
      Math.min(candidate.maxX - innerInsetX, candidate.minX + Math.round(candidate.bboxWidth * 0.22)),
      (x) => scoreVerticalLineAt(gray, width, height, x, candidate.minY + innerInsetY, candidate.maxY - innerInsetY)
    );
    const innerRight = findStrongDirectionalLine(
      Math.max(candidate.minX + innerInsetX, candidate.maxX - Math.round(candidate.bboxWidth * 0.22)),
      candidate.maxX - innerInsetX,
      (x) => scoreVerticalLineAt(gray, width, height, x, candidate.minY + innerInsetY, candidate.maxY - innerInsetY)
    );
    const nestedInnerSignals = [innerTop, innerBottom, innerLeft, innerRight].filter((line) => line && line.score >= 40);
    const innerGridLeft = clamp(candidate.minX + Math.round(candidate.bboxWidth * 0.08), 0, width - 1);
    const innerGridRight = clamp(candidate.maxX - Math.round(candidate.bboxWidth * 0.08), innerGridLeft + 1, width - 1);
    const innerGridTop = clamp(candidate.minY + Math.round(candidate.bboxHeight * 0.08), 0, height - 1);
    const innerGridBottom = clamp(candidate.maxY - Math.round(candidate.bboxHeight * 0.08), innerGridTop + 1, height - 1);
    const verticalSeries = new Float32Array(innerGridRight - innerGridLeft + 1);
    for (let x = innerGridLeft; x <= innerGridRight; x += 1) {
      verticalSeries[x - innerGridLeft] = scoreVerticalLineAt(gray, width, height, x, innerGridTop, innerGridBottom);
    }
    const horizontalSeries = new Float32Array(innerGridBottom - innerGridTop + 1);
    for (let y = innerGridTop; y <= innerGridBottom; y += 1) {
      horizontalSeries[y - innerGridTop] = scoreHorizontalLineAt(gray, width, height, y, innerGridLeft, innerGridRight);
    }
    const regularVertical = detectRegularLinePeaks(verticalSeries, {
      minSpacing: Math.max(10, Math.round(candidate.bboxWidth * 0.025)),
      thresholdRatio: 0.54
    });
    const regularHorizontal = detectRegularLinePeaks(horizontalSeries, {
      minSpacing: Math.max(10, Math.round(candidate.bboxHeight * 0.02)),
      thresholdRatio: 0.54
    });
    const regularGridConfirmed = (
      regularVertical.peaks.length >= 4
      && regularHorizontal.peaks.length >= 7
      && regularVertical.stableGapCount >= 3
      && regularHorizontal.stableGapCount >= 5
    );
    const estimatedCellGapX = clamp(
      Math.round(
        regularVertical.medianGap && regularVertical.stableGapCount >= 2
          ? regularVertical.medianGap
          : candidate.bboxWidth / Math.max(8, regularVertical.peaks.length + 1 || 10)
      ),
      28,
      Math.round(candidate.bboxWidth * 0.18)
    );
    const estimatedCellGapY = clamp(
      Math.round(
        regularHorizontal.medianGap && regularHorizontal.stableGapCount >= 3
          ? regularHorizontal.medianGap
          : candidate.bboxHeight / Math.max(12, regularHorizontal.peaks.length + 1 || 15)
      ),
      28,
      Math.round(candidate.bboxHeight * 0.14)
    );
    const innerFrameSearchSpanX = Math.max(28, Math.round(candidate.bboxWidth * 0.18));
    const innerFrameSearchSpanY = Math.max(28, Math.round(candidate.bboxHeight * 0.18));
    const pickImmediateInnerLine = (from, to, scoreAt, options) => {
      const nearest = findNearestDirectionalPeak(from, to, scoreAt, options);
      if (nearest) {
        return nearest;
      }
      return findStrongDirectionalLine(from, to, scoreAt);
    };
    const nearInnerTop = pickImmediateInnerLine(
      Math.min(height - 1, outerFrame.top + 4),
      Math.min(height - 1, outerFrame.top + innerFrameSearchSpanY),
      (y) => scoreHorizontalLineAt(gray, width, height, y, refineSpanX0, refineSpanX1),
      {
        direction: 'forward',
        minScore: 18,
        relativeFloor: Math.max(16, (refinedTopLine?.score || 0) * 0.58)
      }
    );
    const nearInnerBottom = pickImmediateInnerLine(
      Math.max(0, outerFrame.bottom - innerFrameSearchSpanY),
      Math.max(0, outerFrame.bottom - 4),
      (y) => scoreHorizontalLineAt(gray, width, height, y, refineSpanX0, refineSpanX1),
      {
        direction: 'backward',
        minScore: 18,
        relativeFloor: Math.max(16, (refinedBottomLine?.score || 0) * 0.58)
      }
    );
    const nearInnerLeft = pickImmediateInnerLine(
      Math.min(width - 1, outerFrame.left + 4),
      Math.min(width - 1, outerFrame.left + innerFrameSearchSpanX),
      (x) => scoreVerticalLineAt(gray, width, height, x, refineSpanY0, refineSpanY1),
      {
        direction: 'forward',
        minScore: 18,
        relativeFloor: Math.max(16, (refinedLeftLine?.score || 0) * 0.58)
      }
    );
    const nearInnerRight = pickImmediateInnerLine(
      Math.max(0, outerFrame.right - innerFrameSearchSpanX),
      Math.max(0, outerFrame.right - 4),
      (x) => scoreVerticalLineAt(gray, width, height, x, refineSpanY0, refineSpanY1),
      {
        direction: 'backward',
        minScore: 18,
        relativeFloor: Math.max(16, (refinedRightLine?.score || 0) * 0.58)
      }
    );
    const findFollowGridLine = (direction, frameLine, quarterGapLimit) => {
      if (!frameLine) {
        return null;
      }
      const searchSpan = Math.max(8, Math.round(quarterGapLimit));
      if (direction === 'top') {
        return findNearestDirectionalPeak(
          Math.min(height - 1, frameLine.index + 2),
          Math.min(height - 1, frameLine.index + searchSpan),
          (y) => scoreHorizontalLineAt(gray, width, height, y, refineSpanX0, refineSpanX1),
          { direction: 'forward', minScore: 12 }
        );
      }
      if (direction === 'bottom') {
        return findNearestDirectionalPeak(
          Math.max(0, frameLine.index - searchSpan),
          Math.max(0, frameLine.index - 2),
          (y) => scoreHorizontalLineAt(gray, width, height, y, refineSpanX0, refineSpanX1),
          { direction: 'backward', minScore: 12 }
        );
      }
      if (direction === 'left') {
        return findNearestDirectionalPeak(
          Math.min(width - 1, frameLine.index + 2),
          Math.min(width - 1, frameLine.index + searchSpan),
          (x) => scoreVerticalLineAt(gray, width, height, x, refineSpanY0, refineSpanY1),
          { direction: 'forward', minScore: 12 }
        );
      }
      return findNearestDirectionalPeak(
        Math.max(0, frameLine.index - searchSpan),
        Math.max(0, frameLine.index - 2),
        (x) => scoreVerticalLineAt(gray, width, height, x, refineSpanY0, refineSpanY1),
        { direction: 'backward', minScore: 12 }
      );
    };
    const quarterGapX = Math.max(8, Math.round(estimatedCellGapX / 4));
    const quarterGapY = Math.max(8, Math.round(estimatedCellGapY / 4));
    const followGridTop = findFollowGridLine('top', nearInnerTop, quarterGapY);
    const followGridBottom = findFollowGridLine('bottom', nearInnerBottom, quarterGapY);
    const followGridLeft = findFollowGridLine('left', nearInnerLeft, quarterGapX);
    const followGridRight = findFollowGridLine('right', nearInnerRight, quarterGapX);
    const buildRemovableSide = (outerLine, innerLine, followGridLine, quarterGapLimit, searchSpan) => {
      if (!outerLine || !innerLine) {
        return { removable: false, distance: null, frameToGridGap: null };
      }
      const distance = Math.abs(innerLine.index - outerLine.index);
      const frameToGridGap = followGridLine ? Math.abs(followGridLine.index - innerLine.index) : null;
      const validOuterInnerDistance = distance >= 4 && distance <= Math.max(12, searchSpan);
      const validStrength = innerLine.score >= 22;
      const weakFollowGridBackedByStrongInner = (
        !!followGridLine
        && followGridLine.score >= 12
        && innerLine.score >= 40
        && frameToGridGap >= 2
        && frameToGridGap <= quarterGapLimit
      );
      const validFrameToGridGap = (
        !followGridLine
        || (
          (followGridLine.score >= 16 || weakFollowGridBackedByStrongInner)
          && frameToGridGap >= 2
          && frameToGridGap <= quarterGapLimit
        )
      );
      return {
        removable: validOuterInnerDistance && validStrength && validFrameToGridGap,
        distance,
        frameToGridGap,
        quarterGapLimit,
        outerScore: Number(outerLine.score.toFixed(3)),
        innerScore: Number(innerLine.score.toFixed(3)),
        followGridScore: followGridLine ? Number(followGridLine.score.toFixed(3)) : null,
        weakFollowGridBackedByStrongInner,
        outerIndex: outerLine.index,
        innerIndex: innerLine.index,
        followGridIndex: followGridLine ? followGridLine.index : null
      };
    };
    const removableSides = {
      top: buildRemovableSide(refinedTopLine, nearInnerTop, followGridTop, quarterGapY, innerFrameSearchSpanY),
      bottom: buildRemovableSide(refinedBottomLine, nearInnerBottom, followGridBottom, quarterGapY, innerFrameSearchSpanY),
      left: buildRemovableSide(refinedLeftLine, nearInnerLeft, followGridLeft, quarterGapX, innerFrameSearchSpanX),
      right: buildRemovableSide(refinedRightLine, nearInnerRight, followGridRight, quarterGapX, innerFrameSearchSpanX)
    };
    const topHeaderGapEligible = (
      !removableSides.top.removable
      && removableSides.bottom.removable
      && removableSides.left.removable
      && removableSides.right.removable
      && regularGridConfirmed
      && !!nearInnerTop
      && !!followGridTop
      && Math.abs((followGridTop?.index || 0) - (nearInnerTop?.index || 0)) <= Math.max(12, quarterGapY)
      && Math.abs((nearInnerTop?.index || 0) - outerFrame.top) >= Math.max(Math.round(quarterGapY * 3), Math.round(candidate.bboxHeight * 0.1), 120)
      && (followGridTop?.score || 0) >= 12
    );
    const hasImmediateInnerFrame = (
      removableSides.top.removable
      && removableSides.bottom.removable
      && removableSides.left.removable
      && removableSides.right.removable
    );
    const hasRelaxedImmediateInnerFrame = (
      removableSides.bottom.removable
      && removableSides.left.removable
      && removableSides.right.removable
      && (removableSides.top.removable || topHeaderGapEligible)
    );
    const structuralFrameConfirmed = (
      hasRelaxedImmediateInnerFrame
      && (
        nestedInnerSignals.length >= 2
        || regularGridConfirmed
        || (
          regularHorizontal.stableGapCount >= 5
          && regularHorizontal.peaks.length >= 7
          && regularVertical.stableGapCount >= 2
        )
      )
    );
    const nestedFrameConfirmed = structuralFrameConfirmed;
    if (!nestedFrameConfirmed) {
      return {
        applied: false,
        reason: hasRelaxedImmediateInnerFrame ? 'no-confirmed-nested-inner-frame' : 'no-immediate-inner-frame',
        component: {
          area: candidate.area,
          bbox: {
            left: candidate.minX,
            top: candidate.minY,
            right: candidate.maxX,
            bottom: candidate.maxY,
            width: candidate.bboxWidth,
            height: candidate.bboxHeight
          },
          fillRatio: Number(candidate.fillRatio.toFixed(4))
        },
        innerFrame: {
          top: innerTop,
          bottom: innerBottom,
          left: innerLeft,
          right: innerRight
        },
        immediateInnerFrame: {
          top: nearInnerTop,
          bottom: nearInnerBottom,
          left: nearInnerLeft,
          right: nearInnerRight
        },
        followGridLine: {
          top: followGridTop,
          bottom: followGridBottom,
          left: followGridLeft,
          right: followGridRight
        },
        relaxedImmediateInnerFrame: {
          applied: false,
          topHeaderGapEligible,
          hasImmediateInnerFrame,
          hasRelaxedImmediateInnerFrame,
          structuralFrameConfirmed
        },
        removableSides,
        regularGrid: {
          verticalPeaks: regularVertical.peaks.length,
          verticalMedianGap: Number((regularVertical.medianGap || 0).toFixed(3)),
          verticalStableGapCount: regularVertical.stableGapCount,
          horizontalPeaks: regularHorizontal.peaks.length,
          horizontalMedianGap: Number((regularHorizontal.medianGap || 0).toFixed(3)),
          horizontalStableGapCount: regularHorizontal.stableGapCount
        }
      };
    }
    const componentMask = new Uint8Array(width * height);
    for (const pixelIndex of candidate.pixels) {
      componentMask[pixelIndex] = 1;
    }
    // At 03 stage we no longer trust any global aspect-ratio prior. We only require:
    // 1) the candidate itself looks like an independent frame, and
    // 2) the candidate is not materially glued to inner dark content.
    const separationCheck = evaluateOuterFrameInnerSeparation({
      darkMask,
      candidateMask: componentMask,
      width,
      height,
      outerFrame,
      immediateInnerFrame: {
        top: topHeaderGapEligible ? (followGridTop?.index ?? nearInnerTop?.index ?? outerFrame.top) : (nearInnerTop?.index ?? outerFrame.top),
        bottom: nearInnerBottom?.index ?? outerFrame.bottom,
        left: nearInnerLeft?.index ?? outerFrame.left,
        right: nearInnerRight?.index ?? outerFrame.right
      },
      spanX0: refineSpanX0,
      spanX1: refineSpanX1,
      spanY0: refineSpanY0,
      spanY1: refineSpanY1
    });
    if (!separationCheck.eligible) {
      return {
        applied: false,
        reason: `candidate-separation-${separationCheck.reason}`,
        component: {
          area: candidate.area,
          bbox: {
            left: candidate.minX,
            top: candidate.minY,
            right: candidate.maxX,
            bottom: candidate.maxY,
            width: candidate.bboxWidth,
            height: candidate.bboxHeight
          },
          fillRatio: Number(candidate.fillRatio.toFixed(4)),
          structure: candidateStructure,
          structureScore: Number((candidate.structureScore || 0).toFixed(4)),
          candidateRankSummary,
          separation: separationCheck
        },
        immediateInnerFrame: {
          top: nearInnerTop,
          bottom: nearInnerBottom,
          left: nearInnerLeft,
          right: nearInnerRight
        }
      };
    }
    const outerQuad = estimateCornerQuadFromMask(componentMask, width, height, {
      recursiveMinSize: 8,
      recursiveMaxDepth: 12,
      recursiveBlend: 0.18,
      recursiveMaxShift: 72,
      boundaryBlend: 0.14,
      boundaryMaxShift: 30,
      stabilizeBlend: 0.04
    }) || [
      [outerFrame.left, outerFrame.top],
      [outerFrame.right, outerFrame.top],
      [outerFrame.right, outerFrame.bottom],
      [outerFrame.left, outerFrame.bottom]
    ];
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outer-frame-crop-'));
    const rectifiedOuterPath = path.join(tempDir, 'outer_frame_rectified.png');
    const rectifiedOuterMetaPath = path.join(tempDir, 'outer_frame_rectified.json');
    let rectifiedMeta = null;
    let rectifiedCrop = null;
    let cropAspectRatio = null;
    const fallbackMargins = {
      top: Math.max(1, Math.round(Math.abs(((topHeaderGapEligible ? followGridTop?.index : nearInnerTop?.index) ?? innerTop?.index ?? outerFrame.top) - outerFrame.top))),
      bottom: Math.max(1, Math.round(Math.abs(outerFrame.bottom - (nearInnerBottom?.index ?? innerBottom?.index ?? outerFrame.bottom)))),
      left: Math.max(1, Math.round(Math.abs((nearInnerLeft?.index ?? innerLeft?.index ?? outerFrame.left) - outerFrame.left))),
      right: Math.max(1, Math.round(Math.abs(outerFrame.right - (nearInnerRight?.index ?? innerRight?.index ?? outerFrame.right))))
    };
    try {
      rectifiedMeta = await runPaperQuadRectify(imagePath, outerQuad, rectifiedOuterPath, rectifiedOuterMetaPath);
      const { data: rectifiedRgbData, info: rectifiedInfo } = await loadRgbImage(rectifiedOuterPath);
      rectifiedCrop = analyzeRectifiedOuterFrameCrop(rectifiedRgbData, rectifiedInfo);
      if (!rectifiedCrop?.cropBox) {
        const rectifiedWidth = rectifiedInfo.width || 0;
        const rectifiedHeight = rectifiedInfo.height || 0;
        const fallbackLeft = clamp(fallbackMargins.left, 0, Math.max(0, rectifiedWidth - 2));
        const fallbackTop = clamp(fallbackMargins.top, 0, Math.max(0, rectifiedHeight - 2));
        const fallbackRight = clamp(rectifiedWidth - 1 - fallbackMargins.right, fallbackLeft + 1, Math.max(1, rectifiedWidth - 1));
        const fallbackBottom = clamp(rectifiedHeight - 1 - fallbackMargins.bottom, fallbackTop + 1, Math.max(1, rectifiedHeight - 1));
        rectifiedCrop = {
          cropBox: {
            left: fallbackLeft,
            top: fallbackTop,
            right: fallbackRight,
            bottom: fallbackBottom,
            width: fallbackRight - fallbackLeft + 1,
            height: fallbackBottom - fallbackTop + 1
          },
          outerFrame: {
            top: 0,
            bottom: rectifiedHeight - 1,
            left: 0,
            right: rectifiedWidth - 1
          },
          immediateInnerFrame: {
            top: fallbackTop,
            bottom: fallbackBottom,
            left: fallbackLeft,
            right: fallbackRight
          },
          removableSides: {
            top: { removable: true, distance: fallbackMargins.top },
            bottom: { removable: true, distance: fallbackMargins.bottom },
            left: { removable: true, distance: fallbackMargins.left },
            right: { removable: true, distance: fallbackMargins.right }
          },
          method: 'rectified-margin-fallback'
        };
      }
      cropAspectRatio = rectifiedCrop?.cropBox?.width && rectifiedCrop?.cropBox?.height
        ? rectifiedCrop.cropBox.width / rectifiedCrop.cropBox.height
        : null;
      await sharp(rectifiedOuterPath)
        .extract({
          left: rectifiedCrop.cropBox.left,
          top: rectifiedCrop.cropBox.top,
          width: rectifiedCrop.cropBox.width,
          height: rectifiedCrop.cropBox.height
        })
        .png()
        .toFile(outputPath);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    return {
      applied: true,
      reason: rectifiedCrop?.method === 'rectified-margin-fallback'
        ? 'outer-frame-rectify-then-margin-crop'
        : 'outer-frame-rectify-then-crop',
      component: {
        area: candidate.area,
        bbox: {
          left: candidate.minX,
          top: candidate.minY,
          right: candidate.maxX,
          bottom: candidate.maxY,
          width: candidate.bboxWidth,
          height: candidate.bboxHeight
        },
        fillRatio: Number(candidate.fillRatio.toFixed(4)),
        refinedOuterFrame: {
          top: outerFrame.top,
          bottom: outerFrame.bottom,
          left: outerFrame.left,
          right: outerFrame.right
        },
        outerQuad,
        rectifiedOuterFrame: rectifiedMeta || null,
        croppedInnerFrame: rectifiedCrop?.cropBox || null,
        cropAspectRatio: Number.isFinite(cropAspectRatio) ? Number(cropAspectRatio.toFixed(4)) : null,
        structure: candidateStructure,
        structureScore: Number((candidate.structureScore || 0).toFixed(4)),
        candidateRankSummary,
        separation: separationCheck,
        immediateInnerFrame: {
          top: rectifiedCrop?.immediateInnerFrame?.top ?? nearInnerTop?.index ?? null,
          bottom: rectifiedCrop?.immediateInnerFrame?.bottom ?? nearInnerBottom?.index ?? null,
          left: rectifiedCrop?.immediateInnerFrame?.left ?? nearInnerLeft?.index ?? null,
          right: rectifiedCrop?.immediateInnerFrame?.right ?? nearInnerRight?.index ?? null
        },
        followGridLine: {
          top: followGridTop?.index ?? null,
          bottom: followGridBottom?.index ?? null,
          left: followGridLeft?.index ?? null,
          right: followGridRight?.index ?? null
        },
        removableSides: rectifiedCrop?.removableSides || removableSides
      },
      innerFrame: {
        top: innerTop,
        bottom: innerBottom,
        left: innerLeft,
        right: innerRight
      },
      regularGrid: {
        verticalPeaks: regularVertical.peaks.length,
        verticalMedianGap: Number((regularVertical.medianGap || 0).toFixed(3)),
        verticalStableGapCount: regularVertical.stableGapCount,
        horizontalPeaks: regularHorizontal.peaks.length,
        horizontalMedianGap: Number((regularHorizontal.medianGap || 0).toFixed(3)),
        horizontalStableGapCount: regularHorizontal.stableGapCount
      }
    };
  }

  const startX = Math.round(width * 0.08);
  const endX = Math.round(width * 0.92);
  const startY = Math.round(height * 0.08);
  const endY = Math.round(height * 0.92);
  const topLine = findStrongDirectionalLine(
    Math.round(height * 0.02),
    Math.round(height * 0.35),
    (y) => scoreHorizontalLineAt(gray, width, height, y, startX, endX)
  );
  const bottomLine = findStrongDirectionalLine(
    Math.round(height * 0.65),
    Math.round(height * 0.98),
    (y) => scoreHorizontalLineAt(gray, width, height, y, startX, endX)
  );
  const leftLine = findStrongDirectionalLine(
    Math.round(width * 0.02),
    Math.round(width * 0.35),
    (x) => scoreVerticalLineAt(gray, width, height, x, startY, endY)
  );
  const rightLine = findStrongDirectionalLine(
    Math.round(width * 0.65),
    Math.round(width * 0.98),
    (x) => scoreVerticalLineAt(gray, width, height, x, startY, endY)
  );
  if (!topLine || !bottomLine || !leftLine || !rightLine) {
    return {
      applied: false,
      reason: 'outer-frame-lines-not-found'
    };
  }
  const outerWidth = rightLine.index - leftLine.index;
  const outerHeight = bottomLine.index - topLine.index;
  const outerStrongEnough = (
    topLine.score >= 70
    && bottomLine.score >= 70
    && leftLine.score >= 70
    && rightLine.score >= 70
  );
  const outerLargeEnough = outerWidth >= width * 0.68 && outerHeight >= height * 0.68;
  if (!outerStrongEnough || !outerLargeEnough) {
    return {
      applied: false,
      reason: 'outer-frame-not-obvious',
      outerFrame: {
        top: topLine,
        bottom: bottomLine,
        left: leftLine,
        right: rightLine
      }
    };
  }

  const innerTop = findStrongDirectionalLine(
    topLine.index + Math.max(16, Math.round(height * 0.01)),
    Math.min(bottomLine.index - 16, topLine.index + Math.round(height * 0.25)),
    (y) => scoreHorizontalLineAt(gray, width, height, y, leftLine.index + 12, rightLine.index - 12)
  );
  const innerBottom = findStrongDirectionalLine(
    Math.max(topLine.index + 16, bottomLine.index - Math.round(height * 0.25)),
    bottomLine.index - Math.max(16, Math.round(height * 0.01)),
    (y) => scoreHorizontalLineAt(gray, width, height, y, leftLine.index + 12, rightLine.index - 12)
  );
  const innerLeft = findStrongDirectionalLine(
    leftLine.index + Math.max(16, Math.round(width * 0.01)),
    Math.min(rightLine.index - 16, leftLine.index + Math.round(width * 0.25)),
    (x) => scoreVerticalLineAt(gray, width, height, x, topLine.index + 12, bottomLine.index - 12)
  );
  const innerRight = findStrongDirectionalLine(
    Math.max(leftLine.index + 16, rightLine.index - Math.round(width * 0.25)),
    rightLine.index - Math.max(16, Math.round(width * 0.01)),
    (x) => scoreVerticalLineAt(gray, width, height, x, topLine.index + 12, bottomLine.index - 12)
  );
  const innerSignals = [innerTop, innerBottom, innerLeft, innerRight].filter((line) => line && line.score >= 45);
  if (innerSignals.length < 3) {
    return {
      applied: false,
      reason: 'no-nested-inner-frame',
      outerFrame: {
        top: topLine,
        bottom: bottomLine,
        left: leftLine,
        right: rightLine
      },
      innerFrame: {
        top: innerTop,
        bottom: innerBottom,
        left: innerLeft,
        right: innerRight
      }
    };
  }

  const cleaned = Buffer.from(rgbData);
  const band = 7;
  const whitenPixel = (x, y) => {
    const px = clamp(x, 0, width - 1);
    const py = clamp(y, 0, height - 1);
    const offset = (py * width + px) * info.channels;
    cleaned[offset] = 255;
    cleaned[offset + 1] = 255;
    cleaned[offset + 2] = 255;
  };
  for (let y = topLine.index - band; y <= topLine.index + band; y += 1) {
    for (let x = leftLine.index - band; x <= rightLine.index + band; x += 1) {
      whitenPixel(x, y);
    }
  }
  for (let y = bottomLine.index - band; y <= bottomLine.index + band; y += 1) {
    for (let x = leftLine.index - band; x <= rightLine.index + band; x += 1) {
      whitenPixel(x, y);
    }
  }
  for (let x = leftLine.index - band; x <= leftLine.index + band; x += 1) {
    for (let y = topLine.index - band; y <= bottomLine.index + band; y += 1) {
      whitenPixel(x, y);
    }
  }
  for (let x = rightLine.index - band; x <= rightLine.index + band; x += 1) {
    for (let y = topLine.index - band; y <= bottomLine.index + band; y += 1) {
      whitenPixel(x, y);
    }
  }

  await sharp(cleaned, {
    raw: {
      width,
      height,
      channels: info.channels
    }
  }).png().toFile(outputPath);

  return {
    applied: true,
    reason: 'outer-frame-erased',
    outerFrame: {
      top: topLine,
      bottom: bottomLine,
      left: leftLine,
      right: rightLine
    },
    innerFrame: {
      top: innerTop,
      bottom: innerBottom,
      left: innerLeft,
      right: innerRight
    }
  };
}

function medianCoordinate(points, axis = 0) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }
  const values = points
    .map((point) => Array.isArray(point) ? Number(point[axis]) : NaN)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) {
    return null;
  }
  return median(values);
}

function deriveDominantGuideBoundsFromImage(gray, width, height, guides, options = {}) {
  if (!guides) {
    return null;
  }
  const hintedLeft = clamp(Math.round(Number(guides.left)), 0, Math.max(0, width - 1));
  const hintedRight = clamp(Math.round(Number(guides.right)), hintedLeft, Math.max(0, width - 1));
  const hintedTop = clamp(Math.round(Number(guides.top)), 0, Math.max(0, height - 1));
  const hintedBottom = clamp(Math.round(Number(guides.bottom)), hintedTop, Math.max(0, height - 1));
  const cellWidth = Math.max(24, Math.round(Number(options.cellWidth) || 0));
  const cellHeight = Math.max(24, Math.round(Number(options.cellHeight) || 0));
  const sideSearch = Math.max(12, Math.round(cellWidth * 0.22));
  const topLift = Math.max(20, Math.round(cellHeight * 1.2));
  const topReturn = Math.max(10, Math.round(cellHeight * 0.18));
  const bottomDrop = Math.max(16, Math.round(cellHeight * 0.55));
  const coarseY0 = clamp(hintedTop - topLift, 0, Math.max(0, height - 1));
  const coarseY1 = clamp(hintedBottom + bottomDrop, coarseY0, Math.max(0, height - 1));

  const leftPoints = collectGlobalVerticalBoundaryPoints(gray, width, height, {
    expectedX: hintedLeft,
    xStart: hintedLeft,
    xEnd: hintedLeft + sideSearch,
    yStart: coarseY0,
    yEnd: coarseY1,
    inwardDir: 1,
    step: 8,
    outwardBias: 0.1
  });
  const rightPoints = collectGlobalVerticalBoundaryPoints(gray, width, height, {
    expectedX: hintedRight,
    xStart: hintedRight - sideSearch,
    xEnd: hintedRight,
    yStart: coarseY0,
    yEnd: coarseY1,
    inwardDir: -1,
    step: 8,
    outwardBias: 0.1
  });
  const leftLine = fitLineRobust(leftPoints, 4);
  const rightLine = fitLineRobust(rightPoints, 4);
  const leftTop = probeVerticalLineEndpoint(leftLine, gray, width, height, {
    startY: Math.min(hintedBottom, hintedTop + Math.max(16, Math.round(cellHeight * 0.6))),
    endY: coarseY0,
    inwardDir: 1,
    direction: 'top'
  });
  const rightTop = probeVerticalLineEndpoint(rightLine, gray, width, height, {
    startY: Math.min(hintedBottom, hintedTop + Math.max(16, Math.round(cellHeight * 0.6))),
    endY: coarseY0,
    inwardDir: -1,
    direction: 'top'
  });
  const leftBottom = probeVerticalLineEndpoint(leftLine, gray, width, height, {
    startY: Math.max(hintedTop, hintedBottom - Math.max(16, Math.round(cellHeight * 0.6))),
    endY: coarseY1,
    inwardDir: 1,
    direction: 'bottom'
  });
  const rightBottom = probeVerticalLineEndpoint(rightLine, gray, width, height, {
    startY: Math.max(hintedTop, hintedBottom - Math.max(16, Math.round(cellHeight * 0.6))),
    endY: coarseY1,
    inwardDir: -1,
    direction: 'bottom'
  });

  const verticalTopY = medianCoordinate([leftTop, rightTop], 1);
  const verticalBottomY = medianCoordinate([leftBottom, rightBottom], 1);
  const topProbeExpected = Number.isFinite(verticalTopY) ? verticalTopY : hintedTop;
  const bottomProbeExpected = Number.isFinite(verticalBottomY) ? verticalBottomY : hintedBottom;

  const topPoints = collectGlobalHorizontalBoundaryPoints(gray, width, height, {
    expectedY: topProbeExpected,
    xStart: hintedLeft,
    xEnd: hintedRight,
    yStart: Math.max(0, Math.round(topProbeExpected - topLift)),
    yEnd: Math.min(height - 1, Math.round(topProbeExpected + topReturn)),
    inwardDir: 1,
    step: 8,
    outwardBias: 0.1
  });
  const bottomPoints = collectGlobalHorizontalBoundaryPoints(gray, width, height, {
    expectedY: bottomProbeExpected,
    xStart: hintedLeft,
    xEnd: hintedRight,
    yStart: Math.max(0, Math.round(bottomProbeExpected - topReturn)),
    yEnd: Math.min(height - 1, Math.round(bottomProbeExpected + bottomDrop)),
    inwardDir: -1,
    step: 8,
    outwardBias: 0.1
  });
  const topLine = fitLineRobust(topPoints, 4);
  const bottomLine = fitLineRobust(bottomPoints, 4);
  const extremeTopPoints = extractExtremeSupportPoints(
    topLine,
    topPoints,
    (point) => scoreOuterHorizontalBoundaryAt(gray, width, height, point[1], point[0] - 10, point[0] + 10, 1),
    'top',
    { ratio: 0.18 }
  );
  const extremeBottomPoints = extractExtremeSupportPoints(
    bottomLine,
    bottomPoints,
    (point) => scoreOuterHorizontalBoundaryAt(gray, width, height, point[1], point[0] - 10, point[0] + 10, -1),
    'bottom',
    { ratio: 0.18 }
  );
  const topExtremeY = medianCoordinate(extremeTopPoints, 1);
  const bottomExtremeY = medianCoordinate(extremeBottomPoints, 1);

  let effectiveTop = hintedTop;
  let effectiveBottom = hintedBottom;
  if (Number.isFinite(verticalTopY) && verticalTopY < effectiveTop) {
    effectiveTop = verticalTopY;
  }
  if (Number.isFinite(topExtremeY) && topExtremeY < effectiveTop + cellHeight * 0.35) {
    effectiveTop = Math.min(effectiveTop, topExtremeY);
  }
  if (Number.isFinite(verticalBottomY) && verticalBottomY > effectiveBottom) {
    effectiveBottom = verticalBottomY;
  }
  if (Number.isFinite(bottomExtremeY) && bottomExtremeY > effectiveBottom - cellHeight * 0.35) {
    effectiveBottom = Math.max(effectiveBottom, bottomExtremeY);
  }

  return {
    left: hintedLeft,
    right: hintedRight,
    top: clamp(Math.round(effectiveTop), 0, Math.max(0, height - 1)),
    bottom: clamp(Math.round(effectiveBottom), 0, Math.max(0, height - 1)),
    diagnostics: {
      hinted: {
        left: hintedLeft,
        right: hintedRight,
        top: hintedTop,
        bottom: hintedBottom
      },
      coarseWindow: {
        y: [coarseY0, coarseY1],
        sideSearch
      },
      verticalEndpoints: {
        leftTop: leftTop ? leftTop.map((value) => Number(value.toFixed(3))) : null,
        rightTop: rightTop ? rightTop.map((value) => Number(value.toFixed(3))) : null,
        leftBottom: leftBottom ? leftBottom.map((value) => Number(value.toFixed(3))) : null,
        rightBottom: rightBottom ? rightBottom.map((value) => Number(value.toFixed(3))) : null
      },
      horizontalExtremes: {
        topY: Number.isFinite(topExtremeY) ? Number(topExtremeY.toFixed(3)) : null,
        bottomY: Number.isFinite(bottomExtremeY) ? Number(bottomExtremeY.toFixed(3)) : null,
        topPoints: extremeTopPoints.length,
        bottomPoints: extremeBottomPoints.length
      }
    }
  };
}

function collectGlobalHorizontalBoundaryPoints(gray, width, height, options = {}) {
  const {
    expectedY,
    xStart,
    xEnd,
    yStart,
    yEnd,
    inwardDir,
    step = 6,
    outwardBias = 0.16
  } = options;
  const xFrom = Math.round(Math.min(xStart, xEnd));
  const xTo = Math.round(Math.max(xStart, xEnd));
  const yFrom = Math.round(Math.min(yStart, yEnd));
  const yTo = Math.round(Math.max(yStart, yEnd));
  const outwardTargetY = inwardDir > 0
    ? Math.round(expectedY + (yFrom - expectedY) * 0.62)
    : Math.round(expectedY + (yTo - expectedY) * 0.62);
  const points = [];
  for (let x = xFrom; x <= xTo; x += step) {
    const yPick = pickBestDirectionalIndex(
      yFrom,
      yTo,
      Math.round(expectedY),
      (candidateY) => scoreOuterHorizontalBoundaryAt(gray, width, height, candidateY, x - 10, x + 10, inwardDir),
      {
        distancePenalty: 0.62,
        outwardTarget: outwardTargetY,
        outwardBias
      }
    );
    points.push([x, yPick.index]);
  }
  return points;
}

async function refineGridCornerAnchorsByImage(imagePath, corners, guides, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!imagePath || !quad || !guides) {
    return { corners: quad, applied: false, diagnostics: null };
  }

  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const baseGray = computeGray(rgbData, info.channels);
  const gray = await buildOuterFrameEnhancedGray(baseGray, info.width, info.height, guides);
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(24, Math.round(getMedianGap(xPeaks, info.width * 0.12)));
  const cellHeight = Math.max(24, Math.round(getMedianGap(yPeaks, info.height * 0.08)));
  const rawGuideHints = inferGridOuterBoundHints(options.rawGuides || null, cellWidth, cellHeight, info.width, info.height);
  const hintedGuides = {
    left: clamp(Math.round(Number(rawGuideHints?.left ?? guides.left ?? average([quad[0][0], quad[3][0]]))), 0, Math.max(0, info.width - 1)),
    right: 0,
    top: 0,
    bottom: 0
  };
  hintedGuides.right = clamp(Math.round(Number(rawGuideHints?.right ?? guides.right ?? average([quad[1][0], quad[2][0]]))), hintedGuides.left, Math.max(0, info.width - 1));
  hintedGuides.top = clamp(Math.round(Number(rawGuideHints?.top ?? guides.top ?? average([quad[0][1], quad[1][1]]))), 0, Math.max(0, info.height - 1));
  hintedGuides.bottom = clamp(Math.round(Number(rawGuideHints?.bottom ?? guides.bottom ?? average([quad[2][1], quad[3][1]]))), hintedGuides.top, Math.max(0, info.height - 1));
  const coarseGuideBounds = deriveDominantGuideBoundsFromImage(gray, info.width, info.height, hintedGuides, {
    cellWidth,
    cellHeight
  });
  const guideLeft = hintedGuides.left;
  const guideRight = hintedGuides.right;
  const guideTop = hintedGuides.top;
  const guideBottom = hintedGuides.bottom;
  const searchX = Math.max(6, Math.round(cellWidth * 0.28));
  const searchY = Math.max(6, Math.round(cellHeight * 0.28));
  const topSearchUpY = Math.max(searchY, Math.round(cellHeight * 0.58));
  const topSearchDownY = Math.max(4, Math.round(cellHeight * 0.08));
  const bottomSearchOutwardX = Math.max(8, Math.round(cellWidth * 0.14));
  const bottomSearchUpY = Math.max(6, Math.round(cellHeight * 0.08));
  const bottomSearchDownY = Math.max(10, Math.round(cellHeight * 0.42));
  const verticalSpan = Math.max(18, Math.round(cellHeight * 1.1));
  const horizontalSpan = Math.max(18, Math.round(cellWidth * 1.1));

  const cornerSpecs = [
    { name: 'leftTop', index: 0, xDir: 1, yDir: 1 },
    { name: 'rightTop', index: 1, xDir: -1, yDir: 1 },
    { name: 'rightBottom', index: 2, xDir: -1, yDir: -1 },
    { name: 'leftBottom', index: 3, xDir: 1, yDir: -1 }
  ];

  const refinedCorners = [...quad];
  const diagnostics = {};

  for (const spec of cornerSpecs) {
    const expected = quad[spec.index];
    const expectedX = Number(expected[0]);
    const expectedY = Number(expected[1]);
    const isBottomCorner = spec.yDir < 0;
    const xSearchStart = clamp(
      isBottomCorner
        ? (expectedX - bottomSearchOutwardX)
        : (spec.xDir > 0 ? expectedX : (expectedX - searchX)),
      0,
      Math.max(0, info.width - 1)
    );
    const xSearchEnd = clamp(
      isBottomCorner
        ? (expectedX + bottomSearchOutwardX)
        : (spec.xDir > 0 ? (expectedX + searchX) : expectedX),
      0,
      Math.max(0, info.width - 1)
    );
    const ySearchStart = clamp(
      isBottomCorner
        ? (expectedY - bottomSearchUpY)
        : (spec.yDir > 0 ? (expectedY - topSearchUpY) : (expectedY - searchY)),
      0,
      Math.max(0, info.height - 1)
    );
    const ySearchEnd = clamp(
      isBottomCorner
        ? (expectedY + bottomSearchDownY)
        : (spec.yDir > 0 ? (expectedY + topSearchDownY) : expectedY),
      0,
      Math.max(0, info.height - 1)
    );
    const verticalY0 = clamp(
      spec.yDir > 0 ? (expectedY - topSearchUpY) : (expectedY - verticalSpan),
      0,
      Math.max(0, info.height - 1)
    );
    const verticalY1 = clamp(
      spec.yDir > 0 ? (expectedY + verticalSpan) : (expectedY + bottomSearchDownY),
      0,
      Math.max(0, info.height - 1)
    );
    const horizontalX0 = clamp(
      spec.xDir > 0 ? expectedX : (expectedX - horizontalSpan),
      0,
      Math.max(0, info.width - 1)
    );
    const horizontalX1 = clamp(
      spec.xDir > 0 ? (expectedX + horizontalSpan) : expectedX,
      0,
      Math.max(0, info.width - 1)
    );
    const inwardXDir = spec.xDir > 0 ? 1 : -1;
    const inwardYDir = spec.yDir > 0 ? 1 : -1;
    const xFrom = Math.round(Math.min(xSearchStart, xSearchEnd));
    const xTo = Math.round(Math.max(xSearchStart, xSearchEnd));
    const yFrom = Math.round(Math.min(ySearchStart, ySearchEnd));
    const yTo = Math.round(Math.max(ySearchStart, ySearchEnd));
    const outwardTargetX = spec.xDir > 0
      ? Math.round(expectedX + (xFrom - expectedX) * 0.62)
      : Math.round(expectedX + (xTo - expectedX) * 0.62);
    const outwardTargetY = spec.yDir > 0
      ? Math.round(expectedY + (yFrom - expectedY) * 0.62)
      : Math.round(expectedY + (yTo - expectedY) * 0.62);

    const verticalPoints = collectLocalVerticalBoundaryPoints(gray, info.width, info.height, {
      expectedX,
      xStart: xFrom,
      xEnd: xTo,
      yStart: verticalY0,
      yEnd: verticalY1,
      inwardDir: inwardXDir,
      outwardBias: 0.18
    });
    const horizontalPoints = collectLocalHorizontalBoundaryPoints(gray, info.width, info.height, {
      expectedY,
      xStart: horizontalX0,
      xEnd: horizontalX1,
      yStart: yFrom,
      yEnd: yTo,
      inwardDir: inwardYDir,
      outwardBias: isBottomCorner ? 0.28 : 0.16
    });
    const verticalLine = fitLineRobust(verticalPoints, 4);
    const horizontalLine = fitLineRobust(horizontalPoints, 4);
    let refinedPoint = intersectLines(verticalLine, horizontalLine);
    let xScore = 0;
    let yScore = 0;
    const intersectionInsideLocalWindow = pointWithinWindow(refinedPoint, xFrom, xTo, yFrom, yTo, 4);

    if (!Array.isArray(refinedPoint) || !intersectionInsideLocalWindow) {
      const xPick = pickBestDirectionalIndex(
        xFrom,
        xTo,
        Math.round(expectedX),
        (candidateX) => {
          const verticalScore = scoreOuterVerticalBoundaryAt(
            gray,
            info.width,
            info.height,
            candidateX,
            verticalY0,
            verticalY1,
            inwardXDir
          );
          const centerScore = scoreCornerIntersection(gray, info.width, info.height, candidateX, expectedY);
          return verticalScore * 0.84 + centerScore * 0.16;
        },
        {
          distancePenalty: 0.56,
          outwardTarget: outwardTargetX,
          outwardBias: 0.18
        }
      );
      const yPick = pickBestDirectionalIndex(
        yFrom,
        yTo,
        Math.round(expectedY),
        (candidateY) => {
          const horizontalScore = scoreOuterHorizontalBoundaryAt(
            gray,
            info.width,
            info.height,
            candidateY,
            horizontalX0,
            horizontalX1,
            inwardYDir
          );
          const centerScore = scoreCornerIntersection(gray, info.width, info.height, xPick.index, candidateY);
          return horizontalScore * 0.84 + centerScore * 0.16;
        },
        {
          distancePenalty: 0.62,
          outwardTarget: outwardTargetY,
          outwardBias: 0.16
        }
      );
      refinedPoint = [xPick.index, yPick.index];
      xScore = xPick.score;
      yScore = yPick.score;
    } else {
      refinedPoint = [
        clamp(Math.round(refinedPoint[0]), 0, Math.max(0, info.width - 1)),
        clamp(Math.round(refinedPoint[1]), 0, Math.max(0, info.height - 1))
      ];
      xScore = average(verticalPoints.map((point) => scoreOuterVerticalBoundaryAt(
        gray,
        info.width,
        info.height,
        point[0],
        point[1] - 8,
        point[1] + 8,
        inwardXDir
      )));
      yScore = average(horizontalPoints.map((point) => scoreOuterHorizontalBoundaryAt(
        gray,
        info.width,
        info.height,
        point[1],
        point[0] - 8,
        point[0] + 8,
        inwardYDir
      )));
    }

    let bottomCornerAnchor = null;
    if (isBottomCorner) {
      const anchorSpanX = Math.max(12, Math.round(cellWidth * 0.12));
      const anchorSpanY = Math.max(12, Math.round(cellHeight * 0.12));
      const anchorHorizontalSpan = Math.max(22, Math.round(cellWidth * 0.46));
      const bottomAnchor = pickBestLocalCorner({
        xStart: refinedPoint[0] - anchorSpanX,
        xEnd: refinedPoint[0] + anchorSpanX,
        yStart: yFrom,
        yEnd: yTo,
        expectedX: refinedPoint[0],
        expectedY: refinedPoint[1],
        distancePenalty: 0.42,
        scoreAt: (candidateX, candidateY) => {
          const horizontalXStart = clamp(
            spec.xDir > 0 ? candidateX : (candidateX - anchorHorizontalSpan),
            0,
            Math.max(0, info.width - 1)
          );
          const horizontalXEnd = clamp(
            spec.xDir > 0 ? (candidateX + anchorHorizontalSpan) : candidateX,
            0,
            Math.max(0, info.width - 1)
          );
          const verticalScore = scoreOuterVerticalBoundaryAt(
            gray,
            info.width,
            info.height,
            candidateX,
            candidateY - Math.max(18, Math.round(cellHeight * 0.72)),
            candidateY + Math.max(6, Math.round(cellHeight * 0.06)),
            inwardXDir
          );
          const horizontalScore = scoreOuterHorizontalBoundaryAt(
            gray,
            info.width,
            info.height,
            candidateY,
            horizontalXStart,
            horizontalXEnd,
            inwardYDir
          );
          const terminationScore = scoreVerticalTerminationAt(
            gray,
            info.width,
            info.height,
            candidateX,
            candidateY
          );
          const centerScore = scoreCornerIntersection(gray, info.width, info.height, candidateX, candidateY);
          const downwardBias = Math.max(0, candidateY - refinedPoint[1]) * 0.08;
          return horizontalScore * 0.34 + verticalScore * 0.24 + terminationScore * 0.3 + centerScore * 0.12 + downwardBias;
        }
      });
      bottomCornerAnchor = {
        before: [...refinedPoint],
        candidate: [bottomAnchor.x, bottomAnchor.y],
        candidateScore: Number((bottomAnchor.score || 0).toFixed(3))
      };
      if (
        bottomAnchor
        && Number.isFinite(bottomAnchor.score)
        && bottomAnchor.score >= Math.max(cornerScoreEstimate(xScore, yScore), 82)
      ) {
        refinedPoint = [bottomAnchor.x, bottomAnchor.y];
        xScore = Math.max(xScore, bottomAnchor.score * 0.72);
        yScore = Math.max(yScore, bottomAnchor.score * 0.72);
        bottomCornerAnchor.applied = true;
      } else if (bottomCornerAnchor) {
        bottomCornerAnchor.applied = false;
      }
    }

    let bottomCornerConfirmation = null;
    if (isBottomCorner) {
      const confirmSpanX = Math.max(18, Math.round(cellWidth * 0.52));
      const confirmX0 = clamp(
        spec.xDir > 0 ? refinedPoint[0] : (refinedPoint[0] - confirmSpanX),
        0,
        Math.max(0, info.width - 1)
      );
      const confirmX1 = clamp(
        spec.xDir > 0 ? (refinedPoint[0] + confirmSpanX) : refinedPoint[0],
        0,
        Math.max(0, info.width - 1)
      );
      const confirmVerticalY0 = clamp(
        refinedPoint[1] - Math.max(18, Math.round(cellHeight * 0.72)),
        0,
        Math.max(0, info.height - 1)
      );
      const confirmVerticalY1 = clamp(
        refinedPoint[1] + Math.max(8, Math.round(cellHeight * 0.12)),
        0,
        Math.max(0, info.height - 1)
      );
      const confirmedYPick = pickBestDirectionalIndex(
        yFrom,
        yTo,
        Math.round(refinedPoint[1]),
        (candidateY) => {
          const horizontalScore = scoreOuterHorizontalBoundaryAt(
            gray,
            info.width,
            info.height,
            candidateY,
            confirmX0,
            confirmX1,
            inwardYDir
          );
          const verticalScore = scoreOuterVerticalBoundaryAt(
            gray,
            info.width,
            info.height,
            refinedPoint[0],
            confirmVerticalY0,
            confirmVerticalY1,
            inwardXDir
          );
          const terminationScore = scoreVerticalTerminationAt(
            gray,
            info.width,
            info.height,
            refinedPoint[0],
            candidateY
          );
          const centerScore = scoreCornerIntersection(gray, info.width, info.height, refinedPoint[0], candidateY);
          return horizontalScore * 0.4 + verticalScore * 0.16 + terminationScore * 0.32 + centerScore * 0.12;
        },
        {
          distancePenalty: 0.34,
          outwardTarget: yTo,
          outwardBias: 0.38
        }
      );
      bottomCornerConfirmation = {
        before: [...refinedPoint],
        confirmedY: confirmedYPick.index,
        confirmedScore: Number((confirmedYPick.score || 0).toFixed(3)),
        xWindow: [confirmX0, confirmX1],
        yWindow: [yFrom, yTo]
      };
      const maxConfirmShift = Math.max(18, Math.round(cellHeight * 0.18));
      const minAcceptScore = Math.max(52, yScore * 0.78);
      const bottomBandToleranceUp = Math.max(12, Math.round(cellHeight * 0.08));
      const bottomBandToleranceDown = Math.max(10, Math.round(cellHeight * 0.06));
      const confirmationWithinTightBottomBand = (
        confirmedYPick.index >= (expectedY - bottomBandToleranceUp)
        && confirmedYPick.index <= (expectedY + bottomBandToleranceDown)
      );
      if (
        confirmedYPick.index > refinedPoint[1]
        && (confirmedYPick.index - refinedPoint[1]) <= maxConfirmShift
        && confirmedYPick.score >= minAcceptScore
        && confirmationWithinTightBottomBand
      ) {
        refinedPoint = [refinedPoint[0], confirmedYPick.index];
        yScore = Math.max(yScore, confirmedYPick.score);
        bottomCornerConfirmation.applied = true;
      } else {
        bottomCornerConfirmation.applied = false;
      }
    }

    const cornerScore = (xScore + yScore) / 2;

    refinedCorners[spec.index] = refinedPoint;
    diagnostics[spec.name] = {
      expected: [expectedX, expectedY],
      refined: refinedPoint,
      cornerScore: Number((cornerScore || 0).toFixed(3)),
      mode: 'local-axis-line-search',
      searchWindow: {
        x: [xSearchStart, xSearchEnd],
        y: [ySearchStart, ySearchEnd]
      },
      axisScores: {
        xScore: Number((xScore || 0).toFixed(3)),
        yScore: Number((yScore || 0).toFixed(3))
      },
      lineFit: {
        verticalPoints: verticalPoints.length,
        horizontalPoints: horizontalPoints.length,
        usedLineIntersection: Boolean(verticalLine && horizontalLine && intersectionInsideLocalWindow),
        rejectedIntersectionOutsideWindow: Boolean(verticalLine && horizontalLine && !intersectionInsideLocalWindow)
      },
      bottomCornerAnchor,
      bottomCornerConfirmation
    };
  }

  const normalizedRefined = normalizeCornerQuad(refinedCorners);
  if (!normalizedRefined) {
    return { corners: quad, applied: false, diagnostics };
  }

  const edgeLineInputs = {
    top: collectGlobalHorizontalBoundaryPoints(gray, info.width, info.height, {
      expectedY: guideTop,
      xStart: guideLeft,
      xEnd: guideRight,
      yStart: Math.max(0, Math.min(guideTop - topSearchUpY, Number(coarseGuideBounds?.top ?? guideTop) - topSearchDownY)),
      yEnd: Math.max(0, guideTop + topSearchDownY),
      inwardDir: 1,
      step: 8,
      outwardBias: 0.16
    }),
    bottom: collectGlobalHorizontalBoundaryPoints(gray, info.width, info.height, {
      expectedY: guideBottom,
      xStart: guideLeft,
      xEnd: guideRight,
      yStart: guideBottom - bottomSearchUpY,
      yEnd: Math.max(
        guideBottom + bottomSearchDownY,
        Number(coarseGuideBounds?.bottom ?? guideBottom) + bottomSearchUpY
      ),
      inwardDir: -1,
      step: 8,
      outwardBias: 0.16
    }),
    left: collectGlobalVerticalBoundaryPoints(gray, info.width, info.height, {
      expectedX: guideLeft,
      xStart: guideLeft,
      xEnd: guideLeft + searchX,
      yStart: guideTop,
      yEnd: guideBottom,
      inwardDir: 1,
      step: 8,
      outwardBias: 0.18
    }),
    right: collectGlobalVerticalBoundaryPoints(gray, info.width, info.height, {
      expectedX: guideRight,
      xStart: guideRight - searchX,
      xEnd: guideRight,
      yStart: guideTop,
      yEnd: guideBottom,
      inwardDir: -1,
      step: 8,
      outwardBias: 0.18
    })
  };
  const topLine = fitLineRobust(edgeLineInputs.top, 4);
  const bottomLine = fitLineRobust(edgeLineInputs.bottom, 4);
  const leftLine = fitLineRobust(edgeLineInputs.left, 4);
  const rightLine = fitLineRobust(edgeLineInputs.right, 4);
  const edgeLineQuality = {
    top: evaluateBoundaryLineQuality(
      topLine,
      edgeLineInputs.top,
      (point) => scoreOuterHorizontalBoundaryAt(gray, info.width, info.height, point[1], point[0] - 10, point[0] + 10, 1),
      140,
      {
        axis: 'x',
        expectedStart: guideLeft,
        expectedEnd: guideRight,
        binSize: 18
      }
    ),
    bottom: evaluateBoundaryLineQuality(
      bottomLine,
      edgeLineInputs.bottom,
      (point) => scoreOuterHorizontalBoundaryAt(gray, info.width, info.height, point[1], point[0] - 10, point[0] + 10, -1),
      140,
      {
        axis: 'x',
        expectedStart: guideLeft,
        expectedEnd: guideRight,
        binSize: 18
      }
    ),
    left: evaluateBoundaryLineQuality(
      leftLine,
      edgeLineInputs.left,
      (point) => scoreOuterVerticalBoundaryAt(gray, info.width, info.height, point[0], point[1] - 10, point[1] + 10, 1),
      170,
      {
        axis: 'y',
        expectedStart: guideTop,
        expectedEnd: guideBottom,
        binSize: 18
      }
    ),
    right: evaluateBoundaryLineQuality(
      rightLine,
      edgeLineInputs.right,
      (point) => scoreOuterVerticalBoundaryAt(gray, info.width, info.height, point[0], point[1] - 10, point[1] + 10, -1),
      170,
      {
        axis: 'y',
        expectedStart: guideTop,
        expectedEnd: guideBottom,
        binSize: 18
      }
    )
  };
  const extremeTopPoints = extractExtremeSupportPoints(
    topLine,
    edgeLineInputs.top,
    (point) => scoreOuterHorizontalBoundaryAt(gray, info.width, info.height, point[1], point[0] - 10, point[0] + 10, 1),
    'top'
  );
  const extremeBottomPoints = extractExtremeSupportPoints(
    bottomLine,
    edgeLineInputs.bottom,
    (point) => scoreOuterHorizontalBoundaryAt(gray, info.width, info.height, point[1], point[0] - 10, point[0] + 10, -1),
    'bottom'
  );
  const extremeLeftPoints = extractExtremeSupportPoints(
    leftLine,
    edgeLineInputs.left,
    (point) => scoreOuterVerticalBoundaryAt(gray, info.width, info.height, point[0], point[1] - 10, point[1] + 10, 1),
    'left'
  );
  const extremeRightPoints = extractExtremeSupportPoints(
    rightLine,
    edgeLineInputs.right,
    (point) => scoreOuterVerticalBoundaryAt(gray, info.width, info.height, point[0], point[1] - 10, point[1] + 10, -1),
    'right'
  );
  const topPointHalves = splitSupportPointsByAxis(extremeTopPoints, 0);
  const topLeftAnchor = topPointHalves.first.length
    ? [average(topPointHalves.first.map((point) => point[0])), average(topPointHalves.first.map((point) => point[1]))]
    : null;
  const topRightAnchor = topPointHalves.second.length
    ? [average(topPointHalves.second.map((point) => point[0])), average(topPointHalves.second.map((point) => point[1]))]
    : null;
  const bottomPointHalves = splitSupportPointsByAxis(extremeBottomPoints, 0);
  const bottomLeftAnchor = bottomPointHalves.first.length
    ? [average(bottomPointHalves.first.map((point) => point[0])), average(bottomPointHalves.first.map((point) => point[1]))]
    : null;
  const bottomRightAnchor = bottomPointHalves.second.length
    ? [average(bottomPointHalves.second.map((point) => point[0])), average(bottomPointHalves.second.map((point) => point[1]))]
    : null;
  const topBandY = medianCoordinate(extremeTopPoints, 1);
  const bottomBandY = medianCoordinate(extremeBottomPoints, 1);
  const coarseTopY = Number.isFinite(Number(coarseGuideBounds?.top)) ? Number(coarseGuideBounds.top) : null;
  const coarseBottomY = Number.isFinite(Number(coarseGuideBounds?.bottom)) ? Number(coarseGuideBounds.bottom) : null;
  let preferredTopBandY = topBandY;
  let preferredBottomBandY = bottomBandY;
  if (Number.isFinite(coarseTopY) && Number.isFinite(preferredTopBandY)) {
    const upwardGap = preferredTopBandY - coarseTopY;
    if (upwardGap >= cellHeight * 0.45 && upwardGap <= cellHeight * 1.35) {
      preferredTopBandY = coarseTopY;
    }
  } else if (Number.isFinite(coarseTopY)) {
    preferredTopBandY = coarseTopY;
  }
  // Bottom edge is much more likely to be polluted by the paper border / shadow.
  // Keep the dominant bottom support band as the primary source and use coarseBottom
  // only as a diagnostic reference, not as a direct override.
  const leftTopAnchor = extractEdgeEndAnchor(extremeLeftPoints, 'top', 1, 0.18);
  const leftBottomAnchor = extractEdgeEndAnchor(extremeLeftPoints, 'bottom', 1, 0.18);
  const rightTopAnchor = extractEdgeEndAnchor(extremeRightPoints, 'top', 1, 0.18);
  const rightBottomAnchor = extractEdgeEndAnchor(extremeRightPoints, 'bottom', 1, 0.18);
  const probedLeftTop = probeVerticalLineEndpoint(leftLine, gray, info.width, info.height, {
    startY: guideTop + Math.max(12, Math.round(cellHeight * 0.35)),
    endY: Math.max(0, guideTop - topSearchUpY),
    inwardDir: 1,
    direction: 'top'
  });
  const probedLeftBottom = probeVerticalLineEndpoint(leftLine, gray, info.width, info.height, {
    startY: guideBottom - Math.max(12, Math.round(cellHeight * 0.35)),
    endY: Math.min(info.height - 1, guideBottom + bottomSearchDownY),
    inwardDir: 1,
    direction: 'bottom'
  });
  const probedRightTop = probeVerticalLineEndpoint(rightLine, gray, info.width, info.height, {
    startY: guideTop + Math.max(12, Math.round(cellHeight * 0.35)),
    endY: Math.max(0, guideTop - topSearchUpY),
    inwardDir: -1,
    direction: 'top'
  });
  const probedRightBottom = probeVerticalLineEndpoint(rightLine, gray, info.width, info.height, {
    startY: guideBottom - Math.max(12, Math.round(cellHeight * 0.35)),
    endY: Math.min(info.height - 1, guideBottom + bottomSearchDownY),
    inwardDir: -1,
    direction: 'bottom'
  });
  let effectiveLeftTopAnchor = probedLeftTop || leftTopAnchor;
  const effectiveLeftBottomAnchor = probedLeftBottom || leftBottomAnchor;
  let effectiveRightTopAnchor = probedRightTop || rightTopAnchor;
  const effectiveRightBottomAnchor = probedRightBottom || rightBottomAnchor;
  const coarseVerticalEndpointTopCandidates = [
    coarseGuideBounds?.diagnostics?.verticalEndpoints?.leftTop?.[1],
    coarseGuideBounds?.diagnostics?.verticalEndpoints?.rightTop?.[1]
  ].map(Number).filter(Number.isFinite);
  const coarseVerticalEndpointTopY = coarseVerticalEndpointTopCandidates.length
    ? average(coarseVerticalEndpointTopCandidates)
    : null;
  const topContinuityWeak = (
    (edgeLineQuality.top.continuity?.longestRunRatio ?? 0) < 0.58
    || (edgeLineQuality.top.continuity?.maxGapRatio ?? 1) > 0.12
  );
  if (
    Number.isFinite(coarseVerticalEndpointTopY)
    && Number.isFinite(preferredTopBandY)
    && preferredTopBandY < coarseVerticalEndpointTopY - Math.max(22, cellHeight * 0.28)
    && topContinuityWeak
  ) {
    preferredTopBandY = coarseVerticalEndpointTopY;
  }
  const topAnchorTolerance = Math.max(18, Math.round(cellHeight * 0.16));
  if (
    topLeftAnchor
    && effectiveLeftTopAnchor
    && effectiveLeftTopAnchor[1] > topLeftAnchor[1] + topAnchorTolerance
  ) {
    const alignedX = solveLineXAtY(leftLine, topLeftAnchor[1]);
    effectiveLeftTopAnchor = [
      Number.isFinite(alignedX) ? alignedX : effectiveLeftTopAnchor[0],
      topLeftAnchor[1]
    ];
  }
  if (
    topRightAnchor
    && effectiveRightTopAnchor
    && effectiveRightTopAnchor[1] > topRightAnchor[1] + topAnchorTolerance
  ) {
    const alignedX = solveLineXAtY(rightLine, topRightAnchor[1]);
    effectiveRightTopAnchor = [
      Number.isFinite(alignedX) ? alignedX : effectiveRightTopAnchor[0],
      topRightAnchor[1]
    ];
  }
  const locallyRefinedRightTopAnchor = effectiveRightTopAnchor
    ? refineOuterRightAnchorX(gray, info.width, info.height, effectiveRightTopAnchor[0], effectiveRightTopAnchor[1], {
        searchLeft: Math.max(12, Math.round(cellWidth * 0.16)),
        searchRight: Math.max(18, Math.round(cellWidth * 0.22)),
        spanY: Math.max(8, Math.round(cellHeight * 0.14)),
        minScore: 50,
        keepRatio: 0.9
      })
    : null;
  if (locallyRefinedRightTopAnchor) {
    effectiveRightTopAnchor = locallyRefinedRightTopAnchor;
  }
  const projectedTopLeftAnchor = Number.isFinite(preferredTopBandY)
    ? (() => {
        const x = solveLineXAtY(leftLine, preferredTopBandY);
        return Number.isFinite(x) ? [x, preferredTopBandY] : null;
      })()
    : null;
  const projectedTopRightAnchor = Number.isFinite(preferredTopBandY)
    ? (() => {
        const x = solveLineXAtY(rightLine, preferredTopBandY);
        if (!Number.isFinite(x)) {
          return null;
        }
        return refineOuterRightAnchorX(gray, info.width, info.height, x, preferredTopBandY, {
          searchLeft: Math.max(12, Math.round(cellWidth * 0.16)),
          searchRight: Math.max(18, Math.round(cellWidth * 0.22)),
          spanY: Math.max(8, Math.round(cellHeight * 0.14)),
          minScore: 50,
          keepRatio: 0.9
        }) || [x, preferredTopBandY];
      })()
    : null;
  const projectedBottomLeftAnchor = Number.isFinite(preferredBottomBandY)
    ? (() => {
        const x = solveLineXAtY(leftLine, preferredBottomBandY);
        return Number.isFinite(x) ? [x, preferredBottomBandY] : null;
      })()
    : null;
  const projectedBottomRightAnchor = Number.isFinite(preferredBottomBandY)
    ? (() => {
        const x = solveLineXAtY(rightLine, preferredBottomBandY);
        return Number.isFinite(x) ? [x, preferredBottomBandY] : null;
      })()
    : null;
  const initialGuard = evaluateDominantEdgeQuadGuard({
    normalizedRefined,
    cellWidth,
    cellHeight,
    projectedTopLeftAnchor,
    projectedTopRightAnchor,
    projectedBottomLeftAnchor,
    projectedBottomRightAnchor
  });
  const safeProjectedTopLeftAnchor = initialGuard.rejectProjectedTopAnchors ? null : projectedTopLeftAnchor;
  const safeProjectedTopRightAnchor = initialGuard.rejectProjectedTopAnchors ? null : projectedTopRightAnchor;
  const safeProjectedBottomLeftAnchor = initialGuard.rejectProjectedBottomAnchors ? null : projectedBottomLeftAnchor;
  const safeProjectedBottomRightAnchor = initialGuard.rejectProjectedBottomAnchors ? null : projectedBottomRightAnchor;
  const dominantTopLine = buildLineFromEndAnchors(
    safeProjectedTopLeftAnchor || topLeftAnchor || effectiveLeftTopAnchor,
    safeProjectedTopRightAnchor || topRightAnchor || effectiveRightTopAnchor,
    topLine
  ) || topLine;
  const dominantBottomLine = buildLineFromEndAnchors(
    safeProjectedBottomLeftAnchor || bottomLeftAnchor || effectiveLeftBottomAnchor,
    safeProjectedBottomRightAnchor || bottomRightAnchor || effectiveRightBottomAnchor,
    extremeBottomPoints.length ? shiftLineToPoints(bottomLine, extremeBottomPoints) : bottomLine
  ) || (extremeBottomPoints.length ? shiftLineToPoints(bottomLine, extremeBottomPoints) : bottomLine);
  const endAnchoredLeftLine = buildLineFromEndAnchors(effectiveLeftTopAnchor, effectiveLeftBottomAnchor, leftLine) || leftLine;
  const endAnchoredRightLine = buildLineFromEndAnchors(effectiveRightTopAnchor, effectiveRightBottomAnchor, rightLine) || rightLine;
  const dominantLeftLine = blendLines(
    extremeLeftPoints.length ? shiftLineToPoints(leftLine, extremeLeftPoints) : leftLine,
    endAnchoredLeftLine,
    0.22
  ) || leftLine;
  const dominantRightLine = blendLines(
    extremeRightPoints.length ? shiftLineToPoints(rightLine, extremeRightPoints) : rightLine,
    endAnchoredRightLine,
    0.22
  ) || rightLine;
  let edgeQuad = normalizeCornerQuad([
    intersectLines(dominantTopLine, dominantLeftLine),
    intersectLines(dominantTopLine, dominantRightLine),
    intersectLines(dominantBottomLine, dominantRightLine),
    intersectLines(dominantBottomLine, dominantLeftLine)
  ]);
  const probedRightBottomCorner = intersectLines(dominantBottomLine, endAnchoredRightLine);
  if (edgeQuad && Array.isArray(probedRightBottomCorner)) {
    const adjusted = edgeQuad.map((point) => [...point]);
    adjusted[2] = movePointToward(edgeQuad[2], probedRightBottomCorner, 0.38);
    edgeQuad = normalizeCornerQuad(adjusted) || edgeQuad;
  }
  const finalGuard = evaluateDominantEdgeQuadGuard({
    edgeQuad,
    normalizedRefined,
    cellWidth,
    cellHeight,
    projectedTopLeftAnchor: safeProjectedTopLeftAnchor,
    projectedTopRightAnchor: safeProjectedTopRightAnchor,
    projectedBottomLeftAnchor: safeProjectedBottomLeftAnchor,
    projectedBottomRightAnchor: safeProjectedBottomRightAnchor
  });
  const dominantLineReady = (
    edgeQuad
    && edgeLineQuality.top.supportRatio >= 0.5
    && edgeLineQuality.bottom.supportRatio >= 0.5
    && edgeLineQuality.left.supportRatio >= 0.5
    && edgeLineQuality.right.supportRatio >= 0.5
    && (edgeLineQuality.top.continuity?.longestRunRatio ?? 0) >= 0.58
    && (edgeLineQuality.top.continuity?.endpointCoverage ?? 0) >= 0.5
    && (edgeLineQuality.bottom.continuity?.longestRunRatio ?? 0) >= 0.58
    && (edgeLineQuality.bottom.continuity?.endpointCoverage ?? 0) >= 0.5
    && (edgeLineQuality.left.continuity?.longestRunRatio ?? 0) >= 0.6
    && (edgeLineQuality.left.continuity?.endpointCoverage ?? 0) >= 0.5
    && (edgeLineQuality.right.continuity?.longestRunRatio ?? 0) >= 0.6
    && (edgeLineQuality.right.continuity?.endpointCoverage ?? 0) >= 0.5
    && finalGuard.dominantTopWithinLocalTolerance
    && finalGuard.dominantBottomWithinLocalTolerance
    && finalGuard.dominantSidesWithinLocalTolerance
  );
  const uniformSpanEstimate = edgeQuad ? estimateUniformGridSpan(edgeQuad, guides) : null;
  const localCornerConfidence = average(
    Object.values(diagnostics)
      .map((detail) => clamp01(((Number(detail?.cornerScore) || 0) - 44) / 42))
      .filter((value) => Number.isFinite(value))
  );
  const rawPerCornerConfidence = [
    diagnostics.leftTop,
    diagnostics.rightTop,
    diagnostics.rightBottom,
    diagnostics.leftBottom
  ].map((detail) => clamp01(((Number(detail?.cornerScore) || 0) - 44) / 42));
  const edgeConfidence = average([
    edgeLineQuality.top.confidence,
    edgeLineQuality.bottom.confidence,
    edgeLineQuality.left.confidence,
    edgeLineQuality.right.confidence
  ].filter((value) => Number.isFinite(value)));
  let finalRefined = normalizedRefined;
  let outputSource = 'local-corner-fallback';
  let quadSelectionDiagnostics = null;
  if (dominantLineReady) {
    finalRefined = stabilizeQuadGeometry(edgeQuad, { blend: 0.32 }) || edgeQuad;
    outputSource = 'dominant-edge-lines';
  } else if (edgeQuad) {
    const cornerNames = ['leftTop', 'rightTop', 'rightBottom', 'leftBottom'];
    const perCornerConfidence = rawPerCornerConfidence.map((confidence, index) => {
      const detail = diagnostics[cornerNames[index]] || null;
      const localPoint = normalizedRefined[index];
      const edgePoint = edgeQuad[index];
      const expectedPoint = detail?.expected;
      const expectedDrift = Array.isArray(expectedPoint)
        ? Math.hypot(localPoint[0] - expectedPoint[0], localPoint[1] - expectedPoint[1])
        : 0;
      const edgeDrift = Math.hypot(localPoint[0] - edgePoint[0], localPoint[1] - edgePoint[1]);
      const anchorAppliedPenalty = detail?.bottomCornerAnchor?.applied ? 0.28 : 0;
      const confirmationRejectedPenalty = (
        detail?.bottomCornerConfirmation
        && detail.bottomCornerConfirmation.applied === false
        && Number(detail.bottomCornerConfirmation.confirmedY) > Number(localPoint[1]) + Math.max(8, cellHeight * 0.08)
      ) ? 0.08 : 0;
      const expectedDriftPenalty = clamp01(expectedDrift / Math.max(18, cellHeight * 0.22)) * 0.24;
      const edgeDriftPenalty = clamp01(edgeDrift / Math.max(24, cellHeight * 0.28)) * 0.34;
      return clamp01(
        confidence
        - anchorAppliedPenalty
        - confirmationRejectedPenalty
        - expectedDriftPenalty
        - edgeDriftPenalty
      );
    });
    const baseBlend = 0.18;
    const topDownPenalty = Math.max(10, Math.round(cellHeight * 0.08));
    const bottomUpPenalty = Math.max(10, Math.round(cellHeight * 0.08));
    const cornerWeights = [
      average([edgeLineQuality.top.confidence, edgeLineQuality.left.confidence]),
      average([edgeLineQuality.top.confidence, edgeLineQuality.right.confidence]),
      average([edgeLineQuality.bottom.confidence, edgeLineQuality.right.confidence]),
      average([edgeLineQuality.bottom.confidence, edgeLineQuality.left.confidence])
    ].map((confidence, index) => {
      const localCorner = normalizedRefined[index];
      const edgeCorner = edgeQuad[index];
      const distance = Math.hypot(edgeCorner[0] - localCorner[0], edgeCorner[1] - localCorner[1]);
      const consistency = clamp01(1 - (distance / Math.max(18, cellHeight * 0.24)));
      let weight = baseBlend + confidence * 0.46;
      weight *= 0.34 + consistency * 0.66;
      if (index < 2 && edgeCorner[1] > localCorner[1] + topDownPenalty) {
        weight *= 0.18;
      }
      if (index >= 2 && edgeCorner[1] < localCorner[1] - bottomUpPenalty) {
        weight *= 0.25;
      }
      return clamp01(weight);
    });
    const mergedQuad = mergeCornerQuadsWithConfidence(
      normalizedRefined,
      edgeQuad,
      cornerWeights,
      { maxShift: Math.max(18, Math.round(cellHeight * 0.22)), defaultBlend: 0.26 }
    );
    const localStabilizedQuad = stabilizeQuadGeometry(normalizedRefined, { blend: 0.24 }) || normalizedRefined;
    const edgeStabilizedQuad = stabilizeQuadGeometry(edgeQuad, { blend: 0.32 }) || edgeQuad;
    const uncertaintyRetainedQuad = blendQuadByCornerStability(
      normalizedRefined,
      edgeStabilizedQuad,
      perCornerConfidence,
      cornerWeights,
      { maxShift: Math.max(28, Math.round(cellHeight * 0.32)), minBlend: 0.03, maxBlend: 0.82 }
    ) || mergedQuad;
    const selectiveCornerReplacement = buildSelectiveCornerReplacementQuad(
      normalizedRefined,
      edgeStabilizedQuad,
      perCornerConfidence,
      {
        guides,
        minImprovement: 0.1,
        maxCornerConfidence: 0.84,
        maxShift: Math.max(34, Math.round(cellHeight * 0.36))
      }
    );
    const selectiveReplacementQuad = selectiveCornerReplacement?.quad || uncertaintyRetainedQuad;
    const candidateEntries = [
      {
        name: 'local-corner-fallback',
        quad: normalizedRefined,
        supportScore: localCornerConfidence,
        distancePenaltyScale: Math.max(20, cellHeight * 0.18)
      },
      {
        name: 'local-corner-stabilized',
        quad: localStabilizedQuad,
        supportScore: localCornerConfidence * 0.98,
        distancePenaltyScale: Math.max(20, cellHeight * 0.18)
      },
      {
        name: 'dominant-edge-lines',
        quad: edgeQuad,
        supportScore: edgeConfidence,
        distancePenaltyScale: Math.max(18, cellHeight * 0.16)
      },
      {
        name: 'dominant-edge-stabilized',
        quad: edgeStabilizedQuad,
        supportScore: edgeConfidence * 0.99,
        distancePenaltyScale: Math.max(18, cellHeight * 0.16)
      },
      {
        name: 'uncertain-corner-geometry',
        quad: uncertaintyRetainedQuad,
        supportScore: average([
          localCornerConfidence * 0.96,
          edgeConfidence * 0.88
        ].filter((value) => Number.isFinite(value))),
        distancePenaltyScale: Math.max(18, cellHeight * 0.15)
      },
      {
        name: 'selective-corner-replacement',
        quad: selectiveReplacementQuad,
        supportScore: average([
          localCornerConfidence * 0.97,
          edgeConfidence * 0.9
        ].filter((value) => Number.isFinite(value))),
        distancePenaltyScale: Math.max(18, cellHeight * 0.14)
      },
      {
        name: 'blended-geometry',
        quad: mergedQuad,
        supportScore: average([localCornerConfidence, edgeConfidence].filter((value) => Number.isFinite(value))),
        distancePenaltyScale: Math.max(18, cellHeight * 0.17)
      }
    ].filter((entry) => normalizeCornerQuad(entry.quad));

    const scoredCandidates = candidateEntries.map((entry) => {
      const normalizedCandidate = normalizeCornerQuad(entry.quad);
      const rectangularity = evaluateRectangularQuadQuality(normalizedCandidate, { guides });
      const meanShift = average(
        normalizedCandidate.map((point, index) => Math.hypot(
          point[0] - normalizedRefined[index][0],
          point[1] - normalizedRefined[index][1]
        ))
      );
      const maxShift = Math.max(
        ...normalizedCandidate.map((point, index) => Math.hypot(
          point[0] - normalizedRefined[index][0],
          point[1] - normalizedRefined[index][1]
        ))
      );
      const weightedCornerShift = average(
        normalizedCandidate.map((point, index) => {
          const shift = Math.hypot(
            point[0] - normalizedRefined[index][0],
            point[1] - normalizedRefined[index][1]
          );
          const confidence = perCornerConfidence[index];
          return shift * (0.35 + confidence * 0.65);
        })
      );
      const distancePenalty = clamp01(meanShift / Math.max(1, entry.distancePenaltyScale));
      const cornerRetentionScore = clamp01(
        1 - weightedCornerShift / Math.max(8, cellHeight * 0.22)
      );
      const rectangleScore = rectangularity?.score ?? 0;
      const guideScore = rectangularity?.guideSpanScore;
      const topBandAlignmentScore = Number.isFinite(preferredTopBandY)
        ? clamp01(
            1 - (
              average([normalizedCandidate[0][1], normalizedCandidate[1][1]].map((value) => Math.abs(value - preferredTopBandY)))
              / Math.max(16, cellHeight * 0.22)
            )
          )
        : 1;
      const bottomBandAlignmentScore = Number.isFinite(preferredBottomBandY)
        ? clamp01(
            1 - (
              average([normalizedCandidate[2][1], normalizedCandidate[3][1]].map((value) => Math.abs(value - preferredBottomBandY)))
              / Math.max(18, cellHeight * 0.24)
            )
          )
        : 1;
      const bandAlignmentScore = average([topBandAlignmentScore, bottomBandAlignmentScore]);
      const totalScore = clamp01(
        rectangleScore * 0.46
        + bandAlignmentScore * 0.18
        + (Number.isFinite(entry.supportScore) ? entry.supportScore : 0) * 0.18
        + (Number.isFinite(guideScore) ? guideScore : rectangleScore) * 0.08
        + cornerRetentionScore * 0.1
        + (1 - distancePenalty) * 0.04
      );
      return {
        ...entry,
        quad: normalizedCandidate,
        meanShift,
        maxShift,
        weightedCornerShift,
        cornerRetentionScore,
        bandAlignmentScore,
        topBandAlignmentScore,
        bottomBandAlignmentScore,
        distancePenalty,
        rectangularity,
        totalScore
      };
    });
    scoredCandidates.sort((a, b) => b.totalScore - a.totalScore);
    let bestCandidate = scoredCandidates[0] || null;
    const localFallbackCandidate = scoredCandidates.find((entry) => entry.name === 'local-corner-fallback') || null;
    const rectanglePriorityCandidate = scoredCandidates
      .filter((entry) => entry.name !== 'local-corner-fallback' && entry.name !== 'local-corner-stabilized')
      .sort((a, b) => {
        const rectangleDelta = (b.rectangularity?.score || 0) - (a.rectangularity?.score || 0);
        if (Math.abs(rectangleDelta) > 1e-6) {
          return rectangleDelta;
        }
        return (b.supportScore || 0) - (a.supportScore || 0);
      })[0] || null;
    let overrideReason = null;
    if (
      bestCandidate?.name === 'local-corner-fallback'
      && localFallbackCandidate
      && rectanglePriorityCandidate
      && (rectanglePriorityCandidate.rectangularity?.score || 0) >= (localFallbackCandidate.rectangularity?.score || 0) + 0.015
      && (rectanglePriorityCandidate.rectangularity?.rotatedRectangleScore || 0) >= (localFallbackCandidate.rectangularity?.rotatedRectangleScore || 0) + 0.18
      && (rectanglePriorityCandidate.supportScore || 0) >= Math.max(0.55, (localFallbackCandidate.supportScore || 0) - 0.28)
      && (rectanglePriorityCandidate.cornerRetentionScore || 0) >= 0.18
      && rectanglePriorityCandidate.maxShift <= Math.max(64, cellHeight * 0.42)
    ) {
      bestCandidate = rectanglePriorityCandidate;
      overrideReason = 'prefer-rotated-rectangle-fit-when-it-clearly-outweighs-local-corner-drift';
    }
    if (bestCandidate?.quad) {
      finalRefined = bestCandidate.quad;
      outputSource = bestCandidate.name;
    } else {
      finalRefined = mergedQuad;
    }
    quadSelectionDiagnostics = {
      localCornerConfidence: Number((localCornerConfidence || 0).toFixed(3)),
      edgeConfidence: Number((edgeConfidence || 0).toFixed(3)),
      winner: outputSource,
      overrideReason,
      selectiveCornerReplacement: selectiveCornerReplacement?.replacements || null,
      candidates: scoredCandidates.map((entry) => ({
        name: entry.name,
        totalScore: Number((entry.totalScore || 0).toFixed(4)),
        supportScore: Number((entry.supportScore || 0).toFixed(4)),
        rectangleScore: Number((entry.rectangularity?.score || 0).toFixed(4)),
        guideSpanScore: Number.isFinite(entry.rectangularity?.guideSpanScore)
          ? Number(entry.rectangularity.guideSpanScore.toFixed(4))
          : null,
        meanShift: Number((entry.meanShift || 0).toFixed(3)),
        maxShift: Number((entry.maxShift || 0).toFixed(3)),
        weightedCornerShift: Number((entry.weightedCornerShift || 0).toFixed(3)),
        cornerRetentionScore: Number((entry.cornerRetentionScore || 0).toFixed(4)),
        bandAlignmentScore: Number((entry.bandAlignmentScore || 0).toFixed(4)),
        topBandAlignmentScore: Number((entry.topBandAlignmentScore || 0).toFixed(4)),
        bottomBandAlignmentScore: Number((entry.bottomBandAlignmentScore || 0).toFixed(4)),
        parallelDotTopBottom: Number((entry.rectangularity?.parallelDotTopBottom || 0).toFixed(4)),
        parallelDotLeftRight: Number((entry.rectangularity?.parallelDotLeftRight || 0).toFixed(4)),
        rightAngleScore: Number((entry.rectangularity?.rightAngleScore || 0).toFixed(4)),
        rotatedRectangleScore: Number((entry.rectangularity?.rotatedRectangleScore || 0).toFixed(4)),
        rotatedRectangleTightScore: Number((entry.rectangularity?.rotatedRectangleTightScore || 0).toFixed(4)),
        rotatedMeanResidual: Number((entry.rectangularity?.rotatedMeanResidual || 0).toFixed(3)),
        rotatedMaxResidual: Number((entry.rectangularity?.rotatedMaxResidual || 0).toFixed(3)),
        rotationAngleDeg: Number((((entry.rectangularity?.rotationAngle || 0) * 180) / Math.PI).toFixed(3)),
        oppositeWidthRatio: Number((entry.rectangularity?.oppositeWidthRatio || 0).toFixed(4)),
        oppositeHeightRatio: Number((entry.rectangularity?.oppositeHeightRatio || 0).toFixed(4)),
        diagonalRatio: Number((entry.rectangularity?.diagonalRatio || 0).toFixed(4)),
        midpointGap: Number((entry.rectangularity?.midpointGap || 0).toFixed(3))
      }))
    };
  }

  const applied = finalRefined.some((point, index) => (
    Math.abs(point[0] - quad[index][0]) >= 1 || Math.abs(point[1] - quad[index][1]) >= 1
  ));

  return {
    corners: finalRefined,
    applied,
    diagnostics: {
      method: 'per-corner local line search',
      outputSource,
      rawGuideHints: rawGuideHints
        ? {
            left: rawGuideHints.left,
            right: rawGuideHints.right,
            top: rawGuideHints.top,
            bottom: rawGuideHints.bottom,
            reasons: rawGuideHints.reasons,
            medianXGap: Number(rawGuideHints.medianXGap.toFixed(3)),
            medianYGap: Number(rawGuideHints.medianYGap.toFixed(3)),
            diagnostics: rawGuideHints.diagnostics
          }
        : null,
      coarseGuideBounds: coarseGuideBounds
        ? {
            left: coarseGuideBounds.left,
            right: coarseGuideBounds.right,
            top: coarseGuideBounds.top,
            bottom: coarseGuideBounds.bottom,
            diagnostics: coarseGuideBounds.diagnostics
          }
        : null,
      cellWidth,
      cellHeight,
      searchX,
      searchY,
      topSearchUpY,
      topSearchDownY,
      bottomSearchOutwardX,
      bottomSearchUpY,
      bottomSearchDownY,
      verticalSpan,
      horizontalSpan,
      edgeLineFit: {
        topPoints: edgeLineInputs.top.length,
        bottomPoints: edgeLineInputs.bottom.length,
        leftPoints: edgeLineInputs.left.length,
        rightPoints: edgeLineInputs.right.length,
        applied: Boolean(edgeQuad),
        dominantLineReady: Boolean(dominantLineReady),
        uniformSpanEstimate: uniformSpanEstimate
          ? {
              topWidth: Number(uniformSpanEstimate.topWidth.toFixed(3)),
              bottomWidth: Number(uniformSpanEstimate.bottomWidth.toFixed(3)),
              leftHeight: Number(uniformSpanEstimate.leftHeight.toFixed(3)),
              rightHeight: Number(uniformSpanEstimate.rightHeight.toFixed(3)),
              estimatedWidth: Number(uniformSpanEstimate.estimatedWidth.toFixed(3)),
              estimatedHeight: Number(uniformSpanEstimate.estimatedHeight.toFixed(3))
            }
          : null,
        dominantSupportPoints: {
          top: extremeTopPoints.length,
          bottom: extremeBottomPoints.length,
          left: extremeLeftPoints.length,
          right: extremeRightPoints.length
        },
        dominantTopAnchors: {
          left: (safeProjectedTopLeftAnchor || topLeftAnchor) ? (safeProjectedTopLeftAnchor || topLeftAnchor).map((value) => Number(value.toFixed(3))) : null,
          right: (safeProjectedTopRightAnchor || topRightAnchor) ? (safeProjectedTopRightAnchor || topRightAnchor).map((value) => Number(value.toFixed(3))) : null
        },
        dominantBottomAnchors: {
          left: (safeProjectedBottomLeftAnchor || bottomLeftAnchor) ? (safeProjectedBottomLeftAnchor || bottomLeftAnchor).map((value) => Number(value.toFixed(3))) : null,
          right: (safeProjectedBottomRightAnchor || bottomRightAnchor) ? (safeProjectedBottomRightAnchor || bottomRightAnchor).map((value) => Number(value.toFixed(3))) : null
        },
        preferredBandY: {
          top: Number.isFinite(preferredTopBandY) ? Number(preferredTopBandY.toFixed(3)) : null,
          bottom: Number.isFinite(preferredBottomBandY) ? Number(preferredBottomBandY.toFixed(3)) : null,
          rawTop: Number.isFinite(topBandY) ? Number(topBandY.toFixed(3)) : null,
          rawBottom: Number.isFinite(bottomBandY) ? Number(bottomBandY.toFixed(3)) : null,
          coarseTop: Number.isFinite(coarseTopY) ? Number(coarseTopY.toFixed(3)) : null,
          coarseBottom: Number.isFinite(coarseBottomY) ? Number(coarseBottomY.toFixed(3)) : null,
          coarseVerticalEndpointTop: Number.isFinite(coarseVerticalEndpointTopY) ? Number(coarseVerticalEndpointTopY.toFixed(3)) : null,
          localTop: Number.isFinite(finalGuard.localTopBandY) ? Number(finalGuard.localTopBandY.toFixed(3)) : null,
          localBottom: Number.isFinite(finalGuard.localBottomBandY) ? Number(finalGuard.localBottomBandY.toFixed(3)) : null,
          rejectProjectedTopAnchors: finalGuard.rejectProjectedTopAnchors,
          rejectProjectedBottomAnchors: finalGuard.rejectProjectedBottomAnchors,
          dominantTopOvershoot: Number.isFinite(finalGuard.dominantTopOvershoot) ? Number(finalGuard.dominantTopOvershoot.toFixed(3)) : null,
          dominantBottomOvershoot: Number.isFinite(finalGuard.dominantBottomOvershoot) ? Number(finalGuard.dominantBottomOvershoot.toFixed(3)) : null,
          dominantLeftOvershoot: Number.isFinite(finalGuard.dominantLeftOvershoot) ? Number(finalGuard.dominantLeftOvershoot.toFixed(3)) : null,
          dominantRightOvershoot: Number.isFinite(finalGuard.dominantRightOvershoot) ? Number(finalGuard.dominantRightOvershoot.toFixed(3)) : null
        },
        dominantLeftAnchors: {
          top: effectiveLeftTopAnchor ? effectiveLeftTopAnchor.map((value) => Number(value.toFixed(3))) : null,
          bottom: effectiveLeftBottomAnchor ? effectiveLeftBottomAnchor.map((value) => Number(value.toFixed(3))) : null
        },
        dominantRightAnchors: {
          top: effectiveRightTopAnchor ? effectiveRightTopAnchor.map((value) => Number(value.toFixed(3))) : null,
          bottom: effectiveRightBottomAnchor ? effectiveRightBottomAnchor.map((value) => Number(value.toFixed(3))) : null
        },
        quality: {
          top: {
            confidence: Number(edgeLineQuality.top.confidence.toFixed(3)),
            residual: Number(edgeLineQuality.top.residual.toFixed(3)),
            averageScore: Number(edgeLineQuality.top.averageScore.toFixed(3)),
            supportRatio: Number(edgeLineQuality.top.supportRatio.toFixed(3)),
            continuity: edgeLineQuality.top.continuity
              ? {
                  coverageRatio: Number(edgeLineQuality.top.continuity.coverageRatio.toFixed(3)),
                  longestRunRatio: Number(edgeLineQuality.top.continuity.longestRunRatio.toFixed(3)),
                  endpointCoverage: Number(edgeLineQuality.top.continuity.endpointCoverage.toFixed(3)),
                  maxGapRatio: Number(edgeLineQuality.top.continuity.maxGapRatio.toFixed(3))
                }
              : null
          },
          bottom: {
            confidence: Number(edgeLineQuality.bottom.confidence.toFixed(3)),
            residual: Number(edgeLineQuality.bottom.residual.toFixed(3)),
            averageScore: Number(edgeLineQuality.bottom.averageScore.toFixed(3)),
            supportRatio: Number(edgeLineQuality.bottom.supportRatio.toFixed(3)),
            continuity: edgeLineQuality.bottom.continuity
              ? {
                  coverageRatio: Number(edgeLineQuality.bottom.continuity.coverageRatio.toFixed(3)),
                  longestRunRatio: Number(edgeLineQuality.bottom.continuity.longestRunRatio.toFixed(3)),
                  endpointCoverage: Number(edgeLineQuality.bottom.continuity.endpointCoverage.toFixed(3)),
                  maxGapRatio: Number(edgeLineQuality.bottom.continuity.maxGapRatio.toFixed(3))
                }
              : null
          },
          left: {
            confidence: Number(edgeLineQuality.left.confidence.toFixed(3)),
            residual: Number(edgeLineQuality.left.residual.toFixed(3)),
            averageScore: Number(edgeLineQuality.left.averageScore.toFixed(3)),
            supportRatio: Number(edgeLineQuality.left.supportRatio.toFixed(3)),
            continuity: edgeLineQuality.left.continuity
              ? {
                  coverageRatio: Number(edgeLineQuality.left.continuity.coverageRatio.toFixed(3)),
                  longestRunRatio: Number(edgeLineQuality.left.continuity.longestRunRatio.toFixed(3)),
                  endpointCoverage: Number(edgeLineQuality.left.continuity.endpointCoverage.toFixed(3)),
                  maxGapRatio: Number(edgeLineQuality.left.continuity.maxGapRatio.toFixed(3))
                }
              : null
          },
          right: {
            confidence: Number(edgeLineQuality.right.confidence.toFixed(3)),
            residual: Number(edgeLineQuality.right.residual.toFixed(3)),
            averageScore: Number(edgeLineQuality.right.averageScore.toFixed(3)),
            supportRatio: Number(edgeLineQuality.right.supportRatio.toFixed(3)),
            continuity: edgeLineQuality.right.continuity
              ? {
                  coverageRatio: Number(edgeLineQuality.right.continuity.coverageRatio.toFixed(3)),
                  longestRunRatio: Number(edgeLineQuality.right.continuity.longestRunRatio.toFixed(3)),
                  endpointCoverage: Number(edgeLineQuality.right.continuity.endpointCoverage.toFixed(3)),
                  maxGapRatio: Number(edgeLineQuality.right.continuity.maxGapRatio.toFixed(3))
                }
              : null
          }
        },
        quadSelection: quadSelectionDiagnostics
      },
      corners: diagnostics
    }
  };
}

async function blurGray(grayData, width, height, sigma) {
  const grayscale = Buffer.alloc(width * height);
  for (let i = 0; i < grayData.length; i++) {
    grayscale[i] = clamp(Math.round(grayData[i]), 0, 255);
  }
  const { data } = await sharp(grayscale, {
    raw: {
      width,
      height,
      channels: 1
    }
  })
    .blur(sigma)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

async function buildOuterFrameEnhancedGray(gray, width, height, guides = null) {
  const blurred = await blurGray(gray, width, height, 2.4);
  const enhanced = new Float32Array(gray.length);
  const left = Number(guides?.left ?? 0);
  const right = Number(guides?.right ?? Math.max(0, width - 1));
  const top = Number(guides?.top ?? 0);
  const bottom = Number(guides?.bottom ?? Math.max(0, height - 1));
  const edgeBandX = Math.max(24, Math.round((right - left) * 0.08));
  const edgeBandY = Math.max(24, Math.round((bottom - top) * 0.08));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const localContrast = Math.max(0, blurred[index] - gray[index]);
      const nearOuterFrame = (
        Math.abs(x - left) <= edgeBandX ||
        Math.abs(x - right) <= edgeBandX ||
        Math.abs(y - top) <= edgeBandY ||
        Math.abs(y - bottom) <= edgeBandY
      );
      const gain = nearOuterFrame ? 2.2 : 1.35;
      enhanced[index] = clamp(gray[index] - localContrast * gain, 0, 255);
    }
  }
  return enhanced;
}

function buildGuideMask(width, height, guides, gridRows, gridCols) {
  const normalized = buildNormalizedGuideSet(guides, gridRows, gridCols);
  if (!normalized) {
    return null;
  }

  const left = clamp(Math.round(normalized.left), 0, Math.max(0, width - 1));
  const right = clamp(Math.round(normalized.right), left + 1, width);
  const top = clamp(Math.round(normalized.top), 0, Math.max(0, height - 1));
  const bottom = clamp(Math.round(normalized.bottom), top + 1, height);
  const avgCellW = Math.max(1, (right - left) / Math.max(gridCols || 1, 1));
  const avgCellH = Math.max(1, (bottom - top) / Math.max(gridRows || 1, 1));
  const shortSide = Math.max(1, Math.min(avgCellW, avgCellH));
  const edgeBand = Math.max(1, Math.round(shortSide * 0.012));
  const mask = new Uint8Array(width * height);

  for (const xValue of normalized.xPeaks) {
    const xCenter = clamp(Math.round(xValue), 0, Math.max(0, width - 1));
    const xStart = clamp(xCenter - edgeBand, 0, Math.max(0, width - 1));
    const xEnd = clamp(xCenter + edgeBand, 0, Math.max(0, width - 1));
    for (let y = top; y < bottom; y++) {
      const rowOffset = y * width;
      for (let x = xStart; x <= xEnd; x++) {
        mask[rowOffset + x] = 1;
      }
    }
  }

  for (const yValue of normalized.yPeaks) {
    const yCenter = clamp(Math.round(yValue), 0, Math.max(0, height - 1));
    const yStart = clamp(yCenter - edgeBand, 0, Math.max(0, height - 1));
    const yEnd = clamp(yCenter + edgeBand, 0, Math.max(0, height - 1));
    for (let y = yStart; y <= yEnd; y++) {
      const rowOffset = y * width;
      for (let x = left; x < right; x++) {
        mask[rowOffset + x] = 1;
      }
    }
  }

  return {
    mask,
    left,
    right,
    top,
    bottom,
    avgCellW,
    avgCellH,
    xPeaks: normalized.xPeaks,
    yPeaks: normalized.yPeaks
  };
}

function expandGuideMaskInfo(width, height, guideMaskInfo, options = {}) {
  if (!guideMaskInfo) {
    return null;
  }

  const {
    topPadRatio = 0,
    bottomPadRatio = 0,
    leftPadRatio = 0,
    rightPadRatio = 0
  } = options;

  const padTop = Math.max(0, Math.round(guideMaskInfo.avgCellH * topPadRatio));
  const padBottom = Math.max(0, Math.round(guideMaskInfo.avgCellH * bottomPadRatio));
  const padLeft = Math.max(0, Math.round(guideMaskInfo.avgCellW * leftPadRatio));
  const padRight = Math.max(0, Math.round(guideMaskInfo.avgCellW * rightPadRatio));

  return buildGuideMask(
    width,
    height,
    {
      left: clamp(guideMaskInfo.left - padLeft, 0, width),
      right: clamp(guideMaskInfo.right + padRight, 0, width),
      top: clamp(guideMaskInfo.top - padTop, 0, height),
      bottom: clamp(guideMaskInfo.bottom + padBottom, 0, height),
      xPeaks: guideMaskInfo.xPeaks,
      yPeaks: guideMaskInfo.yPeaks
    },
    Math.max(1, guideMaskInfo.yPeaks.length - 1),
    Math.max(1, guideMaskInfo.xPeaks.length - 1)
  );
}

function buildRefinedGuideRemovedRgb(rgbData, blurredRgbData, info, guideMaskInfo) {
  if (!guideMaskInfo) {
    return Buffer.from(rgbData);
  }

  const { mask } = guideMaskInfo;
  const output = Buffer.from(rgbData);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) {
      continue;
    }
    const offset = i * info.channels;
    const r = output[offset];
    const g = output[offset + 1];
    const b = output[offset + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const blurredR = blurredRgbData[offset];
    const blurredG = blurredRgbData[offset + 1];
    const blurredB = blurredRgbData[offset + 2];
    const blurredGray = 0.299 * blurredR + 0.587 * blurredG + 0.114 * blurredB;
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const colorSpan = maxChannel - minChannel;
    const brightnessGap = Math.abs(blurredGray - gray);
    const removable =
      gray >= 148 &&
      colorSpan <= 42 &&
      brightnessGap <= 18;
    if (!removable) {
      continue;
    }
    output[offset] = clamp(Math.round(blurredR), 0, 232);
    output[offset + 1] = clamp(Math.round(blurredG), 0, 232);
    output[offset + 2] = clamp(Math.round(blurredB), 0, 232);
  }
  return output;
}

function buildNeutralGuideRemovedRgb(rgbData, blurredRgbData, info, guideMaskInfo) {
  if (!guideMaskInfo) {
    return Buffer.from(rgbData);
  }

  const { mask } = guideMaskInfo;
  const output = Buffer.from(rgbData);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) {
      continue;
    }
    const offset = i * info.channels;
    const r = output[offset];
    const g = output[offset + 1];
    const b = output[offset + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const blurredR = blurredRgbData[offset];
    const blurredG = blurredRgbData[offset + 1];
    const blurredB = blurredRgbData[offset + 2];
    const blurredGray = 0.299 * blurredR + 0.587 * blurredG + 0.114 * blurredB;
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const colorSpan = maxChannel - minChannel;
    const brightnessGap = Math.abs(blurredGray - gray);
    const removable =
      gray >= 135 &&
      colorSpan <= 58 &&
      brightnessGap <= 28;
    if (!removable) {
      continue;
    }
    output[offset] = clamp(Math.round(r * 0.2 + blurredR * 0.8), 0, 228);
    output[offset + 1] = clamp(Math.round(g * 0.2 + blurredG * 0.8), 0, 228);
    output[offset + 2] = clamp(Math.round(b * 0.2 + blurredB * 0.8), 0, 228);
  }
  return output;
}

function buildGridBackgroundMaskBuffer(rgbData, info, guideMaskInfo) {
  const output = Buffer.alloc(info.width * info.height, 0);
  if (!guideMaskInfo) {
    return output;
  }
  const { mask } = guideMaskInfo;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) {
      continue;
    }
    const offset = i * info.channels;
    const r = rgbData[offset];
    const g = rgbData[offset + 1];
    const b = rgbData[offset + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const colorSpan = maxChannel - minChannel;
    const keep = gray >= 70 && (gray >= 125 || colorSpan <= 55);
    output[i] = keep ? 255 : 0;
  }
  return output;
}

function buildIntegralImage(values, width, height) {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += values[y * width + x];
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  return integral;
}

function smoothSeries(values, radius) {
  const result = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    for (let j = start; j <= end; j++) {
      sum += values[j];
      count++;
    }
    result[i] = count ? sum / count : values[i];
  }
  return result;
}

function detectRegularLinePeaks(series, options = {}) {
  const {
    minSpacing = 12,
    thresholdRatio = 0.58
  } = options;
  if (!series || !series.length) {
    return { peaks: [], medianGap: 0, stableGapCount: 0, threshold: 0 };
  }
  let maxValue = 0;
  let mean = 0;
  for (let i = 0; i < series.length; i += 1) {
    const value = Number(series[i]) || 0;
    maxValue = Math.max(maxValue, value);
    mean += value;
  }
  mean /= Math.max(1, series.length);
  const threshold = Math.max(mean * 1.18, maxValue * thresholdRatio);
  const peaks = [];
  let lastAccepted = -Infinity;
  for (let i = 1; i < series.length - 1; i += 1) {
    const current = Number(series[i]) || 0;
    if (current < threshold) {
      continue;
    }
    if (current < (Number(series[i - 1]) || 0) || current < (Number(series[i + 1]) || 0)) {
      continue;
    }
    if (i - lastAccepted < minSpacing) {
      if (peaks.length && current > peaks[peaks.length - 1].value) {
        peaks[peaks.length - 1] = { index: i, value: current };
        lastAccepted = i;
      }
      continue;
    }
    peaks.push({ index: i, value: current });
    lastAccepted = i;
  }
  const gaps = peaks.slice(1).map((peak, index) => peak.index - peaks[index].index).filter((gap) => gap > 0);
  const medianGap = gaps.length ? median(gaps) : 0;
  const stableGapCount = gaps.filter((gap) => medianGap > 0 && gap >= medianGap * 0.72 && gap <= medianGap * 1.28).length;
  return { peaks, medianGap, stableGapCount, threshold };
}

function flattenVerticalBackground(normalized, width, height, guideMaskInfo = null) {
  if (!guideMaskInfo) {
    return normalized;
  }

  const rowMeans = new Float32Array(height);
  const rowCounts = new Uint32Array(height);
  for (let y = guideMaskInfo.top; y < guideMaskInfo.bottom; y++) {
    for (let x = guideMaskInfo.left; x < guideMaskInfo.right; x++) {
      const value = normalized[y * width + x];
      if (value < 150) {
        continue;
      }
      rowMeans[y] += value;
      rowCounts[y] += 1;
    }
  }

  let globalSum = 0;
  let globalCount = 0;
  for (let y = guideMaskInfo.top; y < guideMaskInfo.bottom; y++) {
    if (!rowCounts[y]) {
      continue;
    }
    rowMeans[y] /= rowCounts[y];
    globalSum += rowMeans[y];
    globalCount++;
  }

  if (!globalCount) {
    return normalized;
  }

  const globalMean = globalSum / globalCount;
  const filledMeans = new Float32Array(height);
  let lastValue = globalMean;
  for (let y = 0; y < height; y++) {
    if (rowCounts[y]) {
      lastValue = rowMeans[y];
    }
    filledMeans[y] = lastValue;
  }
  for (let y = height - 1; y >= 0; y--) {
    if (!rowCounts[y]) {
      filledMeans[y] = y + 1 < height ? filledMeans[y + 1] : globalMean;
    }
  }

  const smoothMeans = smoothSeries(filledMeans, 18);
  const adjusted = new Float32Array(normalized.length);
  for (let y = 0; y < height; y++) {
    const bias = smoothMeans[y] - globalMean;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      adjusted[index] = clamp(normalized[index] - bias, 0, 255);
    }
  }
  return adjusted;
}

function flattenCellBackground(normalized, width, height, guideMaskInfo = null) {
  if (!guideMaskInfo || !Array.isArray(guideMaskInfo.xPeaks) || !Array.isArray(guideMaskInfo.yPeaks)) {
    return normalized;
  }

  const xPeaks = guideMaskInfo.xPeaks.map((value) => clamp(Math.round(value), 0, width));
  const yPeaks = guideMaskInfo.yPeaks.map((value) => clamp(Math.round(value), 0, height));
  if (xPeaks.length < 2 || yPeaks.length < 2) {
    return normalized;
  }

  const biases = [];
  let globalSum = 0;
  let globalCount = 0;

  for (let row = 0; row < yPeaks.length - 1; row++) {
    const top = Math.max(0, Math.min(yPeaks[row], yPeaks[row + 1]));
    const bottom = Math.min(height, Math.max(yPeaks[row], yPeaks[row + 1]));
    const rowBiases = [];
    for (let col = 0; col < xPeaks.length - 1; col++) {
      const left = Math.max(0, Math.min(xPeaks[col], xPeaks[col + 1]));
      const right = Math.min(width, Math.max(xPeaks[col], xPeaks[col + 1]));
      let sum = 0;
      let count = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const value = normalized[y * width + x];
          if (value < 176) {
            continue;
          }
          sum += value;
          count++;
        }
      }
      const mean = count ? sum / count : null;
      rowBiases.push(mean);
      if (mean !== null) {
        globalSum += mean;
        globalCount++;
      }
    }
    biases.push(rowBiases);
  }

  if (!globalCount) {
    return normalized;
  }

  const globalMean = globalSum / globalCount;
  for (let row = 0; row < biases.length; row++) {
    for (let col = 0; col < biases[row].length; col++) {
      if (biases[row][col] === null) {
        const left = col > 0 ? biases[row][col - 1] : null;
        const right = col + 1 < biases[row].length ? biases[row][col + 1] : null;
        const up = row > 0 ? biases[row - 1][col] : null;
        const down = row + 1 < biases.length ? biases[row + 1][col] : null;
        const neighbors = [left, right, up, down].filter((value) => value !== null);
        biases[row][col] = neighbors.length ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length : globalMean;
      }
    }
  }

  const adjusted = new Float32Array(normalized.length);
  for (let row = 0; row < yPeaks.length - 1; row++) {
    const top = Math.max(0, Math.min(yPeaks[row], yPeaks[row + 1]));
    const bottom = Math.min(height, Math.max(yPeaks[row], yPeaks[row + 1]));
    for (let col = 0; col < xPeaks.length - 1; col++) {
      const left = Math.max(0, Math.min(xPeaks[col], xPeaks[col + 1]));
      const right = Math.min(width, Math.max(xPeaks[col], xPeaks[col + 1]));
      const bias = biases[row][col] - globalMean;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const index = y * width + x;
          adjusted[index] = clamp(normalized[index] - bias, 0, 255);
        }
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (
        x < guideMaskInfo.left ||
        x >= guideMaskInfo.right ||
        y < guideMaskInfo.top ||
        y >= guideMaskInfo.bottom
      ) {
        const index = y * width + x;
        adjusted[index] = normalized[index];
      }
    }
  }

  return adjusted;
}

function sampleIntegral(integral, width, left, top, right, bottom) {
  return (
    integral[(bottom + 1) * (width + 1) + (right + 1)] -
    integral[top * (width + 1) + (right + 1)] -
    integral[(bottom + 1) * (width + 1) + left] +
    integral[top * (width + 1) + left]
  );
}

function buildAdaptiveBinary(gray, blurredGray, rgbData, info, threshold, ignoreRedGrid, guideMaskInfo = null) {
  const pixelCount = info.width * info.height;
  const normalized = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    normalized[i] = clamp((gray[i] * 255) / Math.max(blurredGray[i], 1), 0, 255);
  }
  const verticallyFlattened = flattenVerticalBackground(normalized, info.width, info.height, guideMaskInfo);
  const flattened = flattenCellBackground(verticallyFlattened, info.width, info.height, guideMaskInfo);

  const integral = buildIntegralImage(flattened, info.width, info.height);
  const output = Buffer.alloc(pixelCount);
  const radius = 17;

  for (let y = 0; y < info.height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(info.height - 1, y + radius);
    for (let x = 0; x < info.width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(info.width - 1, x + radius);
      const area = (right - left + 1) * (bottom - top + 1);
      const localMean = sampleIntegral(integral, info.width, left, top, right, bottom) / Math.max(area, 1);
      const index = y * info.width + x;
      if (
        guideMaskInfo &&
        (x < guideMaskInfo.left || x >= guideMaskInfo.right || y < guideMaskInfo.top || y >= guideMaskInfo.bottom)
      ) {
        output[index] = 255;
        continue;
      }
      const offset = index * info.channels;
      const r = rgbData[offset];
      const g = rgbData[offset + 1];
      const b = rgbData[offset + 2];
      const isRedGrid =
        ignoreRedGrid &&
        r > 150 &&
        g < 170 &&
        b < 170 &&
        r - g > 30 &&
        r - b > 30;
      const binary = !isRedGrid && flattened[index] < Math.min(threshold, localMean - 8);
      output[index] = binary ? 0 : 255;
    }
  }

  return output;
}

function buildSegmentationReady(gray, blurredGray, width, height, guideMaskInfo = null) {
  const normalized = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    normalized[i] = clamp((gray[i] * 255) / Math.max(blurredGray[i], 1), 0, 255);
  }
  // 02_4 是切分输入图，不应像 mask 一样把边界外内容硬抹白，否则顶部题头和首行容易丢失。
  const verticallyFlattened = flattenVerticalBackground(normalized, width, height, null);
  const flattened = flattenCellBackground(verticallyFlattened, width, height, null);
  const output = Buffer.alloc(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const darkness = clamp(255 - flattened[i], 0, 72);
    const residualDarkness = Math.max(0, darkness - 24);
    const enhanced = 255 - clamp(residualDarkness * 2.8, 0, 255);
    const value = clamp(Math.round(enhanced), 0, 255);
    output[i] = value >= 228 ? 255 : value;
  }

  return output;
}

function buildReadablePreprocess(gray, blurredGray, width, height, guideMaskInfo = null) {
  const normalized = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    normalized[i] = clamp((gray[i] * 255) / Math.max(blurredGray[i], 1), 0, 255);
  }

  const verticallyFlattened = flattenVerticalBackground(normalized, width, height, guideMaskInfo);
  const flattened = flattenCellBackground(verticallyFlattened, width, height, guideMaskInfo);
  const output = Buffer.alloc(gray.length);

  for (let i = 0; i < gray.length; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    if (
      guideMaskInfo &&
      (x < guideMaskInfo.left || x >= guideMaskInfo.right || y < guideMaskInfo.top || y >= guideMaskInfo.bottom)
    ) {
      output[i] = 255;
      continue;
    }

    const darkness = clamp(255 - flattened[i], 0, 255);
    const preservedDarkness = Math.max(0, darkness - 8);
    const enhanced = 255 - clamp(preservedDarkness * 1.55, 0, 255);
    output[i] = clamp(Math.round(enhanced), 0, 255);
  }

  return output;
}

async function refineOutputsWithDetectedGrid(warpedImagePath, options = {}) {
  const {
    preprocessInputPath = null,
    guideRemovedInputPath = null,
    outputPath = null,
    preservePreprocessOutputPath = false,
    segmentationOutputPath = null,
    guideRemovedOutputPath = null,
    neutralGuideRemovedOutputPath = null,
    gridBackgroundMaskOutputPath = null,
    gridBoundaryDetection = null,
    segmentationBoundaryDetection = null,
    guideRemovalBoundaryDetection = null,
    gridRows = null,
    gridCols = null,
    blurSigma = 18,
    threshold = 185,
    ignoreRedGrid = true
  } = options;

  const baseBoundaryDetection = segmentationBoundaryDetection || gridBoundaryDetection;
  const baseImagePath = preprocessInputPath || null;
  if (!baseImagePath || !baseBoundaryDetection?.guides || !gridRows || !gridCols) {
    return null;
  }

  const { data: rgbData, info } = await loadRgbImage(baseImagePath);
  const guideRemovalMaskInfo = buildGuideMask(
    info.width,
    info.height,
    (guideRemovalBoundaryDetection || baseBoundaryDetection).guides,
    gridRows,
    gridCols
  );
  const segmentationGuideMaskInfoBase = buildGuideMask(
    info.width,
    info.height,
    baseBoundaryDetection.guides,
    gridRows,
    gridCols
  );
  if (!guideRemovalMaskInfo || !segmentationGuideMaskInfoBase) {
    return null;
  }
  const avgShortSide = Math.max(1, Math.min(guideRemovalMaskInfo.avgCellW, guideRemovalMaskInfo.avgCellH));
  const guideBlurSigma = Math.max(6, avgShortSide * 0.08);
  const sourceGray = computeGray(rgbData, info.channels);
  let neutralGuideRemovedRgb = null;
  if (guideRemovedInputPath) {
    const guideRemovedInput = await loadRgbImage(guideRemovedInputPath);
    neutralGuideRemovedRgb = guideRemovedInput.data;
  } else {
    const blurredRgbData = await blurRgbChannels(rgbData, info, guideBlurSigma);
    neutralGuideRemovedRgb = buildNeutralGuideRemovedRgb(rgbData, blurredRgbData, info, guideRemovalMaskInfo);
  }
  const refinedRgb = Buffer.from(neutralGuideRemovedRgb);
  const gray = computeGray(rgbData, info.channels);
  const blurredGray = await blurGray(gray, info.width, info.height, Math.max(1, blurSigma));

  if (guideRemovedOutputPath) {
    if (guideRemovedInputPath && guideRemovedInputPath !== guideRemovedOutputPath) {
      await fs.promises.copyFile(guideRemovedInputPath, guideRemovedOutputPath);
    } else {
      await sharp(refinedRgb, {
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels
        }
      }).png().toFile(guideRemovedOutputPath);
    }
  }
  if (neutralGuideRemovedOutputPath) {
    if (guideRemovedInputPath && guideRemovedInputPath !== neutralGuideRemovedOutputPath) {
      await fs.promises.copyFile(guideRemovedInputPath, neutralGuideRemovedOutputPath);
    } else {
      await sharp(neutralGuideRemovedRgb, {
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels
        }
      }).png().toFile(neutralGuideRemovedOutputPath);
    }
  }

  if (outputPath) {
    if (!preservePreprocessOutputPath) {
      if (preprocessInputPath && preprocessInputPath !== outputPath) {
        await fs.promises.copyFile(preprocessInputPath, outputPath);
      } else {
        const neutralGray = Buffer.alloc(sourceGray.length);
        for (let i = 0; i < sourceGray.length; i++) {
          neutralGray[i] = clamp(Math.round(sourceGray[i]), 0, 255);
        }
        await sharp(neutralGray, {
          raw: {
            width: info.width,
            height: info.height,
            channels: 1
          }
        }).png().toFile(outputPath);
      }
    } else if (!fs.existsSync(outputPath)) {
      await fs.promises.copyFile(preprocessInputPath, outputPath);
    }
  }

  const gridDetectionInputPath = outputPath || baseImagePath;
  let gridDetectionRgbData = rgbData;
  let gridDetectionInfo = info;
  let gridDetectionGray = sourceGray;
  let gridDetectionBlurredGray = blurredGray;

  if (outputPath) {
    const sequentialInput = await loadRgbImage(outputPath);
    gridDetectionRgbData = sequentialInput.data;
    gridDetectionInfo = sequentialInput.info;
    gridDetectionGray = computeGray(gridDetectionRgbData, gridDetectionInfo.channels);
    gridDetectionBlurredGray = await blurGray(gridDetectionGray, gridDetectionInfo.width, gridDetectionInfo.height, Math.max(1, blurSigma));
  }

  if (gridBackgroundMaskOutputPath) {
    const maskBuffer = buildGridBackgroundMaskBuffer(gridDetectionRgbData, gridDetectionInfo, segmentationGuideMaskInfoBase);
    await sharp(maskBuffer, {
      raw: {
        width: gridDetectionInfo.width,
        height: gridDetectionInfo.height,
        channels: 1
      }
    }).png().toFile(gridBackgroundMaskOutputPath);
  }

  if (segmentationOutputPath) {
    if (gridDetectionInputPath && gridDetectionInputPath !== segmentationOutputPath) {
      await fs.promises.copyFile(gridDetectionInputPath, segmentationOutputPath);
    } else {
      const segmentationReady = buildSegmentationReady(
        gridDetectionGray,
        gridDetectionBlurredGray,
        gridDetectionInfo.width,
        gridDetectionInfo.height,
        null
      );
      await sharp(segmentationReady, {
        raw: {
          width: gridDetectionInfo.width,
          height: gridDetectionInfo.height,
          channels: 1
        }
      }).png().toFile(segmentationOutputPath);
    }
  }

  return {
    guideAligned: true,
    gridDetectionInputPath,
    guideBounds: {
      left: segmentationGuideMaskInfoBase.left,
      right: segmentationGuideMaskInfoBase.right,
      top: segmentationGuideMaskInfoBase.top,
      bottom: segmentationGuideMaskInfoBase.bottom
    },
    segmentationGuideBounds: null,
    guideRemovalBounds: {
      left: guideRemovalMaskInfo.left,
      right: guideRemovalMaskInfo.right,
      top: guideRemovalMaskInfo.top,
      bottom: guideRemovalMaskInfo.bottom
    }
  };
}

async function renderDetectedGridAnnotation(imagePath, outputPath, gridRectification, options = {}) {
  if (!imagePath || !outputPath || !gridRectification || gridRectification.error) {
    return null;
  }

  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const guides = gridRectification.guides || {};
  const corners = Array.isArray(gridRectification.corners) ? gridRectification.corners : [];
  const processNo = options.processNo || '02';
  const gridRows = options.gridRows || 0;
  const gridCols = options.gridCols || 0;
  const showGuides = options.showGuides !== false;
  const annotationTitle = String(options.annotationTitle || `${processNo} 真实方格边界 ${gridRows}x${gridCols}`);
  const annotationSubtitle = String(options.annotationSubtitle || (showGuides ? '外边界 + 规范化方格引导线' : '仅显示四角点与外边界'));
  const annotationDetail = String(options.annotationDetail || '');
  const selectiveCornerReplacement = Array.isArray(options.selectiveCornerReplacement)
    ? options.selectiveCornerReplacement
    : [];
  const hasExactGuideCounts =
    Array.isArray(guides.xPeaks) &&
    Array.isArray(guides.yPeaks) &&
    (!gridCols || guides.xPeaks.length === gridCols + 1) &&
    (!gridRows || guides.yPeaks.length === gridRows + 1);
  const normalizedGuides = hasExactGuideCounts
    ? guides
    : (gridBoundaryNormalizePlugin.execute({ gridRectification, gridRows, gridCols }) || guides);
  const xPeaks = Array.isArray(normalizedGuides.xPeaks) ? normalizedGuides.xPeaks : [];
  const yPeaks = Array.isArray(normalizedGuides.yPeaks) ? normalizedGuides.yPeaks : [];
  const hasReliableVerticalBoundaries = gridCols > 0 && xPeaks.length === gridCols + 1;
  const hasReliableHorizontalBoundaries = gridRows > 0 && yPeaks.length === gridRows + 1;
  const peakLines = [];
  if (showGuides && hasReliableVerticalBoundaries) {
    for (const x of xPeaks) {
      const lineX = clamp(Math.round(x), 0, Math.max(0, width - 1));
      peakLines.push(
        `<line x1="${lineX}" y1="${clamp(Math.round(normalizedGuides.top || 0), 0, height)}" x2="${lineX}" y2="${clamp(Math.round(normalizedGuides.bottom || height), 0, height)}" stroke="#2563eb" stroke-width="3" stroke-opacity="0.92"/>`
      );
    }
  }
  if (showGuides && hasReliableHorizontalBoundaries) {
    for (const y of yPeaks) {
      const lineY = clamp(Math.round(y), 0, Math.max(0, height - 1));
      peakLines.push(
        `<line x1="${clamp(Math.round(normalizedGuides.left || 0), 0, width)}" y1="${lineY}" x2="${clamp(Math.round(normalizedGuides.right || width), 0, width)}" y2="${lineY}" stroke="#dc2626" stroke-width="3" stroke-opacity="0.92"/>`
      );
    }
  }

  const replacementTrails = selectiveCornerReplacement.map((item) => {
    if (!item?.applied || !Array.isArray(item.from) || !Array.isArray(item.to)) {
      return '';
    }
    const fromX = clamp(Math.round(item.from[0]), 0, Math.max(0, width - 1));
    const fromY = clamp(Math.round(item.from[1]), 0, Math.max(0, height - 1));
    const toX = clamp(Math.round(item.to[0]), 0, Math.max(0, width - 1));
    const toY = clamp(Math.round(item.to[1]), 0, Math.max(0, height - 1));
    const labelX = clamp(Math.round((fromX + toX) / 2) + 10, 0, Math.max(0, width - 180));
    const labelY = clamp(Math.round((fromY + toY) / 2) - 12, 24, Math.max(24, height - 10));
    const coordLabel = `(${fromX},${fromY})->(${toX},${toY}) d=${Number(item.shift || 0).toFixed(1)} c=${Number(item.confidence || 0).toFixed(2)}`;
    return `
      <line x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}" stroke="#991b1b" stroke-width="3" stroke-dasharray="10 8" stroke-opacity="0.9"/>
      <circle cx="${fromX}" cy="${fromY}" r="8" fill="none" stroke="#991b1b" stroke-width="3" stroke-dasharray="6 4"/>
      <rect x="${labelX}" y="${labelY - 16}" width="290" height="20" rx="6" ry="6" fill="rgba(255,255,255,0.9)" stroke="#991b1b" stroke-width="2"/>
      <text x="${labelX + 8}" y="${labelY - 2}" font-size="13" fill="#7f1d1d">${coordLabel}</text>
    `;
  }).join('\n');

  const cornerPoints = corners.map((point, index) => {
    const x = clamp(Math.round(point[0]), 0, Math.max(0, width - 1));
    const y = clamp(Math.round(point[1]), 0, Math.max(0, height - 1));
    const replacementDetail = selectiveCornerReplacement.find((item) => Number(item?.index) === index) || null;
    const cornerStroke = replacementDetail?.applied ? '#b91c1c' : '#ea580c';
    const cornerFill = replacementDetail?.applied ? '#ef4444' : '#f97316';
    const statusText = replacementDetail?.applied ? 'R' : 'K';
    const statusFill = replacementDetail?.applied ? '#7f1d1d' : '#9a3412';
    const statusLabel = replacementDetail
      ? `${statusText}:${String(replacementDetail.reason || 'keep').slice(0, 16)}`
      : 'K:default';
    return `
      <circle cx="${x}" cy="${y}" r="9" fill="${cornerFill}" stroke="${cornerStroke}" stroke-width="3"/>
      <rect x="${x + 10}" y="${y - 34}" width="162" height="24" rx="8" ry="8" fill="rgba(255,255,255,0.92)" stroke="${cornerStroke}" stroke-width="2"/>
      <text x="${x + 18}" y="${y - 17}" font-size="16" fill="#111827">C${index}</text>
      <text x="${x + 46}" y="${y - 17}" font-size="15" fill="${statusFill}">${statusLabel}</text>
    `;
  }).join('\n');

  const polygon = corners.length === 4
    ? `<polygon points="${corners.map((point) => `${point[0]},${point[1]}`).join(' ')}" fill="none" stroke="#16a34a" stroke-width="6"/>`
    : '';
  const guidesRect = showGuides && normalizedGuides.left !== undefined && normalizedGuides.right !== undefined && normalizedGuides.top !== undefined && normalizedGuides.bottom !== undefined
    ? `<rect x="${normalizedGuides.left}" y="${normalizedGuides.top}" width="${Math.max(1, normalizedGuides.right - normalizedGuides.left)}" height="${Math.max(1, normalizedGuides.bottom - normalizedGuides.top)}" fill="none" stroke="#22c55e" stroke-width="4" stroke-dasharray="12 10"/>`
    : '';
  const infoLines = [annotationSubtitle, annotationDetail].filter(Boolean);
  const infoPanelHeight = 64 + infoLines.length * 24;
  const infoPanelWidth = Math.min(720, Math.max(420, width - 28));
  const infoText = infoLines.map((line, index) => (
    `<text x="30" y="${76 + index * 22}" font-size="18" fill="#374151">${line}</text>`
  )).join('\n');

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${polygon}
      ${guidesRect}
      ${peakLines.join('\n')}
      ${replacementTrails}
      ${cornerPoints}
      <rect x="14" y="14" width="${infoPanelWidth}" height="${infoPanelHeight}" rx="10" ry="10" fill="rgba(229,231,235,0.92)"/>
      <text x="30" y="46" font-size="24" fill="#111827">${annotationTitle}</text>
      ${infoText}
    </svg>
  `;

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(imagePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputPath);
  return outputPath;
}

async function exportGridRectifiedByGuides(imagePath, outputPath, gridBoundaryDetection, options = {}) {
  if (!imagePath || !outputPath || !gridBoundaryDetection?.guides) {
    return null;
  }
  const { metaPath = null, debugPath = null, gridRows = null, gridCols = null } = options;
  const guides = gridBoundaryDetection.guides;
  const corners = gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null;

  if (Array.isArray(corners) && corners.length === 4 && metaPath && gridRows && gridCols) {
    const rectified = await runGridOuterRectify(imagePath, {
      outputPath,
      metaPath,
      debugPath,
      gridRows,
      gridCols,
      corners
    });
    return {
      source: 'grid_corner_anchors',
      outputPath,
      corners,
      warp: rectified?.warp || null,
      guideBounds: guides ? {
        left: Math.round(guides.left || 0),
        top: Math.round(guides.top || 0),
        right: Math.round(guides.right || 0),
        bottom: Math.round(guides.bottom || 0),
        width: Math.round((guides.right || 0) - (guides.left || 0)),
        height: Math.round((guides.bottom || 0) - (guides.top || 0))
      } : null
    };
  }

  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const guideLeft = clamp(Math.round(guides.left || 0), 0, Math.max(0, width - 1));
  const guideTop = clamp(Math.round(guides.top || 0), 0, Math.max(0, height - 1));
  const guideRight = clamp(Math.round(guides.right || width), guideLeft + 1, width);
  const guideBottom = clamp(Math.round(guides.bottom || height), guideTop + 1, height);
  const avgCellWidth = xPeaks.length > 1
    ? average(xPeaks.slice(1).map((value, index) => value - xPeaks[index]).filter((gap) => gap > 0))
    : (guideRight - guideLeft) / 10;
  const avgCellHeight = yPeaks.length > 1
    ? average(yPeaks.slice(1).map((value, index) => value - yPeaks[index]).filter((gap) => gap > 0))
    : (guideBottom - guideTop) / 7;
  const topPadding = Math.max(
    18,
    Math.round(avgCellHeight * (String(guides.ySource || '').includes('A4约束修正') ? 0.16 : 0.12))
  );
  const bottomPadding = Math.max(10, Math.round(avgCellHeight * 0.05));
  const sidePadding = Math.max(6, Math.round(avgCellWidth * 0.03));
  const left = clamp(guideLeft - sidePadding, 0, Math.max(0, width - 1));
  const top = clamp(guideTop - topPadding, 0, Math.max(0, height - 1));
  const right = clamp(guideRight + sidePadding, left + 1, width);
  const bottom = clamp(guideBottom + bottomPadding, top + 1, height);
  const extractWidth = Math.max(1, right - left);
  const extractHeight = Math.max(1, bottom - top);

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(imagePath)
    .extract({
      left,
      top,
      width: extractWidth,
      height: extractHeight
    })
    .png()
    .toFile(outputPath);

  return {
    source: 'grid_boundary_guides_fallback',
    outputPath,
    guideBounds: {
      left: guideLeft,
      top: guideTop,
      right: guideRight,
      bottom: guideBottom,
      width: guideRight - guideLeft,
      height: guideBottom - guideTop
    },
    cropBounds: {
      left,
      top,
      right,
      bottom,
      width: extractWidth,
      height: extractHeight
    },
    padding: { left: guideLeft - left, top: guideTop - top, right: right - guideRight, bottom: bottom - guideBottom }
  };
}

async function updateGridRectifiedMeta(metaPath, rawGridRectification, correctedGridRectified) {
  if (!metaPath || !correctedGridRectified) {
    return;
  }

  const payload = {
    sourceStep: '03_0_方格背景与边界检测.json',
    source: correctedGridRectified.source || 'grid_corner_anchors',
    outputPath: correctedGridRectified.outputPath || null,
    corners: correctedGridRectified.corners || null,
    warp: correctedGridRectified.warp || null,
    guideBounds: correctedGridRectified.guideBounds || null,
    rawGridRectification: rawGridRectification
      ? {
          inputPath: rawGridRectification.inputPath || null,
          corners: rawGridRectification.corners || null,
          guides: rawGridRectification.guides || null,
          warp: rawGridRectification.warp || null
        }
      : null
  };

  await fs.promises.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.promises.writeFile(metaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function connectedBounds(mask, width, height) {
  const visited = new Uint8Array(width * height);
  let best = null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) {
        continue;
      }

      const queue = [[x, y]];
      visited[start] = 1;
      let head = 0;
      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (head < queue.length) {
        const [cx, cy] = queue[head++];
        area++;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          const index = ny * width + nx;
          if (!mask[index] || visited[index]) {
            continue;
          }
          visited[index] = 1;
          queue.push([nx, ny]);
        }
      }

      if (!best || area > best.area) {
        best = { area, minX, minY, maxX, maxY };
      }
    }
  }

  return best;
}

function extractLargestConnectedComponent(mask, width, height) {
  const visited = new Uint8Array(width * height);
  let best = null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) {
        continue;
      }

      const queue = [[x, y]];
      const pixels = [];
      visited[start] = 1;
      let head = 0;
      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (head < queue.length) {
        const [cx, cy] = queue[head++];
        const currentIndex = cy * width + cx;
        pixels.push(currentIndex);
        area += 1;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          const index = ny * width + nx;
          if (!mask[index] || visited[index]) {
            continue;
          }
          visited[index] = 1;
          queue.push([nx, ny]);
        }
      }

      if (!best || area > best.area) {
        best = { area, minX, minY, maxX, maxY, pixels };
      }
    }
  }

  return best;
}

function extractConnectedComponents(mask, width, height, options = {}) {
  const { minArea = 1 } = options;
  const visited = new Uint8Array(width * height);
  const components = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) {
        continue;
      }

      const queue = [[x, y]];
      const pixels = [];
      visited[start] = 1;
      let head = 0;
      let area = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;

      while (head < queue.length) {
        const [cx, cy] = queue[head++];
        const currentIndex = cy * width + cx;
        pixels.push(currentIndex);
        area += 1;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          const index = ny * width + nx;
          if (!mask[index] || visited[index]) {
            continue;
          }
          visited[index] = 1;
          queue.push([nx, ny]);
        }
      }

      if (area >= minArea) {
        components.push({ area, minX, minY, maxX, maxY, pixels });
      }
    }
  }

  return components;
}

function dilateMask(mask, width, height, radius = 1) {
  if (!mask || radius <= 0) {
    return mask;
  }
  const dilated = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -radius; dy <= radius && !on; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          if (mask[ny * width + nx]) {
            on = 1;
            break;
          }
        }
      }
      dilated[y * width + x] = on;
    }
  }
  return dilated;
}

function longestActiveRun(values) {
  let best = 0;
  let current = 0;
  for (const value of values) {
    if (value > 0) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function evaluateOuterFrameCandidateStructure(component, width, height) {
  if (!component || !Array.isArray(component.pixels) || !component.pixels.length) {
    return {
      eligible: false,
      reason: 'missing-component-pixels'
    };
  }
  const bboxWidth = component.maxX - component.minX + 1;
  const bboxHeight = component.maxY - component.minY + 1;
  if (bboxWidth < 32 || bboxHeight < 32) {
    return {
      eligible: false,
      reason: 'bbox-too-small'
    };
  }

  const imageMargin = Math.max(3, Math.round(Math.min(width, height) * 0.004));
  let touchesImageEdge = false;
  const componentMask = new Uint8Array(width * height);
  for (const pixelIndex of component.pixels) {
    componentMask[pixelIndex] = 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (
      x <= imageMargin
      || x >= width - 1 - imageMargin
      || y <= imageMargin
      || y >= height - 1 - imageMargin
    ) {
      touchesImageEdge = true;
    }
  }
  if (touchesImageEdge) {
    return {
      eligible: false,
      reason: 'component-touches-image-edge'
    };
  }

  const bandX = clamp(Math.round(bboxWidth * 0.035), 5, Math.max(5, Math.round(bboxWidth * 0.06)));
  const bandY = clamp(Math.round(bboxHeight * 0.035), 5, Math.max(5, Math.round(bboxHeight * 0.06)));
  const topCoverage = new Uint8Array(bboxWidth);
  const bottomCoverage = new Uint8Array(bboxWidth);
  const leftCoverage = new Uint8Array(bboxHeight);
  const rightCoverage = new Uint8Array(bboxHeight);
  const cornerWindowX = Math.max(bandX, Math.round(bboxWidth * 0.08));
  const cornerWindowY = Math.max(bandY, Math.round(bboxHeight * 0.08));
  let topCount = 0;
  let bottomCount = 0;
  let leftCount = 0;
  let rightCount = 0;
  let cornerTopLeft = 0;
  let cornerTopRight = 0;
  let cornerBottomLeft = 0;
  let cornerBottomRight = 0;

  for (const pixelIndex of component.pixels) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const localX = x - component.minX;
    const localY = y - component.minY;
    if (localY < bandY) {
      topCoverage[localX] = 1;
      topCount += 1;
    }
    if (localY >= bboxHeight - bandY) {
      bottomCoverage[localX] = 1;
      bottomCount += 1;
    }
    if (localX < bandX) {
      leftCoverage[localY] = 1;
      leftCount += 1;
    }
    if (localX >= bboxWidth - bandX) {
      rightCoverage[localY] = 1;
      rightCount += 1;
    }
    if (localX < cornerWindowX && localY < cornerWindowY) {
      cornerTopLeft += 1;
    }
    if (localX >= bboxWidth - cornerWindowX && localY < cornerWindowY) {
      cornerTopRight += 1;
    }
    if (localX < cornerWindowX && localY >= bboxHeight - cornerWindowY) {
      cornerBottomLeft += 1;
    }
    if (localX >= bboxWidth - cornerWindowX && localY >= bboxHeight - cornerWindowY) {
      cornerBottomRight += 1;
    }
  }

  const topCoverageRatio = topCoverage.reduce((sum, value) => sum + value, 0) / Math.max(1, bboxWidth);
  const bottomCoverageRatio = bottomCoverage.reduce((sum, value) => sum + value, 0) / Math.max(1, bboxWidth);
  const leftCoverageRatio = leftCoverage.reduce((sum, value) => sum + value, 0) / Math.max(1, bboxHeight);
  const rightCoverageRatio = rightCoverage.reduce((sum, value) => sum + value, 0) / Math.max(1, bboxHeight);
  const topLongestRunRatio = longestActiveRun(topCoverage) / Math.max(1, bboxWidth);
  const bottomLongestRunRatio = longestActiveRun(bottomCoverage) / Math.max(1, bboxWidth);
  const leftLongestRunRatio = longestActiveRun(leftCoverage) / Math.max(1, bboxHeight);
  const rightLongestRunRatio = longestActiveRun(rightCoverage) / Math.max(1, bboxHeight);

  const interiorX0 = clamp(component.minX + bandX * 2, component.minX, component.maxX);
  const interiorX1 = clamp(component.maxX - bandX * 2, interiorX0, component.maxX);
  const interiorY0 = clamp(component.minY + bandY * 2, component.minY, component.maxY);
  const interiorY1 = clamp(component.maxY - bandY * 2, interiorY0, component.maxY);
  let interiorCount = 0;
  if (interiorX1 > interiorX0 && interiorY1 > interiorY0) {
    for (let y = interiorY0; y <= interiorY1; y += 1) {
      const rowOffset = y * width;
      for (let x = interiorX0; x <= interiorX1; x += 1) {
        if (componentMask[rowOffset + x]) {
          interiorCount += 1;
        }
      }
    }
  }
  const interiorArea = Math.max(1, (interiorX1 - interiorX0 + 1) * (interiorY1 - interiorY0 + 1));
  const interiorFillRatio = interiorCount / interiorArea;
  const sideCoverageStrong = (
    topCoverageRatio >= 0.58
    && bottomCoverageRatio >= 0.58
    && leftCoverageRatio >= 0.58
    && rightCoverageRatio >= 0.58
  );
  const sideRunStrong = (
    topLongestRunRatio >= 0.38
    && bottomLongestRunRatio >= 0.38
    && leftLongestRunRatio >= 0.38
    && rightLongestRunRatio >= 0.38
  );
  const cornerConnected = (
    cornerTopLeft > 0
    && cornerTopRight > 0
    && cornerBottomLeft > 0
    && cornerBottomRight > 0
  );
  const interiorHollow = interiorFillRatio <= 0.1;

  return {
    eligible: sideCoverageStrong && sideRunStrong && cornerConnected && interiorHollow,
    reason: !sideCoverageStrong
      ? 'insufficient-side-coverage'
      : !sideRunStrong
        ? 'insufficient-side-run'
        : !cornerConnected
          ? 'missing-corner-connection'
          : !interiorHollow
            ? 'interior-too-dense'
            : 'ok',
    metrics: {
      topCoverageRatio: Number(topCoverageRatio.toFixed(4)),
      bottomCoverageRatio: Number(bottomCoverageRatio.toFixed(4)),
      leftCoverageRatio: Number(leftCoverageRatio.toFixed(4)),
      rightCoverageRatio: Number(rightCoverageRatio.toFixed(4)),
      topLongestRunRatio: Number(topLongestRunRatio.toFixed(4)),
      bottomLongestRunRatio: Number(bottomLongestRunRatio.toFixed(4)),
      leftLongestRunRatio: Number(leftLongestRunRatio.toFixed(4)),
      rightLongestRunRatio: Number(rightLongestRunRatio.toFixed(4)),
      interiorFillRatio: Number(interiorFillRatio.toFixed(4)),
      cornerCounts: {
        topLeft: cornerTopLeft,
        topRight: cornerTopRight,
        bottomLeft: cornerBottomLeft,
        bottomRight: cornerBottomRight
      },
      touchesImageEdge
    }
  };
}

function scoreOuterFrameCandidate(component, structure, imageArea) {
  if (!component || !structure?.metrics) {
    return Number.NEGATIVE_INFINITY;
  }
  const metrics = structure.metrics;
  const sideCoverageAvg = average([
    metrics.topCoverageRatio,
    metrics.bottomCoverageRatio,
    metrics.leftCoverageRatio,
    metrics.rightCoverageRatio
  ]);
  const sideRunAvg = average([
    metrics.topLongestRunRatio,
    metrics.bottomLongestRunRatio,
    metrics.leftLongestRunRatio,
    metrics.rightLongestRunRatio
  ]);
  const cornerPresence = average([
    metrics.cornerCounts?.topLeft ? 1 : 0,
    metrics.cornerCounts?.topRight ? 1 : 0,
    metrics.cornerCounts?.bottomLeft ? 1 : 0,
    metrics.cornerCounts?.bottomRight ? 1 : 0
  ]);
  const hollowScore = Math.max(0, 1 - Math.min(1, metrics.interiorFillRatio / 0.12));
  const areaScore = Math.min(1, (component.bboxArea || 0) / Math.max(1, imageArea));
  return (
    sideCoverageAvg * 0.34
    + sideRunAvg * 0.28
    + cornerPresence * 0.18
    + hollowScore * 0.12
    + areaScore * 0.08
  );
}

function buildOuterFrameCandidateRankSummary(componentCandidates, limit = 3) {
  return componentCandidates.slice(0, Math.max(1, limit)).map((item, index) => ({
    rank: index + 1,
    bbox: {
      left: item.minX,
      top: item.minY,
      right: item.maxX,
      bottom: item.maxY,
      width: item.bboxWidth,
      height: item.bboxHeight
    },
    eligible: Boolean(item.structure?.eligible),
    reason: item.structure?.reason || null,
    structureScore: Number((item.structureScore || 0).toFixed(4)),
    fillRatio: Number(item.fillRatio.toFixed(4)),
    metrics: item.structure?.metrics || null
  }));
}

function evaluateOuterFrameInnerSeparation({
  darkMask,
  candidateMask,
  width,
  height,
  outerFrame,
  immediateInnerFrame,
  spanX0,
  spanX1,
  spanY0,
  spanY1
}) {
  if (
    !darkMask || !candidateMask || !outerFrame || !immediateInnerFrame
    || width <= 0 || height <= 0
  ) {
    return {
      eligible: false,
      reason: 'missing-separation-input'
    };
  }

  const summarizeHorizontalGap = (y0, y1, x0, x1) => {
    if (y1 < y0 || x1 < x0) {
      return {
        gap: 0,
        unrelatedRatio: 1,
        unrelatedDarkRatio: 0,
        candidateRatio: 0,
        adjacentUnrelatedDarkRatio: 0,
        pixelCount: 0
      };
    }
    let unrelatedCount = 0;
    let unrelatedDarkCount = 0;
    let adjacentUnrelatedDarkCount = 0;
    let candidateCount = 0;
    let pixelCount = 0;
    for (let y = y0; y <= y1; y += 1) {
      const rowOffset = y * width;
      for (let x = x0; x <= x1; x += 1) {
        const index = rowOffset + x;
        pixelCount += 1;
        if (candidateMask[index]) {
          candidateCount += 1;
          continue;
        }
        if (darkMask[index]) {
          unrelatedDarkCount += 1;
          const neighbors = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1]
          ];
          if (neighbors.some(([nx, ny]) => nx >= 0 && nx < width && ny >= 0 && ny < height && candidateMask[ny * width + nx])) {
            adjacentUnrelatedDarkCount += 1;
          }
        } else {
          unrelatedCount += 1;
        }
      }
    }
    return {
      gap: y1 - y0 + 1,
      unrelatedRatio: pixelCount > 0 ? (unrelatedCount / pixelCount) : 1,
      unrelatedDarkRatio: pixelCount > 0 ? (unrelatedDarkCount / pixelCount) : 0,
      candidateRatio: pixelCount > 0 ? (candidateCount / pixelCount) : 0,
      adjacentUnrelatedDarkRatio: pixelCount > 0 ? (adjacentUnrelatedDarkCount / pixelCount) : 0,
      pixelCount
    };
  };

  const summarizeVerticalGap = (x0, x1, y0, y1) => {
    if (x1 < x0 || y1 < y0) {
      return {
        gap: 0,
        unrelatedRatio: 1,
        unrelatedDarkRatio: 0,
        candidateRatio: 0,
        adjacentUnrelatedDarkRatio: 0,
        pixelCount: 0
      };
    }
    let unrelatedCount = 0;
    let unrelatedDarkCount = 0;
    let adjacentUnrelatedDarkCount = 0;
    let candidateCount = 0;
    let pixelCount = 0;
    for (let y = y0; y <= y1; y += 1) {
      const rowOffset = y * width;
      for (let x = x0; x <= x1; x += 1) {
        const index = rowOffset + x;
        pixelCount += 1;
        if (candidateMask[index]) {
          candidateCount += 1;
          continue;
        }
        if (darkMask[index]) {
          unrelatedDarkCount += 1;
          const neighbors = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1]
          ];
          if (neighbors.some(([nx, ny]) => nx >= 0 && nx < width && ny >= 0 && ny < height && candidateMask[ny * width + nx])) {
            adjacentUnrelatedDarkCount += 1;
          }
        } else {
          unrelatedCount += 1;
        }
      }
    }
    return {
      gap: x1 - x0 + 1,
      unrelatedRatio: pixelCount > 0 ? (unrelatedCount / pixelCount) : 1,
      unrelatedDarkRatio: pixelCount > 0 ? (unrelatedDarkCount / pixelCount) : 0,
      candidateRatio: pixelCount > 0 ? (candidateCount / pixelCount) : 0,
      adjacentUnrelatedDarkRatio: pixelCount > 0 ? (adjacentUnrelatedDarkCount / pixelCount) : 0,
      pixelCount
    };
  };

  const topGap = summarizeHorizontalGap(
    clamp(outerFrame.top + 1, 0, height - 1),
    clamp(immediateInnerFrame.top - 1, 0, height - 1),
    clamp(spanX0, 0, width - 1),
    clamp(spanX1, 0, width - 1)
  );
  const bottomGap = summarizeHorizontalGap(
    clamp(immediateInnerFrame.bottom + 1, 0, height - 1),
    clamp(outerFrame.bottom - 1, 0, height - 1),
    clamp(spanX0, 0, width - 1),
    clamp(spanX1, 0, width - 1)
  );
  const leftGap = summarizeVerticalGap(
    clamp(outerFrame.left + 1, 0, width - 1),
    clamp(immediateInnerFrame.left - 1, 0, width - 1),
    clamp(spanY0, 0, height - 1),
    clamp(spanY1, 0, height - 1)
  );
  const rightGap = summarizeVerticalGap(
    clamp(immediateInnerFrame.right + 1, 0, width - 1),
    clamp(outerFrame.right - 1, 0, width - 1),
    clamp(spanY0, 0, height - 1),
    clamp(spanY1, 0, height - 1)
  );

  const minGap = 3;
  const maxAdjacentUnrelatedDarkRatio = 0.035;
  const maxCandidateOverlapRatio = 0.45;
  const sides = { top: topGap, bottom: bottomGap, left: leftGap, right: rightGap };
  const sideFlags = Object.fromEntries(
    Object.entries(sides).map(([key, metrics]) => ([
      key,
      metrics.gap >= minGap
      && metrics.candidateRatio <= maxCandidateOverlapRatio
      && metrics.adjacentUnrelatedDarkRatio <= maxAdjacentUnrelatedDarkRatio
    ]))
  );
  const passedCount = Object.values(sideFlags).filter(Boolean).length;
  const eligible = passedCount >= 3 && sideFlags.left && sideFlags.right;
  return {
    eligible,
    reason: eligible ? 'ok' : 'inner-content-too-close-to-outer-frame',
    metrics: {
      top: {
        gap: topGap.gap,
        unrelatedRatio: Number(topGap.unrelatedRatio.toFixed(4)),
        unrelatedDarkRatio: Number(topGap.unrelatedDarkRatio.toFixed(4)),
        candidateRatio: Number(topGap.candidateRatio.toFixed(4)),
        adjacentUnrelatedDarkRatio: Number(topGap.adjacentUnrelatedDarkRatio.toFixed(4))
      },
      bottom: {
        gap: bottomGap.gap,
        unrelatedRatio: Number(bottomGap.unrelatedRatio.toFixed(4)),
        unrelatedDarkRatio: Number(bottomGap.unrelatedDarkRatio.toFixed(4)),
        candidateRatio: Number(bottomGap.candidateRatio.toFixed(4)),
        adjacentUnrelatedDarkRatio: Number(bottomGap.adjacentUnrelatedDarkRatio.toFixed(4))
      },
      left: {
        gap: leftGap.gap,
        unrelatedRatio: Number(leftGap.unrelatedRatio.toFixed(4)),
        unrelatedDarkRatio: Number(leftGap.unrelatedDarkRatio.toFixed(4)),
        candidateRatio: Number(leftGap.candidateRatio.toFixed(4)),
        adjacentUnrelatedDarkRatio: Number(leftGap.adjacentUnrelatedDarkRatio.toFixed(4))
      },
      right: {
        gap: rightGap.gap,
        unrelatedRatio: Number(rightGap.unrelatedRatio.toFixed(4)),
        unrelatedDarkRatio: Number(rightGap.unrelatedDarkRatio.toFixed(4)),
        candidateRatio: Number(rightGap.candidateRatio.toFixed(4)),
        adjacentUnrelatedDarkRatio: Number(rightGap.adjacentUnrelatedDarkRatio.toFixed(4))
      },
      sideFlags
    }
  };
}

function computeMaskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) {
        continue;
      }
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    area
  };
}

function computeMaskRectStats(mask, width, rect) {
  const { x0, y0, x1, y1 } = rect;
  let count = 0;
  let boundaryCount = 0;
  let minX = x1;
  let minY = y1;
  let maxX = x0 - 1;
  let maxY = y0 - 1;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      let isBoundary = false;
      for (let dy = -1; dy <= 1 && !isBoundary; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || !mask[ny * width + nx]) {
            isBoundary = true;
            break;
          }
        }
      }
      if (isBoundary) {
        boundaryCount += 1;
      }
    }
  }
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return {
    count,
    boundaryCount,
    ratio: count / area,
    boundaryRatio: boundaryCount / area,
    bounds: maxX >= minX && maxY >= minY ? { minX, minY, maxX, maxY } : null
  };
}

function splitRectTo3x3(rect) {
  const { x0, y0, x1, y1 } = rect;
  const stepX = (x1 - x0) / 3;
  const stepY = (y1 - y0) / 3;
  const cells = [];
  for (let gy = 0; gy < 3; gy += 1) {
    for (let gx = 0; gx < 3; gx += 1) {
      const cell = {
        gx,
        gy,
        x0: x0 + Math.floor(stepX * gx),
        y0: y0 + Math.floor(stepY * gy),
        x1: gx === 2 ? x1 : x0 + Math.floor(stepX * (gx + 1)),
        y1: gy === 2 ? y1 : y0 + Math.floor(stepY * (gy + 1))
      };
      if (cell.x1 > cell.x0 && cell.y1 > cell.y0) {
        cells.push(cell);
      }
    }
  }
  return cells;
}

function getCornerCellPriorities(cornerType) {
  if (cornerType === 'topLeft') {
    return [[0, 0], [1, 0], [0, 1]];
  }
  if (cornerType === 'topRight') {
    return [[2, 0], [1, 0], [2, 1]];
  }
  if (cornerType === 'bottomRight') {
    return [[2, 2], [2, 1], [1, 2]];
  }
  return [[0, 2], [0, 1], [1, 2]];
}

function getCornerRequiredEdges(cornerType) {
  if (cornerType === 'topLeft') {
    return ['top', 'left'];
  }
  if (cornerType === 'topRight') {
    return ['top', 'right'];
  }
  if (cornerType === 'bottomRight') {
    return ['bottom', 'right'];
  }
  return ['bottom', 'left'];
}

function scoreCornerCell(cell, stats, cornerType) {
  if (!stats.count) {
    return -Infinity;
  }
  const centerX = (cell.x0 + cell.x1) / 2;
  const centerY = (cell.y0 + cell.y1) / 2;
  let geometricScore = 0;
  if (cornerType === 'topLeft') {
    geometricScore = -(centerX + centerY);
  } else if (cornerType === 'topRight') {
    geometricScore = centerX - centerY;
  } else if (cornerType === 'bottomRight') {
    geometricScore = centerX + centerY;
  } else {
    geometricScore = -centerX + centerY;
  }
  return (
    stats.boundaryCount * 8
    + stats.count * 2
    + stats.boundaryRatio * 120
    + stats.ratio * 40
    + geometricScore * 0.01
  );
}

function build3x3CellAnalysis(mask, width, cells) {
  const statsMap = new Map();
  const getCell = (gx, gy) => cells.find((item) => item.gx === gx && item.gy === gy) || null;
  const isWhiteLike = (gx, gy) => {
    const stats = statsMap.get(`${gx},${gy}`);
    return Boolean(stats && (stats.count > 0 || stats.ratio >= 0.04));
  };

  for (const cell of cells) {
    statsMap.set(`${cell.gx},${cell.gy}`, computeMaskRectStats(mask, width, cell));
  }

  return cells.map((cell) => {
    const stats = statsMap.get(`${cell.gx},${cell.gy}`);
    const leftFilled = isWhiteLike(cell.gx - 1, cell.gy);
    const rightFilled = isWhiteLike(cell.gx + 1, cell.gy);
    const topFilled = isWhiteLike(cell.gx, cell.gy - 1);
    const bottomFilled = isWhiteLike(cell.gx, cell.gy + 1);
    const edgeFlags = {
      left: stats.count > 0 && !leftFilled,
      right: stats.count > 0 && !rightFilled,
      top: stats.count > 0 && !topFilled,
      bottom: stats.count > 0 && !bottomFilled
    };
    return {
      ...cell,
      stats,
      edgeFlags
    };
  });
}

function chooseCornerCellFromAnalysis(analysis, cornerType) {
  const requiredEdges = getCornerRequiredEdges(cornerType);
  const priorities = getCornerCellPriorities(cornerType);
  const keySet = new Set(priorities.map(([gx, gy]) => `${gx},${gy}`));
  const candidates = analysis.filter((item) => keySet.has(`${item.gx},${item.gy}`) && item.stats.count > 0);
  if (!candidates.length) {
    return null;
  }

  let best = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const matchedEdges = requiredEdges.reduce((sum, edge) => sum + (candidate.edgeFlags[edge] ? 1 : 0), 0);
    const priorityIndex = priorities.findIndex(([gx, gy]) => gx === candidate.gx && gy === candidate.gy);
    const score = (
      matchedEdges * 1000
      + candidate.stats.boundaryCount * 10
      + candidate.stats.boundaryRatio * 200
      + candidate.stats.ratio * 60
      - Math.max(0, priorityIndex) * 15
    );
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function pickCornerPixelFromRect(mask, width, rect, cornerType) {
  let bestPoint = null;
  let bestScore = cornerType === 'bottomRight' ? -Infinity : Infinity;
  if (cornerType === 'topRight' || cornerType === 'bottomLeft') {
    bestScore = cornerType === 'topRight' ? -Infinity : Infinity;
  }

  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }
      let boundary = false;
      for (let dy = -1; dy <= 1 && !boundary; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || !mask[ny * width + nx]) {
            boundary = true;
            break;
          }
        }
      }
      if (!boundary) {
        continue;
      }
      let score = 0;
      if (cornerType === 'topLeft') {
        score = x + y;
        if (score < bestScore) {
          bestScore = score;
          bestPoint = [x, y];
        }
      } else if (cornerType === 'topRight') {
        score = x - y;
        if (score > bestScore) {
          bestScore = score;
          bestPoint = [x, y];
        }
      } else if (cornerType === 'bottomRight') {
        score = x + y;
        if (score > bestScore) {
          bestScore = score;
          bestPoint = [x, y];
        }
      } else {
        score = x - y;
        if (score < bestScore) {
          bestScore = score;
          bestPoint = [x, y];
        }
      }
    }
  }
  return bestPoint;
}

function estimateCornerQuadByExtremes(mask, width, height) {
  let topLeft = null;
  let topRight = null;
  let bottomRight = null;
  let bottomLeft = null;
  let bestTopLeft = Infinity;
  let bestTopRight = -Infinity;
  let bestBottomRight = -Infinity;
  let bestBottomLeft = Infinity;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }
      const sum = x + y;
      const diff = x - y;
      if (sum < bestTopLeft) {
        bestTopLeft = sum;
        topLeft = [x, y];
      }
      if (diff > bestTopRight) {
        bestTopRight = diff;
        topRight = [x, y];
      }
      if (sum > bestBottomRight) {
        bestBottomRight = sum;
        bottomRight = [x, y];
      }
      if (diff < bestBottomLeft) {
        bestBottomLeft = diff;
        bottomLeft = [x, y];
      }
    }
  }

  return normalizeCornerQuad([topLeft, topRight, bottomRight, bottomLeft]);
}

function detectCornerByRecursive3x3(mask, width, height, bounds, cornerType, options = {}) {
  const {
    minSize = 12,
    maxDepth = 10
  } = options;
  let rect = {
    x0: bounds.minX,
    y0: bounds.minY,
    x1: bounds.maxX + 1,
    y1: bounds.maxY + 1
  };
  let depth = 0;

  while (depth < maxDepth && (rect.x1 - rect.x0 > minSize || rect.y1 - rect.y0 > minSize)) {
    const cells = splitRectTo3x3(rect);
    const analysis = build3x3CellAnalysis(mask, width, cells);
    let bestCell = chooseCornerCellFromAnalysis(analysis, cornerType);
    if (!bestCell) {
      const priorities = getCornerCellPriorities(cornerType);
      let bestScore = -Infinity;
      for (const [gx, gy] of priorities) {
        const cell = analysis.find((item) => item.gx === gx && item.gy === gy);
        if (!cell) {
          continue;
        }
        const score = scoreCornerCell(cell, cell.stats, cornerType);
        if (score > bestScore) {
          bestScore = score;
          bestCell = cell;
        }
      }
    }
    if (!bestCell || !bestCell.stats.count) {
      break;
    }
    rect = bestCell;
    depth += 1;
  }

  return pickCornerPixelFromRect(mask, width, rect, cornerType);
}

function collectMaskBoundaryPoints(mask, width, height) {
  const points = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }
      let boundary = false;
      for (let dy = -1; dy <= 1 && !boundary; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) {
            boundary = true;
            break;
          }
        }
      }
      if (boundary) {
        points.push([x, y]);
      }
    }
  }
  return points;
}

function pointSegmentDistance(point, start, end) {
  const px = point[0];
  const py = point[1];
  const sx = start[0];
  const sy = start[1];
  const ex = end[0];
  const ey = end[1];
  const vx = ex - sx;
  const vy = ey - sy;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-6) {
    return Math.hypot(px - sx, py - sy);
  }
  const t = clamp(((px - sx) * vx + (py - sy) * vy) / lenSq, 0, 1);
  const projX = sx + t * vx;
  const projY = sy + t * vy;
  return Math.hypot(px - projX, py - projY);
}

function fitLinePca(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  const centerX = average(points.map((point) => point[0]));
  const centerY = average(points.map((point) => point[1]));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - centerX;
    const dy = y - centerY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dirX = Math.cos(theta);
  const dirY = Math.sin(theta);
  const normalX = -dirY;
  const normalY = dirX;
  const c = -(normalX * centerX + normalY * centerY);
  return { a: normalX, b: normalY, c };
}

function linePointDistance(line, point) {
  if (!line || !Array.isArray(point)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(line.a * point[0] + line.b * point[1] + line.c) / Math.max(1e-6, Math.hypot(line.a, line.b));
}

function fitLineRobust(points, passes = 3) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  let working = [...points];
  let line = fitLinePca(working);
  if (!line) {
    return null;
  }
  for (let i = 0; i < passes; i += 1) {
    const distances = working
      .map((point) => linePointDistance(line, point))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!distances.length) {
      break;
    }
    const pivot = distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.8))];
    const threshold = Math.max(1.5, pivot * 1.25);
    const filtered = working.filter((point) => linePointDistance(line, point) <= threshold);
    if (filtered.length < 10 || filtered.length === working.length) {
      break;
    }
    working = filtered;
    line = fitLinePca(working) || line;
  }
  return line;
}

function computeLineFitResidual(line, points) {
  if (!line || !Array.isArray(points) || !points.length) {
    return Number.POSITIVE_INFINITY;
  }
  const distances = points
    .map((point) => linePointDistance(line, point))
    .filter(Number.isFinite);
  return distances.length ? average(distances) : Number.POSITIVE_INFINITY;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function pointWithinWindow(point, xFrom, xTo, yFrom, yTo, margin = 0) {
  if (!Array.isArray(point) || point.length < 2) {
    return false;
  }
  return (
    point[0] >= Math.min(xFrom, xTo) - margin
    && point[0] <= Math.max(xFrom, xTo) + margin
    && point[1] >= Math.min(yFrom, yTo) - margin
    && point[1] <= Math.max(yFrom, yTo) + margin
  );
}

function evaluateBoundaryLineQuality(line, points, scoreAtPoint, targetPointCount = 120) {
  if (!line || !Array.isArray(points) || !points.length) {
    return {
      confidence: 0,
      residual: Number.POSITIVE_INFINITY,
      averageScore: 0,
      pointCount: 0,
      supportRatio: 0,
      continuity: null
    };
  }
  const continuityOptions = arguments[4] || {};
  const residual = computeLineFitResidual(line, points);
  const pointScores = points.map((point) => scoreAtPoint(point));
  const averageScore = average(pointScores);
  const pointCount = points.length;
  const distanceTolerance = Math.max(8, residual * 1.85);
  const scoreThreshold = Math.max(28, averageScore * 0.3);
  const supportPoints = points.filter((point, index) => (
    linePointDistance(line, point) <= distanceTolerance
    && pointScores[index] >= scoreThreshold
  ));
  const supportCount = supportPoints.length;
  const supportRatio = supportCount / Math.max(1, pointCount);
  const continuity = evaluateBoundarySupportContinuity(supportPoints, continuityOptions);
  const countConfidence = clamp01(pointCount / Math.max(1, targetPointCount));
  const residualConfidence = clamp01(1 - (residual / 5.5));
  const scoreConfidence = clamp01(averageScore / 135);
  const supportConfidence = clamp01((supportRatio - 0.18) / 0.52);
  const continuityConfidence = continuity
    ? clamp01(
        continuity.coverageRatio * 0.26
        + continuity.longestRunRatio * 0.36
        + continuity.endpointCoverage * 0.28
        + (1 - continuity.maxGapRatio) * 0.1
      )
    : 0;
  return {
    confidence: countConfidence * 0.14 + residualConfidence * 0.22 + scoreConfidence * 0.14 + supportConfidence * 0.22 + continuityConfidence * 0.28,
    residual,
    averageScore,
    pointCount,
    supportRatio,
    continuity
  };
}

function evaluateBoundarySupportContinuity(points, options = {}) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }
  const axis = options.axis === 'y' ? 'y' : 'x';
  const expectedStart = Number.isFinite(options.expectedStart) ? Number(options.expectedStart) : null;
  const expectedEnd = Number.isFinite(options.expectedEnd) ? Number(options.expectedEnd) : null;
  const coordinates = points
    .map((point) => axis === 'x' ? Number(point[0]) : Number(point[1]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!coordinates.length) {
    return null;
  }
  const observedStart = coordinates[0];
  const observedEnd = coordinates[coordinates.length - 1];
  const spanStart = Number.isFinite(expectedStart) ? Math.min(expectedStart, expectedEnd) : observedStart;
  const spanEnd = Number.isFinite(expectedEnd) ? Math.max(expectedStart, expectedEnd) : observedEnd;
  const span = Math.max(1, spanEnd - spanStart);
  const binSize = Math.max(8, Number.isFinite(options.binSize) ? Number(options.binSize) : Math.round(span / 42));
  const totalBins = Math.max(1, Math.round(span / binSize));
  const occupied = new Array(totalBins).fill(false);
  for (const coordinate of coordinates) {
    const index = clamp(Math.round((coordinate - spanStart) / Math.max(binSize, 1)), 0, totalBins - 1);
    occupied[index] = true;
  }
  const occupiedCount = occupied.filter(Boolean).length;
  let longestRun = 0;
  let currentRun = 0;
  let maxGap = 0;
  let currentGap = 0;
  for (const filled of occupied) {
    if (filled) {
      currentRun += 1;
      longestRun = Math.max(longestRun, currentRun);
      currentGap = 0;
    } else {
      currentGap += 1;
      maxGap = Math.max(maxGap, currentGap);
      currentRun = 0;
    }
  }
  const endpointBandBins = Math.max(1, Math.round(totalBins * 0.14));
  const leftEndpointCoverage = occupied.slice(0, endpointBandBins).some(Boolean) ? 1 : 0;
  const rightEndpointCoverage = occupied.slice(Math.max(0, totalBins - endpointBandBins)).some(Boolean) ? 1 : 0;
  return {
    coverageRatio: occupiedCount / Math.max(1, totalBins),
    longestRunRatio: longestRun / Math.max(1, totalBins),
    endpointCoverage: (leftEndpointCoverage + rightEndpointCoverage) / 2,
    maxGapRatio: maxGap / Math.max(1, totalBins),
    spanStart,
    spanEnd,
    binSize,
    totalBins,
    occupiedCount
  };
}

function mergeCornerQuadsWithConfidence(baseQuad, refinedQuad, cornerWeights, options = {}) {
  const base = normalizeCornerQuad(baseQuad);
  const refined = normalizeCornerQuad(refinedQuad);
  if (!base || !refined) {
    return refined || base || null;
  }
  const maxShift = Number.isFinite(options.maxShift) ? options.maxShift : 54;
  const defaultBlend = Number.isFinite(options.defaultBlend) ? options.defaultBlend : 0.28;
  const merged = base.map(([bx, by], index) => {
    const [rx, ry] = refined[index];
    const dx = rx - bx;
    const dy = ry - by;
    const distance = Math.hypot(dx, dy);
    const limitedScale = distance > maxShift ? (maxShift / Math.max(distance, 1e-6)) : 1;
    const weight = clamp01(Number.isFinite(cornerWeights?.[index]) ? cornerWeights[index] : defaultBlend);
    return [
      bx + dx * weight * limitedScale,
      by + dy * weight * limitedScale
    ];
  });
  return normalizeCornerQuad(merged) || base;
}

function blendQuadByCornerStability(baseQuad, targetQuad, cornerConfidences, cornerTargetSupports, options = {}) {
  const base = normalizeCornerQuad(baseQuad);
  const target = normalizeCornerQuad(targetQuad);
  if (!base || !target) {
    return target || base || null;
  }
  const maxShift = Number.isFinite(options.maxShift) ? options.maxShift : 64;
  const minBlend = Number.isFinite(options.minBlend) ? options.minBlend : 0.04;
  const maxBlend = Number.isFinite(options.maxBlend) ? options.maxBlend : 0.9;
  const blended = base.map(([bx, by], index) => {
    const [tx, ty] = target[index];
    const dx = tx - bx;
    const dy = ty - by;
    const distance = Math.hypot(dx, dy);
    const targetSupport = clamp01(Number.isFinite(cornerTargetSupports?.[index]) ? cornerTargetSupports[index] : 0.5);
    const cornerConfidence = clamp01(Number.isFinite(cornerConfidences?.[index]) ? cornerConfidences[index] : 0.5);
    const blend = clamp(
      minBlend + (1 - cornerConfidence) * 0.58 + targetSupport * 0.26,
      minBlend,
      maxBlend
    );
    const limitedScale = distance > maxShift ? (maxShift / Math.max(distance, 1e-6)) : 1;
    return [
      bx + dx * blend * limitedScale,
      by + dy * blend * limitedScale
    ];
  });
  const stabilized = stabilizeQuadGeometry(blended, { blend: 0.18 }) || blended;
  return normalizeCornerQuad(stabilized) || base;
}

function buildSelectiveCornerReplacementQuad(baseQuad, targetQuad, cornerConfidences, options = {}) {
  const base = normalizeCornerQuad(baseQuad);
  const target = normalizeCornerQuad(targetQuad);
  if (!base || !target) {
    return target || base || null;
  }
  const minImprovement = Number.isFinite(options.minImprovement) ? options.minImprovement : 0.08;
  const maxCornerConfidence = Number.isFinite(options.maxCornerConfidence) ? options.maxCornerConfidence : 0.82;
  const maxShift = Number.isFinite(options.maxShift) ? options.maxShift : 72;
  const working = base.map((point) => [...point]);
  const baseQuality = evaluateRectangularQuadQuality(base, { guides: options.guides });
  let currentScore = baseQuality?.rotatedRectangleScore ?? 0;
  const replacements = [];

  for (let index = 0; index < base.length; index += 1) {
    const confidence = clamp01(Number.isFinite(cornerConfidences?.[index]) ? cornerConfidences[index] : 0.5);
    if (confidence > maxCornerConfidence) {
      replacements.push({
        index,
        applied: false,
        reason: 'corner-confidence-too-high',
        confidence: Number(confidence.toFixed(4)),
        from: working[index].map((value) => Number(value.toFixed(3))),
        to: candidatePoint.map((value) => Number(value.toFixed(3)))
      });
      continue;
    }
    const candidatePoint = target[index];
    const shift = Math.hypot(candidatePoint[0] - working[index][0], candidatePoint[1] - working[index][1]);
    if (shift > maxShift) {
      replacements.push({
        index,
        applied: false,
        reason: 'corner-shift-too-large',
        confidence: Number(confidence.toFixed(4)),
        shift: Number(shift.toFixed(3)),
        from: working[index].map((value) => Number(value.toFixed(3))),
        to: candidatePoint.map((value) => Number(value.toFixed(3)))
      });
      continue;
    }
    const candidateQuad = working.map((point, pointIndex) => pointIndex === index ? [...candidatePoint] : [...point]);
    const candidateQuality = evaluateRectangularQuadQuality(candidateQuad, { guides: options.guides });
    const candidateScore = candidateQuality?.rotatedRectangleScore ?? 0;
    const improvement = candidateScore - currentScore;
    if (improvement >= minImprovement) {
      working[index] = [...candidatePoint];
      currentScore = candidateScore;
      replacements.push({
        index,
        applied: true,
        reason: 'rotated-rectangle-score-improved',
        confidence: Number(confidence.toFixed(4)),
        shift: Number(shift.toFixed(3)),
        improvement: Number(improvement.toFixed(4)),
        from: base[index].map((value) => Number(value.toFixed(3))),
        to: candidatePoint.map((value) => Number(value.toFixed(3)))
      });
    } else {
      replacements.push({
        index,
        applied: false,
        reason: 'improvement-too-small',
        confidence: Number(confidence.toFixed(4)),
        shift: Number(shift.toFixed(3)),
        improvement: Number(improvement.toFixed(4)),
        from: working[index].map((value) => Number(value.toFixed(3))),
        to: candidatePoint.map((value) => Number(value.toFixed(3)))
      });
    }
  }

  const stabilized = stabilizeQuadGeometry(working, { blend: 0.12 }) || working;
  return {
    quad: normalizeCornerQuad(stabilized) || base,
    replacements
  };
}

function mergeTopCornerRecoveryHint(baseQuad, recoveredQuad, diagnostics, cellHeight) {
  const base = normalizeCornerQuad(baseQuad);
  const recovered = normalizeCornerQuad(recoveredQuad);
  if (!base || !recovered || !diagnostics) {
    return base;
  }
  const merged = base.map((point) => [...point]);
  const topSpecs = [
    { index: 0, name: 'leftTop' },
    { index: 1, name: 'rightTop' }
  ];
  const maxLift = Math.max(16, Math.round(cellHeight * 0.46));
  for (const spec of topSpecs) {
    const detail = diagnostics?.corners?.[spec.name];
    if (!detail?.applied) {
      continue;
    }
    const recoveredY = Number(recovered[spec.index][1]);
    const currentY = Number(base[spec.index][1]);
    const lift = currentY - recoveredY;
    if (!Number.isFinite(recoveredY) || !Number.isFinite(currentY) || lift <= 4) {
      continue;
    }
    const dashedConfidence = clamp01(((Number(detail.dashedYScore) || 0) - 24) / 34);
    const outerConfidence = clamp01(((Number(detail.refinedOuterScore) || 0) - 24) / 34);
    const confidence = dashedConfidence * 0.42 + outerConfidence * 0.58;
    if (confidence <= 0.22) {
      continue;
    }
    const limitedLift = Math.min(lift, maxLift);
    merged[spec.index][1] = currentY - limitedLift * (0.42 + confidence * 0.34);
  }
  return normalizeCornerQuad(merged) || base;
}

function intersectLines(lineA, lineB) {
  if (!lineA || !lineB) {
    return null;
  }
  const det = lineA.a * lineB.b - lineB.a * lineA.b;
  if (Math.abs(det) <= 1e-6) {
    return null;
  }
  const x = (lineA.b * lineB.c - lineB.b * lineA.c) / det;
  const y = (lineB.a * lineA.c - lineA.a * lineB.c) / det;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return [x, y];
}

function collectEdgePointsNearSegment(boundaryPoints, start, end, options = {}) {
  const {
    bandRatio = 0.02,
    bandMin = 3,
    cornerRadiusRatio = 0.28,
    minPoints = 12
  } = options;
  const length = Math.max(1, Math.hypot(end[0] - start[0], end[1] - start[1]));
  const band = Math.max(bandMin, length * bandRatio);
  const cornerRadius = Math.max(8, length * cornerRadiusRatio);
  let points = boundaryPoints.filter((point) => (
    pointSegmentDistance(point, start, end) <= band
    && (Math.hypot(point[0] - start[0], point[1] - start[1]) <= cornerRadius
      || Math.hypot(point[0] - end[0], point[1] - end[1]) <= cornerRadius)
  ));
  if (points.length < minPoints) {
    const looseBand = Math.max(band * 1.8, 6);
    const looseRadius = Math.max(cornerRadius * 1.35, 14);
    points = boundaryPoints.filter((point) => (
      pointSegmentDistance(point, start, end) <= looseBand
      && (Math.hypot(point[0] - start[0], point[1] - start[1]) <= looseRadius
        || Math.hypot(point[0] - end[0], point[1] - end[1]) <= looseRadius)
    ));
  }
  return points;
}

function refineCornerIntersections(boundaryPoints, quad, edgeLines) {
  const refinedLines = [...edgeLines];
  const edgeDefs = [
    { start: quad[0], end: quad[1] },
    { start: quad[1], end: quad[2] },
    { start: quad[3], end: quad[2] },
    { start: quad[0], end: quad[3] }
  ];
  const cornerEdgePairs = [
    [0, 3],
    [0, 1],
    [1, 2],
    [2, 3]
  ];

  for (const [edgeAIndex, edgeBIndex] of cornerEdgePairs) {
    const edgeA = edgeDefs[edgeAIndex];
    const edgeB = edgeDefs[edgeBIndex];
    const edgeAPoints = collectEdgePointsNearSegment(boundaryPoints, edgeA.start, edgeA.end, {
      bandRatio: 0.016,
      bandMin: 2.2,
      cornerRadiusRatio: 0.22
    });
    const edgeBPoints = collectEdgePointsNearSegment(boundaryPoints, edgeB.start, edgeB.end, {
      bandRatio: 0.016,
      bandMin: 2.2,
      cornerRadiusRatio: 0.22
    });
    if (edgeAPoints.length >= 12) {
      refinedLines[edgeAIndex] = fitLineRobust(edgeAPoints) || refinedLines[edgeAIndex];
    }
    if (edgeBPoints.length >= 12) {
      refinedLines[edgeBIndex] = fitLineRobust(edgeBPoints) || refinedLines[edgeBIndex];
    }
  }

  const refinedCorners = [
    intersectLines(refinedLines[0], refinedLines[3]),
    intersectLines(refinedLines[0], refinedLines[1]),
    intersectLines(refinedLines[1], refinedLines[2]),
    intersectLines(refinedLines[2], refinedLines[3])
  ];
  if (refinedCorners.some((point) => !Array.isArray(point))) {
    return {
      corners: quad,
      lines: refinedLines
    };
  }
  return {
    corners: normalizeCornerQuad(refinedCorners),
    lines: refinedLines
  };
}

function quantile(values, q) {
  if (!Array.isArray(values) || !values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.round((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[index];
}

function normalizeVector(vector, fallback = [1, 0]) {
  if (!Array.isArray(vector) || vector.length < 2) {
    return [...fallback];
  }
  const x = Number(vector[0]);
  const y = Number(vector[1]);
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length <= 1e-6) {
    return [...fallback];
  }
  return [x / length, y / length];
}

function buildQuadOrientationFrame(quad) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized) {
    return null;
  }
  const [lt, rt, rb, lb] = normalized;
  const center = [
    average(normalized.map((point) => point[0])),
    average(normalized.map((point) => point[1]))
  ];
  const topVector = [rt[0] - lt[0], rt[1] - lt[1]];
  const bottomVector = [rb[0] - lb[0], rb[1] - lb[1]];
  const leftVector = [lb[0] - lt[0], lb[1] - lt[1]];
  const rightVector = [rb[0] - rt[0], rb[1] - rt[1]];

  const horizontalApprox = normalizeVector([
    topVector[0] + bottomVector[0],
    topVector[1] + bottomVector[1]
  ]);
  const verticalApprox = normalizeVector([
    leftVector[0] + rightVector[0],
    leftVector[1] + rightVector[1]
  ], [-horizontalApprox[1], horizontalApprox[0]]);

  let horizontal = horizontalApprox;
  let vertical = [-horizontal[1], horizontal[0]];
  if ((vertical[0] * verticalApprox[0] + vertical[1] * verticalApprox[1]) < 0) {
    vertical = [-vertical[0], -vertical[1]];
  }
  if ((horizontal[0] * horizontalApprox[0] + horizontal[1] * horizontalApprox[1]) < 0) {
    horizontal = [-horizontal[0], -horizontal[1]];
    vertical = [-vertical[0], -vertical[1]];
  }

  return {
    center,
    horizontal,
    vertical
  };
}

function refineQuadByDominantBoundaryLines(boundaryPoints, quad) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized || !Array.isArray(boundaryPoints) || boundaryPoints.length < 80) {
    return normalized;
  }
  const frame = buildQuadOrientationFrame(normalized);
  if (!frame) {
    return normalized;
  }
  const projected = boundaryPoints.map((point) => {
    const dx = point[0] - frame.center[0];
    const dy = point[1] - frame.center[1];
    return {
      point,
      u: dx * frame.horizontal[0] + dy * frame.horizontal[1],
      v: dx * frame.vertical[0] + dy * frame.vertical[1]
    };
  });
  const us = projected.map((item) => item.u);
  const vs = projected.map((item) => item.v);
  const minUBand = quantile(us, 0.12);
  const maxUBand = quantile(us, 0.88);
  const minVBand = quantile(vs, 0.12);
  const maxVBand = quantile(vs, 0.88);
  const innerUMin = quantile(us, 0.08);
  const innerUMax = quantile(us, 0.92);
  const innerVMin = quantile(vs, 0.08);
  const innerVMax = quantile(vs, 0.92);
  if (![minUBand, maxUBand, minVBand, maxVBand, innerUMin, innerUMax, innerVMin, innerVMax].every(Number.isFinite)) {
    return normalized;
  }

  const topPoints = projected
    .filter((item) => item.v <= minVBand && item.u >= innerUMin && item.u <= innerUMax)
    .map((item) => item.point);
  const bottomPoints = projected
    .filter((item) => item.v >= maxVBand && item.u >= innerUMin && item.u <= innerUMax)
    .map((item) => item.point);
  const leftPoints = projected
    .filter((item) => item.u <= minUBand && item.v >= innerVMin && item.v <= innerVMax)
    .map((item) => item.point);
  const rightPoints = projected
    .filter((item) => item.u >= maxUBand && item.v >= innerVMin && item.v <= innerVMax)
    .map((item) => item.point);
  if (topPoints.length < 16 || bottomPoints.length < 16 || leftPoints.length < 16 || rightPoints.length < 16) {
    return normalized;
  }

  const topLine = fitLineRobust(topPoints, 4);
  const bottomLine = fitLineRobust(bottomPoints, 4);
  const leftLine = fitLineRobust(leftPoints, 4);
  const rightLine = fitLineRobust(rightPoints, 4);
  const refined = normalizeCornerQuad([
    intersectLines(topLine, leftLine),
    intersectLines(topLine, rightLine),
    intersectLines(bottomLine, rightLine),
    intersectLines(bottomLine, leftLine)
  ]);
  if (!refined) {
    return normalized;
  }
  return refined;
}

function collectPointsInQuadCornerWindow(boundaryPoints, quad, cornerIndex, options = {}) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized || !Array.isArray(boundaryPoints) || !boundaryPoints.length) {
    return [];
  }
  const {
    edgePortion = 0.18,
    maxPointDistance = 36
  } = options;
  const prevIndex = (cornerIndex + 3) % 4;
  const nextIndex = (cornerIndex + 1) % 4;
  const corner = normalized[cornerIndex];
  const prev = normalized[prevIndex];
  const next = normalized[nextIndex];
  const prevTarget = [
    corner[0] + (prev[0] - corner[0]) * edgePortion,
    corner[1] + (prev[1] - corner[1]) * edgePortion
  ];
  const nextTarget = [
    corner[0] + (next[0] - corner[0]) * edgePortion,
    corner[1] + (next[1] - corner[1]) * edgePortion
  ];
  const triangleArea = Math.abs(
    (prevTarget[0] - corner[0]) * (nextTarget[1] - corner[1])
    - (prevTarget[1] - corner[1]) * (nextTarget[0] - corner[0])
  );
  if (triangleArea <= 1e-6) {
    return [];
  }
  const sign = (p1, p2, p3) => (
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
  );
  const isInsideTriangle = (point) => {
    const d1 = sign(point, corner, prevTarget);
    const d2 = sign(point, prevTarget, nextTarget);
    const d3 = sign(point, nextTarget, corner);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };
  return boundaryPoints.filter((point) => (
    isInsideTriangle(point)
    && Math.hypot(point[0] - corner[0], point[1] - corner[1]) <= maxPointDistance
  ));
}

function refineQuadByCornerLocalWindows(boundaryPoints, quad, baseLines) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized || !Array.isArray(baseLines) || baseLines.length !== 4) {
    return normalized;
  }
  const refinedLines = [...baseLines];
  const cornerToEdges = [
    [0, 3],
    [0, 1],
    [1, 2],
    [2, 3]
  ];
  for (let cornerIndex = 0; cornerIndex < 4; cornerIndex += 1) {
    const [edgeAIndex, edgeBIndex] = cornerToEdges[cornerIndex];
    const points = collectPointsInQuadCornerWindow(boundaryPoints, normalized, cornerIndex, {
      edgePortion: 0.22,
      maxPointDistance: 48
    });
    if (points.length < 10) {
      continue;
    }
    const lineA = refinedLines[edgeAIndex];
    const lineB = refinedLines[edgeBIndex];
    const edgeAPoints = points.filter((point) => linePointDistance(lineA, point) <= 8);
    const edgeBPoints = points.filter((point) => linePointDistance(lineB, point) <= 8);
    if (edgeAPoints.length >= 8) {
      refinedLines[edgeAIndex] = fitLineRobust(edgeAPoints, 4) || refinedLines[edgeAIndex];
    }
    if (edgeBPoints.length >= 8) {
      refinedLines[edgeBIndex] = fitLineRobust(edgeBPoints, 4) || refinedLines[edgeBIndex];
    }
  }
  const refined = normalizeCornerQuad([
    intersectLines(refinedLines[0], refinedLines[3]),
    intersectLines(refinedLines[0], refinedLines[1]),
    intersectLines(refinedLines[1], refinedLines[2]),
    intersectLines(refinedLines[2], refinedLines[3])
  ]);
  return refined || normalized;
}

function buildDownsampledGrayGradient(colorData, info, targetMax = 1200) {
  const { width, height, channels } = info;
  const ratio = Math.min(1, targetMax / Math.max(width, height));
  const scaledWidth = Math.max(1, Math.round(width * ratio));
  const scaledHeight = Math.max(1, Math.round(height * ratio));
  const gray = new Float32Array(scaledWidth * scaledHeight);

  for (let sy = 0; sy < scaledHeight; sy += 1) {
    for (let sx = 0; sx < scaledWidth; sx += 1) {
      const x = Math.min(width - 1, Math.round(sx / Math.max(ratio, 1e-6)));
      const y = Math.min(height - 1, Math.round(sy / Math.max(ratio, 1e-6)));
      const offset = (y * width + x) * channels;
      gray[sy * scaledWidth + sx] = 0.299 * colorData[offset] + 0.587 * colorData[offset + 1] + 0.114 * colorData[offset + 2];
    }
  }

  const gradient = new Float32Array(scaledWidth * scaledHeight);
  for (let y = 1; y < scaledHeight - 1; y += 1) {
    for (let x = 1; x < scaledWidth - 1; x += 1) {
      const gx = gray[y * scaledWidth + (x + 1)] - gray[y * scaledWidth + (x - 1)];
      const gy = gray[(y + 1) * scaledWidth + x] - gray[(y - 1) * scaledWidth + x];
      gradient[y * scaledWidth + x] = Math.hypot(gx, gy);
    }
  }

  return {
    gray,
    gradient,
    width: scaledWidth,
    height: scaledHeight,
    ratio
  };
}

function sampleGray(gray, width, height, x, y) {
  const ix = clamp(Math.round(x), 0, Math.max(0, width - 1));
  const iy = clamp(Math.round(y), 0, Math.max(0, height - 1));
  return gray[iy * width + ix];
}

function sampleGradient(gradient, width, height, x, y) {
  const ix = clamp(Math.round(x), 0, Math.max(0, width - 1));
  const iy = clamp(Math.round(y), 0, Math.max(0, height - 1));
  return gradient[iy * width + ix];
}

function collectGradientEdgePoints(edgeStart, edgeEnd, centroid, grayPack, options = {}) {
  const {
    samples = 72,
    searchRadius = 16,
    probeOffset = 3,
    minScore = 18
  } = options;
  const { gray, gradient, width, height } = grayPack;
  const dx = edgeEnd[0] - edgeStart[0];
  const dy = edgeEnd[1] - edgeStart[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  let normalX = -dy / length;
  let normalY = dx / length;
  const midX = (edgeStart[0] + edgeEnd[0]) / 2;
  const midY = (edgeStart[1] + edgeEnd[1]) / 2;
  const toCenterX = centroid[0] - midX;
  const toCenterY = centroid[1] - midY;
  if ((toCenterX * normalX + toCenterY * normalY) < 0) {
    normalX *= -1;
    normalY *= -1;
  }

  const points = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (i + 1) / (samples + 1);
    const baseX = edgeStart[0] + dx * t;
    const baseY = edgeStart[1] + dy * t;
    let bestPoint = null;
    let bestScore = -Infinity;
    for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
      const px = baseX + normalX * offset;
      const py = baseY + normalY * offset;
      if (px < 1 || px >= width - 1 || py < 1 || py >= height - 1) {
        continue;
      }
      const edgeStrength = sampleGradient(gradient, width, height, px, py);
      const inside = sampleGray(gray, width, height, px + normalX * probeOffset, py + normalY * probeOffset);
      const outside = sampleGray(gray, width, height, px - normalX * probeOffset, py - normalY * probeOffset);
      const contrast = inside - outside;
      const score = edgeStrength + contrast * 1.15 - Math.abs(offset) * 0.35;
      if (contrast > 8 && score > bestScore) {
        bestScore = score;
        bestPoint = [px, py];
      }
    }
    if (bestPoint && bestScore >= minScore) {
      points.push(bestPoint);
    }
  }
  return points;
}

function refineCornerQuadWithImageEdges(colorData, info, corners, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad || !colorData || !info?.width || !info?.height) {
    return quad;
  }
  const grayPack = buildDownsampledGrayGradient(colorData, info, options.targetMax || 1200);
  const scalePoint = ([x, y]) => [x * grayPack.ratio, y * grayPack.ratio];
  const unscalePoint = ([x, y]) => [x / Math.max(grayPack.ratio, 1e-6), y / Math.max(grayPack.ratio, 1e-6)];
  const scaledQuad = quad.map(scalePoint);
  const centroid = [
    average(scaledQuad.map((point) => point[0])),
    average(scaledQuad.map((point) => point[1]))
  ];
  const edgeDefs = [
    [scaledQuad[0], scaledQuad[1]],
    [scaledQuad[1], scaledQuad[2]],
    [scaledQuad[3], scaledQuad[2]],
    [scaledQuad[0], scaledQuad[3]]
  ];
  const lines = [];

  for (const [start, end] of edgeDefs) {
    const edgeLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const points = collectGradientEdgePoints(start, end, centroid, grayPack, {
      samples: Math.max(42, Math.round(edgeLength / 10)),
      searchRadius: Math.max(8, Math.round(edgeLength * 0.035)),
      probeOffset: Math.max(2, Math.round(edgeLength * 0.006)),
      minScore: 14
    });
    if (points.length < 10) {
      return quad;
    }
    lines.push(fitLineRobust(points, 4));
  }

  const refined = [
    intersectLines(lines[0], lines[3]),
    intersectLines(lines[0], lines[1]),
    intersectLines(lines[1], lines[2]),
    intersectLines(lines[2], lines[3])
  ];
  if (refined.some((point) => !Array.isArray(point))) {
    return quad;
  }

  return normalizeCornerQuad(refined.map((point) => {
    const [x, y] = unscalePoint(point);
    return [
      clamp(x, 0, Math.max(0, info.width - 1)),
      clamp(y, 0, Math.max(0, info.height - 1))
    ];
  })) || quad;
}

function refineCornerQuadByRadialSearch(colorData, info, corners, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad || !colorData || !info?.width || !info?.height) {
    return quad;
  }
  const grayPack = buildDownsampledGrayGradient(colorData, info, options.targetMax || 1200);
  const scalePoint = ([x, y]) => [x * grayPack.ratio, y * grayPack.ratio];
  const unscalePoint = ([x, y]) => [x / Math.max(grayPack.ratio, 1e-6), y / Math.max(grayPack.ratio, 1e-6)];
  const scaledQuad = quad.map(scalePoint);
  const center = [
    average(scaledQuad.map((point) => point[0])),
    average(scaledQuad.map((point) => point[1]))
  ];
  const {
    searchRadius = 18,
    lateralRadius = 8,
    probeOffset = 4,
    minScore = 22,
    minContrast = 14,
    blend = 0.58,
    maxShift = 28
  } = options;
  const refined = scaledQuad.map((corner) => {
    const rayX = corner[0] - center[0];
    const rayY = corner[1] - center[1];
    const rayLength = Math.hypot(rayX, rayY);
    if (!Number.isFinite(rayLength) || rayLength <= 1e-6) {
      return corner;
    }
    const outwardX = rayX / rayLength;
    const outwardY = rayY / rayLength;
    const tangentX = -outwardY;
    const tangentY = outwardX;
    let bestPoint = corner;
    let bestScore = -Infinity;

    for (let step = 0; step <= searchRadius; step += 1) {
      for (let lateral = -lateralRadius; lateral <= lateralRadius; lateral += 1) {
        const px = corner[0] + outwardX * step + tangentX * lateral;
        const py = corner[1] + outwardY * step + tangentY * lateral;
        if (px < 1 || px >= grayPack.width - 1 || py < 1 || py >= grayPack.height - 1) {
          continue;
        }
        const edgeStrength = sampleGradient(grayPack.gradient, grayPack.width, grayPack.height, px, py);
        const insideGray = sampleGray(grayPack.gray, grayPack.width, grayPack.height, px - outwardX * probeOffset, py - outwardY * probeOffset);
        const outsideGray = sampleGray(grayPack.gray, grayPack.width, grayPack.height, px + outwardX * probeOffset, py + outwardY * probeOffset);
        const lineGray = sampleGray(grayPack.gray, grayPack.width, grayPack.height, px, py);
        const contrast = insideGray - outsideGray;
        const darkness = Math.max(0, 255 - lineGray);
        const score = edgeStrength * 0.72 + contrast * 1.1 + darkness * 0.18 + step * 0.45 - Math.abs(lateral) * 0.35;
        if (contrast >= minContrast && score > bestScore && score >= minScore) {
          bestScore = score;
          bestPoint = [px, py];
        }
      }
    }

    const [targetX, targetY] = unscalePoint(bestPoint);
    const dx = targetX - (corner[0] / Math.max(grayPack.ratio, 1e-6));
    const dy = targetY - (corner[1] / Math.max(grayPack.ratio, 1e-6));
    const distance = Math.hypot(dx, dy);
    const limitedScale = distance > maxShift ? (maxShift / Math.max(distance, 1e-6)) : 1;
    return [
      clamp((corner[0] / Math.max(grayPack.ratio, 1e-6)) + dx * blend * limitedScale, 0, Math.max(0, info.width - 1)),
      clamp((corner[1] / Math.max(grayPack.ratio, 1e-6)) + dy * blend * limitedScale, 0, Math.max(0, info.height - 1))
    ];
  });

  return normalizeCornerQuad(refined) || quad;
}

function evaluateDominantEdgeQuadGuard(options = {}) {
  const {
    edgeQuad = null,
    normalizedRefined = null,
    cellWidth = 0,
    cellHeight = 0,
    projectedTopLeftAnchor = null,
    projectedTopRightAnchor = null,
    projectedBottomLeftAnchor = null,
    projectedBottomRightAnchor = null
  } = options;
  const refinedQuad = normalizeCornerQuad(normalizedRefined);
  const dominantQuad = normalizeCornerQuad(edgeQuad);
  const localTopBandY = medianCoordinate(refinedQuad ? [refinedQuad[0], refinedQuad[1]] : [], 1);
  const localBottomBandY = medianCoordinate(refinedQuad ? [refinedQuad[2], refinedQuad[3]] : [], 1);
  const projectedTopAnchorY = medianCoordinate([projectedTopLeftAnchor, projectedTopRightAnchor], 1);
  const projectedBottomAnchorY = medianCoordinate([projectedBottomLeftAnchor, projectedBottomRightAnchor], 1);
  const dominantTopLiftTolerance = Math.max(18, Math.round(Number(cellHeight || 0) * 0.22));
  const dominantBottomDropTolerance = Math.max(18, Math.round(Number(cellHeight || 0) * 0.22));
  const dominantSideTolerance = Math.max(16, Math.round(Number(cellWidth || 0) * 0.2));
  const rejectProjectedTopAnchors = (
    Number.isFinite(projectedTopAnchorY)
    && Number.isFinite(localTopBandY)
    && projectedTopAnchorY < localTopBandY - dominantTopLiftTolerance
  );
  const rejectProjectedBottomAnchors = (
    Number.isFinite(projectedBottomAnchorY)
    && Number.isFinite(localBottomBandY)
    && projectedBottomAnchorY > localBottomBandY + dominantBottomDropTolerance
  );
  const dominantTopOvershoot = dominantQuad && refinedQuad
    ? Math.max(
        Number(refinedQuad[0][1]) - Number(dominantQuad[0][1]),
        Number(refinedQuad[1][1]) - Number(dominantQuad[1][1])
      )
    : 0;
  const dominantBottomOvershoot = dominantQuad && refinedQuad
    ? Math.max(
        Number(dominantQuad[2][1]) - Number(refinedQuad[2][1]),
        Number(dominantQuad[3][1]) - Number(refinedQuad[3][1])
      )
    : 0;
  const dominantLeftOvershoot = dominantQuad && refinedQuad
    ? Math.max(
        Number(refinedQuad[0][0]) - Number(dominantQuad[0][0]),
        Number(refinedQuad[3][0]) - Number(dominantQuad[3][0])
      )
    : 0;
  const dominantRightOvershoot = dominantQuad && refinedQuad
    ? Math.max(
        Number(dominantQuad[1][0]) - Number(refinedQuad[1][0]),
        Number(dominantQuad[2][0]) - Number(refinedQuad[2][0])
      )
    : 0;
  return {
    localTopBandY,
    localBottomBandY,
    rejectProjectedTopAnchors,
    rejectProjectedBottomAnchors,
    dominantTopLiftTolerance,
    dominantBottomDropTolerance,
    dominantSideTolerance,
    dominantTopOvershoot,
    dominantBottomOvershoot,
    dominantLeftOvershoot,
    dominantRightOvershoot,
    dominantTopWithinLocalTolerance: !dominantQuad || dominantTopOvershoot <= dominantTopLiftTolerance,
    dominantBottomWithinLocalTolerance: !dominantQuad || dominantBottomOvershoot <= dominantBottomDropTolerance,
    dominantSidesWithinLocalTolerance: (
      !dominantQuad
      || (
        dominantLeftOvershoot <= dominantSideTolerance
        && dominantRightOvershoot <= dominantSideTolerance
      )
    )
  };
}

function mergeCornerQuads(baseQuad, refinedQuad, options = {}) {
  const base = normalizeCornerQuad(baseQuad);
  const refined = normalizeCornerQuad(refinedQuad);
  if (!base || !refined) {
    return refined || base || null;
  }
  const blend = Number.isFinite(options.blend) ? options.blend : 0.62;
  const maxShift = Number.isFinite(options.maxShift) ? options.maxShift : 54;
  const merged = base.map(([bx, by], index) => {
    const [rx, ry] = refined[index];
    const dx = rx - bx;
    const dy = ry - by;
    const distance = Math.hypot(dx, dy);
    const limitedScale = distance > maxShift ? (maxShift / Math.max(distance, 1e-6)) : 1;
    return [
      bx + dx * blend * limitedScale,
      by + dy * blend * limitedScale
    ];
  });
  return normalizeCornerQuad(merged) || base;
}

function stabilizeQuadGeometry(corners, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  const blend = Number.isFinite(options.blend) ? options.blend : 0.22;
  const [lt, rt, rb, lb] = quad.map(([x, y]) => [Number(x), Number(y)]);

  const topDx = rt[0] - lt[0];
  const topDy = rt[1] - lt[1];
  const bottomDx = rb[0] - lb[0];
  const bottomDy = rb[1] - lb[1];
  const leftDx = lb[0] - lt[0];
  const leftDy = lb[1] - lt[1];
  const rightDx = rb[0] - rt[0];
  const rightDy = rb[1] - rt[1];

  const topSlope = topDy / Math.max(Math.abs(topDx), 1e-6);
  const bottomSlope = bottomDy / Math.max(Math.abs(bottomDx), 1e-6);
  const leftSlope = leftDx / Math.max(Math.abs(leftDy), 1e-6);
  const rightSlope = rightDx / Math.max(Math.abs(rightDy), 1e-6);

  const targetHorizontalSlope = average([topSlope, bottomSlope]);
  const targetVerticalSlope = average([leftSlope, rightSlope]);
  const avgWidth = average([Math.abs(topDx), Math.abs(bottomDx)]);
  const avgHeight = average([Math.abs(leftDy), Math.abs(rightDy)]);

  const targetTopDy = targetHorizontalSlope * Math.max(avgWidth, 1);
  const targetBottomDy = targetHorizontalSlope * Math.max(avgWidth, 1);
  const targetLeftDx = targetVerticalSlope * Math.max(avgHeight, 1);
  const targetRightDx = targetVerticalSlope * Math.max(avgHeight, 1);

  const corrected = [
    [lt[0], lt[1] + (targetTopDy - topDy) * blend * 0.5],
    [rt[0], rt[1] - (targetTopDy - topDy) * blend * 0.5],
    [rb[0] - (targetRightDx - rightDx) * blend * 0.5, rb[1] - (targetBottomDy - bottomDy) * blend * 0.5],
    [lb[0] + (targetLeftDx - leftDx) * blend * 0.5, lb[1] + (targetBottomDy - bottomDy) * blend * 0.5]
  ];

  return normalizeCornerQuad(corrected) || quad;
}

function evaluateRectangularQuadQuality(corners, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  const [lt, rt, rb, lb] = quad.map(([x, y]) => [Number(x), Number(y)]);
  const topVector = [rt[0] - lt[0], rt[1] - lt[1]];
  const rightVector = [rb[0] - rt[0], rb[1] - rt[1]];
  const bottomVector = [rb[0] - lb[0], rb[1] - lb[1]];
  const leftVector = [lb[0] - lt[0], lb[1] - lt[1]];
  const vectors = [
    topVector,
    rightVector,
    [-bottomVector[0], -bottomVector[1]],
    [-leftVector[0], -leftVector[1]]
  ];
  const lengths = [
    Math.hypot(topVector[0], topVector[1]),
    Math.hypot(rightVector[0], rightVector[1]),
    Math.hypot(bottomVector[0], bottomVector[1]),
    Math.hypot(leftVector[0], leftVector[1])
  ];
  if (lengths.some((value) => !Number.isFinite(value) || value < 1e-6)) {
    return null;
  }
  const area = Math.abs(
    quad.reduce((sum, point, index) => {
      const next = quad[(index + 1) % quad.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2
  );
  const guideWidth = Number(options.guides?.right) - Number(options.guides?.left);
  const guideHeight = Number(options.guides?.bottom) - Number(options.guides?.top);
  const diagonalA = Math.hypot(rb[0] - lt[0], rb[1] - lt[1]);
  const diagonalB = Math.hypot(lb[0] - rt[0], lb[1] - rt[1]);
  const topLength = lengths[0];
  const rightLength = lengths[1];
  const bottomLength = lengths[2];
  const leftLength = lengths[3];
  const unitVectors = vectors.map(([dx, dy], index) => [dx / lengths[index], dy / lengths[index]]);
  const parallelDotTopBottom = Math.abs(unitVectors[0][0] * unitVectors[2][0] + unitVectors[0][1] * unitVectors[2][1]);
  const parallelDotLeftRight = Math.abs(unitVectors[1][0] * unitVectors[3][0] + unitVectors[1][1] * unitVectors[3][1]);
  const rightAngles = [
    Math.abs(unitVectors[0][0] * unitVectors[1][0] + unitVectors[0][1] * unitVectors[1][1]),
    Math.abs(unitVectors[1][0] * unitVectors[2][0] + unitVectors[1][1] * unitVectors[2][1]),
    Math.abs(unitVectors[2][0] * unitVectors[3][0] + unitVectors[2][1] * unitVectors[3][1]),
    Math.abs(unitVectors[3][0] * unitVectors[0][0] + unitVectors[3][1] * unitVectors[0][1])
  ];
  const oppositeWidthRatio = Math.min(topLength, bottomLength) / Math.max(topLength, bottomLength, 1e-6);
  const oppositeHeightRatio = Math.min(leftLength, rightLength) / Math.max(leftLength, rightLength, 1e-6);
  const diagonalRatio = Math.min(diagonalA, diagonalB) / Math.max(diagonalA, diagonalB, 1e-6);
  const midpointA = [(lt[0] + rb[0]) / 2, (lt[1] + rb[1]) / 2];
  const midpointB = [(rt[0] + lb[0]) / 2, (rt[1] + lb[1]) / 2];
  const midpointGap = Math.hypot(midpointA[0] - midpointB[0], midpointA[1] - midpointB[1]);
  const referenceSize = Math.max(1, average([topLength, bottomLength, leftLength, rightLength]));
  const midpointScore = clamp01(1 - midpointGap / Math.max(8, referenceSize * 0.025));
  const guideWidthRatio = Number.isFinite(guideWidth) && guideWidth > 1
    ? Math.min(topLength, bottomLength) / Math.max(Math.max(topLength, bottomLength), guideWidth)
    : null;
  const guideHeightRatio = Number.isFinite(guideHeight) && guideHeight > 1
    ? Math.min(leftLength, rightLength) / Math.max(Math.max(leftLength, rightLength), guideHeight)
    : null;
  const guideSpanScore = average(
    [guideWidthRatio, guideHeightRatio].filter((value) => Number.isFinite(value)).map((value) => clamp01(value))
  );
  const rightAngleScore = 1 - average(rightAngles);
  const centroid = [
    average(quad.map((point) => point[0])),
    average(quad.map((point) => point[1]))
  ];
  const horizontalDirection = [
    topVector[0] / Math.max(topLength, 1e-6) + bottomVector[0] / Math.max(bottomLength, 1e-6),
    topVector[1] / Math.max(topLength, 1e-6) + bottomVector[1] / Math.max(bottomLength, 1e-6)
  ];
  const rotationAngle = Math.atan2(horizontalDirection[1], horizontalDirection[0]);
  const cosTheta = Math.cos(-rotationAngle);
  const sinTheta = Math.sin(-rotationAngle);
  const rotated = quad.map(([x, y]) => {
    const dx = x - centroid[0];
    const dy = y - centroid[1];
    return [
      dx * cosTheta - dy * sinTheta,
      dx * sinTheta + dy * cosTheta
    ];
  });
  const rotatedLeftX = average([rotated[0][0], rotated[3][0]]);
  const rotatedRightX = average([rotated[1][0], rotated[2][0]]);
  const rotatedTopY = average([rotated[0][1], rotated[1][1]]);
  const rotatedBottomY = average([rotated[2][1], rotated[3][1]]);
  const fittedRectangle = [
    [rotatedLeftX, rotatedTopY],
    [rotatedRightX, rotatedTopY],
    [rotatedRightX, rotatedBottomY],
    [rotatedLeftX, rotatedBottomY]
  ];
  const rotatedResiduals = rotated.map((point, index) => Math.hypot(
    point[0] - fittedRectangle[index][0],
    point[1] - fittedRectangle[index][1]
  ));
  const rotatedMeanResidual = average(rotatedResiduals);
  const rotatedMaxResidual = Math.max(...rotatedResiduals);
  const rotatedWidth = Math.abs(rotatedRightX - rotatedLeftX);
  const rotatedHeight = Math.abs(rotatedBottomY - rotatedTopY);
  const rotatedReferenceSize = Math.max(1, average([rotatedWidth, rotatedHeight]));
  const rotatedRectangleScore = clamp01(
    1 - rotatedMeanResidual / Math.max(6, rotatedReferenceSize * 0.035)
  );
  const rotatedRectangleTightScore = clamp01(
    1 - rotatedMaxResidual / Math.max(8, rotatedReferenceSize * 0.05)
  );
  const score = clamp01(
    rotatedRectangleScore * 0.42
    + rotatedRectangleTightScore * 0.18
    + parallelDotTopBottom * 0.12
    + parallelDotLeftRight * 0.12
    + rightAngleScore * 0.08
    + oppositeWidthRatio * 0.03
    + oppositeHeightRatio * 0.03
    + diagonalRatio * 0.01
    + midpointScore * 0.01
  );
  return {
    score,
    area,
    topLength,
    rightLength,
    bottomLength,
    leftLength,
    guideSpanScore: Number.isFinite(guideSpanScore) ? guideSpanScore : null,
    parallelDotTopBottom,
    parallelDotLeftRight,
    rightAngleScore,
    oppositeWidthRatio,
    oppositeHeightRatio,
    diagonalRatio,
    midpointGap,
    rotationAngle,
    rotatedRectangleScore,
    rotatedRectangleTightScore,
    rotatedMeanResidual,
    rotatedMaxResidual,
    rotatedWidth,
    rotatedHeight
  };
}

function estimateUniformGridSpan(quad, guides = null) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized) {
    return null;
  }
  const [lt, rt, rb, lb] = normalized;
  const topWidth = Math.hypot(rt[0] - lt[0], rt[1] - lt[1]);
  const bottomWidth = Math.hypot(rb[0] - lb[0], rb[1] - lb[1]);
  const leftHeight = Math.hypot(lb[0] - lt[0], lb[1] - lt[1]);
  const rightHeight = Math.hypot(rb[0] - rt[0], rb[1] - rt[1]);
  const guideWidth = Number(guides?.right) - Number(guides?.left);
  const guideHeight = Number(guides?.bottom) - Number(guides?.top);
  const estimatedWidth = average(
    [topWidth, bottomWidth, guideWidth].filter((value) => Number.isFinite(value) && value > 0)
  );
  const estimatedHeight = average(
    [leftHeight, rightHeight, guideHeight].filter((value) => Number.isFinite(value) && value > 0)
  );
  return {
    topWidth,
    bottomWidth,
    leftHeight,
    rightHeight,
    estimatedWidth,
    estimatedHeight
  };
}

function shiftLineToPoints(line, points) {
  if (!line || !Array.isArray(points) || !points.length) {
    return line;
  }
  const c = -average(points.map((point) => line.a * point[0] + line.b * point[1]));
  return { a: line.a, b: line.b, c };
}

function extractExtremeSupportPoints(line, points, scoreAtPoint, edge, options = {}) {
  if (!line || !Array.isArray(points) || !points.length) {
    return [];
  }
  const residual = computeLineFitResidual(line, points);
  const distanceTolerance = Math.max(8, residual * 1.85);
  const scores = points.map((point) => scoreAtPoint(point));
  const averageScore = average(scores);
  const scoreThreshold = Math.max(28, averageScore * 0.3);
  const supported = points.filter((point, index) => (
    linePointDistance(line, point) <= distanceTolerance
    && scores[index] >= scoreThreshold
  ));
  if (!supported.length) {
    return [];
  }
  const axis = edge === 'top' || edge === 'bottom' ? 1 : 0;
  const ordered = [...supported].sort((a, b) => a[axis] - b[axis]);
  const sliceSize = Math.max(12, Math.round(ordered.length * (options.ratio || 0.22)));
  if (edge === 'top' || edge === 'left') {
    return ordered.slice(0, sliceSize);
  }
  return ordered.slice(Math.max(0, ordered.length - sliceSize));
}

function splitSupportPointsByAxis(points, axis = 0) {
  if (!Array.isArray(points) || points.length < 2) {
    return { first: points || [], second: [] };
  }
  const ordered = [...points].sort((a, b) => a[axis] - b[axis]);
  const half = Math.max(1, Math.floor(ordered.length / 2));
  return {
    first: ordered.slice(0, half),
    second: ordered.slice(half)
  };
}

function buildLineFromEndAnchors(leftPoint, rightPoint, fallbackLine = null) {
  if (!Array.isArray(leftPoint) || !Array.isArray(rightPoint)) {
    return fallbackLine;
  }
  const dx = rightPoint[0] - leftPoint[0];
  const dy = rightPoint[1] - leftPoint[1];
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-6) {
    return fallbackLine;
  }
  const normalX = -dy / length;
  const normalY = dx / length;
  const c = -(normalX * leftPoint[0] + normalY * leftPoint[1]);
  return { a: normalX, b: normalY, c };
}

function extractEdgeEndAnchor(points, edge, axis = 0, ratio = 0.18) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }
  const ordered = [...points].sort((a, b) => a[axis] - b[axis]);
  const sliceSize = Math.max(8, Math.round(ordered.length * ratio));
  const selected = (edge === 'top' || edge === 'left')
    ? ordered.slice(0, sliceSize)
    : ordered.slice(Math.max(0, ordered.length - sliceSize));
  if (!selected.length) {
    return null;
  }
  return [
    average(selected.map((point) => point[0])),
    average(selected.map((point) => point[1]))
  ];
}

function blendLines(lineA, lineB, blend = 0.5) {
  if (!lineA) return lineB || null;
  if (!lineB) return lineA || null;
  const weightA = 1 - blend;
  const weightB = blend;
  const a = lineA.a * weightA + lineB.a * weightB;
  const b = lineA.b * weightA + lineB.b * weightB;
  const norm = Math.hypot(a, b);
  if (!Number.isFinite(norm) || norm <= 1e-6) {
    return lineA;
  }
  return {
    a: a / norm,
    b: b / norm,
    c: (lineA.c * weightA + lineB.c * weightB) / norm
  };
}

function solveLineXAtY(line, y) {
  if (!line || Math.abs(line.a) <= 1e-6) {
    return null;
  }
  const x = (-line.b * y - line.c) / line.a;
  return Number.isFinite(x) ? x : null;
}

function probeVerticalLineEndpoint(line, gray, width, height, options = {}) {
  const {
    startY,
    endY,
    inwardDir,
    direction = 'top',
    step = 2
  } = options;
  if (!line) {
    return null;
  }
  const from = Math.round(startY);
  const to = Math.round(endY);
  const advance = direction === 'top' ? -Math.abs(step) : Math.abs(step);
  let y = from;
  let best = null;
  let missRun = 0;
  while ((advance < 0 && y >= to) || (advance > 0 && y <= to)) {
    const x = solveLineXAtY(line, y);
    if (x === null || x < 1 || x >= width - 1 || y < 1 || y >= height - 1) {
      y += advance;
      continue;
    }
    const score = scoreOuterVerticalBoundaryAt(
      gray,
      width,
      height,
      x,
      y - 10,
      y + 10,
      inwardDir
    );
    if (score >= 54) {
      best = [x, y];
      missRun = 0;
    } else {
      missRun += 1;
      if (best && missRun >= 5) {
        break;
      }
    }
    y += advance;
  }
  return best;
}

function refineOuterRightAnchorX(gray, width, height, expectedX, anchorY, options = {}) {
  const {
    searchLeft = 18,
    searchRight = 18,
    spanY = 10,
    minScore = 52,
    keepRatio = 0.88
  } = options;
  if (!Number.isFinite(expectedX) || !Number.isFinite(anchorY)) {
    return null;
  }
  const y0 = clamp(Math.round(anchorY - spanY), 0, Math.max(0, height - 1));
  const y1 = clamp(Math.round(anchorY + spanY), y0, Math.max(0, height - 1));
  const xStart = clamp(Math.round(expectedX - searchLeft), 0, Math.max(0, width - 1));
  const xEnd = clamp(Math.round(expectedX + searchRight), xStart, Math.max(0, width - 1));
  let bestScore = -Infinity;
  const candidates = [];
  for (let x = xStart; x <= xEnd; x += 1) {
    const score = scoreOuterVerticalBoundaryAt(gray, width, height, x, y0, y1, -1);
    if (!Number.isFinite(score)) {
      continue;
    }
    candidates.push({ x, score });
    if (score > bestScore) {
      bestScore = score;
    }
  }
  if (!Number.isFinite(bestScore)) {
    return null;
  }
  const threshold = Math.max(minScore, bestScore * keepRatio);
  const usable = candidates.filter((item) => item.score >= threshold);
  if (!usable.length) {
    return null;
  }
  usable.sort((a, b) => b.x - a.x || b.score - a.score);
  return [usable[0].x, anchorY];
}

function movePointToward(target, source, blend = 0.5) {
  if (!Array.isArray(target) || !Array.isArray(source)) {
    return target || source || null;
  }
  return [
    target[0] * (1 - blend) + source[0] * blend,
    target[1] * (1 - blend) + source[1] * blend
  ];
}

function refineCornerQuadFromBoundary(mask, width, height, initialCorners) {
  const quad = normalizeCornerQuad(initialCorners);
  if (!quad) {
    return null;
  }
  const boundaryPoints = collectMaskBoundaryPoints(mask, width, height);
  if (boundaryPoints.length < 40) {
    return quad;
  }

  const edgeDefs = [
    { start: quad[0], end: quad[1] },
    { start: quad[1], end: quad[2] },
    { start: quad[3], end: quad[2] },
    { start: quad[0], end: quad[3] }
  ];

  const lines = [];
  for (const edge of edgeDefs) {
    const edgeLength = Math.max(1, Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1]));
    let selected = boundaryPoints.filter((point) => pointSegmentDistance(point, edge.start, edge.end) <= Math.max(3.5, edgeLength * 0.02));
    if (selected.length < 18) {
      selected = boundaryPoints.filter((point) => pointSegmentDistance(point, edge.start, edge.end) <= Math.max(6, edgeLength * 0.035));
    }
    if (selected.length < 12) {
      return quad;
    }
    lines.push(fitLineRobust(selected));
  }

  const refined = [
    intersectLines(lines[0], lines[3]),
    intersectLines(lines[0], lines[1]),
    intersectLines(lines[1], lines[2]),
    intersectLines(lines[2], lines[3])
  ];
  if (refined.some((point) => !Array.isArray(point))) {
    return quad;
  }

  const coarseQuad = normalizeCornerQuad(refined);
  const localRefined = refineCornerIntersections(boundaryPoints, coarseQuad, lines);
  const finalQuad = normalizeCornerQuad(localRefined.corners || coarseQuad) || coarseQuad;

  return normalizeCornerQuad(finalQuad.map(([x, y]) => [
    clamp(x, 0, Math.max(0, width - 1)),
    clamp(y, 0, Math.max(0, height - 1))
  ]));
}

function estimateCornerQuadFromMask(mask, width, height, options = {}) {
  const bounds = computeMaskBounds(mask, width, height);
  if (!bounds) {
    return null;
  }
  const {
    recursiveMinSize = 12,
    recursiveMaxDepth = 10,
    recursiveBlend = 0.28,
    recursiveMaxShift = 96,
    boundaryBlend = 0.16,
    boundaryMaxShift = 42,
    stabilizeBlend = 0.18
  } = options;

  const fallbackQuad = estimateCornerQuadByExtremes(mask, width, height);
  const recursiveQuad = normalizeCornerQuad([
    detectCornerByRecursive3x3(mask, width, height, bounds, 'topLeft', { minSize: recursiveMinSize, maxDepth: recursiveMaxDepth }) || fallbackQuad?.[0] || null,
    detectCornerByRecursive3x3(mask, width, height, bounds, 'topRight', { minSize: recursiveMinSize, maxDepth: recursiveMaxDepth }) || fallbackQuad?.[1] || null,
    detectCornerByRecursive3x3(mask, width, height, bounds, 'bottomRight', { minSize: recursiveMinSize, maxDepth: recursiveMaxDepth }) || fallbackQuad?.[2] || null,
    detectCornerByRecursive3x3(mask, width, height, bounds, 'bottomLeft', { minSize: recursiveMinSize, maxDepth: recursiveMaxDepth }) || fallbackQuad?.[3] || null
  ]);
  if (!recursiveQuad) {
    return fallbackQuad;
  }

  const cornerDrivenQuad = mergeCornerQuads(fallbackQuad, recursiveQuad, {
    blend: recursiveBlend,
    maxShift: recursiveMaxShift
  }) || fallbackQuad || recursiveQuad;
  const boundaryRefinedQuad = refineCornerQuadFromBoundary(mask, width, height, cornerDrivenQuad) || cornerDrivenQuad;
  const dominantBoundaryQuad = refineQuadByDominantBoundaryLines(
    collectMaskBoundaryPoints(mask, width, height),
    boundaryRefinedQuad
  ) || boundaryRefinedQuad;
  const mergedBoundaryQuad = mergeCornerQuads(boundaryRefinedQuad, dominantBoundaryQuad, {
    blend: Math.min(0.22, Math.max(0.08, boundaryBlend)),
    maxShift: Math.min(28, Math.max(12, boundaryMaxShift))
  }) || boundaryRefinedQuad;
  const mergedQuad = mergeCornerQuads(cornerDrivenQuad, mergedBoundaryQuad, {
    blend: boundaryBlend,
    maxShift: boundaryMaxShift
  }) || cornerDrivenQuad;
  if (stabilizeBlend <= 0) {
    return mergedQuad;
  }
  return stabilizeQuadGeometry(mergedQuad, { blend: stabilizeBlend }) || mergedQuad;
}

async function runPaperQuadRectify(inputPath, corners, outputPath, metaPath = null) {
  if (!inputPath || !outputPath || !Array.isArray(corners) || corners.length !== 4) {
    return null;
  }
  const scriptPath = path.join(__dirname, 'paper_quad_rectify.py');
  const args = [
    scriptPath,
    '--image', inputPath,
    '--corners-json', JSON.stringify(corners),
    '--output', outputPath
  ];
  if (metaPath) {
    args.push('--meta-output', metaPath);
  }
  const { stdout } = await execFileAsync('python3', args, {
    cwd: __dirname,
    maxBuffer: 10 * 1024 * 1024
  });
  if (metaPath) {
    return JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
  }
  return JSON.parse((stdout || '').trim() || '{}');
}

function analyzeRectifiedOuterFrameCrop(rgbData, info) {
  const width = info.width || 0;
  const height = info.height || 0;
  if (width < 120 || height < 120) {
    return null;
  }
  const gray = computeGray(rgbData, info.channels);
  const darkMask = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    darkMask[i] = gray[i] < 156 ? 1 : 0;
  }
  const spanX0 = clamp(Math.round(width * 0.12), 0, Math.max(0, width - 1));
  const spanX1 = clamp(Math.round(width * 0.88), spanX0 + 1, Math.max(1, width - 1));
  const spanY0 = clamp(Math.round(height * 0.12), 0, Math.max(0, height - 1));
  const spanY1 = clamp(Math.round(height * 0.88), spanY0 + 1, Math.max(1, height - 1));
  const topSearch = Math.max(14, Math.round(height * 0.16));
  const bottomSearch = Math.max(14, Math.round(height * 0.16));
  const sideSearch = Math.max(14, Math.round(width * 0.16));
  const refinedTopLine = findStrongDirectionalLine(
    0,
    Math.min(height - 1, topSearch),
    (y) => scoreHorizontalLineAt(gray, width, height, y, spanX0, spanX1)
  );
  const refinedBottomLine = findStrongDirectionalLine(
    Math.max(0, height - 1 - bottomSearch),
    height - 1,
    (y) => scoreHorizontalLineAt(gray, width, height, y, spanX0, spanX1)
  );
  const refinedLeftLine = findStrongDirectionalLine(
    0,
    Math.min(width - 1, sideSearch),
    (x) => scoreVerticalLineAt(gray, width, height, x, spanY0, spanY1)
  );
  const refinedRightLine = findStrongDirectionalLine(
    Math.max(0, width - 1 - sideSearch),
    width - 1,
    (x) => scoreVerticalLineAt(gray, width, height, x, spanY0, spanY1)
  );
  if (!refinedTopLine || !refinedBottomLine || !refinedLeftLine || !refinedRightLine) {
    return null;
  }

  const pickImmediateInnerLine = (from, to, scoreAt, options = {}) => {
    const nearest = findNearestDirectionalPeak(from, to, scoreAt, options);
    if (nearest) {
      return nearest;
    }
    return findStrongDirectionalLine(from, to, scoreAt);
  };
  const estimatedCellGapX = Math.max(28, Math.round(width / 16));
  const estimatedCellGapY = Math.max(28, Math.round(height / 20));
  const innerFrameSearchSpanX = Math.max(18, Math.round(width * 0.12));
  const innerFrameSearchSpanY = Math.max(18, Math.round(height * 0.12));
  const nearInnerTop = pickImmediateInnerLine(
    Math.min(height - 1, refinedTopLine.index + 3),
    Math.min(height - 1, refinedTopLine.index + innerFrameSearchSpanY),
    (y) => scoreHorizontalLineAt(gray, width, height, y, spanX0, spanX1),
    { direction: 'forward', minScore: 16, relativeFloor: Math.max(14, refinedTopLine.score * 0.52) }
  );
  const nearInnerBottom = pickImmediateInnerLine(
    Math.max(0, refinedBottomLine.index - innerFrameSearchSpanY),
    Math.max(0, refinedBottomLine.index - 3),
    (y) => scoreHorizontalLineAt(gray, width, height, y, spanX0, spanX1),
    { direction: 'backward', minScore: 16, relativeFloor: Math.max(14, refinedBottomLine.score * 0.52) }
  );
  const nearInnerLeft = pickImmediateInnerLine(
    Math.min(width - 1, refinedLeftLine.index + 3),
    Math.min(width - 1, refinedLeftLine.index + innerFrameSearchSpanX),
    (x) => scoreVerticalLineAt(gray, width, height, x, spanY0, spanY1),
    { direction: 'forward', minScore: 16, relativeFloor: Math.max(14, refinedLeftLine.score * 0.52) }
  );
  const nearInnerRight = pickImmediateInnerLine(
    Math.max(0, refinedRightLine.index - innerFrameSearchSpanX),
    Math.max(0, refinedRightLine.index - 3),
    (x) => scoreVerticalLineAt(gray, width, height, x, spanY0, spanY1),
    { direction: 'backward', minScore: 16, relativeFloor: Math.max(14, refinedRightLine.score * 0.52) }
  );
  if (!nearInnerTop || !nearInnerBottom || !nearInnerLeft || !nearInnerRight) {
    return null;
  }
  const quarterGapX = Math.max(8, Math.round(estimatedCellGapX / 4));
  const quarterGapY = Math.max(8, Math.round(estimatedCellGapY / 4));
  const buildRemovableSide = (outerLine, innerLine, quarterGapLimit, maxSpan) => {
    const distance = Math.abs(innerLine.index - outerLine.index);
    return {
      removable: distance >= 4 && distance <= Math.max(12, maxSpan) && distance <= Math.max(14, quarterGapLimit * 3),
      distance,
      outerScore: Number(outerLine.score.toFixed(3)),
      innerScore: Number(innerLine.score.toFixed(3))
    };
  };
  const removableSides = {
    top: buildRemovableSide(refinedTopLine, nearInnerTop, quarterGapY, innerFrameSearchSpanY),
    bottom: buildRemovableSide(refinedBottomLine, nearInnerBottom, quarterGapY, innerFrameSearchSpanY),
    left: buildRemovableSide(refinedLeftLine, nearInnerLeft, quarterGapX, innerFrameSearchSpanX),
    right: buildRemovableSide(refinedRightLine, nearInnerRight, quarterGapX, innerFrameSearchSpanX)
  };
  if (!removableSides.top.removable || !removableSides.bottom.removable || !removableSides.left.removable || !removableSides.right.removable) {
    return null;
  }
  const cropPad = 1;
  const cropLeft = clamp(nearInnerLeft.index - cropPad, 0, width - 1);
  const cropRight = clamp(nearInnerRight.index + cropPad, cropLeft + 1, width - 1);
  const cropTop = clamp(nearInnerTop.index - cropPad, 0, height - 1);
  const cropBottom = clamp(nearInnerBottom.index + cropPad, cropTop + 1, height - 1);
  return {
    cropBox: {
      left: cropLeft,
      top: cropTop,
      right: cropRight,
      bottom: cropBottom,
      width: cropRight - cropLeft + 1,
      height: cropBottom - cropTop + 1
    },
    outerFrame: {
      top: refinedTopLine.index,
      bottom: refinedBottomLine.index,
      left: refinedLeftLine.index,
      right: refinedRightLine.index
    },
    immediateInnerFrame: {
      top: nearInnerTop.index,
      bottom: nearInnerBottom.index,
      left: nearInnerLeft.index,
      right: nearInnerRight.index
    },
    removableSides
  };
}

function expandCornerQuadFromCentroid(corners, width, height, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  const {
    scale = 1.035,
    padX = 18,
    padY = 18
  } = options;
  const centerX = average(quad.map((point) => Number(point[0])));
  const centerY = average(quad.map((point) => Number(point[1])));
  const expanded = quad.map(([x, y]) => {
    const dx = Number(x) - centerX;
    const dy = Number(y) - centerY;
    const outX = dx >= 0 ? padX : -padX;
    const outY = dy >= 0 ? padY : -padY;
    return [
      clamp(centerX + dx * scale + outX, 0, Math.max(0, width - 1)),
      clamp(centerY + dy * scale + outY, 0, Math.max(0, height - 1))
    ];
  });
  return normalizeCornerQuad(expanded);
}

function protectGridBoundsAfterOuterFrameCleanup(
  gridBoundaryDetection,
  imageSize,
  gridRows,
  gridCols,
  options = {}
) {
  if (!gridBoundaryDetection || gridBoundaryDetection.error) {
    return {
      gridBoundaryDetection,
      cleanupCoverageProtection: null
    };
  }
  const width = Number(imageSize?.width) || 0;
  const height = Number(imageSize?.height) || 0;
  if (width <= 0 || height <= 0) {
    return {
      gridBoundaryDetection,
      cleanupCoverageProtection: null
    };
  }

  const currentQuad = normalizeCornerQuad(
    gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null
  );
  if (!currentQuad) {
    return {
      gridBoundaryDetection,
      cleanupCoverageProtection: {
        applied: false,
        reason: 'missing-corners'
      }
    };
  }

  const bounds = getCornerEdgeBounds(currentQuad);
  if (!bounds) {
    return {
      gridBoundaryDetection,
      cleanupCoverageProtection: {
        applied: false,
        reason: 'missing-corner-bounds'
      }
    };
  }

  const minWidthCoverage = options.minWidthCoverage ?? 0.88;
  const minHeightCoverage = options.minHeightCoverage ?? 0.9;
  const maxSideGapRatioX = options.maxSideGapRatioX ?? 0.055;
  const maxSideGapRatioY = options.maxSideGapRatioY ?? 0.05;
  const nearFullPadX = clamp(
    Math.round(width * (options.nearFullPadRatioX ?? 0.008)),
    options.minPadX ?? 4,
    Math.max(options.minPadX ?? 4, Math.round(width * (options.maxPadRatioX ?? 0.018)))
  );
  const nearFullPadY = clamp(
    Math.round(height * (options.nearFullPadRatioY ?? 0.008)),
    options.minPadY ?? 4,
    Math.max(options.minPadY ?? 4, Math.round(height * (options.maxPadRatioY ?? 0.018)))
  );

  const leftGapRatio = bounds.left / Math.max(1, width);
  const rightGapRatio = (width - 1 - bounds.right) / Math.max(1, width);
  const topGapRatio = bounds.top / Math.max(1, height);
  const bottomGapRatio = (height - 1 - bounds.bottom) / Math.max(1, height);
  const widthCoverage = (bounds.right - bounds.left) / Math.max(1, width);
  const heightCoverage = (bounds.bottom - bounds.top) / Math.max(1, height);

  const underWidth = widthCoverage < minWidthCoverage;
  const underHeight = heightCoverage < minHeightCoverage;
  const overGapX = leftGapRatio > maxSideGapRatioX || rightGapRatio > maxSideGapRatioX;
  const overGapY = topGapRatio > maxSideGapRatioY || bottomGapRatio > maxSideGapRatioY;

  if (!underWidth && !underHeight && !overGapX && !overGapY) {
    return {
      gridBoundaryDetection,
      cleanupCoverageProtection: {
        applied: false,
        reason: 'coverage-already-sufficient',
        metrics: {
          widthCoverage: Number(widthCoverage.toFixed(4)),
          heightCoverage: Number(heightCoverage.toFixed(4)),
          leftGapRatio: Number(leftGapRatio.toFixed(4)),
          rightGapRatio: Number(rightGapRatio.toFixed(4)),
          topGapRatio: Number(topGapRatio.toFixed(4)),
          bottomGapRatio: Number(bottomGapRatio.toFixed(4))
        }
      }
    };
  }

  const targetLeft = clamp(
    Math.round(underWidth || leftGapRatio > maxSideGapRatioX ? nearFullPadX : bounds.left),
    0,
    Math.max(0, width - 2)
  );
  const targetRight = clamp(
    Math.round(underWidth || rightGapRatio > maxSideGapRatioX ? width - 1 - nearFullPadX : bounds.right),
    targetLeft + 1,
    Math.max(1, width - 1)
  );
  const targetTop = clamp(
    Math.round(underHeight || topGapRatio > maxSideGapRatioY ? nearFullPadY : bounds.top),
    0,
    Math.max(0, height - 2)
  );
  const targetBottom = clamp(
    Math.round(underHeight || bottomGapRatio > maxSideGapRatioY ? height - 1 - nearFullPadY : bounds.bottom),
    targetTop + 1,
    Math.max(1, height - 1)
  );

  const protectedQuad = normalizeCornerQuad([
    [targetLeft, targetTop],
    [targetRight, targetTop],
    [targetRight, targetBottom],
    [targetLeft, targetBottom]
  ]);
  const protectedGuides = buildGuidesFromCornerQuad(
    protectedQuad,
    gridBoundaryDetection.guides || gridBoundaryDetection.rawGuides || null,
    gridRows,
    gridCols
  );
  if (!protectedQuad || !protectedGuides) {
    return {
      gridBoundaryDetection,
      cleanupCoverageProtection: {
        applied: false,
        reason: 'protected-guides-build-failed'
      }
    };
  }

  return {
    gridBoundaryDetection: {
      ...gridBoundaryDetection,
      corners: protectedQuad,
      cornerAnchors: buildGridCornerAnchors(protectedQuad, protectedGuides),
      guides: {
        ...protectedGuides,
        xSource: `${gridBoundaryDetection.guides?.xSource || '外边界固定 + 内部均分'} + 去外框全幅保护`,
        ySource: `${gridBoundaryDetection.guides?.ySource || '外边界固定 + 内部均分'} + 去外框全幅保护`
      }
    },
    cleanupCoverageProtection: {
      applied: true,
      reason: 'outer-frame-cleanup-near-full-coverage',
      originalBounds: {
        left: Number(bounds.left.toFixed(3)),
        right: Number(bounds.right.toFixed(3)),
        top: Number(bounds.top.toFixed(3)),
        bottom: Number(bounds.bottom.toFixed(3))
      },
      protectedBounds: {
        left: targetLeft,
        right: targetRight,
        top: targetTop,
        bottom: targetBottom
      },
      metrics: {
        widthCoverage: Number(widthCoverage.toFixed(4)),
        heightCoverage: Number(heightCoverage.toFixed(4)),
        leftGapRatio: Number(leftGapRatio.toFixed(4)),
        rightGapRatio: Number(rightGapRatio.toFixed(4)),
        topGapRatio: Number(topGapRatio.toFixed(4)),
        bottomGapRatio: Number(bottomGapRatio.toFixed(4))
      }
    }
  };
}

function isRectStrongWhite(metrics, options = {}) {
  return (
    (
      metrics.whiteRatio >= (options.strongWhiteRatioThreshold ?? 0.62)
      && metrics.centerWhite
    )
    || (
      metrics.whiteRatio >= (options.softWhiteRatioThreshold ?? 0.42)
      && metrics.avgBrightness >= (options.softBrightnessThreshold ?? 132)
      && metrics.centerBrightness >= (options.softBrightnessThreshold ?? 132) - 8
    )
  );
}

function isRectMaybeWhite(metrics, options = {}) {
  return (
    metrics.whiteRatio >= (options.maybeWhiteRatioThreshold ?? 0.18)
    && metrics.avgBrightness >= (options.maybeBrightnessThreshold ?? 108)
    && metrics.centerBrightness >= (options.maybeBrightnessThreshold ?? 108) - 6
  );
}

function computeRectWhiteMetrics(whiteMask, brightnessMap, width, x0, y0, x1, y1) {
  let whiteCount = 0;
  let brightnessSum = 0;
  let pixelCount = 0;
  const centerX = clamp(Math.floor((x0 + x1 - 1) / 2), x0, Math.max(x0, x1 - 1));
  const centerY = clamp(Math.floor((y0 + y1 - 1) / 2), y0, Math.max(y0, y1 - 1));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = y * width + x;
      whiteCount += whiteMask[index] ? 1 : 0;
      brightnessSum += brightnessMap[index];
      pixelCount += 1;
    }
  }
  return {
    whiteRatio: pixelCount > 0 ? whiteCount / pixelCount : 0,
    avgBrightness: pixelCount > 0 ? brightnessSum / pixelCount : 0,
    centerWhite: Boolean(whiteMask[centerY * width + centerX]),
    centerBrightness: brightnessMap[centerY * width + centerX],
    pixelCount
  };
}

function fillRectMask(mask, width, x0, y0, x1, y1, value = 1) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      mask[y * width + x] = value;
    }
  }
}

function buildDirectionalAnchors(allowedDirections = []) {
  const anchors = new Set();
  if (allowedDirections.includes('left')) {
    anchors.add('2,0');
    anchors.add('2,1');
    anchors.add('2,2');
  }
  if (allowedDirections.includes('right')) {
    anchors.add('0,0');
    anchors.add('0,1');
    anchors.add('0,2');
  }
  if (allowedDirections.includes('top')) {
    anchors.add('0,2');
    anchors.add('1,2');
    anchors.add('2,2');
  }
  if (allowedDirections.includes('bottom')) {
    anchors.add('0,0');
    anchors.add('1,0');
    anchors.add('2,0');
  }
  if (!anchors.size) {
    anchors.add('1,1');
  }
  anchors.add('1,1');
  return anchors;
}

function refinePaperBoundaryRect(whiteMask, brightnessMap, width, rect, outputMask, options = {}) {
  const minRectSize = Math.max(2, options.minRefineRectSize || 2);
  const { x0, y0, x1, y1 } = rect;
  const rectWidth = x1 - x0;
  const rectHeight = y1 - y0;
  const allowedDirections = Array.isArray(options.allowedDirections) ? options.allowedDirections : [];
  if (rectWidth <= 0 || rectHeight <= 0) {
    return;
  }

  const metrics = computeRectWhiteMetrics(whiteMask, brightnessMap, width, x0, y0, x1, y1);
  if (isRectStrongWhite(metrics, options)) {
    fillRectMask(outputMask, width, x0, y0, x1, y1, 1);
    return;
  }
  if (!isRectMaybeWhite(metrics, options)) {
    return;
  }
  if (rectWidth <= minRectSize && rectHeight <= minRectSize) {
    if (metrics.whiteRatio >= (options.leafWhiteRatioThreshold ?? 0.2) && metrics.centerWhite) {
      fillRectMask(outputMask, width, x0, y0, x1, y1, 1);
    }
    return;
  }

  const stepX = rectWidth / 3;
  const stepY = rectHeight / 3;
  const subRects = [];
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const subRect = {
        gx,
        gy,
        x0: x0 + Math.floor(stepX * gx),
        y0: y0 + Math.floor(stepY * gy),
        x1: gx === 2 ? x1 : x0 + Math.floor(stepX * (gx + 1)),
        y1: gy === 2 ? y1 : y0 + Math.floor(stepY * (gy + 1))
      };
      if (subRect.x1 <= subRect.x0 || subRect.y1 <= subRect.y0) {
        continue;
      }
      const subMetrics = computeRectWhiteMetrics(
        whiteMask,
        brightnessMap,
        width,
        subRect.x0,
        subRect.y0,
        subRect.x1,
        subRect.y1
      );
      subRects.push({
        ...subRect,
        metrics: subMetrics,
        strong: isRectStrongWhite(subMetrics, options),
        maybe: isRectMaybeWhite(subMetrics, options)
      });
    }
  }

  const rectMap = new Map(subRects.map((item) => [`${item.gx},${item.gy}`, item]));
  const isWhiteLike = (gx, gy) => {
    const item = rectMap.get(`${gx},${gy}`);
    return Boolean(item && (item.strong || item.maybe));
  };
  const centerNode = rectMap.get('1,1') || null;
  if (centerNode) {
    const surroundingStates = [];
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (gx === 1 && gy === 1) {
          continue;
        }
        surroundingStates.push(isWhiteLike(gx, gy));
      }
    }
    if (surroundingStates.length === 8) {
      if (surroundingStates.every(Boolean)) {
        centerNode.strong = true;
        centerNode.maybe = true;
      } else if (surroundingStates.every((value) => !value)) {
        centerNode.strong = false;
        centerNode.maybe = false;
      }
    }
  }
  const anchors = buildDirectionalAnchors(allowedDirections);
  const queue = [];
  const visited = new Set();

  for (const anchor of anchors) {
    const node = rectMap.get(anchor);
    if (!node || !(node.strong || node.maybe)) {
      continue;
    }
    queue.push(node);
    visited.add(anchor);
  }

  while (queue.length) {
    const current = queue.shift();
    const neighbors = [
      [current.gx - 1, current.gy],
      [current.gx + 1, current.gy],
      [current.gx, current.gy - 1],
      [current.gx, current.gy + 1]
    ];
    for (const [nx, ny] of neighbors) {
      const key = `${nx},${ny}`;
      if (visited.has(key)) {
        continue;
      }
      const node = rectMap.get(key);
      if (!node || !(node.strong || node.maybe)) {
        continue;
      }
      visited.add(key);
      queue.push(node);
    }
  }

  for (const key of visited) {
    const subRect = rectMap.get(key);
    if (!subRect) {
      continue;
    }
    if ((subRect.x1 - subRect.x0) <= minRectSize && (subRect.y1 - subRect.y0) <= minRectSize) {
      if (subRect.metrics.whiteRatio >= (options.leafWhiteRatioThreshold ?? 0.2) && subRect.metrics.centerWhite) {
        fillRectMask(outputMask, width, subRect.x0, subRect.y0, subRect.x1, subRect.y1, 1);
      }
      continue;
    }
    if (subRect.strong && subRect.metrics.centerWhite) {
      fillRectMask(outputMask, width, subRect.x0, subRect.y0, subRect.x1, subRect.y1, 1);
      continue;
    }
    refinePaperBoundaryRect(whiteMask, brightnessMap, width, subRect, outputMask, options);
  }
}

function buildPaperCandidateMask(colorData, info, options = {}) {
  const {
    brightnessThreshold = 112,
    saturationThreshold = 96,
    scale = 320,
    blockSize = 9,
    strongWhiteRatioThreshold = 0.58,
    softWhiteRatioThreshold = 0.34,
    softBrightnessThreshold = brightnessThreshold + 4,
    maybeWhiteRatioThreshold = 0.16,
    maybeBrightnessThreshold = brightnessThreshold - 4,
    minRefineRectSize = 1,
    leafWhiteRatioThreshold = 0.18
  } = options;
  const { width, height, channels } = info;
  const resizeRatio = Math.min(1, scale / Math.max(width, height));
  const scaledWidth = Math.max(1, Math.round(width * resizeRatio));
  const scaledHeight = Math.max(1, Math.round(height * resizeRatio));
  const baseMask = new Uint8Array(scaledWidth * scaledHeight);
  const brightnessMap = new Float32Array(scaledWidth * scaledHeight);

  for (let sy = 0; sy < scaledHeight; sy++) {
    for (let sx = 0; sx < scaledWidth; sx++) {
      const x = Math.min(width - 1, Math.round(sx / resizeRatio));
      const y = Math.min(height - 1, Math.round(sy / resizeRatio));
      const offset = (y * width + x) * channels;
      const r = colorData[offset];
      const g = colorData[offset + 1];
      const b = colorData[offset + 2];
      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      const saturation = maxChannel - minChannel;
      const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
      brightnessMap[sy * scaledWidth + sx] = brightness;
      baseMask[sy * scaledWidth + sx] =
        brightness >= brightnessThreshold && saturation <= saturationThreshold ? 1 : 0;
    }
  }

  const safeBlockSize = Math.max(4, Math.round(blockSize));
  const blockCols = Math.max(1, Math.ceil(scaledWidth / safeBlockSize));
  const blockRows = Math.max(1, Math.ceil(scaledHeight / safeBlockSize));
  const strongBlockMask = new Uint8Array(blockCols * blockRows);
  const maybeBlockMask = new Uint8Array(blockCols * blockRows);
  const blockCenterWhite = new Uint8Array(blockCols * blockRows);
  const blockWhiteRatioMap = new Float32Array(blockCols * blockRows);
  const blockBrightnessMap = new Float32Array(blockCols * blockRows);
  const centerIndex = (blockRows > 0 && blockCols > 0)
    ? Math.floor(blockRows / 2) * blockCols + Math.floor(blockCols / 2)
    : 0;

  for (let by = 0; by < blockRows; by++) {
    for (let bx = 0; bx < blockCols; bx++) {
      const x0 = bx * safeBlockSize;
      const y0 = by * safeBlockSize;
      const x1 = Math.min(scaledWidth, x0 + safeBlockSize);
      const y1 = Math.min(scaledHeight, y0 + safeBlockSize);
      const metrics = computeRectWhiteMetrics(baseMask, brightnessMap, scaledWidth, x0, y0, x1, y1);
      const blockIndex = by * blockCols + bx;
      blockCenterWhite[blockIndex] = metrics.centerWhite ? 1 : 0;
      blockWhiteRatioMap[blockIndex] = metrics.whiteRatio;
      blockBrightnessMap[blockIndex] = metrics.avgBrightness;
      if (isRectStrongWhite(metrics, {
        strongWhiteRatioThreshold,
        softWhiteRatioThreshold,
        softBrightnessThreshold
      })) {
        strongBlockMask[blockIndex] = 1;
      }
      if (isRectMaybeWhite(metrics, {
        maybeWhiteRatioThreshold,
        maybeBrightnessThreshold
      })) {
        maybeBlockMask[blockIndex] = 1;
      }
    }
  }

  const mask = new Uint8Array(scaledWidth * scaledHeight);
  let seedIndex = centerIndex;
  if (!strongBlockMask[seedIndex]) {
    let bestDistance = Infinity;
    for (let index = 0; index < strongBlockMask.length; index++) {
      if (!strongBlockMask[index]) {
        continue;
      }
      const dx = (index % blockCols) - (centerIndex % blockCols);
      const dy = Math.floor(index / blockCols) - Math.floor(centerIndex / blockCols);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        seedIndex = index;
      }
    }
  }
  if (!strongBlockMask[seedIndex]) {
    return {
      mask: baseMask,
      resizeRatio,
      scaledWidth,
      scaledHeight,
      blockSize: safeBlockSize,
      blockCols,
      blockRows
    };
  }
  const componentBlockMask = new Uint8Array(blockCols * blockRows);
  const queue = [seedIndex];
  componentBlockMask[seedIndex] = 1;
  while (queue.length) {
    const index = queue.shift();
    const bx = index % blockCols;
    const by = Math.floor(index / blockCols);
    const neighbors = [
      [bx - 1, by],
      [bx + 1, by],
      [bx, by - 1],
      [bx, by + 1]
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= blockCols || ny < 0 || ny >= blockRows) {
        continue;
      }
      const neighborIndex = ny * blockCols + nx;
      if (componentBlockMask[neighborIndex] || !maybeBlockMask[neighborIndex]) {
        continue;
      }
      if (!blockCenterWhite[neighborIndex]) {
        continue;
      }
      const neighborSupport = [
        [nx - 1, ny],
        [nx + 1, ny],
        [nx, ny - 1],
        [nx, ny + 1]
      ].reduce((count, [sx, sy]) => {
        if (sx < 0 || sx >= blockCols || sy < 0 || sy >= blockRows) {
          return count;
        }
        const supportIndex = sy * blockCols + sx;
        return count + (strongBlockMask[supportIndex] || componentBlockMask[supportIndex] ? 1 : 0);
      }, 0);
      const relaxedMaybe =
        blockWhiteRatioMap[neighborIndex] >= Math.max(maybeWhiteRatioThreshold + 0.08, 0.24)
        && blockBrightnessMap[neighborIndex] >= maybeBrightnessThreshold + 6;
      if (!strongBlockMask[neighborIndex] && !(relaxedMaybe && neighborSupport >= 2)) {
        continue;
      }
      componentBlockMask[neighborIndex] = 1;
      queue.push(neighborIndex);
    }
  }

  for (let by = 0; by < blockRows; by++) {
    for (let bx = 0; bx < blockCols; bx++) {
      const blockIndex = by * blockCols + bx;
      if (!componentBlockMask[blockIndex]) {
        continue;
      }
      const x0 = bx * safeBlockSize;
      const y0 = by * safeBlockSize;
      const x1 = Math.min(scaledWidth, x0 + safeBlockSize);
      const y1 = Math.min(scaledHeight, y0 + safeBlockSize);
      const neighbors = [
        [bx - 1, by],
        [bx + 1, by],
        [bx, by - 1],
        [bx, by + 1]
      ];
      let missingSides = 0;
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= blockCols || ny < 0 || ny >= blockRows || !componentBlockMask[ny * blockCols + nx]) {
          missingSides += 1;
        }
      }
      if (missingSides === 0) {
        fillRectMask(mask, scaledWidth, x0, y0, x1, y1, 1);
        continue;
      }
      refinePaperBoundaryRect(
        baseMask,
        brightnessMap,
        scaledWidth,
        { x0, y0, x1, y1 },
        mask,
        {
          allowedDirections: neighbors
            .filter(([nx, ny]) => nx < 0 || nx >= blockCols || ny < 0 || ny >= blockRows || !componentBlockMask[ny * blockCols + nx])
            .map(([nx, ny]) => {
              if (nx < bx) return 'left';
              if (nx > bx) return 'right';
              if (ny < by) return 'top';
              return 'bottom';
            }),
          strongWhiteRatioThreshold,
          softWhiteRatioThreshold,
          softBrightnessThreshold,
          maybeWhiteRatioThreshold,
          maybeBrightnessThreshold,
          minRefineRectSize,
          leafWhiteRatioThreshold
        }
      );
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= blockCols || ny < 0 || ny >= blockRows || componentBlockMask[ny * blockCols + nx]) {
          continue;
        }
        const nx0 = nx * safeBlockSize;
        const ny0 = ny * safeBlockSize;
        const nx1 = Math.min(scaledWidth, nx0 + safeBlockSize);
        const ny1 = Math.min(scaledHeight, ny0 + safeBlockSize);
        refinePaperBoundaryRect(
          baseMask,
          brightnessMap,
          scaledWidth,
          { x0: nx0, y0: ny0, x1: nx1, y1: ny1 },
          mask,
          {
            allowedDirections: [
              nx < bx ? 'right' : nx > bx ? 'left' : ny < by ? 'bottom' : 'top'
            ],
            strongWhiteRatioThreshold,
            softWhiteRatioThreshold,
            softBrightnessThreshold,
            maybeWhiteRatioThreshold,
            maybeBrightnessThreshold,
            minRefineRectSize,
            leafWhiteRatioThreshold
          }
        );
      }
    }
  }

  return {
    mask,
    resizeRatio,
    scaledWidth,
    scaledHeight,
    blockSize: safeBlockSize,
    blockCols,
    blockRows
  };
}

function detectPaperRegion(colorData, info, options = {}) {
  const {
    padding = 18,
    paddingTop = padding,
    paddingRight = padding,
    paddingBottom = padding,
    paddingLeft = padding,
    minAreaRatio = 0.38,
    inwardCropRatio = 0.015,
    maskDilateRadius = 2,
    cornerExpandScale = 1.035,
    cornerExpandPadX = 18,
    cornerExpandPadY = 18,
    paperCornerImageRefineBlend = 0.08,
    paperCornerImageRefineMaxShift = 12,
    paperCornerStabilizeBlend = 0.03,
    paperCornerRadialRefineBlend = 0,
    paperCornerRadialRefineMaxShift = 16
  } = options;
  const { width, height } = info;
  const candidate = buildPaperCandidateMask(colorData, info, options);
  const best = extractLargestConnectedComponent(candidate.mask, candidate.scaledWidth, candidate.scaledHeight);

  if (!best || best.area / (candidate.scaledWidth * candidate.scaledHeight) < minAreaRatio) {
    return {
      bounds: {
        left: 0,
        top: 0,
        width,
        height
      },
      resizeRatio: candidate.resizeRatio,
      scaledWidth: candidate.scaledWidth,
      scaledHeight: candidate.scaledHeight,
      componentMask: new Uint8Array(candidate.scaledWidth * candidate.scaledHeight).fill(1),
      usedFallback: true
    };
  }

  const componentMask = new Uint8Array(candidate.scaledWidth * candidate.scaledHeight);
  for (const index of best.pixels) {
    componentMask[index] = 1;
  }
  const expandedMask = dilateMask(componentMask, candidate.scaledWidth, candidate.scaledHeight, maskDilateRadius);
  const expandedBounds = computeMaskBounds(expandedMask, candidate.scaledWidth, candidate.scaledHeight) || best;
  const cornerQuad = estimateCornerQuadFromMask(componentMask, candidate.scaledWidth, candidate.scaledHeight, {
    recursiveMinSize: 6,
    recursiveMaxDepth: 14,
    recursiveBlend: 0.18,
    recursiveMaxShift: 64,
    boundaryBlend: 0.1,
    boundaryMaxShift: 24,
    stabilizeBlend: 0.04
  });
  const remapPoint = (point) => (
    Array.isArray(point) && point.length >= 2
      ? [
          clamp(point[0] / candidate.resizeRatio, 0, width - 1),
          clamp(point[1] / candidate.resizeRatio, 0, height - 1)
        ]
      : null
  );
  const paperCorners = Array.isArray(cornerQuad)
      ? (() => {
        const remappedCorners = normalizeCornerQuad(cornerQuad.map(remapPoint));
        const imageRefinedCorners = paperCornerImageRefineBlend > 0
          ? (refineCornerQuadWithImageEdges(
              colorData,
              info,
              remappedCorners,
              { targetMax: 1200 }
            ) || remappedCorners)
          : remappedCorners;
        const mergedCorners = paperCornerImageRefineBlend > 0
          ? (mergeCornerQuads(remappedCorners, imageRefinedCorners, {
              blend: paperCornerImageRefineBlend,
              maxShift: paperCornerImageRefineMaxShift
            }) || remappedCorners)
          : remappedCorners;
        const radialRefinedCorners = paperCornerRadialRefineBlend > 0
          ? (mergeCornerQuads(
              mergedCorners,
              refineCornerQuadByRadialSearch(colorData, info, mergedCorners, {
                blend: 1,
                maxShift: paperCornerRadialRefineMaxShift
              }) || mergedCorners,
              {
                blend: paperCornerRadialRefineBlend,
                maxShift: paperCornerRadialRefineMaxShift
              }
            ) || mergedCorners)
          : mergedCorners;
        const stabilizedCorners = paperCornerStabilizeBlend > 0
          ? (stabilizeQuadGeometry(radialRefinedCorners, { blend: paperCornerStabilizeBlend }) || radialRefinedCorners)
          : radialRefinedCorners;
        return expandCornerQuadFromCentroid(
          stabilizedCorners,
          width,
          height,
          {
            scale: cornerExpandScale,
            padX: cornerExpandPadX,
            padY: cornerExpandPadY
          }
        );
      })()
    : null;

  const cornerBounds = Array.isArray(paperCorners) && paperCorners.length === 4
    ? {
        minX: Math.min(...paperCorners.map((point) => Number(point[0]))),
        minY: Math.min(...paperCorners.map((point) => Number(point[1]))),
        maxX: Math.max(...paperCorners.map((point) => Number(point[0]))),
        maxY: Math.max(...paperCorners.map((point) => Number(point[1])))
      }
    : null;
  const sourceBounds = cornerBounds || {
    minX: expandedBounds.minX / candidate.resizeRatio,
    minY: expandedBounds.minY / candidate.resizeRatio,
    maxX: expandedBounds.maxX / candidate.resizeRatio,
    maxY: expandedBounds.maxY / candidate.resizeRatio
  };
  const left = clamp(Math.floor(sourceBounds.minX) - paddingLeft, 0, width - 1);
  const top = clamp(Math.floor(sourceBounds.minY) - paddingTop, 0, height - 1);
  const right = clamp(Math.ceil(sourceBounds.maxX + 1) + paddingRight, left + 1, width);
  const bottom = clamp(Math.ceil(sourceBounds.maxY + 1) + paddingBottom, top + 1, height);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const inwardX = Math.max(2, Math.floor(cropWidth * inwardCropRatio));
  const inwardY = Math.max(2, Math.floor(cropHeight * inwardCropRatio));
  const innerLeft = clamp(left + inwardX, 0, width - 1);
  const innerTop = clamp(top + inwardY, 0, height - 1);
  const innerRight = clamp(right - inwardX, innerLeft + 1, width);
  const innerBottom = clamp(bottom - inwardY, innerTop + 1, height);

  return {
    bounds: {
      left: innerLeft,
      top: innerTop,
      width: innerRight - innerLeft,
      height: innerBottom - innerTop
    },
    resizeRatio: candidate.resizeRatio,
    scaledWidth: candidate.scaledWidth,
    scaledHeight: candidate.scaledHeight,
    componentMask: expandedMask,
    paperCorners,
    usedFallback: false
  };
}

function detectPaperBounds(colorData, info, options = {}) {
  return detectPaperRegion(colorData, info, options).bounds;
}

async function fallbackPreprocessPaperImage(inputPath, options = {}) {
  const {
    threshold = 185,
    blurSigma = 18,
    outputPath = null,
    segmentationOutputPath = null,
    paperCropOutputPath = null,
    warpedOutputPath = null,
    guideRemovedOutputPath = null,
    neutralGuideRemovedOutputPath = null,
    gridBackgroundMaskOutputPath = null,
    gridAnnotatedOutputPath = null,
    ignoreRedGrid = true,
    cropToPaper = true
  } = options;

  const source = sharp(inputPath).ensureAlpha();
  const { data: sourceColorData, info: sourceInfo } = await source.clone().raw().toBuffer({ resolveWithObject: true });
  const paperBounds = cropToPaper
    ? detectPaperBounds(sourceColorData, sourceInfo)
    : {
        left: 0,
        top: 0,
        width: sourceInfo.width,
        height: sourceInfo.height
      };
  const working = source.clone().extract(paperBounds);
  const { data: colorData, info } = await working.clone().raw().toBuffer({ resolveWithObject: true });

  const { data: bgData } = await working
    .clone()
    .greyscale()
    .blur(blurSigma)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const output = Buffer.alloc(info.width * info.height);

  for (let i = 0; i < output.length; i++) {
    const offset = i * info.channels;
    const r = colorData[offset];
    const g = colorData[offset + 1];
    const b = colorData[offset + 2];
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const isRedGrid =
      ignoreRedGrid &&
      r > 150 &&
      g < 170 &&
      b < 170 &&
      r - g > 30 &&
      r - b > 30;
    const bg = Math.max(bgData[i], 1);

    if (isRedGrid) {
      output[i] = 255;
      continue;
    }

    const normalized = clamp(Math.round((gray * 255) / bg), 0, 255);
    output[i] = normalized < threshold ? 0 : 255;
  }

  const processed = sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 1
    }
  }).png();

  if (outputPath) {
    await processed.toFile(outputPath);
  }

  if (paperCropOutputPath) {
    await working.clone().png().toFile(paperCropOutputPath);
  }

  if (warpedOutputPath) {
    await working.clone().png().toFile(warpedOutputPath);
  }

  if (guideRemovedOutputPath) {
    await working.clone().png().toFile(guideRemovedOutputPath);
  }
  if (neutralGuideRemovedOutputPath) {
    await working.clone().png().toFile(neutralGuideRemovedOutputPath);
  }

  if (gridBackgroundMaskOutputPath) {
    await sharp({
      create: {
        width: info.width,
        height: info.height,
        channels: 1,
        background: 0
      }
    }).png().toFile(gridBackgroundMaskOutputPath);
  }

  if (gridAnnotatedOutputPath) {
    await working.clone().png().toFile(gridAnnotatedOutputPath);
  }

  if (segmentationOutputPath && segmentationOutputPath !== outputPath) {
    await working.clone().greyscale().normalize().png().toFile(segmentationOutputPath);
  }

  return {
    buffer: await processed.toBuffer(),
    segmentationOutputPath: segmentationOutputPath || outputPath,
    paperCropOutputPath: paperCropOutputPath || null,
    warpedOutputPath: warpedOutputPath || null,
    guideRemovedOutputPath: guideRemovedOutputPath || null,
    neutralGuideRemovedOutputPath: neutralGuideRemovedOutputPath || null,
    gridBackgroundMaskOutputPath: gridBackgroundMaskOutputPath || null,
    gridAnnotatedOutputPath: gridAnnotatedOutputPath || null,
    method: 'fallback_brightness_crop',
    paperBounds,
    paperCorners: null,
    roughPaperCorners: null,
    refinedPaperCorners: null,
    cornerSelection: null,
    warp: {
      targetWidth: info.width,
      targetHeight: info.height,
      insetX: 0,
      insetY: 0
    },
    outputInfo: {
      width: info.width,
      height: info.height
    }
  };
}

async function runPerspectivePreprocess(inputPath, options = {}) {
  const scriptPath = path.join(__dirname, 'a4_perspective_preprocess.py');
  const {
    threshold = 185,
    blurSigma = 18,
    outputPath,
    segmentationOutputPath = null,
    paperCropOutputPath = null,
    warpedOutputPath = null,
    guideRemovedOutputPath = null,
    neutralGuideRemovedOutputPath = null,
    gridBackgroundMaskOutputPath = null,
    gridAnnotatedOutputPath = null,
    debugPath = null,
    cropToPaper = true,
    ignoreRedGrid = true,
    gridRows = null,
    gridCols = null,
    gridType = 'square'
  } = options;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'a4-preprocess-'));
  const metaPath = path.join(tempDir, 'meta.json');
  const args = [
    scriptPath,
    '--input', inputPath,
    '--output', outputPath,
    '--segmentation-output', segmentationOutputPath || outputPath,
    '--paper-crop-output', paperCropOutputPath || '',
    '--warped-output', warpedOutputPath || '',
    '--guide-removed-output', guideRemovedOutputPath || '',
    '--neutral-guide-removed-output', neutralGuideRemovedOutputPath || '',
    '--grid-background-mask-output', gridBackgroundMaskOutputPath || '',
    '--grid-annotated-output', gridAnnotatedOutputPath || '',
    '--meta', metaPath,
    '--threshold', String(threshold),
    '--blur-sigma', String(blurSigma),
    '--grid-type', String(gridType || 'square')
  ];

  if (gridRows) {
    args.push('--grid-rows', String(gridRows));
  }
  if (gridCols) {
    args.push('--grid-cols', String(gridCols));
  }

  if (debugPath) {
    args.push('--debug', debugPath);
  }
  if (cropToPaper) {
    args.push('--crop-to-paper');
  }
  if (ignoreRedGrid) {
    args.push('--ignore-red-grid');
  }

  try {
    await execFileAsync('python3', args, { cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
    const buffer = await fs.promises.readFile(outputPath);
    return {
      buffer,
      segmentationOutputPath: meta.segmentationOutputPath || segmentationOutputPath || outputPath,
      paperCropOutputPath: meta.paperCropOutputPath || paperCropOutputPath || null,
      warpedOutputPath: meta.warpedOutputPath || warpedOutputPath || null,
      guideRemovedOutputPath: meta.guideRemovedOutputPath || guideRemovedOutputPath || null,
      neutralGuideRemovedOutputPath: meta.neutralGuideRemovedOutputPath || neutralGuideRemovedOutputPath || null,
      gridBackgroundMaskOutputPath: meta.gridBackgroundMaskOutputPath || gridBackgroundMaskOutputPath || null,
      gridAnnotatedOutputPath: meta.gridAnnotatedOutputPath || gridAnnotatedOutputPath || null,
      method: meta.method || 'perspective',
      paperBounds: meta.paperBounds,
      paperCorners: meta.paperCorners || null,
      roughPaperCorners: meta.roughPaperCorners || null,
      refinedPaperCorners: meta.refinedPaperCorners || null,
      cornerSelection: meta.cornerSelection || null,
      warp: meta.warp || null,
      outputInfo: meta.outputInfo
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function runGridOuterRectify(inputPath, options = {}) {
  const scriptPath = path.join(__dirname, 'grid_outer_rectify.py');
  const {
    outputPath,
    metaPath,
    debugPath = null,
    gridRows,
    gridCols,
    threshold = 220,
    corners = null
  } = options;

  if (!outputPath || !metaPath || !gridRows || !gridCols) {
    return null;
  }

  const args = [
    scriptPath,
    '--input', inputPath,
    '--output', outputPath,
    '--meta', metaPath,
    '--grid-rows', String(gridRows),
    '--grid-cols', String(gridCols),
    '--threshold', String(threshold)
  ];

  if (debugPath) {
    args.push('--debug', debugPath);
  }
  if (Array.isArray(corners) && corners.length === 4) {
    args.push('--corners-json', JSON.stringify(corners));
  }

  await execFileAsync('python3', args, { cwd: __dirname, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
}

function buildGridDetectionCrop(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const insetX = Math.max(24, Math.round(width * 0.03));
  const insetY = Math.max(36, Math.round(height * 0.03));
  const left = clamp(insetX, 0, Math.max(0, width - 2));
  const top = clamp(insetY, 0, Math.max(0, height - 2));
  const right = clamp(width - insetX, left + 1, width);
  const bottom = clamp(height - insetY, top + 1, height);
  if (right - left < Math.max(200, width * 0.6) || bottom - top < Math.max(200, height * 0.6)) {
    return null;
  }
  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  };
}

function remapGridRectificationToFullImage(gridRectification, cropBox) {
  if (!gridRectification || gridRectification.error || !cropBox) {
    return gridRectification;
  }
  const remapPoint = (point) => (
    Array.isArray(point) && point.length >= 2
      ? [Number(point[0]) + cropBox.left, Number(point[1]) + cropBox.top]
      : point
  );
  const remapPeaks = (values, offset) => (
    Array.isArray(values)
      ? values.map((value) => Number(value) + offset)
      : values
  );
  return {
    ...gridRectification,
    inputPath: gridRectification.originalInputPath || gridRectification.inputPath,
    detectionCrop: cropBox,
    corners: Array.isArray(gridRectification.corners)
      ? gridRectification.corners.map(remapPoint)
      : gridRectification.corners,
    guides: gridRectification.guides
      ? {
          ...gridRectification.guides,
          left: Number(gridRectification.guides.left) + cropBox.left,
          right: Number(gridRectification.guides.right) + cropBox.left,
          top: Number(gridRectification.guides.top) + cropBox.top,
          bottom: Number(gridRectification.guides.bottom) + cropBox.top,
          xPeaks: remapPeaks(gridRectification.guides.xPeaks, cropBox.left),
          yPeaks: remapPeaks(gridRectification.guides.yPeaks, cropBox.top)
        }
      : gridRectification.guides
  };
}

async function extractGridArtifactsFromWarpedImages(options = {}) {
  const {
    preprocessInputPath,
    warpedImagePath,
    guideRemovedInputPath = null,
    outputPath = null,
    segmentationOutputPath = null,
    guideRemovedOutputPath = null,
    neutralGuideRemovedOutputPath = null,
    gridBackgroundMaskOutputPath = null,
    gridAnnotatedOutputPath = null,
    gridRectifiedOutputPath = null,
    gridRectifiedMetaPath = null,
    gridRectifiedDebugPath = null,
    gridRows = null,
    gridCols = null,
    threshold = 185,
    blurSigma = 18,
    ignoreRedGrid = true,
    processNo = '03',
    a4Constraint = null,
    enableA4GuideConstraint = processNo === '02'
  } = options;

  const resolvedOutputPath = outputPath || preprocessInputPath || null;
  const resolvedSegmentationPath = segmentationOutputPath || null;
  const resolvedGuideRemovedPath = guideRemovedOutputPath || null;

  if (!preprocessInputPath || !warpedImagePath || !resolvedOutputPath || !gridRows || !gridCols) {
    throw new Error('extractGridArtifactsFromWarpedImages 缺少上一步产物，禁止使用默认回退逻辑');
  }

  if (preprocessInputPath !== resolvedOutputPath) {
    await fs.promises.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await fs.promises.copyFile(preprocessInputPath, resolvedOutputPath);
  }
  if (resolvedSegmentationPath && preprocessInputPath !== resolvedSegmentationPath) {
    await fs.promises.mkdir(path.dirname(resolvedSegmentationPath), { recursive: true });
    await fs.promises.copyFile(preprocessInputPath, resolvedSegmentationPath);
  }
  if (guideRemovedInputPath && resolvedGuideRemovedPath && guideRemovedInputPath !== resolvedGuideRemovedPath) {
    await fs.promises.mkdir(path.dirname(resolvedGuideRemovedPath), { recursive: true });
    await fs.promises.copyFile(guideRemovedInputPath, resolvedGuideRemovedPath);
  }

  const orientedGrid = orientSquareGridCounts(gridRows, gridCols, await sharp(warpedImagePath).metadata(), 'square');
  const effectiveGridRows = orientedGrid.gridRows;
  const effectiveGridCols = orientedGrid.gridCols;

  let outerFrameCleanup = {
    applied: false,
    reason: 'not-attempted'
  };
  if (processNo === '03' && resolvedOutputPath) {
    try {
      outerFrameCleanup = await removeObviousOuterFrameLines(preprocessInputPath, resolvedOutputPath);
    } catch (outerFrameError) {
      outerFrameCleanup = {
        applied: false,
        reason: 'outer-frame-cleanup-error',
        error: outerFrameError.message
      };
    }
  }
  const boundaryInputPath = (
    processNo === '03'
    && outerFrameCleanup?.applied
    && resolvedOutputPath
  )
    ? resolvedOutputPath
    : preprocessInputPath;
  if (
    processNo === '03'
    && outerFrameCleanup?.applied
    && resolvedSegmentationPath
    && boundaryInputPath
    && resolvedSegmentationPath !== boundaryInputPath
  ) {
    await fs.promises.mkdir(path.dirname(resolvedSegmentationPath), { recursive: true });
    await fs.promises.copyFile(boundaryInputPath, resolvedSegmentationPath);
  }

  let gridRectification = null;
  let rawGridRectifyTempDir = null;
  if (gridRectifiedOutputPath && gridRectifiedMetaPath) {
    try {
      rawGridRectifyTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'grid-rectify-raw-'));
      const preprocessMeta = await sharp(boundaryInputPath).metadata();
      const detectionCrop = buildGridDetectionCrop(preprocessMeta.width || 0, preprocessMeta.height || 0);
      let gridDetectionInputPath = resolvedSegmentationPath || boundaryInputPath || resolvedOutputPath;
      if (detectionCrop) {
        const croppedDetectionPath = path.join(rawGridRectifyTempDir, 'grid_detection_crop.png');
        await sharp(gridDetectionInputPath)
          .extract(detectionCrop)
          .png()
          .toFile(croppedDetectionPath);
        gridDetectionInputPath = croppedDetectionPath;
      }
      const rawRectifiedOutputPath = path.join(rawGridRectifyTempDir, 'raw_grid_rectified.png');
      const rawRectifiedMetaPath = path.join(rawGridRectifyTempDir, 'raw_grid_rectified.json');
      const rawGridRectification = await runGridOuterRectify(
        gridDetectionInputPath,
        {
          outputPath: rawRectifiedOutputPath,
          metaPath: rawRectifiedMetaPath,
          gridRows: effectiveGridRows,
          gridCols: effectiveGridCols
        }
      );
      if (processNo === '03' && outerFrameCleanup?.applied) {
        gridRectification = rawGridRectification
          ? {
              ...rawGridRectification,
              originalInputPath: gridDetectionInputPath
            }
          : rawGridRectification;
      } else {
        gridRectification = remapGridRectificationToFullImage(
          rawGridRectification
            ? {
                ...rawGridRectification,
                originalInputPath: resolvedSegmentationPath || boundaryInputPath || resolvedOutputPath
              }
            : rawGridRectification,
          detectionCrop
        );
      }
    } catch (gridError) {
      gridRectification = {
        error: gridError.message
      };
    }
  }

  let gridBoundaryDetection = null;
  let guideRemovalBoundaryDetection = null;
  let cleanupCoverageProtection = null;
  if (
    gridRectification &&
    !gridRectification.error &&
    warpedImagePath
  ) {
    try {
        const normalizedCorners = normalizeCornerQuad(gridRectification.corners || null);
        const normalizedGuides = buildGuidesFromRawPeaks(
          gridRectification.guides || null,
          effectiveGridRows,
          effectiveGridCols
        ) || gridBoundaryNormalizePlugin.execute({
          gridRectification,
          gridRows: effectiveGridRows,
          gridCols: effectiveGridCols
        }) || buildGuidesFromCornerQuad(
          normalizedCorners,
          gridRectification.guides || null,
          effectiveGridRows,
          effectiveGridCols
        ) || gridRectification.guides || null;
        gridBoundaryDetection = {
          source: '真实方格边界识别',
          annotationPath: gridAnnotatedOutputPath,
          corners: normalizedCorners,
          cornerAnchors: buildGridCornerAnchors(normalizedCorners, normalizedGuides),
          rawGuides: gridRectification.guides || null,
          guides: normalizedGuides
        };
      guideRemovalBoundaryDetection = {
        ...gridBoundaryDetection,
        source: '真实方格边界识别_去底纹专用'
      };
    } catch (annotationError) {
      gridBoundaryDetection = {
        source: '真实方格边界识别',
        error: annotationError.message
      };
      guideRemovalBoundaryDetection = gridBoundaryDetection;
    }
  }

  let guideConstraintRepair = null;
  if (gridBoundaryDetection && !gridBoundaryDetection.error && enableA4GuideConstraint) {
    const outputMeta = await sharp(warpedImagePath).metadata();
    const repaired = applyA4GuideConstraint(
      gridBoundaryDetection,
      {
        width: outputMeta.width || 0,
        height: outputMeta.height || 0
      },
      a4Constraint || deriveA4ConstraintFromBounds({
        width: outputMeta.width || 0,
        height: outputMeta.height || 0
      }),
      effectiveGridRows,
      effectiveGridCols
    );
    gridBoundaryDetection = repaired.gridBoundaryDetection;
    guideConstraintRepair = repaired.guideConstraintRepair;
  } else if (gridBoundaryDetection && !gridBoundaryDetection.error) {
    guideConstraintRepair = {
      applied: false,
      reason: processNo === '03'
        ? '03阶段已禁用A4约束，总方格边界仅按自身四角点/边界检测结果处理'
        : 'A4约束未启用'
    };
  }

  let topGuideConfirmation = null;
  if (gridBoundaryDetection && !gridBoundaryDetection.error) {
    try {
      topGuideConfirmation = await refineTopGuideByVerticalAnchors(
        boundaryInputPath,
        gridBoundaryDetection.guides || null
      );
      topGuideConfirmation = topGuideConfirmation
        ? {
            ...topGuideConfirmation,
            appliedToOutput: false,
            note: '当前仅保留顶边竖线确认诊断，不直接覆盖主流程 corners/guides，避免误把首行内部横线当成外边界'
          }
        : null;
    } catch (topGuideError) {
      topGuideConfirmation = {
        method: 'top-guide vertical-anchor confirmation',
        appliedToOutput: false,
        error: topGuideError.message
      };
    }
  }

  let cornerRefinement = null;
  if (gridBoundaryDetection && !gridBoundaryDetection.error) {
    try {
      const refinedCorners = await refineGridCornerAnchorsByImage(
        boundaryInputPath,
        gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null,
        gridBoundaryDetection.guides || null,
        { rawGuides: gridBoundaryDetection.rawGuides || null }
      );
      const currentQuad = normalizeCornerQuad(
        gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null
      );
      let refinedQuad = normalizeCornerQuad(refinedCorners?.corners || null);
      let topCornerRecovery = null;
      if (refinedQuad) {
        topCornerRecovery = await recoverTopCornersByInnerGuide(
          boundaryInputPath,
          refinedQuad,
          gridBoundaryDetection.guides || null
        );
        if (
          topCornerRecovery?.corners
          && refinedCorners?.diagnostics?.outputSource !== 'dominant-edge-lines'
        ) {
          refinedQuad = mergeTopCornerRecoveryHint(
            refinedQuad,
            topCornerRecovery.corners,
            topCornerRecovery.diagnostics || null,
            refinedCorners?.diagnostics?.cellHeight || 0
          );
        }
      }
      let appliedToOutput = false;
      if (currentQuad && refinedQuad) {
        const mergedGuides = buildGuidesFromCornerQuad(
          refinedQuad,
          gridBoundaryDetection.guides || null,
          effectiveGridRows,
          effectiveGridCols
        );
        if (mergedGuides) {
          const outputQuad = normalizeCornerQuad(refinedQuad);
          gridBoundaryDetection = {
            ...gridBoundaryDetection,
            corners: outputQuad,
            cornerAnchors: buildGridCornerAnchors(outputQuad, mergedGuides),
            guides: {
              ...mergedGuides,
              xSource: `${gridBoundaryDetection.guides?.xSource || '外边界固定 + 内部均分'} + 四角点校准`,
              ySource: `${gridBoundaryDetection.guides?.ySource || '外边界固定 + 内部均分'} + 四角点独立校准`
            }
          };
          appliedToOutput = true;
        }
      }
      cornerRefinement = refinedCorners?.diagnostics
        ? {
            ...refinedCorners.diagnostics,
            topCornerRecovery: topCornerRecovery?.diagnostics || null,
            appliedToOutput,
            note: appliedToOutput
              ? '四个角点已按局部横竖线交点独立校准，并回写主流程 corners/guides'
              : '当前仅输出四角点独立检测诊断，未覆盖主流程 corners'
          }
        : null;
    } catch (cornerRefineError) {
      cornerRefinement = {
        method: 'per-corner local line search',
        appliedToOutput: false,
        error: cornerRefineError.message
      };
    }
  }

  if (
    processNo === '03'
    && outerFrameCleanup?.applied
    && gridBoundaryDetection
    && !gridBoundaryDetection.error
    && boundaryInputPath
  ) {
    const boundaryMeta = await sharp(boundaryInputPath).metadata();
    const protectedBoundary = protectGridBoundsAfterOuterFrameCleanup(
      gridBoundaryDetection,
      {
        width: boundaryMeta.width || 0,
        height: boundaryMeta.height || 0
      },
      effectiveGridRows,
      effectiveGridCols
    );
    gridBoundaryDetection = protectedBoundary.gridBoundaryDetection;
    cleanupCoverageProtection = protectedBoundary.cleanupCoverageProtection;
    if (guideRemovalBoundaryDetection && !guideRemovalBoundaryDetection.error) {
      guideRemovalBoundaryDetection = {
        ...guideRemovalBoundaryDetection,
        corners: gridBoundaryDetection.corners,
        cornerAnchors: gridBoundaryDetection.cornerAnchors,
        guides: gridBoundaryDetection.guides
      };
    }
  }

  if (gridBoundaryDetection && !gridBoundaryDetection.error && gridAnnotatedOutputPath) {
    const annotationDetail = cornerRefinement
      ? [
          `source=${cornerRefinement.outputSource || 'unknown'}`,
          cornerRefinement.edgeLineFit?.preferredBandY?.rejectProjectedTopAnchors ? 'guard=reject-top-projected-anchor' : null,
          cornerRefinement.edgeLineFit?.preferredBandY?.rejectProjectedBottomAnchors ? 'guard=reject-bottom-projected-anchor' : null
        ].filter(Boolean).join(' ; ')
      : '';
    await renderDetectedGridAnnotation(
      boundaryInputPath,
      gridAnnotatedOutputPath,
      {
        corners: gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null,
        guides: gridBoundaryDetection.guides || null
      },
      {
        processNo,
        gridRows: Math.max(1, (gridBoundaryDetection.guides?.yPeaks || []).length - 1),
        gridCols: Math.max(1, (gridBoundaryDetection.guides?.xPeaks || []).length - 1),
        showGuides: false,
        annotationDetail,
        selectiveCornerReplacement: cornerRefinement?.edgeLineFit?.quadSelection?.selectiveCornerReplacement || null
      }
    );
  }

  let correctedGridRectified = null;
  if (
    gridBoundaryDetection &&
    !gridBoundaryDetection.error &&
    boundaryInputPath &&
    gridRectifiedOutputPath
  ) {
    try {
      correctedGridRectified = await exportGridRectifiedByGuides(
        boundaryInputPath,
        gridRectifiedOutputPath,
        gridBoundaryDetection,
        {
          metaPath: gridRectifiedMetaPath,
          gridRows: Math.max(1, (gridBoundaryDetection.guides?.yPeaks || []).length - 1),
          gridCols: Math.max(1, (gridBoundaryDetection.guides?.xPeaks || []).length - 1)
        }
      );
      await updateGridRectifiedMeta(
        gridRectifiedMetaPath,
        gridRectification,
        correctedGridRectified
      );
    } catch (gridRectifiedExportError) {
      correctedGridRectified = {
        error: gridRectifiedExportError.message
      };
    }
  }

  let realBoundaryRefinement = null;
  if (
    gridBoundaryDetection &&
    !gridBoundaryDetection.error &&
    warpedImagePath
  ) {
    try {
      realBoundaryRefinement = await refineOutputsWithDetectedGrid(
        (processNo === '03' && outerFrameCleanup?.applied) ? boundaryInputPath : warpedImagePath,
        {
        preprocessInputPath: boundaryInputPath,
        guideRemovedInputPath,
        outputPath: resolvedOutputPath,
        preservePreprocessOutputPath: processNo === '03',
        segmentationOutputPath: resolvedSegmentationPath,
        guideRemovedOutputPath: resolvedGuideRemovedPath,
        gridBackgroundMaskOutputPath: gridBackgroundMaskOutputPath || null,
        gridBoundaryDetection,
        segmentationBoundaryDetection: gridBoundaryDetection,
        guideRemovalBoundaryDetection: guideRemovalBoundaryDetection || gridBoundaryDetection,
        gridRows: Math.max(1, (gridBoundaryDetection.guides?.yPeaks || []).length - 1),
        gridCols: Math.max(1, (gridBoundaryDetection.guides?.xPeaks || []).length - 1),
        blurSigma,
        threshold,
        ignoreRedGrid
      });
    } catch (refineError) {
      realBoundaryRefinement = {
        error: refineError.message
      };
    }
  }

  if (
    resolvedSegmentationPath &&
    gridRectifiedOutputPath &&
    correctedGridRectified &&
    !correctedGridRectified.error &&
    resolvedSegmentationPath !== gridRectifiedOutputPath
  ) {
    await fs.promises.mkdir(path.dirname(resolvedSegmentationPath), { recursive: true });
    await fs.promises.copyFile(gridRectifiedOutputPath, resolvedSegmentationPath);
  }

  if (rawGridRectifyTempDir) {
    await fs.promises.rm(rawGridRectifyTempDir, { recursive: true, force: true });
  }

  return {
    outputPath: resolvedOutputPath,
    segmentationOutputPath: resolvedSegmentationPath,
    guideRemovedOutputPath: resolvedGuideRemovedPath,
    neutralGuideRemovedOutputPath: neutralGuideRemovedOutputPath || null,
    gridBackgroundMaskOutputPath: gridBackgroundMaskOutputPath || null,
    gridRectifiedOutputPath: correctedGridRectified && !correctedGridRectified.error ? gridRectifiedOutputPath : null,
    gridRectification,
    correctedGridRectified,
    gridRectifiedSourceStep: correctedGridRectified && !correctedGridRectified.error
      ? '03_0_方格背景与边界检测.json'
      : null,
    guideRemovalBoundaryDetection,
    gridBoundaryDetection,
    outerFrameCleanup,
    guideConstraintRepair,
    topGuideConfirmation,
    cornerRefinement,
    realBoundaryRefinement,
    cleanupCoverageProtection,
    a4Constraint: a4Constraint || null,
    effectiveGridRows: Math.max(1, (gridBoundaryDetection?.guides?.yPeaks || []).length - 1) || effectiveGridRows,
    effectiveGridCols: Math.max(1, (gridBoundaryDetection?.guides?.xPeaks || []).length - 1) || effectiveGridCols
  };
}

async function preprocessPaperImage(inputPath, options = {}) {
  const { outputPath = null } = options;
  if (!outputPath) {
    throw new Error('preprocessPaperImage需要outputPath以支持透视矫正输出');
  }

  try {
    const result = await runPerspectivePreprocess(inputPath, options);
    if (
      options.neutralGuideRemovedOutputPath &&
      result.warpedOutputPath &&
      options.neutralGuideRemovedOutputPath !== result.warpedOutputPath
    ) {
      await fs.promises.mkdir(path.dirname(options.neutralGuideRemovedOutputPath), { recursive: true });
      await fs.promises.copyFile(result.warpedOutputPath, options.neutralGuideRemovedOutputPath);
      result.neutralGuideRemovedOutputPath = options.neutralGuideRemovedOutputPath;
    }
    const {
      gridRectifiedOutputPath = null,
      gridRectifiedMetaPath = null,
      gridRectifiedDebugPath = null,
      gridRows = null,
      gridCols = null
    } = options;

    const a4Constraint = deriveA4ConstraintFromBounds(result.paperBounds || null);
    const gridArtifacts = await extractGridArtifactsFromWarpedImages({
      preprocessInputPath: options.outputPath || outputPath,
      warpedImagePath: result.warpedOutputPath,
      guideRemovedInputPath: result.guideRemovedOutputPath || null,
      outputPath: options.outputPath || outputPath,
      segmentationOutputPath: options.segmentationOutputPath || result.segmentationOutputPath || outputPath,
      guideRemovedOutputPath: options.guideRemovedOutputPath || result.guideRemovedOutputPath || null,
      neutralGuideRemovedOutputPath: options.neutralGuideRemovedOutputPath || result.neutralGuideRemovedOutputPath || null,
      gridBackgroundMaskOutputPath: options.gridBackgroundMaskOutputPath || result.gridBackgroundMaskOutputPath || null,
      gridAnnotatedOutputPath: options.gridAnnotatedOutputPath || null,
      gridRectifiedOutputPath,
      gridRectifiedMetaPath,
      gridRectifiedDebugPath,
      gridRows,
      gridCols,
      threshold: options.threshold || 185,
      blurSigma: options.blurSigma || 18,
      ignoreRedGrid: options.ignoreRedGrid !== false,
      a4Constraint: options.a4Constraint || a4Constraint,
      processNo: '02'
    });

    return {
      ...result,
      ...gridArtifacts,
      a4Constraint
    };
  } catch (error) {
    return fallbackPreprocessPaperImage(inputPath, options);
  }
}

module.exports = {
  preprocessPaperImage,
  detectPaperBounds,
  detectPaperRegion,
  extractGridArtifactsFromWarpedImages,
  evaluateDominantEdgeQuadGuard
};
