const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { requireSharp } = require('../utils/require_sharp');
const sharp = requireSharp();

const execFileAsync = promisify(execFile);
const { normalizeGridBoundaryGuides } = require('../05_切分插件/domain/guide_normalization');
const DEFAULT_NEUTRAL_PAPER_COLOR = Object.freeze({
  r: 216,
  g: 216,
  b: 216,
  gray: 216
});

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

function getQuadBounds(corners) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  return {
    left: Math.round(Math.min(...quad.map((point) => Number(point[0])))),
    right: Math.round(Math.max(...quad.map((point) => Number(point[0])))),
    top: Math.round(Math.min(...quad.map((point) => Number(point[1])))),
    bottom: Math.round(Math.max(...quad.map((point) => Number(point[1]))))
  };
}

function cloneSerializable(value) {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function buildLockedInferredOuterFrameSnapshot(inferredOuterFrame, lockedAt = null) {
  const snapshot = cloneSerializable(inferredOuterFrame);
  if (!snapshot || typeof snapshot !== 'object') {
    return snapshot;
  }
  snapshot.diagnostics = {
    ...(snapshot.diagnostics || {}),
    decoupledFromInnerFrame: true,
    innerFrameFeedbackDisabled: true,
    outerFrameLockedAt: lockedAt || null
  };
  return snapshot;
}

function solveLinearSystem(matrix, vector) {
  const size = Array.isArray(matrix) ? matrix.length : 0;
  if (!size || !Array.isArray(vector) || vector.length !== size) {
    return null;
  }
  const augmented = matrix.map((row, index) => [...row.map(Number), Number(vector[index])]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let maxRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[maxRow][pivot])) {
        maxRow = row;
      }
    }
    if (Math.abs(augmented[maxRow][pivot]) < 1e-9) {
      return null;
    }
    if (maxRow !== pivot) {
      [augmented[pivot], augmented[maxRow]] = [augmented[maxRow], augmented[pivot]];
    }
    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot][column] /= pivotValue;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) {
        continue;
      }
      const factor = augmented[row][pivot];
      if (!factor) {
        continue;
      }
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function computeHomographyMatrix(sourceQuad, targetQuad) {
  const src = normalizeCornerQuad(sourceQuad);
  const dst = normalizeCornerQuad(targetQuad);
  if (!src || !dst) {
    return null;
  }
  const matrix = [];
  const vector = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = src[index];
    const [u, v] = dst[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const solution = solveLinearSystem(matrix, vector);
  if (!solution) {
    return null;
  }
  return [
    [solution[0], solution[1], solution[2]],
    [solution[3], solution[4], solution[5]],
    [solution[6], solution[7], 1]
  ];
}

function applyHomographyToPoint(point, homography) {
  if (!Array.isArray(point) || point.length < 2 || !homography) {
    return null;
  }
  const x = Number(point[0]);
  const y = Number(point[1]);
  const denominator = (homography[2][0] * x) + (homography[2][1] * y) + homography[2][2];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return null;
  }
  const mappedX = ((homography[0][0] * x) + (homography[0][1] * y) + homography[0][2]) / denominator;
  const mappedY = ((homography[1][0] * x) + (homography[1][1] * y) + homography[1][2]) / denominator;
  return [mappedX, mappedY];
}

function projectRectifiedCropBoxToSourceQuad(sourceQuad, rectifiedMeta, cropBox) {
  const normalizedSourceQuad = normalizeCornerQuad(sourceQuad);
  const width = Number(rectifiedMeta?.targetWidth) || 0;
  const height = Number(rectifiedMeta?.targetHeight) || 0;
  if (!normalizedSourceQuad || width <= 1 || height <= 1 || !cropBox) {
    return null;
  }
  const left = Number(cropBox.left);
  const top = Number(cropBox.top);
  const right = Number(cropBox.right);
  const bottom = Number(cropBox.bottom);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return null;
  }
  const targetQuad = [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1]
  ];
  const inverseHomography = computeHomographyMatrix(targetQuad, normalizedSourceQuad);
  if (!inverseHomography) {
    return null;
  }
  const projectedQuad = normalizeCornerQuad([
    applyHomographyToPoint([left, top], inverseHomography),
    applyHomographyToPoint([right, top], inverseHomography),
    applyHomographyToPoint([right, bottom], inverseHomography),
    applyHomographyToPoint([left, bottom], inverseHomography)
  ]);
  if (!projectedQuad) {
    return null;
  }
  const trims = {
    left,
    top,
    right: Math.max(0, (width - 1) - right),
    bottom: Math.max(0, (height - 1) - bottom)
  };
  return {
    quad: projectedQuad,
    bounds: getQuadBounds(projectedQuad),
    rectifiedTrims: trims
  };
}

function projectSourceQuadToRectifiedPlane(sourceQuad, rectifiedMeta, subjectQuad) {
  const normalizedSourceQuad = normalizeCornerQuad(sourceQuad);
  const normalizedSubjectQuad = normalizeCornerQuad(subjectQuad);
  const width = Number(rectifiedMeta?.targetWidth) || 0;
  const height = Number(rectifiedMeta?.targetHeight) || 0;
  if (!normalizedSourceQuad || !normalizedSubjectQuad || width <= 1 || height <= 1) {
    return null;
  }
  const targetQuad = [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1]
  ];
  const homography = computeHomographyMatrix(normalizedSourceQuad, targetQuad);
  if (!homography) {
    return null;
  }
  const projectedQuad = normalizeCornerQuad(
    normalizedSubjectQuad.map((point) => applyHomographyToPoint(point, homography))
  );
  if (!projectedQuad) {
    return null;
  }
  return {
    quad: projectedQuad,
    bounds: getQuadBounds(projectedQuad)
  };
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
  const remapGuidePeaks = (peaks, previousStart, previousEnd, nextStart, nextEnd, cells) => {
    const sanitized = sanitizeGuidePeaks(peaks);
    const targetCount = Math.max(1, Number(cells) || 1) + 1;
    if (
      sanitized.length === targetCount
      && Number.isFinite(previousStart)
      && Number.isFinite(previousEnd)
      && previousEnd > previousStart
      && Number.isFinite(nextStart)
      && Number.isFinite(nextEnd)
      && nextEnd > nextStart
    ) {
      return sanitized.map((value, index) => {
        if (index === 0) {
          return nextStart;
        }
        if (index === sanitized.length - 1) {
          return nextEnd;
        }
        const ratio = (value - previousStart) / (previousEnd - previousStart);
        return nextStart + ratio * (nextEnd - nextStart);
      });
    }
    return buildUniformGuidePeaks(nextStart, nextEnd, Math.max(1, Number(cells) || 1));
  };
  const remappedGuides = {
    ...(fallbackGuides || {}),
    left,
    right,
    top,
    bottom,
    xPeaks: remapGuidePeaks(
      fallbackGuides?.xPeaks,
      Number(fallbackGuides?.left),
      Number(fallbackGuides?.right),
      left,
      right,
      gridCols
    ),
    yPeaks: remapGuidePeaks(
      fallbackGuides?.yPeaks,
      Number(fallbackGuides?.top),
      Number(fallbackGuides?.bottom),
      top,
      bottom,
      gridRows
    )
  };
  const preserveCornerAnchoredAxisPeaks = (peaks, remappedPeaks, startBound, endBound, cells) => {
    const expectedCount = Math.max(1, Number(cells) || 1) + 1;
    const nextStart = Number(startBound);
    const nextEnd = Number(endBound);
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) {
      return sanitizeGuidePeaks(peaks);
    }
    const candidatePeaks = sanitizeGuidePeaks(peaks);
    const remappedAxisPeaks = sanitizeGuidePeaks(remappedPeaks);
    const fallbackAxisPeaks = remappedAxisPeaks.length === expectedCount
      ? remappedAxisPeaks
      : buildUniformGuidePeaks(nextStart, nextEnd, Math.max(1, Number(cells) || 1));
    const candidateAxisPeaks = candidatePeaks.length === expectedCount
      ? candidatePeaks
      : fallbackAxisPeaks;
    const candidateIntervals = candidateAxisPeaks
      .slice(1)
      .map((value, index) => value - candidateAxisPeaks[index])
      .filter((gap) => gap > 0);
    const fallbackIntervals = fallbackAxisPeaks
      .slice(1)
      .map((value, index) => value - fallbackAxisPeaks[index])
      .filter((gap) => gap > 0);
    const referenceGap = median(
      candidateIntervals.length ? candidateIntervals : fallbackIntervals
    ) || Math.abs(nextEnd - nextStart) / Math.max(1, Number(cells) || 1);
    const boundaryTolerance = Math.max(6, Math.round(referenceGap * 0.08));
    const boundaryDrift = Math.max(
      Math.abs((candidateAxisPeaks[0] ?? nextStart) - nextStart),
      Math.abs((candidateAxisPeaks[candidateAxisPeaks.length - 1] ?? nextEnd) - nextEnd)
    );
    const resolvedPeaks = boundaryDrift > boundaryTolerance
      ? [...fallbackAxisPeaks]
      : [...candidateAxisPeaks];
    if (!resolvedPeaks.length) {
      return fallbackAxisPeaks;
    }
    resolvedPeaks[0] = nextStart;
    resolvedPeaks[resolvedPeaks.length - 1] = nextEnd;
    for (let index = 1; index < resolvedPeaks.length - 1; index += 1) {
      resolvedPeaks[index] = clamp(
        resolvedPeaks[index],
        resolvedPeaks[index - 1] + 1,
        resolvedPeaks[resolvedPeaks.length - 1] - Math.max(1, resolvedPeaks.length - 1 - index)
      );
    }
    return resolvedPeaks;
  };
  const enrichedGuides = buildGuidesFromRawPeaks(remappedGuides, gridRows, gridCols);
  const mergedGuides = enrichedGuides
    ? {
        ...remappedGuides,
        ...enrichedGuides
      }
    : remappedGuides;
  return {
    ...mergedGuides,
    left,
    right,
    top,
    bottom,
    xPeaks: preserveCornerAnchoredAxisPeaks(
      mergedGuides?.xPeaks,
      remappedGuides.xPeaks,
      left,
      right,
      gridCols
    ),
    yPeaks: preserveCornerAnchoredAxisPeaks(
      mergedGuides?.yPeaks,
      remappedGuides.yPeaks,
      top,
      bottom,
      gridRows
    )
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

function preventStandaloneTopOutwardExpansion(corners, guides, topGuideConfirmation, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad || !guides || !topGuideConfirmation) {
    return {
      corners: quad,
      applied: false,
      diagnostics: null
    };
  }

  const confirmedTop = Number(topGuideConfirmation.refinedTop);
  const left = Number(guides.left);
  const right = Number(guides.right);
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(24, Math.round(options.cellWidth || getMedianGap(xPeaks, 0)));
  const cellHeight = Math.max(24, Math.round(options.cellHeight || getMedianGap(yPeaks, 0)));
  const yPattern = pickFirstNonNull(
    guides?.yPattern,
    guides?.yPatternDiagnostics?.mode,
    guides?.globalPattern?.y?.mode,
    guides?.globalPattern?.mode
  );
  const ySymmetryEligible = Boolean(pickFirstNonNull(
    guides?.yPatternDiagnostics?.symmetry?.eligible,
    guides?.globalPattern?.symmetry?.y?.eligible,
    guides?.globalPattern?.symmetry?.eligible
  ));
  const leftAnchorScore = Number(topGuideConfirmation?.anchors?.leftTop?.score || 0);
  const rightAnchorScore = Number(topGuideConfirmation?.anchors?.rightTop?.score || 0);
  const minReliableAnchorScore = Math.max(42, Math.round(cellHeight * 0.22));
  if (![confirmedTop, left, right].every(Number.isFinite)) {
    return {
      corners: quad,
      applied: false,
      diagnostics: null
    };
  }

  const topOvershootThreshold = Math.max(12, Math.round(cellHeight * 0.25));
  const sideTolerance = Math.max(12, Math.round(cellWidth * 0.08));
  const leftTop = quad[0];
  const rightTop = quad[1];
  const leftOvershoot = confirmedTop - leftTop[1];
  const rightOvershoot = confirmedTop - rightTop[1];
  const leftSideTight = Math.abs(leftTop[0] - left) <= sideTolerance;
  const rightSideTight = Math.abs(rightTop[0] - right) <= sideTolerance;
  const shouldClamp = (
    leftOvershoot > topOvershootThreshold
    && rightOvershoot > topOvershootThreshold
    && leftSideTight
    && rightSideTight
  );
  const diagnostics = {
    confirmedTop,
    yPattern: yPattern || null,
    ySymmetryEligible,
    leftAnchorScore: Number(leftAnchorScore.toFixed(3)),
    rightAnchorScore: Number(rightAnchorScore.toFixed(3)),
    minReliableAnchorScore,
    topOvershootThreshold,
    sideTolerance,
    leftOvershoot: Number(leftOvershoot.toFixed(3)),
    rightOvershoot: Number(rightOvershoot.toFixed(3)),
    leftSideTight,
    rightSideTight,
    applied: shouldClamp
  };
  if (
    yPattern !== 'uniform-boundary-grid'
    || !ySymmetryEligible
    || Math.min(leftAnchorScore, rightAnchorScore) < minReliableAnchorScore
  ) {
    return {
      corners: quad,
      applied: false,
      diagnostics: {
        ...diagnostics,
        applied: false,
        skippedReason: 'top-guide-confirmation-not-stable-enough-for-clamp'
      }
    };
  }
  if (!shouldClamp) {
    return {
      corners: quad,
      applied: false,
      diagnostics
    };
  }

  const leftAnchor = Array.isArray(topGuideConfirmation.anchors?.leftTop)
    ? topGuideConfirmation.anchors.leftTop
    : null;
  const rightAnchor = Array.isArray(topGuideConfirmation.anchors?.rightTop)
    ? topGuideConfirmation.anchors.rightTop
    : null;
  const corrected = [
    [
      clamp(Number.isFinite(Number(leftAnchor?.[0])) ? Number(leftAnchor[0]) : leftTop[0], left - sideTolerance, left + sideTolerance),
      confirmedTop
    ],
    [
      clamp(Number.isFinite(Number(rightAnchor?.[0])) ? Number(rightAnchor[0]) : rightTop[0], right - sideTolerance, right + sideTolerance),
      confirmedTop
    ],
    [...quad[2]],
    [...quad[3]]
  ];
  return {
    corners: normalizeCornerQuad(corrected) || quad,
    applied: true,
    diagnostics
  };
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

function buildNamedCornerMapFromQuad(corners) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  const [leftTop, rightTop, rightBottom, leftBottom] = quad;
  return {
    leftTop,
    rightTop,
    rightBottom,
    leftBottom
  };
}

function attachFinalAppliedCornerDiagnostics(cornerRefinement, corners, extra = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!cornerRefinement || !quad) {
    return cornerRefinement || null;
  }
  return {
    ...cornerRefinement,
    ...extra,
    finalAppliedCorners: buildNamedCornerMapFromQuad(quad),
    finalAppliedQuad: quad
  };
}

function applyVerticalSideConsistency(refinedCorners, diagnostics, options = {}) {
  const {
    guideLeft = null,
    guideRight = null,
    cellWidth = 0,
    enabled = false
  } = options;
  if (!enabled) {
    return refinedCorners;
  }

  const applyOneSide = ({ side, topIndex, bottomIndex, topKey, bottomKey, guideX, inwardIsPositive }) => {
    if (!Number.isFinite(guideX) || !Array.isArray(refinedCorners[topIndex]) || !Array.isArray(refinedCorners[bottomIndex])) {
      return;
    }
    const topPoint = refinedCorners[topIndex];
    const bottomPoint = refinedCorners[bottomIndex];
    const bottomCornerDetail = diagnostics[bottomKey] || null;
    const bottomAnchor = bottomCornerDetail?.bottomCornerAnchor || null;
    const bottomAnchorPoint = Array.isArray(bottomAnchor?.afterClamp)
      ? bottomAnchor.afterClamp
      : (Array.isArray(bottomAnchor?.candidate) ? bottomAnchor.candidate : null);
    const bottomAnchorX = Number(bottomAnchorPoint?.[0]);
    const bottomAnchorScore = Number(bottomAnchor?.candidateScore);
    const bottomCornerScore = Number(bottomCornerDetail?.cornerScore);
    const preserveBottomAnchorTilt = Boolean(
      bottomAnchor?.applied
      && Number.isFinite(bottomAnchorX)
      && Number.isFinite(bottomAnchorScore)
      && bottomAnchorScore >= Math.max(96, bottomCornerScore * 1.22)
    );
    if (preserveBottomAnchorTilt) {
      const skipPayload = {
        skipped: true,
        reason: 'preserve-strong-bottom-anchor-tilt',
        [side === 'left' ? 'guideLeft' : 'guideRight']: Number(guideX),
        anchorX: Number(bottomAnchorX.toFixed(3)),
        anchorScore: Number(bottomAnchorScore.toFixed(3)),
        cornerScore: Number.isFinite(bottomCornerScore) ? Number(bottomCornerScore.toFixed(3)) : null
      };
      if (diagnostics[topKey]) {
        diagnostics[topKey][side === 'left' ? 'leftSideConsistency' : 'rightSideConsistency'] = {
          ...skipPayload,
          role: topKey
        };
      }
      if (diagnostics[bottomKey]) {
        diagnostics[bottomKey][side === 'left' ? 'leftSideConsistency' : 'rightSideConsistency'] = {
          ...skipPayload,
          role: bottomKey
        };
      }
      return;
    }
    const outwardTolerance = Math.max(8, Math.round(cellWidth * 0.035));
    const inwardTolerance = Math.max(8, Math.round(cellWidth * 0.03));
    const averagedX = average([Number(topPoint[0]), Number(bottomPoint[0])]);
    const spread = Math.abs(Number(topPoint[0]) - Number(bottomPoint[0]));
    const guideWeight = spread <= Math.max(4, Math.round(cellWidth * 0.015)) ? 0.8 : 0.65;
    const sharedX = inwardIsPositive
      ? clamp((guideX * guideWeight) + (averagedX * (1 - guideWeight)), guideX - outwardTolerance, guideX + inwardTolerance)
      : clamp((guideX * guideWeight) + (averagedX * (1 - guideWeight)), guideX - inwardTolerance, guideX + outwardTolerance);
    const payload = {
      before: side === 'left'
        ? { leftTopX: Number(topPoint[0]), leftBottomX: Number(bottomPoint[0]) }
        : { rightTopX: Number(topPoint[0]), rightBottomX: Number(bottomPoint[0]) },
      [`averaged${side === 'left' ? 'Left' : 'Right'}X`]: Number(averagedX.toFixed(3)),
      spread: Number(spread.toFixed(3)),
      guideWeight: Number(guideWeight.toFixed(3)),
      [`shared${side === 'left' ? 'Left' : 'Right'}X`]: Number(sharedX.toFixed(3)),
      [side === 'left' ? 'guideLeft' : 'guideRight']: Number(guideX),
      outwardTolerance,
      inwardTolerance,
      applied: Math.abs(Number(topPoint[0]) - sharedX) >= 1 || Math.abs(Number(bottomPoint[0]) - sharedX) >= 1
    };
    refinedCorners[topIndex] = [sharedX, topPoint[1]];
    refinedCorners[bottomIndex] = [sharedX, bottomPoint[1]];
    if (diagnostics[topKey]) {
      diagnostics[topKey].refined = refinedCorners[topIndex];
      diagnostics[topKey][side === 'left' ? 'leftSideConsistency' : 'rightSideConsistency'] = {
        ...payload,
        role: topKey
      };
    }
    if (diagnostics[bottomKey]) {
      diagnostics[bottomKey].refined = refinedCorners[bottomIndex];
      diagnostics[bottomKey][side === 'left' ? 'leftSideConsistency' : 'rightSideConsistency'] = {
        ...payload,
        role: bottomKey
      };
    }
  };

  applyOneSide({ side: 'left', topIndex: 0, bottomIndex: 3, topKey: 'leftTop', bottomKey: 'leftBottom', guideX: guideLeft, inwardIsPositive: true });
  applyOneSide({ side: 'right', topIndex: 1, bottomIndex: 2, topKey: 'rightTop', bottomKey: 'rightBottom', guideX: guideRight, inwardIsPositive: false });
  return refinedCorners;
}

function applyVerticalSideTiltConsistency(refinedCorners, diagnostics, options = {}) {
  const {
    coarseVerticalEndpoints = null,
    guideLeft = null,
    guideRight = null,
    cellWidth = 0,
    enabled = false
  } = options;
  if (!enabled || !coarseVerticalEndpoints) {
    return refinedCorners;
  }

  const configs = [
    {
      side: 'left',
      topIndex: 0,
      bottomIndex: 3,
      topKey: 'leftTop',
      bottomKey: 'leftBottom',
      coarseTop: coarseVerticalEndpoints.leftTop,
      coarseBottom: coarseVerticalEndpoints.leftBottom,
      minX: Number.isFinite(guideLeft) ? guideLeft - Math.max(8, Math.round(cellWidth * 0.035)) : null,
      maxX: Number.isFinite(guideLeft) ? guideLeft + Math.max(8, Math.round(cellWidth * 0.03)) : null
    },
    {
      side: 'right',
      topIndex: 1,
      bottomIndex: 2,
      topKey: 'rightTop',
      bottomKey: 'rightBottom',
      coarseTop: coarseVerticalEndpoints.rightTop,
      coarseBottom: coarseVerticalEndpoints.rightBottom,
      minX: Number.isFinite(guideRight) ? guideRight - Math.max(8, Math.round(cellWidth * 0.03)) : null,
      maxX: Number.isFinite(guideRight) ? guideRight + Math.max(8, Math.round(cellWidth * 0.035)) : null
    }
  ];

  for (const config of configs) {
    if (
      !Array.isArray(refinedCorners[config.topIndex])
      || !Array.isArray(refinedCorners[config.bottomIndex])
      || !Array.isArray(config.coarseTop)
      || !Array.isArray(config.coarseBottom)
    ) {
      continue;
    }
    const localTop = refinedCorners[config.topIndex];
    const localBottom = refinedCorners[config.bottomIndex];
    const coarseTopX = Number(config.coarseTop[0]);
    const coarseBottomX = Number(config.coarseBottom[0]);
    const bottomCornerDetail = diagnostics[config.bottomKey] || null;
    const bottomAnchor = bottomCornerDetail?.bottomCornerAnchor || null;
    const bottomAnchorPoint = Array.isArray(bottomAnchor?.afterClamp)
      ? bottomAnchor.afterClamp
      : (Array.isArray(bottomAnchor?.candidate) ? bottomAnchor.candidate : null);
    const bottomAnchorX = Number(bottomAnchorPoint?.[0]);
    const bottomAnchorScore = Number(bottomAnchor?.candidateScore);
    const bottomCornerScore = Number(bottomCornerDetail?.cornerScore);
    const preserveBottomAnchorTilt = Boolean(
      bottomAnchor?.applied
      && Number.isFinite(bottomAnchorX)
      && Number.isFinite(bottomAnchorScore)
      && bottomAnchorScore >= Math.max(96, bottomCornerScore * 1.22)
    );
    const effectiveMinX = preserveBottomAnchorTilt && Number.isFinite(bottomAnchorX)
      ? Math.min(
        Number(config.minX),
        bottomAnchorX - Math.max(6, Math.round(cellWidth * 0.03))
      )
      : Number(config.minX);
    const effectiveMaxX = preserveBottomAnchorTilt && Number.isFinite(bottomAnchorX)
      ? Math.max(
        Number(config.maxX),
        bottomAnchorX + Math.max(6, Math.round(cellWidth * 0.03))
      )
      : Number(config.maxX);
    if (![coarseTopX, coarseBottomX, effectiveMinX, effectiveMaxX].every(Number.isFinite)) {
      continue;
    }
    const localSpread = Math.abs(Number(localTop[0]) - Number(localBottom[0]));
    const coarseSpread = Math.abs(coarseTopX - coarseBottomX);
    let coarseWeight = localSpread <= Math.max(4, Math.round(cellWidth * 0.015)) ? 0.8 : 0.35;
    if (preserveBottomAnchorTilt) {
      coarseWeight = Math.min(coarseWeight, 0.28);
    }
    const tiltedTopX = clamp((coarseTopX * coarseWeight) + (Number(localTop[0]) * (1 - coarseWeight)), effectiveMinX, effectiveMaxX);
    let tiltedBottomX = clamp((coarseBottomX * coarseWeight) + (Number(localBottom[0]) * (1 - coarseWeight)), effectiveMinX, effectiveMaxX);
    if (preserveBottomAnchorTilt) {
      tiltedBottomX = clamp(
        (bottomAnchorX * 0.48) + (tiltedBottomX * 0.52),
        effectiveMinX,
        effectiveMaxX
      );
    }
    const payload = {
      side: config.side,
      coarseTopX: Number(coarseTopX.toFixed(3)),
      coarseBottomX: Number(coarseBottomX.toFixed(3)),
      localTopX: Number(Number(localTop[0]).toFixed(3)),
      localBottomX: Number(Number(localBottom[0]).toFixed(3)),
      localSpread: Number(localSpread.toFixed(3)),
      coarseSpread: Number(coarseSpread.toFixed(3)),
      coarseWeight: Number(coarseWeight.toFixed(3)),
      tiltedTopX: Number(tiltedTopX.toFixed(3)),
      tiltedBottomX: Number(tiltedBottomX.toFixed(3)),
      preserveBottomAnchorTilt,
      bottomAnchorX: Number.isFinite(bottomAnchorX) ? Number(bottomAnchorX.toFixed(3)) : null,
      applied: Math.abs(tiltedTopX - Number(localTop[0])) >= 1 || Math.abs(tiltedBottomX - Number(localBottom[0])) >= 1
    };
    refinedCorners[config.topIndex] = [tiltedTopX, localTop[1]];
    refinedCorners[config.bottomIndex] = [tiltedBottomX, localBottom[1]];
    if (diagnostics[config.topKey]) {
      diagnostics[config.topKey].refined = refinedCorners[config.topIndex];
      diagnostics[config.topKey].sideTiltConsistency = { ...payload, role: config.topKey };
    }
    if (diagnostics[config.bottomKey]) {
      diagnostics[config.bottomKey].refined = refinedCorners[config.bottomIndex];
      diagnostics[config.bottomKey].sideTiltConsistency = { ...payload, role: config.bottomKey };
    }
  }
  return refinedCorners;
}

function protectCollapsedTopSpan(quad, diagnostics, guides, options = {}) {
  const normalized = normalizeCornerQuad(quad);
  const localLeftTop = diagnostics?.leftTop?.refined;
  const localRightTop = diagnostics?.rightTop?.refined;
  const localLeftBottom = diagnostics?.leftBottom?.refined;
  const localRightBottom = diagnostics?.rightBottom?.refined;
  const guideLeft = Number(guides?.left);
  const guideRight = Number(guides?.right);
  const cellWidth = Number(options.cellWidth) || 0;
  if (
    !normalized
    || !Array.isArray(localLeftTop)
    || !Array.isArray(localRightTop)
    || !Array.isArray(localLeftBottom)
    || !Array.isArray(localRightBottom)
    || !Number.isFinite(guideLeft)
    || !Number.isFinite(guideRight)
    || guideRight <= guideLeft
  ) {
    return {
      corners: normalized || quad,
      applied: false,
      diagnostics: null
    };
  }

  const guideWidth = guideRight - guideLeft;
  const topWidth = Math.abs(Number(normalized[1][0]) - Number(normalized[0][0]));
  const bottomWidth = Math.abs(Number(normalized[2][0]) - Number(normalized[3][0]));
  const localTopWidth = Math.abs(Number(localRightTop[0]) - Number(localLeftTop[0]));
  const localBottomWidth = Math.abs(Number(localRightBottom[0]) - Number(localLeftBottom[0]));
  const localLeftScore = Number(diagnostics?.leftTop?.cornerScore) || 0;
  const localRightScore = Number(diagnostics?.rightTop?.cornerScore) || 0;
  const collapseThreshold = Math.max(guideWidth * 0.3, cellWidth * 1.6, 120);
  const localMinWidth = Math.max(guideWidth * 0.72, cellWidth * 4.2, 320);
  const bottomMinWidth = Math.max(guideWidth * 0.72, cellWidth * 4.2, 320);
  const repairDiagnostics = {
    topWidth: Number(topWidth.toFixed(3)),
    bottomWidth: Number(bottomWidth.toFixed(3)),
    localTopWidth: Number(localTopWidth.toFixed(3)),
    localBottomWidth: Number(localBottomWidth.toFixed(3)),
    guideWidth: Number(guideWidth.toFixed(3)),
    collapseThreshold: Number(collapseThreshold.toFixed(3)),
    localLeftScore: Number(localLeftScore.toFixed(3)),
    localRightScore: Number(localRightScore.toFixed(3)),
    applied: false
  };
  const shouldRepair = (
    topWidth < collapseThreshold
    && localTopWidth >= localMinWidth
    && bottomWidth >= bottomMinWidth
    && localBottomWidth >= bottomMinWidth
    && localLeftScore >= 58
    && localRightScore >= 58
  );
  if (!shouldRepair) {
    return {
      corners: normalized,
      applied: false,
      diagnostics: repairDiagnostics
    };
  }

  const outwardTolerance = Math.max(8, Math.round(cellWidth * 0.04));
  const inwardTolerance = Math.max(10, Math.round(cellWidth * 0.06));
  const repaired = [
    [
      clamp(Number(localLeftTop[0]), guideLeft - outwardTolerance, guideLeft + inwardTolerance),
      Number(normalized[0][1])
    ],
    [
      clamp(Number(localRightTop[0]), guideRight - inwardTolerance, guideRight + outwardTolerance),
      Number(normalized[1][1])
    ],
    [...normalized[2]],
    [...normalized[3]]
  ];
  repairDiagnostics.applied = true;
  return {
    corners: normalizeCornerQuad(repaired) || normalized,
    applied: true,
    diagnostics: repairDiagnostics
  };
}

function applyHorizontalTiltConsistency(normalizedRefined, diagnostics, options = {}) {
  const {
    enabled = false,
    leftBottomPriorityMode = false,
    outerFrameDetected = false,
    preferredTopLeftAnchor = null,
    preferredTopRightAnchor = null,
    preferredBottomLeftAnchor = null,
    preferredBottomRightAnchor = null,
    guideLeft = null,
    guideRight = null,
    cellWidth = 0,
    cellHeight = 0
  } = options;
  if (!enabled || !normalizedRefined || !leftBottomPriorityMode || outerFrameDetected) {
    return normalizeCornerQuad(normalizedRefined) || normalizedRefined;
  }

  const topBottomTiltConfigs = [
    {
      side: 'top',
      leftIndex: 0,
      rightIndex: 1,
      leftKey: 'leftTop',
      rightKey: 'rightTop',
      leftAnchor: preferredTopLeftAnchor,
      rightAnchor: preferredTopRightAnchor,
      leftGuideX: guideLeft,
      rightGuideX: guideRight
    },
    {
      side: 'bottom',
      leftIndex: 3,
      rightIndex: 2,
      leftKey: 'leftBottom',
      rightKey: 'rightBottom',
      leftAnchor: preferredBottomLeftAnchor,
      rightAnchor: preferredBottomRightAnchor,
      leftGuideX: guideLeft,
      rightGuideX: guideRight
    }
  ];

  for (const config of topBottomTiltConfigs) {
    if (
      !Array.isArray(config.leftAnchor)
      || !Array.isArray(config.rightAnchor)
      || !Array.isArray(normalizedRefined[config.leftIndex])
      || !Array.isArray(normalizedRefined[config.rightIndex])
    ) {
      continue;
    }
    const guideXTolerance = Math.max(10, Math.round(cellWidth * 0.05));
    const anchorBandY = average([Number(config.leftAnchor[1]), Number(config.rightAnchor[1])]);
    const localBandY = average([Number(normalizedRefined[config.leftIndex][1]), Number(normalizedRefined[config.rightIndex][1])]);
    const bandYTolerance = Math.max(20, Math.round(cellHeight * 0.12));
    if (
      !Number.isFinite(config.leftGuideX)
      || !Number.isFinite(config.rightGuideX)
      || Math.abs(Number(config.leftAnchor[0]) - config.leftGuideX) > guideXTolerance
      || Math.abs(Number(config.rightAnchor[0]) - config.rightGuideX) > guideXTolerance
      || !Number.isFinite(anchorBandY)
      || !Number.isFinite(localBandY)
    ) {
      continue;
    }
    const localLeft = normalizedRefined[config.leftIndex];
    const localRight = normalizedRefined[config.rightIndex];
    const leftBottomCornerDetail = diagnostics[config.leftKey] || null;
    const rightBottomCornerDetail = diagnostics[config.rightKey] || null;
    const hasStrongBottomAnchorX = (detail) => {
      const bottomAnchor = detail?.bottomCornerAnchor || null;
      const anchorScore = Number(bottomAnchor?.candidateScore);
      const cornerScore = Number(detail?.cornerScore);
      return Boolean(
        config.side === 'bottom'
        && bottomAnchor?.applied
        && Number.isFinite(anchorScore)
        && anchorScore >= Math.max(96, cornerScore * 1.22)
      );
    };
    const preserveLeftBottomAnchorX = hasStrongBottomAnchorX(leftBottomCornerDetail);
    const preserveRightBottomAnchorX = hasStrongBottomAnchorX(rightBottomCornerDetail);
    const localSpreadY = Math.abs(Number(localLeft[1]) - Number(localRight[1]));
    const anchorSpreadY = Math.abs(Number(config.leftAnchor[1]) - Number(config.rightAnchor[1]));
    const anchorWeight = localSpreadY <= Math.max(4, Math.round(cellHeight * 0.015)) ? 0.8 : 0.45;
    if (Math.abs(anchorBandY - localBandY) > bandYTolerance * 1.6 && config.side === 'top') {
      continue;
    }
    const sharedTiltY = clamp(
      anchorBandY * anchorWeight + localBandY * (1 - anchorWeight),
      anchorBandY - bandYTolerance,
      anchorBandY + bandYTolerance
    );
    const adjustedLeft = [
      preserveLeftBottomAnchorX
        ? Number(localLeft[0])
        : (Number(config.leftAnchor[0]) * anchorWeight + Number(localLeft[0]) * (1 - anchorWeight)),
      sharedTiltY
    ];
    const adjustedRight = [
      preserveRightBottomAnchorX
        ? Number(localRight[0])
        : (Number(config.rightAnchor[0]) * anchorWeight + Number(localRight[0]) * (1 - anchorWeight)),
      sharedTiltY
    ];
    const payload = {
      side: config.side,
      anchorWeight: Number(anchorWeight.toFixed(3)),
      localSpreadY: Number(localSpreadY.toFixed(3)),
      anchorSpreadY: Number(anchorSpreadY.toFixed(3)),
      anchorBandY: Number(anchorBandY.toFixed(3)),
      localBandY: Number(localBandY.toFixed(3)),
      sharedTiltY: Number(sharedTiltY.toFixed(3)),
      leftAnchor: config.leftAnchor.map((value) => Number(Number(value).toFixed(3))),
      rightAnchor: config.rightAnchor.map((value) => Number(Number(value).toFixed(3))),
      preserveLeftBottomAnchorX,
      preserveRightBottomAnchorX,
      adjustedLeft: adjustedLeft.map((value) => Number(Number(value).toFixed(3))),
      adjustedRight: adjustedRight.map((value) => Number(Number(value).toFixed(3))),
      applied: (
        Math.abs(adjustedLeft[0] - Number(localLeft[0])) >= 1
        || Math.abs(adjustedLeft[1] - Number(localLeft[1])) >= 1
        || Math.abs(adjustedRight[0] - Number(localRight[0])) >= 1
        || Math.abs(adjustedRight[1] - Number(localRight[1])) >= 1
      )
    };
    normalizedRefined[config.leftIndex] = adjustedLeft;
    normalizedRefined[config.rightIndex] = adjustedRight;
    if (diagnostics[config.leftKey]) {
      diagnostics[config.leftKey].refined = adjustedLeft;
      diagnostics[config.leftKey].horizontalTiltConsistency = { ...payload, role: config.leftKey };
    }
    if (diagnostics[config.rightKey]) {
      diagnostics[config.rightKey].refined = adjustedRight;
      diagnostics[config.rightKey].horizontalTiltConsistency = { ...payload, role: config.rightKey };
    }
  }
  return normalizeCornerQuad(normalizedRefined) || normalizedRefined;
}

function computeConsistencyAdjustmentDiagnostics(diagnostics) {
  const signals = Object.values(diagnostics || {}).map((detail) => {
    if (!detail) {
      return 0;
    }
    return [
      detail.leftSideConsistency?.applied,
      detail.rightSideConsistency?.applied,
      detail.sideTiltConsistency?.applied,
      detail.horizontalTiltConsistency?.applied,
      detail.topGuideAdjusted?.applied
    ].filter(Boolean).length;
  });
  return {
    signals,
    score: clamp01(average(signals) / 2.6),
    perCorner: {
      leftTop: Number(signals[0] || 0),
      rightTop: Number(signals[1] || 0),
      rightBottom: Number(signals[2] || 0),
      leftBottom: Number(signals[3] || 0)
    }
  };
}

function buildQuadCandidateEntries(options = {}) {
  const {
    normalizedRefined,
    localCornerConfidence = 0,
    consistencyAdjustmentScore = 0,
    edgeQuad = null,
    edgeConfidence = 0,
    localStabilizedQuad = null,
    edgeStabilizedQuad = null,
    wholeCornerConsistencyQuad = null,
    selectiveWholeCornerConsistencyQuad = null,
    topAnchorBandAlignedQuad = null,
    uncertaintyRetainedQuad = null,
    supportAlignedQuad = null,
    selectiveReplacementQuad = null,
    mergedQuad = null,
    cellHeight = 0
  } = options;
  return [
    {
      name: 'local-corner-fallback',
      quad: normalizedRefined,
      supportScore: localCornerConfidence,
      distancePenaltyScale: Math.max(20, cellHeight * 0.18)
    },
    {
      name: 'consistency-aligned-local',
      quad: normalizedRefined,
      supportScore: clamp01(
        localCornerConfidence * 0.92
        + consistencyAdjustmentScore * 0.14
      ),
      distancePenaltyScale: Math.max(18, cellHeight * 0.16)
    },
    {
      name: 'local-corner-stabilized',
      quad: localStabilizedQuad,
      supportScore: clamp01(
        localCornerConfidence * 0.98
        + consistencyAdjustmentScore * 0.08
      ),
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
      name: 'whole-corner-consistency',
      quad: wholeCornerConsistencyQuad,
      supportScore: average([
        localCornerConfidence * 0.98,
        edgeConfidence * 0.78
      ].filter((value) => Number.isFinite(value))),
      distancePenaltyScale: Math.max(18, cellHeight * 0.15)
    },
    {
      name: 'selective-whole-corner-consistency',
      quad: selectiveWholeCornerConsistencyQuad,
      supportScore: average([
        localCornerConfidence * 0.99,
        edgeConfidence * 0.82
      ].filter((value) => Number.isFinite(value))),
      distancePenaltyScale: Math.max(18, cellHeight * 0.14)
    },
    {
      name: 'top-anchor-band-aligned',
      quad: topAnchorBandAlignedQuad,
      supportScore: average([
        localCornerConfidence * 0.96,
        edgeConfidence * 0.84
      ].filter((value) => Number.isFinite(value))),
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
      name: 'support-aligned-guides',
      quad: supportAlignedQuad,
      supportScore: average([
        localCornerConfidence * 0.8,
        edgeConfidence * 0.72,
        0.82
      ].filter((value) => Number.isFinite(value))),
      distancePenaltyScale: Math.max(16, cellHeight * 0.14)
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
}

function scoreQuadCandidates(candidateEntries, options = {}) {
  const {
    guides = null,
    rawGuideHints = null,
    cellWidth = 0,
    cellHeight = 0,
    edgeLineInputs = null,
    gray = null,
    imageWidth = 0,
    imageHeight = 0,
    normalizedRefined = null,
    perCornerConfidence = [],
    preferredTopBandY = null,
    preferredBottomBandY = null
  } = options;
  const strictTopLeftIntervalPattern = shouldApplyStrictTopLeftIntervalGateFromDiagnostics(rawGuideHints?.diagnostics || {});
  return candidateEntries.map((entry) => {
    const normalizedCandidate = normalizeCornerQuad(entry.quad);
    const rectangularity = evaluateRectangularQuadQuality(normalizedCandidate, { guides });
    const innerGridSupport = evaluateInnerGridSupportFromRawHints(
      normalizedCandidate,
      rawGuideHints,
      {
        cellWidth,
        cellHeight
      }
    );
    const edgeInkQuality = evaluateCandidateQuadInkQuality(
      normalizedCandidate,
      edgeLineInputs,
      gray,
      imageWidth,
      imageHeight
    );
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
    const edgeInkScore = edgeInkQuality?.overallConfidence ?? 0;
    const edgeDarknessScore = edgeInkQuality?.overallDarkness ?? 0;
    const structuralMinEdgeScore = edgeInkQuality?.structuralMinConfidence ?? 0;
    const innerGridSupportScore = innerGridSupport?.supportScore ?? 0;
    const innerGridSupportEligibleCount = innerGridSupport?.eligibleCount ?? 0;
    const innerGridSupportPenalty = innerGridSupport?.eligible
      ? 1
      : clamp01(
          innerGridSupportScore * 0.12
          + innerGridSupportEligibleCount * 0.22
        );
    const leftSupport = innerGridSupport?.sides?.left || null;
    const topSupport = innerGridSupport?.sides?.top || null;
    const topLeftSupportPriority = strictTopLeftIntervalPattern
      ? average([
          leftSupport?.eligible ? Math.max(Number(leftSupport?.score) || 0, Number(leftSupport?.intervalSupportScore) || 0) : 0,
          topSupport?.eligible ? Math.max(Number(topSupport?.score) || 0, Number(topSupport?.intervalSupportScore) || 0) : 0
        ])
      : 0;
    const missingTopAllowedPenalty = (
      edgeInkQuality?.weakestEdge?.name === 'top'
      && (edgeInkQuality?.weakestEdge?.confidence ?? 0) < 0.28
    ) ? 1 : 0;
    const structuralPenalty = missingTopAllowedPenalty
      ? 1
      : Math.max(
          clamp01((structuralMinEdgeScore - 0.18) / 0.24),
          clamp01((innerGridSupportEligibleCount - 2) / 2.2)
        );
    const totalScore = clamp01(
      innerGridSupportScore * 0.38
      + edgeInkScore * 0.2
      + edgeDarknessScore * 0.12
      + rectangleScore * 0.14
      + bandAlignmentScore * 0.04
      + (Number.isFinite(entry.supportScore) ? entry.supportScore : 0) * 0.04
      + (Number.isFinite(guideScore) ? guideScore : rectangleScore) * 0.03
      + cornerRetentionScore * 0.03
      + topLeftSupportPriority * 0.02
      + (1 - distancePenalty) * 0.02
    ) * structuralPenalty * innerGridSupportPenalty;
    return {
      ...entry,
      quad: normalizedCandidate,
      innerGridSupport,
      edgeInkQuality,
      meanShift,
      maxShift,
      weightedCornerShift,
      cornerRetentionScore,
      bandAlignmentScore,
      topBandAlignmentScore,
      bottomBandAlignmentScore,
      distancePenalty,
      topLeftSupportPriority,
      rectangularity,
      totalScore
    };
  }).sort((a, b) => b.totalScore - a.totalScore);
}

function findQuadCandidateByName(scoredCandidates, name) {
  return scoredCandidates.find((entry) => entry.name === name) || null;
}

function sortWholeConsistencyPriorityCandidates(candidates) {
  return [...candidates].filter(Boolean).sort((a, b) => {
    const rotatedDelta = (b.rectangularity?.rotatedRectangleScore || 0) - (a.rectangularity?.rotatedRectangleScore || 0);
    if (Math.abs(rotatedDelta) > 1e-6) {
      return rotatedDelta;
    }
    const rectangleDelta = (b.rectangularity?.score || 0) - (a.rectangularity?.score || 0);
    if (Math.abs(rectangleDelta) > 1e-6) {
      return rectangleDelta;
    }
    const retentionDelta = (b.cornerRetentionScore || 0) - (a.cornerRetentionScore || 0);
    if (Math.abs(retentionDelta) > 1e-6) {
      return retentionDelta;
    }
    return (a.maxShift || 0) - (b.maxShift || 0);
  });
}

function sortCircleMiInnerFrameRescueCandidates(candidates, cellHeight = 0) {
  return [...candidates].filter(Boolean).sort((a, b) => {
    const aRescueScore = (
      (a.rectangularity?.rotatedRectangleScore || 0) * 0.4
      + (a.rectangularity?.score || 0) * 0.24
      + (a.cornerRetentionScore || 0) * 0.24
      + clamp01(1 - (a.maxShift || 0) / Math.max(36, cellHeight * 0.24)) * 0.12
    );
    const bRescueScore = (
      (b.rectangularity?.rotatedRectangleScore || 0) * 0.4
      + (b.rectangularity?.score || 0) * 0.24
      + (b.cornerRetentionScore || 0) * 0.24
      + clamp01(1 - (b.maxShift || 0) / Math.max(36, cellHeight * 0.24)) * 0.12
    );
    if (Math.abs(bRescueScore - aRescueScore) > 1e-6) {
      return bRescueScore - aRescueScore;
    }
    return (b.totalScore || 0) - (a.totalScore || 0);
  });
}

function selectRectanglePriorityCandidate(scoredCandidates) {
  return scoredCandidates
    .filter((entry) => entry.name !== 'local-corner-fallback' && entry.name !== 'local-corner-stabilized')
    .sort((a, b) => {
      const rectangleDelta = (b.rectangularity?.score || 0) - (a.rectangularity?.score || 0);
      if (Math.abs(rectangleDelta) > 1e-6) {
        return rectangleDelta;
      }
      return (b.supportScore || 0) - (a.supportScore || 0);
    })[0] || null;
}

function applyCandidateOverride(currentBestCandidate, nextCandidate, reason) {
  if (!nextCandidate || nextCandidate.name === currentBestCandidate?.name) {
    return {
      bestCandidate: currentBestCandidate,
      overrideReason: null
    };
  }
  return {
    bestCandidate: nextCandidate,
    overrideReason: reason
  };
}

function applyConditionalCandidateOverride(config = {}) {
  const {
    currentBestCandidate = null,
    shouldApply = false,
    nextCandidate = null,
    reason = ''
  } = config;
  if (!shouldApply) {
    return {
      bestCandidate: currentBestCandidate,
      overrideReason: null
    };
  }
  return applyCandidateOverride(currentBestCandidate, nextCandidate, reason);
}

function mergeCandidateOverrideResult(currentBestCandidate, currentOverrideReason, overrideResult = {}) {
  return {
    bestCandidate: overrideResult.bestCandidate || currentBestCandidate,
    overrideReason: overrideResult.overrideReason || currentOverrideReason
  };
}

function applyMergedCandidateOverride(currentBestCandidate, currentOverrideReason, overrideResult = {}) {
  return mergeCandidateOverrideResult(currentBestCandidate, currentOverrideReason, overrideResult);
}

function applyMergedConditionalCandidateOverride(currentBestCandidate, currentOverrideReason, config = {}) {
  return applyMergedCandidateOverride(
    currentBestCandidate,
    currentOverrideReason,
    applyConditionalCandidateOverride(config)
  );
}

function pickFullySupportedCandidates(scoredCandidates) {
  return scoredCandidates
    .filter((entry) => entry.innerGridSupport?.eligible)
    .sort((a, b) => {
      const supportDelta = (b.innerGridSupport?.supportScore || 0) - (a.innerGridSupport?.supportScore || 0);
      if (Math.abs(supportDelta) > 1e-6) {
        return supportDelta;
      }
      return (b.totalScore || 0) - (a.totalScore || 0);
    });
}

function pickSupportPriorityCandidates(scoredCandidates) {
  const maxInnerSupportCount = Math.max(
    0,
    ...scoredCandidates.map((entry) => entry.innerGridSupport?.eligibleCount || 0)
  );
  return scoredCandidates
    .filter((entry) => (entry.innerGridSupport?.eligibleCount || 0) === maxInnerSupportCount)
    .sort((a, b) => {
      const supportDelta = (b.innerGridSupport?.supportScore || 0) - (a.innerGridSupport?.supportScore || 0);
      if (Math.abs(supportDelta) > 1e-6) {
        return supportDelta;
      }
      return (b.totalScore || 0) - (a.totalScore || 0);
    });
}

function shouldPreferWholeConsistencyCandidate(config = {}) {
  const {
    currentBestCandidate = null,
    wholeConsistencyPriorityCandidate = null,
    cellHeight = 0
  } = config;
  if (
    !wholeConsistencyPriorityCandidate
    || !['local-corner-fallback', 'consistency-aligned-local', 'local-corner-stabilized'].includes(currentBestCandidate?.name)
  ) {
    return false;
  }
  const totalScoreGap = Math.abs((currentBestCandidate?.totalScore || 0) - (wholeConsistencyPriorityCandidate.totalScore || 0));
  return Boolean(
    totalScoreGap <= 0.005
    && (wholeConsistencyPriorityCandidate.rectangularity?.score || 0) >= (currentBestCandidate?.rectangularity?.score || 0) + 0.008
    && (wholeConsistencyPriorityCandidate.rectangularity?.rotatedRectangleScore || 0) >= (currentBestCandidate?.rectangularity?.rotatedRectangleScore || 0) + 0.015
    && (wholeConsistencyPriorityCandidate.cornerRetentionScore || 0) >= 0.78
    && (wholeConsistencyPriorityCandidate.maxShift || 0) <= Math.max(24, cellHeight * 0.18)
  );
}

function shouldPreferStabilizedDominantEdgeCandidate(config = {}) {
  const {
    currentBestCandidate = null,
    dominantEdgeLinesCandidate = null,
    dominantEdgeStabilizedCandidate = null
  } = config;
  if (
    currentBestCandidate?.name !== 'dominant-edge-lines'
    || !dominantEdgeLinesCandidate
    || !dominantEdgeStabilizedCandidate
  ) {
    return false;
  }
  return Boolean(
    Math.abs((dominantEdgeLinesCandidate.totalScore || 0) - (dominantEdgeStabilizedCandidate.totalScore || 0)) <= 0.0025
    && (dominantEdgeStabilizedCandidate.rectangularity?.rotatedRectangleScore || 0) >= (dominantEdgeLinesCandidate.rectangularity?.rotatedRectangleScore || 0) + 0.0005
    && (dominantEdgeStabilizedCandidate.cornerRetentionScore || 0) >= Math.max(0.9, (dominantEdgeLinesCandidate.cornerRetentionScore || 0) - 0.01)
    && (dominantEdgeStabilizedCandidate.maxShift || 0) <= Math.max(12, (dominantEdgeLinesCandidate.maxShift || 0) + 1.2)
  );
}

function shouldRejectGuideAlignedCandidate(config = {}) {
  const {
    currentBestCandidate = null,
    localStabilizedCandidate = null,
    cellHeight = 0
  } = config;
  if (
    currentBestCandidate?.name !== 'support-aligned-guides'
    || !localStabilizedCandidate
  ) {
    return false;
  }
  return Boolean(
    (currentBestCandidate.cornerRetentionScore || 0) <= 0.25
    && (currentBestCandidate.maxShift || 0) >= Math.max(56, cellHeight * 0.3)
    && (localStabilizedCandidate.cornerRetentionScore || 0) >= 0.9
    && (localStabilizedCandidate.rectangularity?.score || 0) >= Math.max(0.92, (currentBestCandidate.rectangularity?.score || 0) - 0.02)
    && (localStabilizedCandidate.supportScore || 0) >= 0.82
  );
}

function selectTopLeftPriorityCandidate(scoredCandidates, currentBestCandidate, computeTopLeftPriority) {
  const nearScoreCandidates = scoredCandidates
    .filter((entry) => Math.abs((entry.totalScore || 0) - (currentBestCandidate?.totalScore || 0)) <= 0.0035)
    .sort((a, b) => {
      const topLeftDelta = computeTopLeftPriority(b) - computeTopLeftPriority(a);
      if (Math.abs(topLeftDelta) > 1e-6) {
        return topLeftDelta;
      }
      return (b.totalScore || 0) - (a.totalScore || 0);
  });
  return nearScoreCandidates[0] || null;
}

function buildWholeConsistencyPriorityPool(candidateMap = {}) {
  return sortWholeConsistencyPriorityCandidates([
    candidateMap.selectiveWholeCornerConsistencyCandidate,
    candidateMap.topAnchorBandAlignedCandidate,
    candidateMap.wholeCornerConsistencyCandidate,
    candidateMap.uncertaintyRetainedCandidate,
    candidateMap.selectiveReplacementCandidate,
    candidateMap.blendedGeometryCandidate
  ]);
}

function buildCircleMiInnerFrameRescuePool(candidateMap = {}, cellHeight = 0) {
  return sortCircleMiInnerFrameRescueCandidates([
    candidateMap.selectiveWholeCornerConsistencyCandidate,
    candidateMap.topAnchorBandAlignedCandidate,
    candidateMap.wholeCornerConsistencyCandidate,
    candidateMap.uncertaintyRetainedCandidate,
    candidateMap.selectiveReplacementCandidate,
    candidateMap.blendedGeometryCandidate,
    candidateMap.localStabilizedCandidate,
    candidateMap.localFallbackCandidate
  ], cellHeight);
}

function shouldPreferRectanglePriorityOverLocalFallback(config = {}) {
  const {
    currentBestCandidate = null,
    localFallbackCandidate = null,
    rectanglePriorityCandidate = null,
    cellHeight = 0
  } = config;
  if (
    currentBestCandidate?.name !== 'local-corner-fallback'
    || !localFallbackCandidate
    || !rectanglePriorityCandidate
  ) {
    return false;
  }
  return Boolean(
    (rectanglePriorityCandidate.rectangularity?.score || 0) >= (localFallbackCandidate.rectangularity?.score || 0) + 0.015
    && (rectanglePriorityCandidate.rectangularity?.rotatedRectangleScore || 0) >= (localFallbackCandidate.rectangularity?.rotatedRectangleScore || 0) + 0.18
    && (rectanglePriorityCandidate.supportScore || 0) >= Math.max(0.55, (localFallbackCandidate.supportScore || 0) - 0.28)
    && (rectanglePriorityCandidate.cornerRetentionScore || 0) >= 0.18
    && (rectanglePriorityCandidate.maxShift || 0) <= Math.max(64, cellHeight * 0.42)
  );
}

function buildQuadSelectionCandidateContext(scoredCandidates) {
  const localFallbackCandidate = findQuadCandidateByName(scoredCandidates, 'local-corner-fallback');
  const localStabilizedCandidate = findQuadCandidateByName(scoredCandidates, 'local-corner-stabilized');
  const wholeCornerConsistencyCandidate = findQuadCandidateByName(scoredCandidates, 'whole-corner-consistency');
  const selectiveWholeCornerConsistencyCandidate = findQuadCandidateByName(scoredCandidates, 'selective-whole-corner-consistency');
  const topAnchorBandAlignedCandidate = findQuadCandidateByName(scoredCandidates, 'top-anchor-band-aligned');
  const uncertaintyRetainedCandidate = findQuadCandidateByName(scoredCandidates, 'uncertain-corner-geometry');
  const selectiveReplacementCandidate = findQuadCandidateByName(scoredCandidates, 'selective-corner-replacement');
  const blendedGeometryCandidate = findQuadCandidateByName(scoredCandidates, 'blended-geometry');
  const dominantEdgeLinesCandidate = findQuadCandidateByName(scoredCandidates, 'dominant-edge-lines');
  const dominantEdgeStabilizedCandidate = findQuadCandidateByName(scoredCandidates, 'dominant-edge-stabilized');
  return {
    localFallbackCandidate,
    localStabilizedCandidate,
    wholeCornerConsistencyCandidate,
    selectiveWholeCornerConsistencyCandidate,
    topAnchorBandAlignedCandidate,
    uncertaintyRetainedCandidate,
    selectiveReplacementCandidate,
    blendedGeometryCandidate,
    dominantEdgeLinesCandidate,
    dominantEdgeStabilizedCandidate,
    rectanglePriorityCandidate: selectRectanglePriorityCandidate(scoredCandidates)
  };
}

function computeQuadTopLeftPriority(entry) {
  if (!entry) {
    return 0;
  }
  if (Number.isFinite(entry.topLeftSupportPriority)) {
    return Number(entry.topLeftSupportPriority);
  }
  const leftSupport = entry.innerGridSupport?.sides?.left || null;
  const topSupport = entry.innerGridSupport?.sides?.top || null;
  return average([
    leftSupport?.eligible ? Math.max(Number(leftSupport?.score) || 0, Number(leftSupport?.intervalSupportScore) || 0) : 0,
    topSupport?.eligible ? Math.max(Number(topSupport?.score) || 0, Number(topSupport?.intervalSupportScore) || 0) : 0
  ]);
}

function applySupportPriorityOverride(config = {}) {
  const {
    currentBestCandidate = null,
    fullySupportedCandidates = [],
    supportPriorityCandidates = []
  } = config;
  if (fullySupportedCandidates.length && currentBestCandidate?.name !== fullySupportedCandidates[0]?.name) {
    return applyCandidateOverride(currentBestCandidate, fullySupportedCandidates[0], 'prefer-fully-supported-inner-grid-quad');
  }
  if (!fullySupportedCandidates.length && supportPriorityCandidates.length && currentBestCandidate?.name !== supportPriorityCandidates[0]?.name) {
    const supportPriorityCandidate = supportPriorityCandidates[0];
    const totalScoreDelta = (supportPriorityCandidate?.totalScore || 0) - (currentBestCandidate?.totalScore || 0);
    const topBandAlignmentDelta = (supportPriorityCandidate?.topBandAlignmentScore || 0) - (currentBestCandidate?.topBandAlignmentScore || 0);
    const cornerRetentionDelta = (supportPriorityCandidate?.cornerRetentionScore || 0) - (currentBestCandidate?.cornerRetentionScore || 0);
    const maxShiftDelta = (supportPriorityCandidate?.maxShift || 0) - (currentBestCandidate?.maxShift || 0);
    const shouldOverride = (
      totalScoreDelta >= -0.006
      && topBandAlignmentDelta >= -0.18
      && cornerRetentionDelta >= -0.12
      && maxShiftDelta <= 12
    );
    if (shouldOverride) {
      return applyCandidateOverride(currentBestCandidate, supportPriorityCandidate, 'prefer-candidate-with-most-inner-grid-support');
    }
  }
  return {
    bestCandidate: currentBestCandidate,
    overrideReason: null
  };
}

function applyTopLeftPriorityOverride(config = {}) {
  const {
    scoredCandidates = [],
    currentBestCandidate = null
  } = config;
  const topLeftPriorityCandidate = selectTopLeftPriorityCandidate(
    scoredCandidates,
    currentBestCandidate,
    computeQuadTopLeftPriority
  );
  return applyConditionalCandidateOverride({
    currentBestCandidate,
    shouldApply: Boolean(
      topLeftPriorityCandidate
      && topLeftPriorityCandidate.name !== currentBestCandidate?.name
      && computeQuadTopLeftPriority(topLeftPriorityCandidate) >= computeQuadTopLeftPriority(currentBestCandidate) + 0.08
      && (topLeftPriorityCandidate.innerGridSupport?.eligibleCount || 0) >= Math.max(2, (currentBestCandidate?.innerGridSupport?.eligibleCount || 0))
      && (topLeftPriorityCandidate.cornerRetentionScore || 0) >= Math.max(0.85, (currentBestCandidate?.cornerRetentionScore || 0) - 0.03)
      && (topLeftPriorityCandidate.maxShift || 0) <= Math.max(18, (currentBestCandidate?.maxShift || 0) + 2.5)
    ),
    nextCandidate: topLeftPriorityCandidate,
    reason: 'prefer-top-left-supported-quad-when-total-scores-are-nearly-tied'
  });
}

function applyQuadSelectionRule(state = {}, ruleApplier = null) {
  if (typeof ruleApplier !== 'function') {
    return state;
  }
  return ruleApplier(state) || state;
}

function buildQuadSelectionRuleAppliers(config = {}) {
  const {
    scoredCandidates = [],
    cellHeight = 0,
    circleMiGridProfile = false,
    fullySupportedCandidates = [],
    supportPriorityCandidates = [],
    localFallbackCandidate = null,
    localStabilizedCandidate = null,
    rectanglePriorityCandidate = null,
    dominantEdgeLinesCandidate = null,
    dominantEdgeStabilizedCandidate = null,
    wholeConsistencyPriorityCandidate = null,
    circleMiInnerFrameRescueCandidate = null,
    topAnchorBandAlignedCandidate = null
  } = config;
  return [
    (state) => applyMergedConditionalCandidateOverride(state.bestCandidate, state.overrideReason, {
      currentBestCandidate: state.bestCandidate,
      shouldApply: !fullySupportedCandidates.length && shouldPreferRectanglePriorityOverLocalFallback({
        currentBestCandidate: state.bestCandidate,
        localFallbackCandidate,
        rectanglePriorityCandidate,
        cellHeight
      }),
      nextCandidate: rectanglePriorityCandidate,
      reason: 'prefer-rotated-rectangle-fit-when-it-clearly-outweighs-local-corner-drift'
    }),
    (state) => applyMergedCandidateOverride(state.bestCandidate, state.overrideReason, applySupportPriorityOverride({
      currentBestCandidate: state.bestCandidate,
      fullySupportedCandidates,
      supportPriorityCandidates
    })),
    (state) => applyMergedConditionalCandidateOverride(state.bestCandidate, state.overrideReason, {
      currentBestCandidate: state.bestCandidate,
      shouldApply: shouldPreferStabilizedDominantEdgeCandidate({
        currentBestCandidate: state.bestCandidate,
        dominantEdgeLinesCandidate,
        dominantEdgeStabilizedCandidate
      }),
      nextCandidate: dominantEdgeStabilizedCandidate,
      reason: 'prefer-stabilized-dominant-edge-quad-when-score-is-nearly-tied'
    }),
    (state) => applyMergedConditionalCandidateOverride(state.bestCandidate, state.overrideReason, {
      currentBestCandidate: state.bestCandidate,
      shouldApply: shouldRejectGuideAlignedCandidate({
        currentBestCandidate: state.bestCandidate,
        localStabilizedCandidate,
        cellHeight
      }),
      nextCandidate: localStabilizedCandidate,
      reason: 'reject-guide-aligned-quad-when-it-breaks-whole-corner-consistency'
    }),
    (state) => applyMergedConditionalCandidateOverride(state.bestCandidate, state.overrideReason, {
      currentBestCandidate: state.bestCandidate,
      shouldApply: shouldPreferWholeConsistencyCandidate({
        currentBestCandidate: state.bestCandidate,
        wholeConsistencyPriorityCandidate,
        cellHeight
      }),
      nextCandidate: wholeConsistencyPriorityCandidate,
      reason: 'prefer-whole-corner-consistent-quad-when-it-improves-rectangle-fit-with-limited-drift'
    }),
    (state) => applyMergedConditionalCandidateOverride(state.bestCandidate, state.overrideReason, {
      currentBestCandidate: state.bestCandidate,
      shouldApply: shouldApplyCircleMiDominantEdgeRescue({
        circleMiGridProfile,
        currentBestCandidate: state.bestCandidate,
        rescueCandidate: circleMiInnerFrameRescueCandidate,
        cellHeight
      }),
      nextCandidate: circleMiInnerFrameRescueCandidate,
      reason: 'reject-dark-edge-dominant-quad-for-circle-mi-inner-frame-when-support-is-missing'
    }),
    (state) => applyMergedConditionalCandidateOverride(state.bestCandidate, state.overrideReason, {
      currentBestCandidate: state.bestCandidate,
      shouldApply: shouldPreferWholeCornerOverUncertainForCircleMi({
        circleMiGridProfile,
        currentBestCandidate: state.bestCandidate,
        wholeConsistencyPriorityCandidate,
        cellHeight
      }),
      nextCandidate: wholeConsistencyPriorityCandidate,
      reason: 'prefer-whole-corner-fit-over-uncertain-corner-geometry-for-circle-mi-grid-when-nearly-tied'
    }),
    (state) => applyMergedConditionalCandidateOverride(state.bestCandidate, state.overrideReason, {
      currentBestCandidate: state.bestCandidate,
      shouldApply: shouldPreferTopAnchorBandAlignedCandidate({
        currentBestCandidate: state.bestCandidate,
        topAnchorBandAlignedCandidate,
        cellHeight
      }),
      nextCandidate: topAnchorBandAlignedCandidate,
      reason: 'prefer-top-anchor-band-aligned-quad-when-it-improves-top-band-consistency-with-similar-geometry'
    }),
    (state) => applyMergedCandidateOverride(state.bestCandidate, state.overrideReason, applyTopLeftPriorityOverride({
      scoredCandidates,
      currentBestCandidate: state.bestCandidate
    }))
  ];
}

function selectBestQuadCandidate(scoredCandidates, options = {}) {
  const {
    cellHeight = 0,
    patternProfile = null,
    outerFrameDetected = false
  } = options;
  const circleMiGridProfile = isCircleMiGridProfile(patternProfile, outerFrameDetected);
  let bestCandidate = scoredCandidates[0] || null;
  const fullySupportedCandidates = pickFullySupportedCandidates(scoredCandidates);
  if (fullySupportedCandidates.length) {
    bestCandidate = fullySupportedCandidates[0];
  }
  const supportPriorityCandidates = pickSupportPriorityCandidates(scoredCandidates);
  const candidateMap = buildQuadSelectionCandidateContext(scoredCandidates);
  const {
    localFallbackCandidate,
    localStabilizedCandidate,
    topAnchorBandAlignedCandidate,
  } = candidateMap;
  const { rectanglePriorityCandidate, dominantEdgeLinesCandidate, dominantEdgeStabilizedCandidate } = candidateMap;
  const wholeConsistencyPriorityPool = buildWholeConsistencyPriorityPool(candidateMap);
  const wholeConsistencyPriorityCandidate = wholeConsistencyPriorityPool[0] || null;
  const circleMiInnerFrameRescuePool = buildCircleMiInnerFrameRescuePool(candidateMap, cellHeight);
  const circleMiInnerFrameRescueCandidate = circleMiInnerFrameRescuePool[0] || null;
  let selectionState = {
    bestCandidate,
    overrideReason: null
  };
  const ruleAppliers = buildQuadSelectionRuleAppliers({
    scoredCandidates,
    cellHeight,
    circleMiGridProfile,
    fullySupportedCandidates,
    supportPriorityCandidates,
    localFallbackCandidate,
    localStabilizedCandidate,
    rectanglePriorityCandidate,
    dominantEdgeLinesCandidate,
    dominantEdgeStabilizedCandidate,
    wholeConsistencyPriorityCandidate,
    circleMiInnerFrameRescueCandidate,
    topAnchorBandAlignedCandidate
  });
  for (const ruleApplier of ruleAppliers) {
    selectionState = applyQuadSelectionRule(selectionState, ruleApplier);
  }
  bestCandidate = selectionState.bestCandidate;
  const { overrideReason } = selectionState;
  return {
    bestCandidate,
    overrideReason,
    fullySupportedCandidates,
    supportPriorityCandidates,
    localFallbackCandidate,
    rectanglePriorityCandidate
  };
}

function buildQuadAverageBounds(quad) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized) {
    return null;
  }
  const [lt, rt, rb, lb] = normalized;
  return {
    left: average([lt[0], lb[0]]),
    right: average([rt[0], rb[0]]),
    top: average([lt[1], rt[1]]),
    bottom: average([lb[1], rb[1]])
  };
}

function resolveWeakTopBandPreference(config = {}) {
  const {
    preferredTopBandY = null,
    localTopBandY = null,
    coarseTopY = null,
    coarseVerticalEndpointTopY = null,
    topContinuityWeak = false,
    cellHeight = 0
  } = config;
  if (
    !Number.isFinite(preferredTopBandY)
    || !Number.isFinite(localTopBandY)
    || !topContinuityWeak
  ) {
    return Number.isFinite(preferredTopBandY) ? preferredTopBandY : null;
  }
  const topBandMismatchThreshold = Math.max(18, cellHeight * 0.22);
  if (preferredTopBandY > localTopBandY + topBandMismatchThreshold) {
    const fallbackTopBandY = [
      localTopBandY,
      coarseTopY,
      coarseVerticalEndpointTopY
    ].filter((value) => Number.isFinite(value) && value <= preferredTopBandY);
    return fallbackTopBandY.length ? Math.min(...fallbackTopBandY) : preferredTopBandY;
  }
  if (preferredTopBandY < localTopBandY - topBandMismatchThreshold) {
    const fallbackTopBandY = [
      coarseVerticalEndpointTopY,
      coarseTopY
    ].filter((value) => (
      Number.isFinite(value)
      && value >= preferredTopBandY
      && value <= localTopBandY + topBandMismatchThreshold
    ));
    return fallbackTopBandY.length ? Math.max(...fallbackTopBandY) : preferredTopBandY;
  }
  return preferredTopBandY;
}

function buildTopAnchorBandAlignedQuad(corners, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  const {
    preferredTopLeftAnchor = null,
    preferredTopRightAnchor = null,
    preferredTopBandY = null,
    cellHeight = 0,
    topContinuity = null
  } = options;
  if (
    !Array.isArray(preferredTopLeftAnchor)
    || !Array.isArray(preferredTopRightAnchor)
    || !Number.isFinite(preferredTopBandY)
  ) {
    return null;
  }
  const currentAnchorBandY = average([
    Number(preferredTopLeftAnchor[1]),
    Number(preferredTopRightAnchor[1])
  ].filter(Number.isFinite));
  if (!Number.isFinite(currentAnchorBandY)) {
    return null;
  }
  const anchorBandDelta = Math.abs(currentAnchorBandY - preferredTopBandY);
  const maxAnchorBandDelta = Math.max(10, cellHeight * 0.14);
  const continuityLongestRunRatio = Number(topContinuity?.longestRunRatio) || 0;
  const continuityCoverageRatio = Number(topContinuity?.coverageRatio) || 0;
  if (
    anchorBandDelta > maxAnchorBandDelta
    || continuityLongestRunRatio < 0.58
    || continuityCoverageRatio < 0.82
  ) {
    return null;
  }
  const shiftedTopLeftAnchor = [
    Number(preferredTopLeftAnchor[0]),
    Number(preferredTopLeftAnchor[1]) + (preferredTopBandY - currentAnchorBandY)
  ];
  const shiftedTopRightAnchor = [
    Number(preferredTopRightAnchor[0]),
    Number(preferredTopRightAnchor[1]) + (preferredTopBandY - currentAnchorBandY)
  ];
  const shiftedTopLine = buildLineFromEndAnchors(shiftedTopLeftAnchor, shiftedTopRightAnchor, null);
  const leftSideLine = buildLineFromEndAnchors(quad[0], quad[3], null);
  const rightSideLine = buildLineFromEndAnchors(quad[1], quad[2], null);
  const nextLeftTop = intersectLines(shiftedTopLine, leftSideLine);
  const nextRightTop = intersectLines(shiftedTopLine, rightSideLine);
  if (!Array.isArray(nextLeftTop) || !Array.isArray(nextRightTop)) {
    return null;
  }
  return normalizeCornerQuad([
    nextLeftTop,
    nextRightTop,
    quad[2],
    quad[3]
  ]) || quad;
}

function isCircleMiGridProfile(patternProfile = null, outerFrameDetected = false) {
  return Boolean(patternProfile?.family === 'circle-mi-grid' && !outerFrameDetected);
}

function shouldPreferTopAnchorBandAlignedCandidate(config = {}) {
  const {
    currentBestCandidate = null,
    topAnchorBandAlignedCandidate = null,
    cellHeight = 0
  } = config;
  if (
    !topAnchorBandAlignedCandidate
    || !['selective-whole-corner-consistency', 'whole-corner-consistency'].includes(currentBestCandidate?.name)
  ) {
    return false;
  }
  return Boolean(
    Math.abs((currentBestCandidate?.totalScore || 0) - (topAnchorBandAlignedCandidate.totalScore || 0)) <= 0.0012
    && (topAnchorBandAlignedCandidate.bandAlignmentScore || 0) >= (currentBestCandidate?.bandAlignmentScore || 0) + 0.02
    && (topAnchorBandAlignedCandidate.rectangularity?.rotatedRectangleScore || 0) >= Math.max(0.82, (currentBestCandidate?.rectangularity?.rotatedRectangleScore || 0) - 0.01)
    && (topAnchorBandAlignedCandidate.cornerRetentionScore || 0) >= Math.max(0.42, (currentBestCandidate?.cornerRetentionScore || 0) - 0.08)
    && (topAnchorBandAlignedCandidate.maxShift || 0) <= Math.max((currentBestCandidate?.maxShift || 0) + Math.max(10, cellHeight * 0.05), cellHeight * 0.24)
  );
}

function shouldApplyCircleMiDominantEdgeRescue(config = {}) {
  const {
    circleMiGridProfile = false,
    currentBestCandidate = null,
    rescueCandidate = null,
    cellHeight = 0
  } = config;
  if (
    !circleMiGridProfile
    || !['dominant-edge-lines', 'dominant-edge-stabilized'].includes(currentBestCandidate?.name)
    || currentBestCandidate?.innerGridSupport?.eligible
    || (currentBestCandidate?.innerGridSupport?.eligibleCount || 0) !== 0
    || (currentBestCandidate?.maxShift || 0) < Math.max(72, cellHeight * 0.34)
    || !rescueCandidate
    || rescueCandidate.name === currentBestCandidate?.name
  ) {
    return false;
  }
  return Boolean(
    Math.abs((currentBestCandidate?.totalScore || 0) - (rescueCandidate.totalScore || 0)) <= 0.0045
    && (rescueCandidate.rectangularity?.rotatedRectangleScore || 0) >= Math.max(0.78, (currentBestCandidate?.rectangularity?.rotatedRectangleScore || 0) - 0.02)
    && (
      (rescueCandidate.cornerRetentionScore || 0) >= Math.max(0.44, (currentBestCandidate?.cornerRetentionScore || 0) + 0.03)
      || (rescueCandidate.rectangularity?.rotatedRectangleScore || 0) >= (currentBestCandidate?.rectangularity?.rotatedRectangleScore || 0) + 0.018
    )
    && (rescueCandidate.maxShift || 0) <= (currentBestCandidate?.maxShift || 0) - Math.max(28, cellHeight * 0.14)
  );
}

function shouldPreferWholeCornerOverUncertainForCircleMi(config = {}) {
  const {
    circleMiGridProfile = false,
    currentBestCandidate = null,
    wholeConsistencyPriorityCandidate = null,
    cellHeight = 0
  } = config;
  if (
    !circleMiGridProfile
    || currentBestCandidate?.name !== 'uncertain-corner-geometry'
    || !wholeConsistencyPriorityCandidate
    || !['selective-whole-corner-consistency', 'whole-corner-consistency'].includes(wholeConsistencyPriorityCandidate.name)
  ) {
    return false;
  }
  return Boolean(
    Math.abs((currentBestCandidate?.totalScore || 0) - (wholeConsistencyPriorityCandidate.totalScore || 0)) <= 0.0015
    && (wholeConsistencyPriorityCandidate.rectangularity?.rotatedRectangleScore || 0) >= (currentBestCandidate?.rectangularity?.rotatedRectangleScore || 0) + 0.16
    && (wholeConsistencyPriorityCandidate.bandAlignmentScore || 0) >= (currentBestCandidate?.bandAlignmentScore || 0) + 0.015
    && (wholeConsistencyPriorityCandidate.maxShift || 0) <= Math.max((currentBestCandidate?.maxShift || 0) + Math.max(18, cellHeight * 0.06), cellHeight * 0.18)
  );
}

function shouldApplyStrictTopLeftIntervalGateFromDiagnostics(diagnostics = {}) {
  return Boolean(
    diagnostics?.globalPattern?.patternProfile?.family === 'inner-dashed-box-grid'
    || diagnostics?.globalPattern?.patternProfile?.settings?.allowTopRecoveryByInnerGuide
    || diagnostics?.overallPattern === 'uniform-cells-with-inner-dashed'
  );
}

function evaluateInnerGridSideSupport(config = {}) {
  const {
    side,
    gap,
    medianGap,
    boundaryGap = 0,
    stableRun,
    globalStableCount = 0,
    requireInferStableRun = 2,
    intervalEvidence = null
  } = config;
  if (!Number.isFinite(gap) || !Number.isFinite(medianGap) || medianGap <= 0) {
    return {
      side,
      eligible: false,
      score: 0,
      mode: 'missing-inner-support',
      gap: Number.isFinite(gap) ? Number(gap.toFixed(3)) : null,
      medianGap: Number.isFinite(medianGap) ? Number(medianGap.toFixed(3)) : null,
      stableRun: Number.isFinite(stableRun) ? stableRun : 0,
      globalStableCount: Number.isFinite(globalStableCount) ? globalStableCount : 0
    };
  }
  const absGap = Math.abs(gap);
  const inferredGapTolerance = Math.max(16, medianGap * 0.3);
  const boundaryGapTolerance = (
    Number.isFinite(boundaryGap) && boundaryGap > 0
  )
    ? Math.max(18, boundaryGap * 0.3)
    : 0;
  const onInnerLineScore = clamp01(1 - absGap / Math.max(10, medianGap * 0.22));
  const oneCellOutScore = clamp01(1 - Math.abs(absGap - medianGap) / inferredGapTolerance);
  const boundaryGapScore = (
    Number.isFinite(boundaryGap) && boundaryGap > 0
  )
    ? clamp01(1 - Math.abs(absGap - boundaryGap) / boundaryGapTolerance)
    : 0;
  const stableScore = clamp01(Math.max(Number(stableRun) || 0, Number(globalStableCount) || 0) / 5);
  const onInnerEligible = onInnerLineScore >= 0.72 && (Number(stableRun) || 0) >= 1;
  const inferredEligible = (
    oneCellOutScore >= 0.72
    && (
      (Number(stableRun) || 0) >= requireInferStableRun
      || (Number(globalStableCount) || 0) >= Math.max(4, requireInferStableRun + 2)
    )
  );
  const boundaryEligible = (
    boundaryGapScore >= 0.72
    && (
      (Number(stableRun) || 0) >= requireInferStableRun
      || (Number(globalStableCount) || 0) >= Math.max(4, requireInferStableRun + 2)
    )
  );
  const preferBoundary = boundaryEligible && boundaryGapScore >= Math.max(onInnerLineScore, oneCellOutScore);
  const preferInferred = !preferBoundary && inferredEligible && oneCellOutScore >= onInnerLineScore;
  const intervalSupportScore = clamp01(Number(intervalEvidence?.supportScore) || 0);
  const intervalSupported = Boolean(intervalEvidence?.supported);
  const intervalEligible = (
    intervalSupported
    && (
      (Number(stableRun) || 0) >= Math.max(1, requireInferStableRun - 1)
      || (Number(globalStableCount) || 0) >= Math.max(3, requireInferStableRun + 1)
      || Math.max(onInnerLineScore, oneCellOutScore, boundaryGapScore) >= 0.56
    )
  );
  const score = Math.max(
    onInnerLineScore * (0.35 + stableScore * 0.65),
    oneCellOutScore * (0.35 + stableScore * 0.65),
    boundaryGapScore * (0.35 + stableScore * 0.65),
    intervalSupportScore * (0.42 + stableScore * 0.58)
  );
  return {
    side,
    eligible: onInnerEligible || inferredEligible || boundaryEligible || intervalEligible,
    score,
    mode: (
      intervalEligible && intervalSupportScore >= Math.max(onInnerLineScore, oneCellOutScore, boundaryGapScore)
    )
      ? 'equal-interval-supported'
      : (
        preferBoundary
          ? 'aligned-with-major-boundary-guide'
          : (preferInferred ? 'one-cell-outside-supported' : (onInnerEligible ? 'aligned-with-first-inner-line' : 'unsupported'))
      ),
    gap: Number(absGap.toFixed(3)),
    medianGap: Number(medianGap.toFixed(3)),
    boundaryGap: Number.isFinite(boundaryGap) ? Number(boundaryGap.toFixed(3)) : null,
    stableRun: Number(stableRun) || 0,
    globalStableCount: Number(globalStableCount) || 0,
    onInnerLineScore: Number(onInnerLineScore.toFixed(4)),
    oneCellOutScore: Number(oneCellOutScore.toFixed(4)),
    boundaryGapScore: Number(boundaryGapScore.toFixed(4)),
    intervalSupportScore: Number(intervalSupportScore.toFixed(4)),
    intervalEvidence: intervalEvidence
      ? {
          supported: intervalSupported,
          supportScore: Number(intervalSupportScore.toFixed(4)),
          sameGapScore: Number(Number(intervalEvidence.sameGapScore || 0).toFixed(4)),
          adjacentGapScore: Number(Number(intervalEvidence.adjacentGapScore || 0).toFixed(4)),
          pairConsistencyScore: Number(Number(intervalEvidence.pairConsistencyScore || 0).toFixed(4)),
          stableRunScore: Number(Number(intervalEvidence.stableRunScore || 0).toFixed(4)),
          firstGap: Number.isFinite(intervalEvidence.firstGap) ? Number(intervalEvidence.firstGap.toFixed(3)) : null,
          secondGap: Number.isFinite(intervalEvidence.secondGap) ? Number(intervalEvidence.secondGap.toFixed(3)) : null,
          medianGap: Number.isFinite(intervalEvidence.medianGap) ? Number(intervalEvidence.medianGap.toFixed(3)) : null
        }
      : null
  };
}

function buildInnerGridIntervalEvidence(config = {}) {
  const {
    firstGap = null,
    secondGap = null,
    medianGap = null,
    stableRun = 0,
    globalStableCount = 0
  } = config;
  if (!Number.isFinite(medianGap) || medianGap <= 0) {
    return null;
  }
  const stableRunScore = clamp01(Math.max(Number(stableRun) || 0, Number(globalStableCount) || 0) / 5);
  const sameGapScore = Number.isFinite(firstGap)
    ? clamp01(1 - Math.abs(Math.abs(firstGap) - medianGap) / Math.max(14, medianGap * 0.28))
    : 0;
  const adjacentGapScore = (
    Number.isFinite(firstGap)
    && Number.isFinite(secondGap)
  )
    ? clamp01(1 - Math.abs(Math.abs(secondGap) - medianGap) / Math.max(14, medianGap * 0.28))
    : 0;
  const pairConsistencyScore = (
    Number.isFinite(firstGap)
    && Number.isFinite(secondGap)
  )
    ? clamp01(1 - Math.abs(Math.abs(firstGap) - Math.abs(secondGap)) / Math.max(12, medianGap * 0.18))
    : 0;
  const supportScore = clamp01(
    sameGapScore * 0.24
    + adjacentGapScore * 0.24
    + pairConsistencyScore * 0.32
    + stableRunScore * 0.2
  );
  return {
    supported: (
      supportScore >= 0.68
      && Math.max(pairConsistencyScore, sameGapScore, adjacentGapScore) >= 0.62
    ),
    supportScore,
    sameGapScore,
    adjacentGapScore,
    pairConsistencyScore,
    stableRunScore,
    firstGap: Number.isFinite(firstGap) ? Math.abs(firstGap) : null,
    secondGap: Number.isFinite(secondGap) ? Math.abs(secondGap) : null,
    medianGap
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

function pickFirstNonNull(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

function repairLeadingUniformRowLoss(guides, corners, imageSize, gridRows, gridCols) {
  const quad = normalizeCornerQuad(corners);
  const width = Number(imageSize?.width || 0);
  const height = Number(imageSize?.height || 0);
  const xPeaks = Array.isArray(guides?.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides?.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  if (!quad || !width || !height || xPeaks.length < 4 || yPeaks.length < 4) {
    return { guides, corners: quad || corners, applied: false, addedRows: 0 };
  }

  const globalPatternMode = guides?.globalPattern?.mode || null;
  const xPattern = pickFirstNonNull(
    guides?.xPattern,
    guides?.xPatternDiagnostics?.mode,
    guides?.globalPattern?.x?.mode,
    globalPatternMode
  );
  const yPattern = pickFirstNonNull(
    guides?.yPattern,
    guides?.yPatternDiagnostics?.mode,
    guides?.globalPattern?.y?.mode,
    globalPatternMode
  );
  const xSymmetryEligible = Boolean(pickFirstNonNull(
    guides?.xPatternDiagnostics?.symmetry?.eligible,
    guides?.globalPattern?.symmetry?.x?.eligible,
    guides?.globalPattern?.symmetry?.eligible
  ));
  const ySymmetryEligible = Boolean(pickFirstNonNull(
    guides?.yPatternDiagnostics?.symmetry?.eligible,
    guides?.globalPattern?.symmetry?.y?.eligible,
    guides?.globalPattern?.symmetry?.eligible
  ));
  if (
    xPattern !== 'uniform-boundary-grid'
    || yPattern !== 'uniform-boundary-grid'
    || !xSymmetryEligible
    || !ySymmetryEligible
  ) {
    return {
      guides,
      corners: quad,
      applied: false,
      addedRows: 0,
      reason: 'pattern-not-strong-uniform-boundary-grid',
      diagnostics: {
        xPattern,
        yPattern,
        globalPatternMode,
        xSymmetryEligible,
        ySymmetryEligible
      }
    };
  }

  const top = Number(guides.top);
  const bottom = Number(guides.bottom);
  const left = Number(guides.left);
  const right = Number(guides.right);
  if (![top, bottom, left, right].every(Number.isFinite) || bottom <= top || right <= left) {
    return { guides, corners: quad, applied: false, addedRows: 0, reason: 'invalid-guide-bounds' };
  }

  const rowCount = Math.max(1, Number(gridRows) || (yPeaks.length - 1));
  const colCount = Math.max(1, Number(gridCols) || (xPeaks.length - 1));
  const yGaps = yPeaks.slice(1).map((value, index) => value - yPeaks[index]).filter((gap) => gap > 0);
  const xGaps = xPeaks.slice(1).map((value, index) => value - xPeaks[index]).filter((gap) => gap > 0);
  const medianYGap = median(yGaps);
  const medianXGap = median(xGaps);
  if (!(medianYGap > 0) || !(medianXGap > 0)) {
    return { guides, corners: quad, applied: false, addedRows: 0, reason: 'invalid-median-gap' };
  }

  const topMargin = top;
  const bottomMargin = Math.max(0, height - bottom);
  const leftMargin = left;
  const rightMargin = Math.max(0, width - right);
  const topExcess = topMargin - bottomMargin;
  const sideBalance = Math.abs(leftMargin - rightMargin);
  const sideBalanceTolerance = Math.max(24, medianXGap * 0.22);
  const topExcessThreshold = Math.max(96, medianYGap * 1.35);
  const topMarginThreshold = medianYGap * 1.85;

  if (
    topExcess < topExcessThreshold
    || topMargin < topMarginThreshold
    || sideBalance > sideBalanceTolerance
  ) {
    return {
      guides,
      corners: quad,
      applied: false,
      addedRows: 0,
      reason: 'top-margin-not-consistent-with-leading-row-loss'
    };
  }

  const inferredMissingRows = clamp(Math.round(topExcess / Math.max(1, medianYGap)), 1, 3);
  const shift = Math.round(inferredMissingRows * medianYGap);
  const repairedTop = clamp(top - shift, 0, Math.max(0, bottom - (rowCount + inferredMissingRows)));
  const repairedRowCount = rowCount + inferredMissingRows;
  const impliedGap = (bottom - repairedTop) / Math.max(1, repairedRowCount);
  const impliedGapRatio = Math.abs(impliedGap - medianYGap) / Math.max(1, medianYGap);
  if (impliedGapRatio > 0.14) {
    return {
      guides,
      corners: quad,
      applied: false,
      addedRows: 0,
      reason: 'repaired-gap-not-consistent-with-uniform-grid',
      diagnostics: {
        medianYGap: Number(medianYGap.toFixed(3)),
        impliedGap: Number(impliedGap.toFixed(3)),
        impliedGapRatio: Number(impliedGapRatio.toFixed(4))
      }
    };
  }

  const repairedYPeaks = buildUniformGuidePeaks(repairedTop, bottom, repairedRowCount);
  const repairedCorners = quad.map(([x, y], index) => (
    index < 2
      ? [x, clamp(y - shift, 0, Math.max(0, height - 1))]
      : [x, y]
  ));

  return {
    guides: {
      ...guides,
      top: repairedTop,
      yPeaks: repairedYPeaks,
      ySource: `${guides.ySource || '检测峰值筛选'} + 顶部整行缺失补全(${inferredMissingRows}行)`
    },
    corners: repairedCorners,
    applied: true,
    addedRows: inferredMissingRows,
    repairedGridRows: repairedRowCount,
    diagnostics: {
      rowCount,
      repairedRowCount,
      inferredMissingRows,
      topMargin: Number(topMargin.toFixed(3)),
      bottomMargin: Number(bottomMargin.toFixed(3)),
      topExcess: Number(topExcess.toFixed(3)),
      leftMargin: Number(leftMargin.toFixed(3)),
      rightMargin: Number(rightMargin.toFixed(3)),
      sideBalance: Number(sideBalance.toFixed(3)),
      medianYGap: Number(medianYGap.toFixed(3)),
      medianXGap: Number(medianXGap.toFixed(3)),
      impliedGap: Number(impliedGap.toFixed(3)),
      impliedGapRatio: Number(impliedGapRatio.toFixed(4)),
      repairedTop
    }
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

function describeGridPatternMode(mode) {
  switch (String(mode || '')) {
    case 'alternating-box-gap':
      return '框宽/间隔交替';
    case 'uniform-cells-with-inner-dashed':
      return '平均分割+内部虚框';
    case 'uniform-boundary-grid':
      return '平均分割';
    case 'mixed':
      return '混合模式';
    default:
      return mode ? String(mode) : '未识别';
  }
}

function tryBuildAlternatingGuidePeaks(rawPeaks, start, end, cells) {
  const targetCount = (cells || 0) + 1;
  const alternatingCount = Math.max(0, targetCount * 2 - 1);
  if (!targetCount || alternatingCount < 3 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  const sanitized = sanitizeGuidePeaks(rawPeaks).filter((value) => value >= start - 8 && value <= end + 8);
  if (sanitized.length < alternatingCount) {
    return null;
  }

  const edgeTolerance = Math.max(12, ((end - start) / Math.max(cells, 1)) * 0.45);
  let best = null;

  for (let offset = 0; offset <= sanitized.length - alternatingCount; offset += 1) {
    const window = sanitized.slice(offset, offset + alternatingCount);
    const widths = [];
    const gaps = [];
    let monotonic = true;

    for (let index = 0; index < targetCount - 1; index += 1) {
      const leftEdge = window[index * 2];
      const rightEdge = window[index * 2 + 1];
      const width = rightEdge - leftEdge;
      if (!(width > 2)) {
        monotonic = false;
        break;
      }
      widths.push(width);
      if (index < targetCount - 2) {
        const nextLeftEdge = window[index * 2 + 2];
        const gap = nextLeftEdge - rightEdge;
        if (!(gap > 2)) {
          monotonic = false;
          break;
        }
        gaps.push(gap);
      }
    }

    if (!monotonic || !widths.length || !gaps.length) {
      continue;
    }

    const medianWidth = median(widths);
    const medianGap = median(gaps);
    if (!Number.isFinite(medianWidth) || !Number.isFinite(medianGap) || medianWidth <= 0 || medianGap <= 0) {
      continue;
    }

    const widthDeviation = average(widths.map((value) => Math.abs(value - medianWidth))) / medianWidth;
    const gapDeviation = average(gaps.map((value) => Math.abs(value - medianGap))) / medianGap;
    const pitchSeries = widths.slice(0, -1).map((value, index) => value + gaps[index]);
    const medianPitch = median(pitchSeries);
    const pitchDeviation = medianPitch > 0
      ? average(pitchSeries.map((value) => Math.abs(value - medianPitch))) / medianPitch
      : 1;
    const leftDistance = Math.abs(window[0] - start);
    const rightDistance = Math.abs(window[window.length - 1] - end);
    const edgeDeviation = (leftDistance + rightDistance) / Math.max(end - start, 1);
    const score = widthDeviation + gapDeviation + pitchDeviation + (edgeDeviation * 0.6);

    const peaks = [start];
    for (let index = 1; index < targetCount - 1; index += 1) {
      peaks.push((window[index * 2 - 1] + window[index * 2]) / 2);
    }
    peaks.push(end);

    const candidate = {
      peaks,
      score,
      diagnostics: {
        mode: 'alternating-box-gap',
        medianWidth: Number(medianWidth.toFixed(3)),
        medianGap: Number(medianGap.toFixed(3)),
        medianPitch: Number(medianPitch.toFixed(3)),
        widthDeviation: Number(widthDeviation.toFixed(4)),
        gapDeviation: Number(gapDeviation.toFixed(4)),
        pitchDeviation: Number(pitchDeviation.toFixed(4)),
        leftDistance: Number(leftDistance.toFixed(3)),
        rightDistance: Number(rightDistance.toFixed(3)),
        windowStart: offset,
        windowEnd: offset + alternatingCount - 1
      }
    };
    if (
      leftDistance <= edgeTolerance
      && rightDistance <= edgeTolerance
      && (!best || candidate.score < best.score)
    ) {
      best = candidate;
    }
  }

  return best;
}

function buildUniformGuideSelection(rawPeaks, start, end, cells) {
  const targetCount = (cells || 0) + 1;
  if (!targetCount || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {
      peaks: [],
      diagnostics: {
        mode: 'uniform-boundary-grid'
      }
    };
  }

  const sanitized = sanitizeGuidePeaks(rawPeaks).filter((value) => value >= start - 4 && value <= end + 4);
  if (!sanitized.length) {
    return {
      peaks: buildUniformGuidePeaks(start, end, cells),
      diagnostics: {
        mode: 'uniform-boundary-grid',
        fallback: 'outer-bound-uniform'
      }
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
  const snappedDistances = selected.map((value, index) => Math.abs(value - expected[index]));
  const meanSnapDistance = average(snappedDistances);
  const meanSnapRatio = meanSnapDistance / Math.max(10, gap);
  const extraPeakCount = Math.max(0, sanitized.length - targetCount);
  const mode = (
    extraPeakCount >= Math.max(2, Math.floor(targetCount / 2))
    && meanSnapRatio <= 0.2
  )
    ? 'uniform-cells-with-inner-dashed'
    : 'uniform-boundary-grid';
  return {
    peaks: selected,
    diagnostics: {
      mode,
      meanSnapDistance: Number(meanSnapDistance.toFixed(3)),
      meanSnapRatio: Number(meanSnapRatio.toFixed(4)),
      extraPeakCount,
      snapDistances: snappedDistances.map((value) => Number(value.toFixed(3)))
    }
  };
}

function analyzeUniformRescueCandidate(peaks, start, end, cells, uniformDiagnostics = null) {
  const values = Array.isArray(peaks) ? peaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const expectedCount = Math.max(0, Number(cells) || 0) + 1;
  if (
    values.length !== expectedCount
    || expectedCount < 4
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || end <= start
  ) {
    return {
      eligible: false,
      reason: 'insufficient-uniform-candidate'
    };
  }
  const intervals = values.slice(1).map((value, index) => value - values[index]).filter((gap) => gap > 0);
  if (intervals.length !== expectedCount - 1) {
    return {
      eligible: false,
      reason: 'invalid-intervals'
    };
  }
  const medianInterval = median(intervals);
  if (!(medianInterval > 0)) {
    return {
      eligible: false,
      reason: 'invalid-median-interval'
    };
  }
  const stableToleranceRatio = 0.16;
  const stableFlags = intervals.map((gap) => (Math.abs(gap - medianInterval) / Math.max(1, medianInterval)) <= stableToleranceRatio);
  const stableCount = stableFlags.filter(Boolean).length;
  const stableRatio = stableFlags.length ? stableCount / stableFlags.length : 0;
  let longestStableRun = 0;
  let currentStableRun = 0;
  stableFlags.forEach((stable) => {
    if (stable) {
      currentStableRun += 1;
      longestStableRun = Math.max(longestStableRun, currentStableRun);
    } else {
      currentStableRun = 0;
    }
  });
  const edgeInstability = [
    stableFlags[0] === false,
    stableFlags[1] === false,
    stableFlags[stableFlags.length - 1] === false,
    stableFlags[stableFlags.length - 2] === false
  ].filter(Boolean).length;
  const meanSnapRatio = Number(uniformDiagnostics?.meanSnapRatio) || Number.POSITIVE_INFINITY;
  const meanSnapDistance = Number(uniformDiagnostics?.meanSnapDistance) || Number.POSITIVE_INFINITY;
  const expectedGap = (end - start) / Math.max(1, Number(cells) || 1);
  const eligible = (
    meanSnapRatio <= 0.16
    && meanSnapDistance <= expectedGap * 0.22
    && stableRatio >= 0.58
    && longestStableRun >= Math.max(3, Math.floor(intervals.length * 0.35))
    && edgeInstability >= 1
  );
  return {
    eligible,
    reason: eligible ? 'stable-majority-intervals-with-edge-disturbance' : 'uniform-rescue-not-supported',
    medianInterval: Number(medianInterval.toFixed(3)),
    stableRatio: Number(stableRatio.toFixed(4)),
    longestStableRun,
    edgeInstability,
    meanSnapRatio: Number.isFinite(meanSnapRatio) ? Number(meanSnapRatio.toFixed(4)) : null,
    meanSnapDistance: Number.isFinite(meanSnapDistance) ? Number(meanSnapDistance.toFixed(3)) : null,
    stableFlags
  };
}

function detectGuidePatternSelection(rawPeaks, start, end, cells) {
  const targetCount = (cells || 0) + 1;
  if (!targetCount || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return {
      peaks: [],
      source: '外边界均分',
      mode: 'uniform-boundary-grid',
      diagnostics: null
    };
  }
  const sanitized = sanitizeGuidePeaks(rawPeaks).filter((value) => value >= start - 4 && value <= end + 4);
  if (!sanitized.length) {
    return {
      peaks: buildUniformGuidePeaks(start, end, cells),
      source: '外边界均分',
      mode: 'uniform-boundary-grid',
      diagnostics: {
        mode: 'uniform-boundary-grid',
        fallback: 'outer-bound-uniform'
      }
    };
  }

  const alternating = tryBuildAlternatingGuidePeaks(sanitized, start, end, cells);
  const uniform = buildUniformGuideSelection(sanitized, start, end, cells);
  const alternatingScore = alternating?.score ?? Number.POSITIVE_INFINITY;
  const uniformScore = uniform?.diagnostics?.meanSnapRatio ?? Number.POSITIVE_INFINITY;
  const globalPitch = (end - start) / Math.max(cells, 1);
  const alternatingMedianWidth = Number(alternating?.diagnostics?.medianWidth) || 0;
  const alternatingMedianGap = Number(alternating?.diagnostics?.medianGap) || 0;
  const alternatingMedianPitch = Number(alternating?.diagnostics?.medianPitch) || 0;
  const uniformSymmetry = analyzeSymmetricSubdivision(
    uniform?.peaks || [],
    start,
    end,
    cells,
    { preferredMode: 'uniform-boundary-grid' }
  );
  const alternatingSymmetry = analyzeSymmetricSubdivision(
    alternating?.peaks || [],
    start,
    end,
    cells,
    { preferredMode: 'alternating-box-gap' }
  );
  const alternatingWidthGapRatio = (
    alternatingMedianWidth > 0
    && alternatingMedianGap > 0
  )
    ? Math.max(alternatingMedianWidth, alternatingMedianGap) / Math.max(1e-6, Math.min(alternatingMedianWidth, alternatingMedianGap))
    : Number.POSITIVE_INFINITY;
  const alternatingPitchVsUniform = globalPitch > 0
    ? Math.abs(alternatingMedianPitch - globalPitch) / globalPitch
    : Number.POSITIVE_INFINITY;
  const dashedLikeAlternatingEvidence = Boolean(
    alternating?.peaks?.length === targetCount
    && sanitized.length >= Math.max(targetCount + 4, targetCount * 2 - 1)
    && alternatingWidthGapRatio <= 1.45
    && alternatingMedianWidth <= globalPitch * 0.72
    && alternatingMedianGap <= globalPitch * 0.72
    && alternatingPitchVsUniform <= 0.16
    && (uniform?.diagnostics?.meanSnapRatio ?? 1) <= 0.22
    && uniformSymmetry.eligible
  );
  const dashedSpecific = resolveSpecificGridSubdivisionMode({
    symmetry: uniformSymmetry,
    uniformDiagnostics: uniform?.diagnostics || null,
    alternatingDiagnostics: alternating?.diagnostics || null,
    dashedLikeEvidence: dashedLikeAlternatingEvidence,
    alternatingAccepted: false
  });
  if (dashedLikeAlternatingEvidence) {
    return {
      peaks: uniform.peaks,
      source: '检测峰值筛选(平均分割+内部虚框)',
      mode: 'uniform-cells-with-inner-dashed',
      diagnostics: {
        mode: 'uniform-cells-with-inner-dashed',
        inferredFrom: 'alternating-peak-pairs-inside-uniform-cells',
        alternatingMedianWidth: Number(alternatingMedianWidth.toFixed(3)),
        alternatingMedianGap: Number(alternatingMedianGap.toFixed(3)),
        alternatingWidthGapRatio: Number(alternatingWidthGapRatio.toFixed(4)),
        alternatingMedianPitch: Number(alternatingMedianPitch.toFixed(3)),
        alternatingPitchVsUniform: Number(alternatingPitchVsUniform.toFixed(4)),
        uniformMeanSnapRatio: Number((uniform?.diagnostics?.meanSnapRatio ?? 0).toFixed(4)),
        extraPeakCount: Number(uniform?.diagnostics?.extraPeakCount || 0),
        specificMode: dashedSpecific.specificMode,
        specificReason: dashedSpecific.reason,
        symmetry: {
          uniform: uniformSymmetry,
          alternating: alternatingSymmetry
        }
      }
    };
  }
  if (
    alternating?.peaks?.length === targetCount
    && alternatingSymmetry.eligible
    && (
      alternatingScore <= 0.24
      || (
        sanitized.length >= Math.max(targetCount * 2 - 1, targetCount + 4)
        && alternatingScore <= uniformScore * 1.35
      )
    )
  ) {
    const alternatingSpecific = resolveSpecificGridSubdivisionMode({
      symmetry: alternatingSymmetry,
      uniformDiagnostics: uniform?.diagnostics || null,
      alternatingDiagnostics: alternating?.diagnostics || null,
      dashedLikeEvidence: false,
      alternatingAccepted: true
    });
    return {
      peaks: alternating.peaks,
      source: '检测峰值筛选(框宽/间隔分离)',
      mode: 'alternating-box-gap',
      diagnostics: {
        ...(alternating.diagnostics || {}),
        specificMode: alternatingSpecific.specificMode,
        specificReason: alternatingSpecific.reason,
        symmetry: alternatingSymmetry
      }
    };
  }

  const fallbackMode = uniformSymmetry.eligible ? (uniform?.diagnostics?.mode || 'uniform-boundary-grid') : 'mixed';
  const fallbackSpecific = resolveSpecificGridSubdivisionMode({
    symmetry: uniformSymmetry,
    uniformDiagnostics: uniform?.diagnostics || null,
    alternatingDiagnostics: alternating?.diagnostics || null,
    dashedLikeEvidence: false,
    alternatingAccepted: false
  });
  const uniformRescue = analyzeUniformRescueCandidate(
    uniform?.peaks || [],
    start,
    end,
    cells,
    uniform?.diagnostics || null
  );
  if (!uniformSymmetry.eligible && uniformRescue.eligible) {
    const rescuedPeaks = buildUniformGuidePeaks(start, end, cells);
    const rescuedSymmetry = analyzeSymmetricSubdivision(
      rescuedPeaks,
      start,
      end,
      cells,
      { preferredMode: 'uniform-boundary-grid' }
    );
    const rescuedSpecific = resolveSpecificGridSubdivisionMode({
      symmetry: rescuedSymmetry,
      uniformDiagnostics: { ...(uniform?.diagnostics || {}), mode: 'uniform-boundary-grid' },
      alternatingDiagnostics: alternating?.diagnostics || null,
      dashedLikeEvidence: false,
      alternatingAccepted: false
    });
    return {
      peaks: rescuedPeaks,
      source: '检测峰值筛选(边界扰动后均分补正)',
      mode: 'uniform-boundary-grid',
      diagnostics: {
        ...(uniform?.diagnostics || {}),
        mode: 'uniform-boundary-grid',
        rescuedFrom: 'mixed',
        rescueReason: uniformRescue.reason,
        rescueDiagnostics: uniformRescue,
        specificMode: rescuedSpecific.specificMode,
        specificReason: rescuedSpecific.reason,
        symmetry: rescuedSymmetry
      }
    };
  }
  return {
    peaks: uniform.peaks,
    source: uniform?.diagnostics?.mode === 'uniform-cells-with-inner-dashed'
      ? '检测峰值筛选(平均分割+内部虚框)'
      : '检测峰值筛选',
    mode: fallbackMode,
    diagnostics: {
      ...(uniform?.diagnostics || {}),
      mode: fallbackMode,
      specificMode: fallbackSpecific.specificMode,
      specificReason: fallbackSpecific.reason,
      symmetry: uniformSymmetry
    }
  };
}

function selectRepresentativeGuidePeaks(rawPeaks, start, end, cells) {
  return detectGuidePatternSelection(rawPeaks, start, end, cells);
}

function maybeForceUniformAxisSelection(selection, start, end, cells, axis = 'x') {
  if (!selection || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return selection;
  }
  const diagnostics = selection.diagnostics || null;
  const symmetry = diagnostics?.symmetry || null;
  const uniformLikeMode = (
    selection.mode === 'uniform-boundary-grid'
    || (axis === 'y' && selection.mode === 'uniform-cells-with-inner-dashed')
  );
  if (
    !uniformLikeMode
    || !symmetry?.eligible
  ) {
    return selection;
  }

  const values = Array.isArray(selection.peaks)
    ? selection.peaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    : [];
  const expectedCount = Math.max(1, Number(cells) || 1) + 1;
  if (values.length !== expectedCount) {
    return selection;
  }

  const intervals = values.slice(1).map((value, index) => value - values[index]).filter((gap) => gap > 0);
  if (intervals.length !== expectedCount - 1) {
    return selection;
  }
  const medianInterval = median(intervals);
  if (!(medianInterval > 0)) {
    return selection;
  }

  const meanSnapRatio = Number(diagnostics?.meanSnapRatio) || 0;
  const symmetryScore = Number(symmetry?.symmetryScore) || 0;
  const extraPeakCount = Number(diagnostics?.extraPeakCount) || 0;
  const minInterval = Math.min(...intervals);
  const maxInterval = Math.max(...intervals);
  const compressedIntervals = intervals.filter((gap) => gap <= medianInterval * 0.62).length;
  const expandedIntervals = intervals.filter((gap) => gap >= medianInterval * 1.38).length;
  const severeInstability = minInterval > 0 && (maxInterval / minInterval) >= 2.35;
  const hasLeadingOrTrailingCompression = (
    intervals[0] <= medianInterval * 0.72
    || intervals[intervals.length - 1] <= medianInterval * 0.72
  );

  const shouldForce = (
    symmetryScore >= 0.74
    && meanSnapRatio >= 0.12
    && extraPeakCount >= Math.max(4, Math.floor(expectedCount * 0.45))
    && severeInstability
    && compressedIntervals >= 1
    && expandedIntervals >= 1
    && (axis === 'y' || hasLeadingOrTrailingCompression)
  );

  if (!shouldForce) {
    return selection;
  }

  const forcedPeaks = buildUniformGuidePeaks(start, end, cells);
  const forcedSymmetry = analyzeSymmetricSubdivision(
    forcedPeaks,
    start,
    end,
    cells,
    { preferredMode: 'uniform-boundary-grid' }
  );
  return {
    ...selection,
    peaks: forcedPeaks,
    source: `${selection.source || '检测峰值筛选'} + 等间距主导均分补正`,
    mode: 'uniform-boundary-grid',
    diagnostics: {
      ...diagnostics,
      mode: 'uniform-boundary-grid',
      rescuedFromMode: selection.mode || null,
      forcedUniformRepair: {
        axis,
        meanSnapRatio: Number(meanSnapRatio.toFixed(4)),
        symmetryScore: Number(symmetryScore.toFixed(4)),
        extraPeakCount,
        medianInterval: Number(medianInterval.toFixed(3)),
        minInterval: Number(minInterval.toFixed(3)),
        maxInterval: Number(maxInterval.toFixed(3)),
        compressedIntervals,
        expandedIntervals,
        severeInstability,
        hasLeadingOrTrailingCompression
      },
      symmetry: forcedSymmetry
    }
  };
}

function analyzeSymmetricSubdivision(peaks, start, end, cells, options = {}) {
  const values = Array.isArray(peaks) ? peaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const expectedCount = Math.max(0, Number(cells) || 0) + 1;
  if (
    values.length < 2
    || expectedCount < 2
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || end <= start
  ) {
    return {
      eligible: false,
      mode: 'asymmetric',
      symmetryScore: 0,
      pairCount: 0,
      reason: 'insufficient-peaks'
    };
  }

  const totalSpan = end - start;
  const center = (start + end) / 2;
  const tolerance = Math.max(6, totalSpan * 0.012);
  const edgeTolerance = Math.max(8, totalSpan * 0.018);
  const normalized = values.map((value) => (value - start) / Math.max(1e-6, totalSpan));
  const intervalPairs = [];
  const intervals = values.slice(1).map((value, index) => value - values[index]).filter((gap) => gap > 0);
  for (let i = 0; i < Math.floor(intervals.length / 2); i += 1) {
    const left = intervals[i];
    const right = intervals[intervals.length - 1 - i];
    const ratio = Math.abs(left - right) / Math.max(1, Math.max(left, right));
    intervalPairs.push({
      left: Number(left.toFixed(3)),
      right: Number(right.toFixed(3)),
      ratio: Number(ratio.toFixed(4)),
      symmetric: ratio <= 0.16
    });
  }

  const mirrorPairs = [];
  for (let i = 0; i < values.length; i += 1) {
    const left = values[i];
    const right = values[values.length - 1 - i];
    const mirrorDelta = Math.abs((left + right) - (start + end));
    mirrorPairs.push({
      left: Number(left.toFixed(3)),
      right: Number(right.toFixed(3)),
      mirrorDelta: Number(mirrorDelta.toFixed(3)),
      symmetric: mirrorDelta <= tolerance
    });
  }

  const edgeAligned = (
    Math.abs(values[0] - start) <= edgeTolerance
    && Math.abs(values[values.length - 1] - end) <= edgeTolerance
  );
  const intervalSymmetryRatio = intervalPairs.length
    ? intervalPairs.filter((entry) => entry.symmetric).length / intervalPairs.length
    : 1;
  const mirrorSymmetryRatio = mirrorPairs.length
    ? mirrorPairs.filter((entry) => entry.symmetric).length / mirrorPairs.length
    : 1;
  const centerOffset = values.length % 2 === 1
    ? Math.abs(values[Math.floor(values.length / 2)] - center)
    : 0;
  const centerAligned = values.length % 2 === 0 || centerOffset <= tolerance;
  const countAligned = Math.abs(values.length - expectedCount) <= Math.max(1, Math.floor(expectedCount * 0.35));
  const symmetryScore = clamp01(
    intervalSymmetryRatio * 0.44
    + mirrorSymmetryRatio * 0.38
    + (edgeAligned ? 0.1 : 0)
    + (centerAligned ? 0.08 : 0)
  );
  const eligible = symmetryScore >= 0.72 && edgeAligned && centerAligned && countAligned;
  const preferredMode = options.preferredMode || null;

  return {
    eligible,
    mode: eligible ? (preferredMode || 'symmetric-subdivision') : 'asymmetric',
    symmetryScore: Number(symmetryScore.toFixed(4)),
    intervalSymmetryRatio: Number(intervalSymmetryRatio.toFixed(4)),
    mirrorSymmetryRatio: Number(mirrorSymmetryRatio.toFixed(4)),
    edgeAligned,
    centerAligned,
    centerOffset: Number(centerOffset.toFixed(3)),
    countAligned,
    pairCount: intervalPairs.length,
    expectedCount,
    actualCount: values.length,
    normalizedPeaks: normalized.map((value) => Number(value.toFixed(4))),
    intervalPairs,
    mirrorPairs
  };
}

function resolveSpecificGridSubdivisionMode(options = {}) {
  const {
    symmetry = null,
    uniformDiagnostics = null,
    alternatingDiagnostics = null,
    dashedLikeEvidence = false,
    alternatingAccepted = false
  } = options;
  if (!symmetry?.eligible) {
    return {
      specificMode: 'unspecified-asymmetric',
      reason: 'symmetry-not-established'
    };
  }
  if (dashedLikeEvidence) {
    return {
      specificMode: 'symmetric-uniform-cells-with-inner-dashed',
      reason: 'symmetric-subdivision-with-inner-dashed-evidence'
    };
  }
  if (alternatingAccepted) {
    return {
      specificMode: 'symmetric-alternating-box-gap',
      reason: 'symmetric-subdivision-with-alternating-width-gap'
    };
  }
  if ((uniformDiagnostics?.mode || null) === 'uniform-boundary-grid') {
    return {
      specificMode: 'symmetric-uniform-boundary-grid',
      reason: 'symmetric-subdivision-with-uniform-cells'
    };
  }
  if ((uniformDiagnostics?.mode || null) === 'uniform-cells-with-inner-dashed') {
    return {
      specificMode: 'symmetric-uniform-cells-with-inner-dashed',
      reason: 'uniform-selection-reports-inner-dashed'
    };
  }
  if ((alternatingDiagnostics?.mode || null) === 'alternating-box-gap') {
    return {
      specificMode: 'symmetric-alternating-box-gap',
      reason: 'alternating-selection-reports-box-gap'
    };
  }
  return {
    specificMode: 'symmetric-unknown-subdivision',
    reason: 'symmetry-established-but-no-specific-subdivision-match'
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

  const xSelection = maybeForceUniformAxisSelection(
    selectRepresentativeGuidePeaks(guides.xPeaks, left, right, gridCols),
    left,
    right,
    gridCols,
    'x'
  );
  const ySelection = maybeForceUniformAxisSelection(
    selectRepresentativeGuidePeaks(guides.yPeaks, top, bottom, gridRows),
    top,
    bottom,
    gridRows,
    'y'
  );
  const representativeGuides = {
    left,
    right,
    top,
    bottom,
    xPeaks: xSelection.peaks,
    yPeaks: ySelection.peaks
  };
  const globalPattern = detectGlobalGridPattern(
    representativeGuides,
    guides,
    gridRows,
    gridCols
  );

  return {
    left,
    right,
    top,
    bottom,
    xPeaks: xSelection.peaks,
    yPeaks: ySelection.peaks,
    xSource: xSelection.source,
    ySource: ySelection.source,
    xPattern: xSelection.mode || null,
    yPattern: ySelection.mode || null,
    xPatternDiagnostics: xSelection.diagnostics || null,
    yPatternDiagnostics: ySelection.diagnostics || null,
    globalPattern
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
    yPeaks: normalizedY,
    xSource: rawPeakGuides?.xSource || guides?.xSource || null,
    ySource: rawPeakGuides?.ySource || guides?.ySource || null,
    xPattern: rawPeakGuides?.xPattern || guides?.xPattern || null,
    yPattern: rawPeakGuides?.yPattern || guides?.yPattern || null,
    xPatternDiagnostics: rawPeakGuides?.xPatternDiagnostics || guides?.xPatternDiagnostics || null,
    yPatternDiagnostics: rawPeakGuides?.yPatternDiagnostics || guides?.yPatternDiagnostics || null,
    globalPattern: detectGlobalGridPattern(
      {
        left,
        right,
        top,
        bottom,
        xPeaks: normalizedX,
        yPeaks: normalizedY,
        xPattern: rawPeakGuides?.xPattern || guides?.xPattern || null,
        yPattern: rawPeakGuides?.yPattern || guides?.yPattern || null,
        xPatternDiagnostics: rawPeakGuides?.xPatternDiagnostics || guides?.xPatternDiagnostics || null,
        yPatternDiagnostics: rawPeakGuides?.yPatternDiagnostics || guides?.yPatternDiagnostics || null
      },
      guides,
      gridRows,
      gridCols
    )
  };
}

function analyzeDividerBandPattern(rawPeaks, representativePeaks, medianSpan) {
  const raw = Array.isArray(rawPeaks) ? rawPeaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  const representative = Array.isArray(representativePeaks) ? representativePeaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  if (raw.length < 3 || representative.length < 3 || !(medianSpan > 0)) {
    return {
      dividerType: 'unknown',
      dividerBands: [],
      dominantDividerType: 'unknown',
      consistentCellSpanRatio: 0,
      consistentDividerRatio: 0
    };
  }
  const sideMin = medianSpan * 0.05;
  const sideMax = medianSpan * 0.22;
  const centerTolerance = Math.max(4, medianSpan * 0.08);
  const spanTolerance = Math.max(8, medianSpan * 0.18);
  const dividerBands = [];

  for (let index = 1; index < representative.length - 1; index += 1) {
    const divider = representative[index];
    const prevSpan = representative[index] - representative[index - 1];
    const nextSpan = representative[index + 1] - representative[index];
    const localRaw = raw.filter((value) => value >= divider - sideMax * 1.2 && value <= divider + sideMax * 1.2);
    const center = localRaw.find((value) => Math.abs(value - divider) <= centerTolerance) ?? null;
    const leftCompanions = localRaw.filter((value) => {
      const delta = divider - value;
      return delta >= sideMin && delta <= sideMax;
    });
    const rightCompanions = localRaw.filter((value) => {
      const delta = value - divider;
      return delta >= sideMin && delta <= sideMax;
    });
    let dividerType = 'single-divider';
    if (center !== null && leftCompanions.length && rightCompanions.length) {
      dividerType = 'solid-divider-with-double-inner-dashed';
    } else if (leftCompanions.length && rightCompanions.length) {
      dividerType = 'double-inner-dashed-without-solid-center';
    } else if (center !== null && (leftCompanions.length || rightCompanions.length)) {
      dividerType = 'solid-divider-with-single-inner-dashed';
    }
    dividerBands.push({
      index,
      divider: Number(divider.toFixed(3)),
      prevSpan: Number(prevSpan.toFixed(3)),
      nextSpan: Number(nextSpan.toFixed(3)),
      spansSimilar: Math.abs(prevSpan - nextSpan) <= spanTolerance,
      centerLine: center !== null ? Number(center.toFixed(3)) : null,
      leftCompanions: leftCompanions.map((value) => Number(value.toFixed(3))),
      rightCompanions: rightCompanions.map((value) => Number(value.toFixed(3))),
      dividerType
    });
  }

  const consistentCellSpanCount = dividerBands.filter((entry) => entry.spansSimilar).length;
  const dividerTypeCounts = dividerBands.reduce((acc, entry) => {
    acc[entry.dividerType] = (acc[entry.dividerType] || 0) + 1;
    return acc;
  }, {});
  const dominantDividerType = Object.entries(dividerTypeCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  const consistentDividerCount = dividerBands.filter((entry) => entry.dividerType === dominantDividerType).length;

  return {
    dividerBands,
    dominantDividerType,
    consistentCellSpanRatio: dividerBands.length ? Number((consistentCellSpanCount / dividerBands.length).toFixed(4)) : 0,
    consistentDividerRatio: dividerBands.length ? Number((consistentDividerCount / dividerBands.length).toFixed(4)) : 0
  };
}

function detectGlobalGridPattern(guides, rawGuides, gridRows, gridCols) {
  if (!guides) {
    return null;
  }
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const rawXPeaks = Array.isArray(rawGuides?.xPeaks) ? rawGuides.xPeaks.map(Number).filter(Number.isFinite) : xPeaks;
  const rawYPeaks = Array.isArray(rawGuides?.yPeaks) ? rawGuides.yPeaks.map(Number).filter(Number.isFinite) : yPeaks;
  const medianCellWidth = xPeaks.length >= 2
    ? median(xPeaks.slice(1).map((value, index) => value - xPeaks[index]).filter((gap) => gap > 0))
    : null;
  const medianCellHeight = yPeaks.length >= 2
    ? median(yPeaks.slice(1).map((value, index) => value - yPeaks[index]).filter((gap) => gap > 0))
    : null;
  const xDividerPattern = analyzeDividerBandPattern(rawXPeaks, xPeaks, medianCellWidth || 0);
  const yDividerPattern = analyzeDividerBandPattern(rawYPeaks, yPeaks, medianCellHeight || 0);
  const xSymmetry = analyzeSymmetricSubdivision(xPeaks, Number(guides.left), Number(guides.right), gridCols, {
    preferredMode: guides?.xPattern || null
  });
  const ySymmetry = analyzeSymmetricSubdivision(yPeaks, Number(guides.top), Number(guides.bottom), gridRows, {
    preferredMode: guides?.yPattern || null
  });
  const declaredGuideMode = (
    guides?.xPattern
    && guides?.yPattern
    && guides.xPattern === guides.yPattern
    && xSymmetry.eligible
    && ySymmetry.eligible
  ) ? guides.xPattern : null;
  const xSpanStable = xDividerPattern.consistentCellSpanRatio >= 0.7;
  const ySpanStable = yDividerPattern.consistentCellSpanRatio >= 0.7;
  const xDoubleDashed = xDividerPattern.dominantDividerType === 'solid-divider-with-double-inner-dashed';
  const yDoubleDashed = yDividerPattern.dominantDividerType === 'solid-divider-with-double-inner-dashed';

  let mode = 'mixed';
  if (declaredGuideMode && ['uniform-boundary-grid', 'uniform-cells-with-inner-dashed', 'alternating-box-gap'].includes(declaredGuideMode)) {
    mode = declaredGuideMode;
  } else if (xSymmetry.eligible && ySymmetry.eligible && xSpanStable && ySpanStable && xDoubleDashed && yDoubleDashed) {
    mode = 'uniform-cells-with-inner-dashed';
  } else if (xSymmetry.eligible && ySymmetry.eligible && xSpanStable && ySpanStable) {
    mode = 'uniform-boundary-grid';
  } else if (xSymmetry.eligible && ySymmetry.eligible && xDividerPattern.dominantDividerType === 'single-divider' && yDividerPattern.dominantDividerType === 'single-divider') {
    mode = 'single-divider-grid';
  }
  const specificMode = (
    guides?.xPatternDiagnostics?.specificMode
    && guides?.yPatternDiagnostics?.specificMode
    && guides.xPatternDiagnostics.specificMode === guides.yPatternDiagnostics.specificMode
  ) ? guides.xPatternDiagnostics.specificMode : (
    xSymmetry.eligible && ySymmetry.eligible
      ? 'symmetric-mixed-subdivision'
      : 'unspecified-asymmetric'
  );

  return {
    mode,
    basedOn: 'adjacent-cell-span-and-divider-band',
    gridRows,
    gridCols,
    specificMode,
    patternProfile: guides?.globalPattern?.patternProfile || null,
    symmetry: {
      x: xSymmetry,
      y: ySymmetry,
      eligible: Boolean(xSymmetry.eligible && ySymmetry.eligible)
    },
    medianCellWidth: Number.isFinite(medianCellWidth) ? Number(medianCellWidth.toFixed(3)) : null,
    medianCellHeight: Number.isFinite(medianCellHeight) ? Number(medianCellHeight.toFixed(3)) : null,
    x: xDividerPattern,
    y: yDividerPattern
  };
}

function getPatternProfileSettings(profileFamily, outerFramePattern = null) {
  const normalizedOuterFramePattern = normalizeOuterFramePattern(outerFramePattern);
  switch (profileFamily) {
    case 'inner-dashed-box-grid':
      return {
        preferLeftBottomTraversal: true,
        allowTopRecoveryByInnerGuide: true,
        prioritizeInnerFrameWhenDarkest: true,
        prioritizeOuterFrameWhenDarkest: false,
        referenceSamples: ['test/obj/1.jpg']
      };
    case 'circle-mi-grid':
      return {
        preferLeftBottomTraversal: false,
        allowTopRecoveryByInnerGuide: false,
        prioritizeInnerFrameWhenDarkest: false,
        prioritizeOuterFrameWhenDarkest: Boolean(normalizedOuterFramePattern),
        referenceSamples: ['test/obj/2.jpg']
      };
    case 'diagonal-mi-grid':
      return {
        preferLeftBottomTraversal: true,
        allowTopRecoveryByInnerGuide: false,
        prioritizeInnerFrameWhenDarkest: !normalizedOuterFramePattern,
        prioritizeOuterFrameWhenDarkest: Boolean(normalizedOuterFramePattern),
        referenceSamples: normalizedOuterFramePattern === 'full-margin-outer-frame'
          ? ['test/obj/3.jpg']
          : ['test/obj/4.jpg']
      };
    default:
      return {
        preferLeftBottomTraversal: false,
        allowTopRecoveryByInnerGuide: true,
        prioritizeInnerFrameWhenDarkest: !normalizedOuterFramePattern,
        prioritizeOuterFrameWhenDarkest: Boolean(normalizedOuterFramePattern),
        referenceSamples: []
      };
  }
}

function normalizeOuterFramePattern(outerFramePattern = null) {
  const allowedPatterns = new Set([
    'full-margin-outer-frame',
    'top-bottom-separated-outer-frame',
    'left-right-separated-outer-frame',
    'three-side-or-asymmetric-outer-frame',
    'mixed-outer-frame'
  ]);
  return allowedPatterns.has(outerFramePattern) ? outerFramePattern : null;
}

function classifyGridPatternProfile(signals, globalPattern = null, outerFramePattern = null) {
  const ringSignal = Number(signals?.ringBandDarkness) || 0;
  const diagonalSignal = Number(signals?.diagonalDarkness) || 0;
  const crossSignal = Number(signals?.crossDarkness) || 0;
  const insetSignal = Number(signals?.insetBoxDarkness) || 0;
  const centerSignal = Number(signals?.centerDarkness) || 0;
  const redGuideRatio = Number(signals?.redGuideRatio) || 0;
  const redGuideStrength = Number(signals?.redGuideStrength) || 0;
  const normalizedOuterFramePattern = normalizeOuterFramePattern(outerFramePattern);
  let profileFamily = 'plain-uniform-grid';
  let reason = 'uniform-grid-without-strong-inner-subdivision-structure';

  if (redGuideRatio >= 0.18 && redGuideStrength >= 0.12) {
    profileFamily = 'circle-mi-grid';
    reason = 'red-guide-lines-match-circle-mi-reference-template';
  } else if (normalizedOuterFramePattern) {
    profileFamily = 'diagonal-mi-grid';
    reason = 'four-side-outer-frame-template-defaults-to-diagonal-mi-reference';
  } else if (
    diagonalSignal >= insetSignal + 0.012
    || diagonalSignal >= crossSignal + 0.01
  ) {
    profileFamily = 'diagonal-mi-grid';
    reason = 'diagonal-strokes-dominate-inner-cell-structure';
  } else if (!normalizedOuterFramePattern) {
    profileFamily = 'inner-dashed-box-grid';
    reason = 'no-explicit-outer-frame-and-non-red-grid-better-match-inner-dashed-reference';
  } else if (
    insetSignal >= diagonalSignal - 0.006
    && insetSignal >= ringSignal - 0.008
    && centerSignal <= Math.max(insetSignal + 0.02, 0.28)
  ) {
    profileFamily = 'inner-dashed-box-grid';
    reason = 'inset-box-structure-better-matches-inner-dashed-reference';
  }

  const outerFrameLayout = normalizedOuterFramePattern || 'no-explicit-outer-frame';
  const profileMode = `template-${profileFamily}-${outerFrameLayout}`;
  return {
    family: profileFamily,
    profileMode,
    outerFrameLayout,
    reason,
    matchedBy: 'blank-cell-structure-sampling',
    signals: {
      ringSignal: Number(ringSignal.toFixed(4)),
      diagonalSignal: Number(diagonalSignal.toFixed(4)),
      crossSignal: Number(crossSignal.toFixed(4)),
      insetSignal: Number(insetSignal.toFixed(4)),
      centerSignal: Number(centerSignal.toFixed(4)),
      redGuideRatio: Number(redGuideRatio.toFixed(4)),
      redGuideStrength: Number(redGuideStrength.toFixed(4))
    },
    id: `${profileFamily}:${outerFrameLayout}`,
    settings: getPatternProfileSettings(profileFamily, normalizedOuterFramePattern),
    globalMode: globalPattern?.mode || null,
    globalSpecificMode: globalPattern?.specificMode || null
  };
}

function mergePatternProfileIntoGuides(guides, patternProfile, outerFramePattern = null) {
  if (!guides || !patternProfile) {
    return guides || null;
  }
  const normalizedOuterFramePattern = normalizeOuterFramePattern(outerFramePattern);
  const nextProfile = {
    ...patternProfile,
    outerFrameLayout: normalizedOuterFramePattern || 'no-explicit-outer-frame',
    profileMode: `template-${patternProfile.family}-${normalizedOuterFramePattern || 'no-explicit-outer-frame'}`,
    id: `${patternProfile.family}:${normalizedOuterFramePattern || 'no-explicit-outer-frame'}`,
    settings: getPatternProfileSettings(patternProfile.family, normalizedOuterFramePattern)
  };
  return {
    ...guides,
    globalPattern: {
      ...(guides.globalPattern || {}),
      patternProfile: nextProfile
    }
  };
}

function resolveRepresentativeBoundarySupport(options = {}) {
  const {
    patternMode = 'mixed',
    representativePeaks = [],
    expectedUniformPeaks = [],
    start = NaN,
    end = NaN,
    uniformGap = NaN,
    medianGap = NaN,
    side = 'start'
  } = options;
  const useRepresentativeMode = (
    patternMode === 'uniform-cells-with-inner-dashed'
    || patternMode === 'uniform-boundary-grid'
    || patternMode === 'mixed'
  );
  const representative = Array.isArray(representativePeaks)
    ? representativePeaks.map(Number).filter(Number.isFinite)
    : [];
  const expected = Array.isArray(expectedUniformPeaks)
    ? expectedUniformPeaks.map(Number).filter(Number.isFinite)
    : [];
  const fallbackGap = Number.isFinite(uniformGap) && uniformGap > 0
    ? uniformGap
    : (Number.isFinite(medianGap) && medianGap > 0 ? medianGap : NaN);
  const isStart = side !== 'end';
  const representativeIndex = isStart ? 1 : Math.max(0, representative.length - 2);
  const expectedIndex = isStart ? 1 : Math.max(0, expected.length - 2);
  const representativeValue = representative.length >= 2 ? Number(representative[representativeIndex]) : NaN;
  const inferredValueFromGap = Number.isFinite(fallbackGap)
    ? (isStart ? Number(start) + fallbackGap : Number(end) - fallbackGap)
    : NaN;
  const expectedValue = expected.length >= 2
    ? Number(expected[expectedIndex])
    : inferredValueFromGap;
  const toleranceBase = Number.isFinite(fallbackGap) && fallbackGap > 0 ? fallbackGap : medianGap;
  const reliabilityTolerance = Math.max(18, Math.round((Number(toleranceBase) || 0) * 0.28));
  const representativeReliable = (
    Number.isFinite(representativeValue)
    && Number.isFinite(expectedValue)
    && Math.abs(representativeValue - expectedValue) <= reliabilityTolerance
  );

  let resolvedValue = representativeValue;
  let resolvedSource = 'representative-peak';
  if (useRepresentativeMode && Number.isFinite(expectedValue) && !representativeReliable) {
    resolvedValue = expectedValue;
    resolvedSource = Number.isFinite(representativeValue)
      ? 'uniform-gap-inferred'
      : 'uniform-gap-fallback';
  } else if (!Number.isFinite(resolvedValue) && Number.isFinite(expectedValue)) {
    resolvedValue = expectedValue;
    resolvedSource = 'uniform-gap-fallback';
  }

  return {
    side,
    value: Number.isFinite(resolvedValue) ? resolvedValue : null,
    source: resolvedSource,
    representativeValue: Number.isFinite(representativeValue) ? representativeValue : null,
    expectedValue: Number.isFinite(expectedValue) ? expectedValue : null,
    uniformGap: Number.isFinite(uniformGap) ? Number(uniformGap.toFixed(3)) : null,
    medianGap: Number.isFinite(medianGap) ? Number(medianGap.toFixed(3)) : null,
    representativeReliable,
    reliabilityTolerance: Number.isFinite(reliabilityTolerance) ? reliabilityTolerance : null,
    representativeDelta: (
      Number.isFinite(representativeValue) && Number.isFinite(expectedValue)
        ? Number((representativeValue - expectedValue).toFixed(3))
        : null
    )
  };
}

function inferGridOuterBoundHints(rawGuides, cellWidth, cellHeight, width, height, options = {}) {
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
  const gridCols = Math.max(1, Number(options.gridCols) || 0);
  const gridRows = Math.max(1, Number(options.gridRows) || 0);
  const xPatternSelection = gridCols ? detectGuidePatternSelection(rawX, left, right, gridCols) : null;
  const yPatternSelection = gridRows ? detectGuidePatternSelection(rawY, top, bottom, gridRows) : null;
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
    xPattern: xPatternSelection?.mode || null,
    yPattern: yPatternSelection?.mode || null,
    overallPattern: (
      xPatternSelection?.mode
      && yPatternSelection?.mode
      && xPatternSelection.mode === yPatternSelection.mode
    ) ? xPatternSelection.mode : 'mixed',
    xPatternDiagnostics: xPatternSelection?.diagnostics || null,
    yPatternDiagnostics: yPatternSelection?.diagnostics || null,
    firstInnerX: innerX[0] ?? null,
    secondInnerX: innerX[1] ?? null,
    lastInnerX: innerX.length ? innerX[innerX.length - 1] : null,
    prevInnerX: innerX.length > 1 ? innerX[innerX.length - 2] : null,
    firstInnerY: innerY[0] ?? null,
    secondInnerY: innerY[1] ?? null,
    lastInnerY: innerY.length ? innerY[innerY.length - 1] : null,
    prevInnerY: innerY.length > 1 ? innerY[innerY.length - 2] : null
  };
  const globalPattern = rawGuides?.globalPattern || detectGlobalGridPattern(
    {
      left,
      right,
      top,
      bottom,
      xPeaks: Array.isArray(xPatternSelection?.peaks) ? xPatternSelection.peaks : [],
      yPeaks: Array.isArray(yPatternSelection?.peaks) ? yPatternSelection.peaks : []
    },
    rawGuides,
    gridRows,
    gridCols
  );
  if (globalPattern) {
    diagnostics.globalPattern = globalPattern;
    diagnostics.overallPattern = globalPattern.mode || diagnostics.overallPattern;
  }
  const representativeX = Array.isArray(xPatternSelection?.peaks) ? xPatternSelection.peaks.map(Number).filter(Number.isFinite) : [];
  const representativeY = Array.isArray(yPatternSelection?.peaks) ? yPatternSelection.peaks.map(Number).filter(Number.isFinite) : [];
  const uniformRepresentativeXGap = representativeX.length >= 3
    ? median(representativeX.slice(1).map((value, index) => value - representativeX[index]).filter((gap) => gap > 0))
    : null;
  const uniformRepresentativeYGap = representativeY.length >= 3
    ? median(representativeY.slice(1).map((value, index) => value - representativeY[index]).filter((gap) => gap > 0))
    : null;
  const expectedUniformX = gridCols ? buildUniformGuidePeaks(left, right, gridCols) : [];
  const expectedUniformY = gridRows ? buildUniformGuidePeaks(top, bottom, gridRows) : [];
  diagnostics.majorXGap = Number.isFinite(uniformRepresentativeXGap) ? Number(uniformRepresentativeXGap.toFixed(3)) : null;
  diagnostics.majorYGap = Number.isFinite(uniformRepresentativeYGap) ? Number(uniformRepresentativeYGap.toFixed(3)) : null;

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
  const countAllStableGaps = (values, medianGap) => {
    if (!Array.isArray(values) || values.length < 3 || !Number.isFinite(medianGap) || medianGap <= 0) {
      return 0;
    }
    const gaps = values.slice(1).map((value, index) => value - values[index]).filter((gap) => gap > 0);
    return gaps.filter((gap) => gap >= medianGap * 0.45 && gap <= medianGap * 1.85).length;
  };
  diagnostics.xGlobalStableGapCount = countAllStableGaps(innerX, medianXGap);
  diagnostics.yGlobalStableGapCount = countAllStableGaps(innerY, medianYGap);

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

  diagnostics.leftBoundarySupport = resolveRepresentativeBoundarySupport({
    patternMode: diagnostics.xPattern || 'mixed',
    representativePeaks: representativeX,
    expectedUniformPeaks: expectedUniformX,
    start: left,
    end: right,
    uniformGap: uniformRepresentativeXGap,
    medianGap: medianXGap,
    side: 'start'
  });
  diagnostics.rightBoundarySupport = resolveRepresentativeBoundarySupport({
    patternMode: diagnostics.xPattern || 'mixed',
    representativePeaks: representativeX,
    expectedUniformPeaks: expectedUniformX,
    start: left,
    end: right,
    uniformGap: uniformRepresentativeXGap,
    medianGap: medianXGap,
    side: 'end'
  });
  diagnostics.topBoundarySupport = resolveRepresentativeBoundarySupport({
    patternMode: diagnostics.yPattern || 'mixed',
    representativePeaks: representativeY,
    expectedUniformPeaks: expectedUniformY,
    start: top,
    end: bottom,
    uniformGap: uniformRepresentativeYGap,
    medianGap: medianYGap,
    side: 'start'
  });
  diagnostics.bottomBoundarySupport = resolveRepresentativeBoundarySupport({
    patternMode: diagnostics.yPattern || 'mixed',
    representativePeaks: representativeY,
    expectedUniformPeaks: expectedUniformY,
    start: top,
    end: bottom,
    uniformGap: uniformRepresentativeYGap,
    medianGap: medianYGap,
    side: 'end'
  });

  const leftBottomJointSupport = (() => {
    const xPatternMode = diagnostics.xPattern || 'mixed';
    const yPatternMode = diagnostics.yPattern || 'mixed';
    const leftBoundarySupport = xPatternMode === 'alternating-box-gap'
      ? {
          side: 'left',
          value: Number(diagnostics.firstInnerX),
          source: 'first-inner-line',
          representativeValue: Number(diagnostics.firstInnerX),
          expectedValue: Number.isFinite(medianXGap) ? Number(left) + medianXGap : null,
          representativeReliable: true,
          representativeDelta: 0
        }
      : resolveRepresentativeBoundarySupport({
          patternMode: xPatternMode,
          representativePeaks: representativeX,
          expectedUniformPeaks: expectedUniformX,
          start: left,
          end: right,
          uniformGap: uniformRepresentativeXGap,
          medianGap: medianXGap,
          side: 'start'
        });
    const bottomBoundarySupport = yPatternMode === 'alternating-box-gap'
      ? {
          side: 'bottom',
          value: Number(diagnostics.lastInnerY),
          source: 'last-inner-line',
          representativeValue: Number(diagnostics.lastInnerY),
          expectedValue: Number.isFinite(medianYGap) ? Number(bottom) - medianYGap : null,
          representativeReliable: true,
          representativeDelta: 0
        }
      : resolveRepresentativeBoundarySupport({
          patternMode: yPatternMode,
          representativePeaks: representativeY,
          expectedUniformPeaks: expectedUniformY,
          start: top,
          end: bottom,
          uniformGap: uniformRepresentativeYGap,
          medianGap: medianYGap,
          side: 'end'
        });
    const supportFirstX = Number(leftBoundarySupport?.value);
    const supportLastY = Number(bottomBoundarySupport?.value);
    const expectedLeftGap = xPatternMode === 'alternating-box-gap'
      ? medianXGap
      : (uniformRepresentativeXGap || medianXGap);
    const expectedBottomGap = yPatternMode === 'alternating-box-gap'
      ? medianYGap
      : (uniformRepresentativeYGap || medianYGap);
    const leftGap = Number(supportFirstX) - Number(hintedLeft);
    const bottomGap = Number(hintedBottom) - Number(supportLastY);
    if (
      !Number.isFinite(leftGap)
      || !Number.isFinite(bottomGap)
      || !Number.isFinite(expectedLeftGap)
      || !Number.isFinite(expectedBottomGap)
      || expectedLeftGap <= 0
      || expectedBottomGap <= 0
    ) {
      return null;
    }
    const leftGapScore = clamp01(1 - Math.abs(leftGap - expectedLeftGap) / Math.max(14, expectedLeftGap * 0.22));
    const bottomGapScore = clamp01(1 - Math.abs(bottomGap - expectedBottomGap) / Math.max(14, expectedBottomGap * 0.22));
    const leftRunScore = clamp01(Math.max(Number(diagnostics.leftStableInnerRun) || 0, Number(diagnostics.xGlobalStableGapCount) || 0) / 5);
    const bottomRunScore = clamp01(Math.max(Number(diagnostics.bottomStableInnerRun) || 0, Number(diagnostics.yGlobalStableGapCount) || 0) / 5);
    const continuityScore = average([leftRunScore, bottomRunScore]);
    const score = average([leftGapScore, bottomGapScore, continuityScore]);
    const softEligible = (
      score >= 0.84
      && leftGapScore >= 0.8
      && bottomGapScore >= 0.58
      && continuityScore >= 0.9
    );
    return {
      eligible: (
        (
          leftGapScore >= 0.72
          && bottomGapScore >= 0.72
          && (Number(diagnostics.leftStableInnerRun) || 0) >= 2
          && (Number(diagnostics.bottomStableInnerRun) || 0) >= 2
        )
        || softEligible
      ),
      eligibilityMode: softEligible ? 'soft-high-score' : 'strict',
      score: Number(score.toFixed(4)),
      xPatternMode,
      yPatternMode,
      leftBoundarySupport,
      bottomBoundarySupport,
      leftGap: Number(leftGap.toFixed(3)),
      bottomGap: Number(bottomGap.toFixed(3)),
      expectedLeftGap: Number(expectedLeftGap.toFixed(3)),
      expectedBottomGap: Number(expectedBottomGap.toFixed(3)),
      leftGapScore: Number(leftGapScore.toFixed(4)),
      bottomGapScore: Number(bottomGapScore.toFixed(4)),
      leftRunScore: Number(leftRunScore.toFixed(4)),
      bottomRunScore: Number(bottomRunScore.toFixed(4)),
      continuityScore: Number(continuityScore.toFixed(4))
    };
  })();
  diagnostics.leftBottomJointSupport = leftBottomJointSupport;

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

function scoreCellPatternSignature(gray, width, height, bounds) {
  const left = Math.max(0, Math.min(width - 1, Math.round(bounds.left)));
  const right = Math.max(left + 1, Math.min(width, Math.round(bounds.right)));
  const top = Math.max(0, Math.min(height - 1, Math.round(bounds.top)));
  const bottom = Math.max(top + 1, Math.min(height, Math.round(bounds.bottom)));
  const cellWidth = right - left;
  const cellHeight = bottom - top;
  if (cellWidth < 24 || cellHeight < 24) {
    return null;
  }

  const step = Math.max(1, Math.round(Math.min(cellWidth, cellHeight) / 42));
  const inset = 0.18;
  const lineTol = 0.04;
  const ringRadius = 0.34;
  const ringTol = 0.05;
  const centerHalf = 0.13;
  let totalDarkness = 0;
  let totalCount = 0;
  let centerDarkness = 0;
  let centerCount = 0;
  let diagonalDarkness = 0;
  let diagonalCount = 0;
  let crossDarkness = 0;
  let crossCount = 0;
  let ringDarkness = 0;
  let ringCount = 0;
  let insetBoxDarkness = 0;
  let insetBoxCount = 0;

  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const nx = ((x - left) + 0.5) / Math.max(1, cellWidth);
      const ny = ((y - top) + 0.5) / Math.max(1, cellHeight);
      if (nx <= 0.06 || nx >= 0.94 || ny <= 0.06 || ny >= 0.94) {
        continue;
      }
      const darkness = clamp01((255 - gray[y * width + x]) / 255);
      totalDarkness += darkness;
      totalCount += 1;
      const dx = nx - 0.5;
      const dy = ny - 0.5;
      const radius = Math.hypot(dx, dy);
      if (Math.abs(nx - 0.5) <= lineTol || Math.abs(ny - 0.5) <= lineTol) {
        crossDarkness += darkness;
        crossCount += 1;
      }
      if (Math.abs(ny - nx) <= lineTol || Math.abs(ny - (1 - nx)) <= lineTol) {
        diagonalDarkness += darkness;
        diagonalCount += 1;
      }
      if (Math.abs(radius - ringRadius) <= ringTol) {
        ringDarkness += darkness;
        ringCount += 1;
      }
      if (
        (Math.abs(nx - inset) <= lineTol && ny >= inset && ny <= (1 - inset))
        || (Math.abs(nx - (1 - inset)) <= lineTol && ny >= inset && ny <= (1 - inset))
        || (Math.abs(ny - inset) <= lineTol && nx >= inset && nx <= (1 - inset))
        || (Math.abs(ny - (1 - inset)) <= lineTol && nx >= inset && nx <= (1 - inset))
      ) {
        insetBoxDarkness += darkness;
        insetBoxCount += 1;
      }
      if (Math.abs(dx) <= centerHalf && Math.abs(dy) <= centerHalf) {
        centerDarkness += darkness;
        centerCount += 1;
      }
    }
  }

  return {
    cellWidth,
    cellHeight,
    totalDarkness: totalCount ? totalDarkness / totalCount : 0,
    centerDarkness: centerCount ? centerDarkness / centerCount : 0,
    diagonalDarkness: diagonalCount ? diagonalDarkness / diagonalCount : 0,
    crossDarkness: crossCount ? crossDarkness / crossCount : 0,
    ringBandDarkness: ringCount ? ringDarkness / ringCount : 0,
    insetBoxDarkness: insetBoxCount ? insetBoxDarkness / insetBoxCount : 0
  };
}

async function analyzeGridPatternProfileByCells(imagePath, guides, options = {}) {
  if (!imagePath || !guides) {
    return null;
  }
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  if (xPeaks.length < 3 || yPeaks.length < 3) {
    return null;
  }

  const { data, info } = await loadRgbImage(imagePath);
  const gray = computeGray(data, info.channels);
  const colorPack = options.colorImagePath
    ? await loadRgbImage(options.colorImagePath).catch(() => null)
    : null;
  const colorData = colorPack?.data || data;
  const colorInfo = colorPack?.info || info;
  const guideColorStats = (() => {
    let sampled = 0;
    let redGuideCount = 0;
    let redStrengthSum = 0;
    const xPeaksRounded = xPeaks.map((value) => Math.round(value));
    const yPeaksRounded = yPeaks.map((value) => Math.round(value));
    const scaleX = colorInfo.width / Math.max(1, info.width);
    const scaleY = colorInfo.height / Math.max(1, info.height);
    const leftBound = Math.max(0, Math.round((guides.left || 0) * scaleX));
    const rightBound = Math.min(colorInfo.width - 1, Math.round((guides.right || (info.width - 1)) * scaleX));
    const topBound = Math.max(0, Math.round((guides.top || 0) * scaleY));
    const bottomBound = Math.min(colorInfo.height - 1, Math.round((guides.bottom || (info.height - 1)) * scaleY));
    for (let y = topBound; y <= bottomBound; y += 3) {
      for (let x = leftBound; x <= rightBound; x += 3) {
        const nearVertical = xPeaksRounded.some((peak) => Math.abs(Math.round(peak * scaleX) - x) <= 2);
        const nearHorizontal = yPeaksRounded.some((peak) => Math.abs(Math.round(peak * scaleY) - y) <= 2);
        if (!nearVertical && !nearHorizontal) {
          continue;
        }
        const grayIndex = Math.min(info.width - 1, Math.round(x / Math.max(scaleX, 1e-6)))
          + Math.min(info.height - 1, Math.round(y / Math.max(scaleY, 1e-6))) * info.width;
        if ((255 - gray[grayIndex]) < 14) {
          continue;
        }
        const offset = (y * colorInfo.width + x) * colorInfo.channels;
        const r = colorData[offset];
        const g = colorData[offset + 1];
        const b = colorData[offset + 2];
        const redExcess = r - Math.max(g, b);
        sampled += 1;
        if (r > 120 && redExcess > 18) {
          redGuideCount += 1;
          redStrengthSum += redExcess / 255;
        }
      }
    }
    return {
      sampled,
      redGuideRatio: sampled ? redGuideCount / sampled : 0,
      redGuideStrength: redGuideCount ? redStrengthSum / redGuideCount : 0
    };
  })();
  const candidates = [];
  for (let row = 0; row < yPeaks.length - 1; row += 1) {
    const top = Math.max(0, Math.min(yPeaks[row], yPeaks[row + 1]));
    const bottom = Math.min(info.height, Math.max(yPeaks[row], yPeaks[row + 1]));
    for (let col = 0; col < xPeaks.length - 1; col += 1) {
      const left = Math.max(0, Math.min(xPeaks[col], xPeaks[col + 1]));
      const right = Math.min(info.width, Math.max(xPeaks[col], xPeaks[col + 1]));
      const signature = scoreCellPatternSignature(gray, info.width, info.height, { left, top, right, bottom });
      if (!signature) {
        continue;
      }
      candidates.push({
        row,
        col,
        ...signature
      });
    }
  }
  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => a.totalDarkness - b.totalDarkness);
  const sampleCount = Math.min(Math.max(6, Math.round(candidates.length * 0.22)), candidates.length);
  const selected = candidates.slice(0, sampleCount);
  const averagedSignals = {
    sampleCount,
    totalDarkness: average(selected.map((item) => item.totalDarkness)),
    centerDarkness: average(selected.map((item) => item.centerDarkness)),
    diagonalDarkness: average(selected.map((item) => item.diagonalDarkness)),
    crossDarkness: average(selected.map((item) => item.crossDarkness)),
    ringBandDarkness: average(selected.map((item) => item.ringBandDarkness)),
    insetBoxDarkness: average(selected.map((item) => item.insetBoxDarkness)),
    redGuideRatio: guideColorStats.redGuideRatio,
    redGuideStrength: guideColorStats.redGuideStrength,
    meanCellWidth: average(selected.map((item) => item.cellWidth)),
    meanCellHeight: average(selected.map((item) => item.cellHeight))
  };
  const patternProfile = classifyGridPatternProfile(
    averagedSignals,
    guides.globalPattern || null,
    options.outerFramePattern || null
  );
  return {
    ...patternProfile,
    sampling: {
      method: 'lowest-ink-cells',
      sampleCount,
      sampledCells: selected.slice(0, 8).map((item) => ({
        row: item.row,
        col: item.col,
        totalDarkness: Number(item.totalDarkness.toFixed(4))
      })),
      averagedSignals: {
        totalDarkness: Number(averagedSignals.totalDarkness.toFixed(4)),
        centerDarkness: Number(averagedSignals.centerDarkness.toFixed(4)),
        diagonalDarkness: Number(averagedSignals.diagonalDarkness.toFixed(4)),
        crossDarkness: Number(averagedSignals.crossDarkness.toFixed(4)),
        ringBandDarkness: Number(averagedSignals.ringBandDarkness.toFixed(4)),
        insetBoxDarkness: Number(averagedSignals.insetBoxDarkness.toFixed(4)),
        redGuideRatio: Number(averagedSignals.redGuideRatio.toFixed(4)),
        redGuideStrength: Number(averagedSignals.redGuideStrength.toFixed(4)),
        meanCellWidth: Number(averagedSignals.meanCellWidth.toFixed(3)),
        meanCellHeight: Number(averagedSignals.meanCellHeight.toFixed(3))
      }
    }
  };
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

function pickOutermostStrongDirectionalIndex(start, end, expected, scoreAt, options = {}) {
  const {
    distancePenalty = 0.85,
    outwardTarget = expected,
    outwardBias = 0,
    strongScoreRatio = 0.9,
    strongScoreMin = 72
  } = options;
  const from = Math.round(Math.min(start, end));
  const to = Math.round(Math.max(start, end));
  const scored = [];
  let bestEntry = null;
  for (let index = from; index <= to; index += 1) {
    const distance = Math.abs(index - expected);
    const outwardDistance = Math.abs(index - outwardTarget);
    const rawScore = scoreAt(index);
    const score = rawScore - distance * distancePenalty - outwardDistance * outwardBias;
    const entry = { index, rawScore, score };
    scored.push(entry);
    if (!bestEntry || score > bestEntry.score) {
      bestEntry = entry;
    }
  }
  if (!bestEntry) {
    return { index: clamp(Math.round(expected), from, to), score: -Infinity };
  }
  const strongThreshold = Math.max(strongScoreMin, bestEntry.rawScore * strongScoreRatio);
  const strongCandidates = scored.filter((entry) => entry.rawScore >= strongThreshold);
  if (!strongCandidates.length) {
    return { index: bestEntry.index, score: bestEntry.score };
  }
  strongCandidates.sort((a, b) => {
    const outwardA = Math.abs(a.index - outwardTarget);
    const outwardB = Math.abs(b.index - outwardTarget);
    if (Math.abs(outwardA - outwardB) > 1e-6) {
      return outwardA - outwardB;
    }
    return b.score - a.score;
  });
  return { index: strongCandidates[0].index, score: strongCandidates[0].score };
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

function analyzeTopBorderPatternByTripleLine(gray, width, height, options = {}) {
  const {
    outerX,
    outerY,
    inward = 1,
    cellWidth = 0,
    cellHeight = 0
  } = options;
  if (!Number.isFinite(outerX) || !Number.isFinite(outerY) || !(cellWidth > 0) || !(cellHeight > 0)) {
    return null;
  }
  const span = Math.max(24, Math.round(cellWidth * 0.9));
  const x0 = clamp(
    Math.round(inward > 0 ? outerX : outerX - span),
    0,
    Math.max(0, width - 1)
  );
  const x1 = clamp(
    Math.round(inward > 0 ? outerX + span : outerX),
    x0,
    Math.max(0, width - 1)
  );
  const yStart = clamp(Math.round(outerY - cellHeight * 0.18), 0, Math.max(0, height - 1));
  const yEnd = clamp(Math.round(outerY + cellHeight * 0.2), yStart, Math.max(0, height - 1));
  const entries = [];
  let maxScore = 0;
  for (let y = yStart; y <= yEnd; y += 1) {
    const lineScore = scoreHorizontalLineAt(gray, width, height, y, x0, x1);
    const dashedScore = scoreHorizontalDashedGuideAt(gray, width, height, y, x0, x1);
    const score = lineScore * 0.7 + dashedScore * 0.3;
    entries.push({ y, score, lineScore, dashedScore });
    maxScore = Math.max(maxScore, score);
  }
  if (!entries.length || maxScore <= 0) {
    return null;
  }
  const localThreshold = maxScore * 0.58;
  const peaks = [];
  for (let index = 1; index < entries.length - 1; index += 1) {
    const current = entries[index];
    if (
      current.score >= localThreshold
      && current.score >= entries[index - 1].score
      && current.score >= entries[index + 1].score
    ) {
      peaks.push(current);
    }
  }
  if (!peaks.length) {
    return null;
  }
  const clusterGap = Math.max(5, Math.round(cellHeight * 0.07));
  const clusters = [];
  let currentCluster = [peaks[0]];
  for (let index = 1; index < peaks.length; index += 1) {
    if (Math.abs(peaks[index].y - peaks[index - 1].y) <= clusterGap) {
      currentCluster.push(peaks[index]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [peaks[index]];
    }
  }
  clusters.push(currentCluster);
  const bestCluster = clusters
    .map((cluster) => {
      const ys = cluster.map((entry) => entry.y);
      const clusterCenter = average(ys);
      const nearestToOuter = cluster
        .slice()
        .sort((a, b) => Math.abs(a.y - outerY) - Math.abs(b.y - outerY))[0];
      return {
        cluster,
        clusterSize: cluster.length,
        clusterCenter,
        nearestToOuter,
        spread: Math.max(...ys) - Math.min(...ys),
        averageScore: average(cluster.map((entry) => entry.score))
      };
    })
    .sort((a, b) => {
      if (b.clusterSize !== a.clusterSize) {
        return b.clusterSize - a.clusterSize;
      }
      const outerDelta = Math.abs(a.nearestToOuter.y - outerY) - Math.abs(b.nearestToOuter.y - outerY);
      if (Math.abs(outerDelta) > 1e-6) {
        return outerDelta;
      }
      return (b.averageScore || 0) - (a.averageScore || 0);
    })[0];
  if (!bestCluster) {
    return null;
  }
  const outerBoundaryCandidate = bestCluster.nearestToOuter;
  const topMost = bestCluster.cluster[0];
  const mode = bestCluster.clusterSize >= 3
    ? 'triple-line-box-inner-dashed'
    : (bestCluster.clusterSize === 2 ? 'double-line-box-inner-dashed' : 'single-line');
  return {
    mode,
    outerBoundaryY: outerBoundaryCandidate.y,
    topMostY: topMost.y,
    outerBoundaryScore: Number(outerBoundaryCandidate.score.toFixed(3)),
    topMostScore: Number(topMost.score.toFixed(3)),
    clusterSize: bestCluster.clusterSize,
    spread: Number(bestCluster.spread.toFixed(3)),
    clusterCenter: Number(bestCluster.clusterCenter.toFixed(3)),
    peaks: bestCluster.cluster.map((entry) => ({
      y: entry.y,
      score: Number(entry.score.toFixed(3)),
      lineScore: Number(entry.lineScore.toFixed(3)),
      dashedScore: Number(entry.dashedScore.toFixed(3))
    }))
  };
}

async function recoverTopCornersByInnerGuide(imagePath, corners, guides) {
  const quad = normalizeCornerQuad(corners);
  if (!imagePath || !quad || !guides) {
    return { corners: quad, applied: false, diagnostics: null };
  }
  const patternProfile = guides?.globalPattern?.patternProfile || null;
  if (patternProfile?.settings?.allowTopRecoveryByInnerGuide === false) {
    return {
      corners: quad,
      applied: false,
      diagnostics: {
        method: 'top-corner recovery by inner dashed guide',
        skipped: true,
        reason: 'pattern-profile-disables-inner-guide-top-recovery',
        patternProfile
      }
    };
  }

  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const baseGray = computeGray(rgbData, info.channels);
  const gray = await buildOuterFrameEnhancedGray(baseGray, info.width, info.height, guides);
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(24, Math.round(getMedianGap(xPeaks, info.width * 0.12)));
  const cellHeight = Math.max(24, Math.round(getMedianGap(yPeaks, info.height * 0.08)));
  const overallPattern = guides?.globalPattern?.mode || (
    (
      guides?.xPattern
      && guides?.yPattern
      && guides.xPattern === guides.yPattern
    )
      ? guides.xPattern
      : 'mixed'
  );
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
    const topBorderPattern = analyzeTopBorderPatternByTripleLine(gray, info.width, info.height, {
      outerX,
      outerY,
      inward: spec.inward,
      cellWidth,
      cellHeight
    });
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
    let refinedOuterY = refinedOuterYPick.index;
    if (
      overallPattern === 'uniform-cells-with-inner-dashed'
      && topBorderPattern
      && topBorderPattern.mode !== 'single-line'
      && Math.abs(topBorderPattern.outerBoundaryY - outerY) <= Math.max(10, Math.round(cellHeight * 0.08))
    ) {
      refinedOuterY = topBorderPattern.outerBoundaryY;
    }
    const shouldApply = (
      refinedOuterY < outerY - Math.round(cellHeight * 0.1)
      && !(
        overallPattern === 'uniform-cells-with-inner-dashed'
        && topBorderPattern
        && topBorderPattern.mode !== 'single-line'
        && Math.abs(topBorderPattern.outerBoundaryY - outerY) <= Math.max(10, Math.round(cellHeight * 0.08))
      )
    );
    diagnostics[spec.name] = {
      expected: [outerX, outerY],
      patternMode: overallPattern,
      globalPattern: guides?.globalPattern || null,
      topBorderPattern,
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
      globalPattern: guides?.globalPattern || null,
      cellWidth,
      cellHeight,
      corners: diagnostics
    }
  };
}

function evaluateRelaxedOuterFrameEvidence(options = {}) {
  const {
    topGap = NaN,
    bottomGap = NaN,
    leftGap = NaN,
    rightGap = NaN,
    topScore = NaN,
    bottomScore = NaN,
    leftScore = NaN,
    rightScore = NaN,
    horizontalGapRatio = Number.POSITIVE_INFINITY,
    verticalGapRatio = Number.POSITIVE_INFINITY,
    cellWidth = 0,
    cellHeight = 0,
    relaxedFourSideEvidence = false
  } = options;
  const topBottomGapDelta = Math.abs(Number(topGap) - Number(bottomGap));
  const leftRightGapDelta = Math.abs(Number(leftGap) - Number(rightGap));
  const topBottomBalanced = topBottomGapDelta <= Math.max(16, Math.round(cellHeight * 0.18));
  const leftRightBalanced = (
    leftRightGapDelta <= Math.max(16, Math.round(cellWidth * 0.1))
    || verticalGapRatio <= 2.25
  );
  const topHeaderInterferenceRisk = (
    Number.isFinite(topScore)
    && Number.isFinite(bottomScore)
    && Number.isFinite(topGap)
    && Number.isFinite(bottomGap)
    && topScore < Math.max(20, bottomScore * 0.58)
    && topGap > bottomGap + Math.max(18, Math.round(cellHeight * 0.14))
  );
  const bottomShadowInterferenceRisk = (
    Number.isFinite(topScore)
    && Number.isFinite(bottomScore)
    && Number.isFinite(topGap)
    && Number.isFinite(bottomGap)
    && bottomScore < Math.max(20, topScore * 0.58)
    && bottomGap > topGap + Math.max(18, Math.round(cellHeight * 0.14))
  );
  const sideEnvelopeStable = (
    Number.isFinite(leftScore)
    && Number.isFinite(rightScore)
    && leftScore >= 28
    && rightScore >= 28
    && leftRightBalanced
  );
  const allowRelaxedAcceptance = Boolean(
    relaxedFourSideEvidence
    && topBottomBalanced
    && sideEnvelopeStable
    && !topHeaderInterferenceRisk
    && !bottomShadowInterferenceRisk
  );
  return {
    topBottomGapDelta,
    leftRightGapDelta,
    topBottomBalanced,
    leftRightBalanced,
    sideEnvelopeStable,
    topHeaderInterferenceRisk,
    bottomShadowInterferenceRisk,
    allowRelaxedAcceptance
  };
}

function inferOuterFrameFromBroadGuideWindow(gray, width, height, detection, options = {}) {
  const guides = detection?.guides || null;
  const rawGuides = detection?.rawGuides || guides || null;
  if (!guides || !rawGuides) {
    return null;
  }
  const rawLeft = Number(rawGuides.left);
  const rawRight = Number(rawGuides.right);
  const rawTop = Number(rawGuides.top);
  const rawBottom = Number(rawGuides.bottom);
  if (![rawLeft, rawRight, rawTop, rawBottom].every(Number.isFinite)) {
    return null;
  }
  const guideTop = Number(guides.top);
  const guideBottom = Number(guides.bottom);
  const rawXPeaks = Array.isArray(rawGuides.xPeaks) ? rawGuides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const rawYPeaks = Array.isArray(rawGuides.yPeaks) ? rawGuides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(
    24,
    Math.round(Number(options.cellWidth) || getMedianGap(rawXPeaks, width * 0.12))
  );
  const cellHeight = Math.max(
    24,
    Math.round(Number(options.cellHeight) || getMedianGap(rawYPeaks, height * 0.08))
  );
  const spanInsetX = Math.max(18, Math.round(cellWidth * 0.12));
  const coarseSpanTop = clamp(
    Math.round(Math.max(rawTop, Number.isFinite(guideTop) ? guideTop : rawTop) + cellHeight * 0.45),
    0,
    Math.max(0, height - 1)
  );
  const coarseSpanBottom = clamp(
    Math.round(Math.min(rawBottom, Number.isFinite(guideBottom) ? guideBottom : rawBottom) - cellHeight * 0.45),
    coarseSpanTop + 1,
    Math.max(1, height - 1)
  );
  const sideSearch = Math.max(14, Math.round(cellWidth * 0.24));
  const leftPoints = collectGlobalVerticalBoundaryPoints(gray, width, height, {
    expectedX: rawLeft,
    xStart: clamp(Math.round(rawLeft - sideSearch), 0, Math.max(0, width - 1)),
    xEnd: clamp(Math.round(rawLeft + Math.max(8, cellWidth * 0.1)), 0, Math.max(0, width - 1)),
    yStart: coarseSpanTop,
    yEnd: coarseSpanBottom,
    inwardDir: 1,
    step: 8,
    outwardBias: 0.08
  });
  const rightPoints = collectGlobalVerticalBoundaryPoints(gray, width, height, {
    expectedX: rawRight,
    xStart: clamp(Math.round(rawRight - Math.max(8, cellWidth * 0.1)), 0, Math.max(0, width - 1)),
    xEnd: clamp(Math.round(rawRight + sideSearch), 0, Math.max(0, width - 1)),
    yStart: coarseSpanTop,
    yEnd: coarseSpanBottom,
    inwardDir: -1,
    step: 8,
    outwardBias: 0.08
  });
  const leftLineFit = fitLineRobust(leftPoints, 4);
  const rightLineFit = fitLineRobust(rightPoints, 4);
  if (!leftLineFit || !rightLineFit) {
    return null;
  }
  const probeStartY = Math.round(average([coarseSpanTop, coarseSpanBottom]));
  const leftTopPoint = probeVerticalLineEndpoint(leftLineFit, gray, width, height, {
    startY: probeStartY,
    endY: 0,
    inwardDir: 1,
    direction: 'top'
  });
  const rightTopPoint = probeVerticalLineEndpoint(rightLineFit, gray, width, height, {
    startY: probeStartY,
    endY: 0,
    inwardDir: -1,
    direction: 'top'
  });
  const leftBottomPoint = probeVerticalLineEndpoint(leftLineFit, gray, width, height, {
    startY: probeStartY,
    endY: height - 1,
    inwardDir: 1,
    direction: 'bottom'
  });
  const rightBottomPoint = probeVerticalLineEndpoint(rightLineFit, gray, width, height, {
    startY: probeStartY,
    endY: height - 1,
    inwardDir: -1,
    direction: 'bottom'
  });
  const topProbeY = medianCoordinate([leftTopPoint, rightTopPoint], 1);
  const bottomProbeY = medianCoordinate([leftBottomPoint, rightBottomPoint], 1);
  if (!Number.isFinite(topProbeY) || !Number.isFinite(bottomProbeY) || bottomProbeY <= topProbeY) {
    return null;
  }
  const spanX0 = clamp(rawLeft + spanInsetX, 0, Math.max(0, width - 1));
  const spanX1 = clamp(rawRight - spanInsetX, spanX0 + 1, Math.max(1, width - 1));
  const horizontalWindow = Math.max(26, Math.round(cellHeight * 0.28));
  const topLine = findStrongDirectionalLine(
    clamp(Math.round(topProbeY - horizontalWindow), 0, Math.max(0, height - 1)),
    clamp(Math.round(topProbeY + horizontalWindow), 0, Math.max(0, height - 1)),
    (y) => scoreOuterHorizontalBoundaryAt(gray, width, height, y, spanX0, spanX1, 1)
  );
  const bottomLine = findStrongDirectionalLine(
    clamp(Math.round(bottomProbeY - horizontalWindow), 0, Math.max(0, height - 1)),
    clamp(Math.round(bottomProbeY + horizontalWindow), 0, Math.max(0, height - 1)),
    (y) => scoreOuterHorizontalBoundaryAt(gray, width, height, y, spanX0, spanX1, -1)
  );
  if (!topLine || !bottomLine || bottomLine.index <= topLine.index) {
    return null;
  }
  const leftAnchorX = medianCoordinate([leftTopPoint, leftBottomPoint], 0);
  const rightAnchorX = medianCoordinate([rightTopPoint, rightBottomPoint], 0);
  const solvedLeftX = solveLineXAtY(leftLineFit, probeStartY);
  const solvedRightX = solveLineXAtY(rightLineFit, probeStartY);
  const outerRect = {
    left: Math.round(Number.isFinite(leftAnchorX) ? leftAnchorX : (Number.isFinite(solvedLeftX) ? solvedLeftX : rawLeft)),
    right: Math.round(Number.isFinite(rightAnchorX) ? rightAnchorX : (Number.isFinite(solvedRightX) ? solvedRightX : rawRight)),
    top: Math.round(topLine.index),
    bottom: Math.round(bottomLine.index)
  };
  const outerQuad = normalizeCornerQuad([
    [outerRect.left, outerRect.top],
    [outerRect.right, outerRect.top],
    [outerRect.right, outerRect.bottom],
    [outerRect.left, outerRect.bottom]
  ]);
  const headerBandHeight = Math.max(0, outerRect.top - rawTop);
  const footerBandHeight = Math.max(0, rawBottom - outerRect.bottom);
  const widthSpan = outerRect.right - outerRect.left;
  const heightSpan = outerRect.bottom - outerRect.top;
  const horizontalScoreMin = Math.max(20, cellHeight * 0.09);
  const verticalScoreMin = Math.max(14, cellWidth * 0.08);
  const leftScore = scoreOuterVerticalBoundaryAt(gray, width, height, outerRect.left, coarseSpanTop, coarseSpanBottom, 1);
  const rightScore = scoreOuterVerticalBoundaryAt(gray, width, height, outerRect.right, coarseSpanTop, coarseSpanBottom, -1);
  const meaningfulHeaderBand = headerBandHeight >= Math.max(36, Math.round(cellHeight * 0.32));
  const meaningfulFooterBand = footerBandHeight >= Math.max(96, Math.round(cellHeight * 0.92));
  const strongSingleBandThreshold = Math.max(120, Math.round(cellHeight * 1.05));
  const strongSingleBand = (
    (meaningfulHeaderBand || meaningfulFooterBand)
    && Math.max(headerBandHeight, footerBandHeight) >= strongSingleBandThreshold
  );
  const dualBandConfirmation = meaningfulHeaderBand && meaningfulFooterBand;
  const allowPatternDrivenSingleBandWindow = String(options.patternProfileFamily || '') === 'circle-mi-grid';
  const singleBandSideGapThresholdX = Math.max(8, Math.round(cellWidth * 0.05));
  const singleBandSideGapThresholdY = Math.max(8, Math.round(cellHeight * 0.05));
  const singleBandSideEvidenceCount = [
    rawLeft - outerRect.left >= singleBandSideGapThresholdX,
    outerRect.right - rawRight >= singleBandSideGapThresholdX,
    rawTop - outerRect.top >= singleBandSideGapThresholdY,
    outerRect.bottom - rawBottom >= singleBandSideGapThresholdY
  ].filter(Boolean).length;
  const eligible = Boolean(
    outerQuad
    && topLine.score >= horizontalScoreMin
    && bottomLine.score >= horizontalScoreMin
    && leftScore >= verticalScoreMin
    && rightScore >= verticalScoreMin
    && widthSpan >= Math.max(Math.round(width * 0.55), Math.round(cellWidth * 4.8))
    && heightSpan >= Math.max(Math.round(height * 0.55), Math.round(cellHeight * 5.5))
    && (
      dualBandConfirmation
      || (
        strongSingleBand
        && (
          allowPatternDrivenSingleBandWindow
          || singleBandSideEvidenceCount >= 2
        )
      )
    )
  );
  if (!eligible) {
    return {
      applied: false,
      reason: 'broad-guide-window-not-confirmed',
      diagnostics: {
        method: 'broad-raw-guide-window-outer-frame',
        rawGuideBounds: { left: rawLeft, right: rawRight, top: rawTop, bottom: rawBottom },
        candidateBounds: outerRect,
        candidateScores: {
          top: Number((topLine.score || 0).toFixed(3)),
          bottom: Number((bottomLine.score || 0).toFixed(3)),
          left: Number((leftScore || 0).toFixed(3)),
          right: Number((rightScore || 0).toFixed(3))
        },
        headerBandHeight,
        footerBandHeight,
        widthSpan,
        heightSpan,
        cellWidth,
        cellHeight,
        meaningfulHeaderBand,
        meaningfulFooterBand,
        dualBandConfirmation,
        strongSingleBand,
        strongSingleBandThreshold,
        allowPatternDrivenSingleBandWindow,
        singleBandSideEvidenceCount,
        singleBandSideGapThresholdX,
        singleBandSideGapThresholdY,
        verticalEndpoints: {
          leftTop: leftTopPoint ? leftTopPoint.map((value) => Number(value.toFixed(3))) : null,
          rightTop: rightTopPoint ? rightTopPoint.map((value) => Number(value.toFixed(3))) : null,
          leftBottom: leftBottomPoint ? leftBottomPoint.map((value) => Number(value.toFixed(3))) : null,
          rightBottom: rightBottomPoint ? rightBottomPoint.map((value) => Number(value.toFixed(3))) : null
        }
      }
    };
  }
  return {
    applied: true,
    reason: 'broad-guide-window-outer-frame',
    outerQuad,
    refinedOuterFrame: outerRect,
    diagnostics: {
      method: 'broad-raw-guide-window-outer-frame',
      outerFramePattern: 'full-margin-outer-frame',
      rawGuideBounds: { left: rawLeft, right: rawRight, top: rawTop, bottom: rawBottom },
      guideBounds: {
        left: Number.isFinite(Number(guides.left)) ? Math.round(Number(guides.left)) : null,
        right: Number.isFinite(Number(guides.right)) ? Math.round(Number(guides.right)) : null,
        top: Number.isFinite(guideTop) ? Math.round(guideTop) : null,
        bottom: Number.isFinite(guideBottom) ? Math.round(guideBottom) : null
      },
      headerBandHeight,
      footerBandHeight,
      candidateScores: {
        top: Number((topLine.score || 0).toFixed(3)),
        bottom: Number((bottomLine.score || 0).toFixed(3)),
        left: Number((leftScore || 0).toFixed(3)),
        right: Number((rightScore || 0).toFixed(3))
      },
      verticalEndpoints: {
        leftTop: leftTopPoint ? leftTopPoint.map((value) => Number(value.toFixed(3))) : null,
        rightTop: rightTopPoint ? rightTopPoint.map((value) => Number(value.toFixed(3))) : null,
        leftBottom: leftBottomPoint ? leftBottomPoint.map((value) => Number(value.toFixed(3))) : null,
        rightBottom: rightBottomPoint ? rightBottomPoint.map((value) => Number(value.toFixed(3))) : null
      },
      cellWidth,
      cellHeight,
      dualBandConfirmation,
      strongSingleBand,
      strongSingleBandThreshold,
      allowPatternDrivenSingleBandWindow,
      singleBandSideEvidenceCount,
      singleBandSideGapThresholdX,
      singleBandSideGapThresholdY
    }
  };
}

function fitTiltedOuterFrameQuadFromBounds(gray, width, height, outerBounds, innerBounds, options = {}) {
  if (!gray || !outerBounds || !innerBounds || width <= 0 || height <= 0) {
    return null;
  }
  const outerLeft = clamp(Math.round(Number(outerBounds.left)), 0, Math.max(0, width - 1));
  const outerRight = clamp(Math.round(Number(outerBounds.right)), outerLeft + 1, Math.max(1, width - 1));
  const outerTop = clamp(Math.round(Number(outerBounds.top)), 0, Math.max(0, height - 1));
  const outerBottom = clamp(Math.round(Number(outerBounds.bottom)), outerTop + 1, Math.max(1, height - 1));
  const innerLeft = clamp(Math.round(Number(innerBounds.left)), outerLeft, outerRight);
  const innerRight = clamp(Math.round(Number(innerBounds.right)), innerLeft + 1, outerRight);
  const innerTop = clamp(Math.round(Number(innerBounds.top)), outerTop, outerBottom);
  const innerBottom = clamp(Math.round(Number(innerBounds.bottom)), innerTop + 1, outerBottom);
  const cellWidth = Math.max(24, Math.round(Number(options.cellWidth) || 0));
  const cellHeight = Math.max(24, Math.round(Number(options.cellHeight) || 0));
  const sideSearch = Math.max(10, Math.round(cellWidth * 0.12));
  const topLift = Math.max(18, Math.round(cellHeight * 0.34));
  const topReturn = Math.max(8, Math.round(cellHeight * 0.08));
  const bottomDrop = Math.max(18, Math.round(cellHeight * 0.2));
  const coarseY0 = clamp(
    Math.round(Math.min(outerTop, innerTop) - topLift),
    0,
    Math.max(0, height - 1)
  );
  const coarseY1 = clamp(
    Math.round(Math.max(outerBottom, innerBottom) + bottomDrop),
    coarseY0,
    Math.max(0, height - 1)
  );

  const leftPoints = collectGlobalVerticalBoundaryPoints(gray, width, height, {
    expectedX: outerLeft,
    xStart: clamp(Math.round(outerLeft - sideSearch), 0, Math.max(0, width - 1)),
    xEnd: clamp(Math.round(Math.min(innerLeft - 2, outerLeft + sideSearch)), 0, Math.max(0, width - 1)),
    yStart: coarseY0,
    yEnd: coarseY1,
    inwardDir: 1,
    step: 8,
    outwardBias: 0.12
  });
  const rightPoints = collectGlobalVerticalBoundaryPoints(gray, width, height, {
    expectedX: outerRight,
    xStart: clamp(Math.round(Math.max(innerRight + 2, outerRight - sideSearch)), 0, Math.max(0, width - 1)),
    xEnd: clamp(Math.round(outerRight + sideSearch), 0, Math.max(0, width - 1)),
    yStart: coarseY0,
    yEnd: coarseY1,
    inwardDir: -1,
    step: 8,
    outwardBias: 0.12
  });
  const leftLineFit = fitLineRobust(leftPoints, 4);
  const rightLineFit = fitLineRobust(rightPoints, 4);
  if (!leftLineFit || !rightLineFit) {
    return null;
  }

  const topProbeStartY = clamp(
    Math.round(Math.min(innerBottom, outerTop + Math.max(16, cellHeight * 0.6))),
    coarseY0,
    coarseY1
  );
  const bottomProbeStartY = clamp(
    Math.round(Math.max(innerTop, outerBottom - Math.max(16, cellHeight * 0.6))),
    coarseY0,
    coarseY1
  );
  const leftTop = probeVerticalLineEndpoint(leftLineFit, gray, width, height, {
    startY: topProbeStartY,
    endY: coarseY0,
    inwardDir: 1,
    direction: 'top'
  });
  const rightTop = probeVerticalLineEndpoint(rightLineFit, gray, width, height, {
    startY: topProbeStartY,
    endY: coarseY0,
    inwardDir: -1,
    direction: 'top'
  });
  const leftBottom = probeVerticalLineEndpoint(leftLineFit, gray, width, height, {
    startY: bottomProbeStartY,
    endY: coarseY1,
    inwardDir: 1,
    direction: 'bottom'
  });
  const rightBottom = probeVerticalLineEndpoint(rightLineFit, gray, width, height, {
    startY: bottomProbeStartY,
    endY: coarseY1,
    inwardDir: -1,
    direction: 'bottom'
  });

  const topProbeMedian = medianCoordinate([leftTop, rightTop], 1);
  const bottomProbeMedian = medianCoordinate([leftBottom, rightBottom], 1);
  const topProbeExpected = Number.isFinite(topProbeMedian) ? topProbeMedian : outerTop;
  const bottomProbeExpected = Number.isFinite(bottomProbeMedian) ? bottomProbeMedian : outerBottom;
  const topPoints = collectGlobalHorizontalBoundaryPoints(gray, width, height, {
    expectedY: topProbeExpected,
    xStart: outerLeft,
    xEnd: outerRight,
    yStart: clamp(Math.round(topProbeExpected - topLift), 0, Math.max(0, height - 1)),
    yEnd: clamp(Math.round(Math.min(innerTop - 2, topProbeExpected + topReturn)), 0, Math.max(0, height - 1)),
    inwardDir: 1,
    step: 8,
    outwardBias: 0.12
  });
  const bottomPoints = collectGlobalHorizontalBoundaryPoints(gray, width, height, {
    expectedY: bottomProbeExpected,
    xStart: outerLeft,
    xEnd: outerRight,
    yStart: clamp(Math.round(Math.max(innerBottom + 2, bottomProbeExpected - topReturn)), 0, Math.max(0, height - 1)),
    yEnd: clamp(Math.round(bottomProbeExpected + bottomDrop), 0, Math.max(0, height - 1)),
    inwardDir: -1,
    step: 8,
    outwardBias: 0.12
  });
  const topLineFit = fitLineRobust(topPoints, 4);
  const bottomLineFit = fitLineRobust(bottomPoints, 4);

  const topAnchorLine = buildLineFromEndAnchors(leftTop, rightTop, topLineFit);
  const bottomAnchorLine = buildLineFromEndAnchors(leftBottom, rightBottom, bottomLineFit);
  const leftAnchorLine = buildLineFromEndAnchors(leftTop, leftBottom, leftLineFit);
  const rightAnchorLine = buildLineFromEndAnchors(rightTop, rightBottom, rightLineFit);
  const topLine = blendLines(topLineFit, topAnchorLine, 0.62) || topAnchorLine || topLineFit;
  const bottomLine = blendLines(bottomLineFit, bottomAnchorLine, 0.62) || bottomAnchorLine || bottomLineFit;
  const leftLine = blendLines(leftLineFit, leftAnchorLine, 0.28) || leftAnchorLine || leftLineFit;
  const rightLine = blendLines(rightLineFit, rightAnchorLine, 0.28) || rightAnchorLine || rightLineFit;
  const quad = normalizeCornerQuad([
    intersectLines(topLine, leftLine),
    intersectLines(topLine, rightLine),
    intersectLines(bottomLine, rightLine),
    intersectLines(bottomLine, leftLine)
  ]);
  if (!quad) {
    return null;
  }
  const bounds = getQuadBounds(quad);
  if (!bounds) {
    return null;
  }
  const maxShiftX = Math.max(14, Math.round(cellWidth * 0.2));
  const maxShiftY = Math.max(16, Math.round(cellHeight * 0.2));
  const withinShiftLimit = (
    Math.abs(bounds.left - outerLeft) <= maxShiftX
    && Math.abs(bounds.right - outerRight) <= maxShiftX
    && Math.abs(bounds.top - outerTop) <= maxShiftY
    && Math.abs(bounds.bottom - outerBottom) <= maxShiftY
  );
  const wrapsInner = (
    bounds.left <= innerLeft - 2
    && bounds.right >= innerRight + 2
    && bounds.top <= innerTop - 2
    && bounds.bottom >= innerBottom + 2
  );
  if (!withinShiftLimit || !wrapsInner) {
    return null;
  }
  return {
    quad,
    bounds,
    diagnostics: {
      verticalEndpoints: {
        leftTop: leftTop ? leftTop.map((value) => Number(value.toFixed(3))) : null,
        rightTop: rightTop ? rightTop.map((value) => Number(value.toFixed(3))) : null,
        leftBottom: leftBottom ? leftBottom.map((value) => Number(value.toFixed(3))) : null,
        rightBottom: rightBottom ? rightBottom.map((value) => Number(value.toFixed(3))) : null
      },
      coarseWindow: {
        y: [coarseY0, coarseY1],
        sideSearch
      },
      topProbeExpected: Number.isFinite(topProbeExpected) ? Number(topProbeExpected.toFixed(3)) : null,
      bottomProbeExpected: Number.isFinite(bottomProbeExpected) ? Number(bottomProbeExpected.toFixed(3)) : null,
      topPointCount: topPoints.length,
      bottomPointCount: bottomPoints.length,
      leftPointCount: leftPoints.length,
      rightPointCount: rightPoints.length
    }
  };
}

async function inferOuterFrameFromPattern(imagePath, detection, cornerRefinement = null, options = {}) {
  const guides = detection?.guides || null;
  const innerQuad = normalizeCornerQuad(
    detection?.cornerAnchors?.corners
    || detection?.corners
    || null
  );
  if (!imagePath || !guides || !innerQuad) {
    return { applied: false, reason: 'missing-inner-guides' };
  }

  const globalPattern = (
    guides?.globalPattern
    || cornerRefinement?.globalPattern
    || cornerRefinement?.rawGuideHints?.diagnostics?.globalPattern
    || null
  );
  const patternProfileFamily = (
    globalPattern?.patternProfile?.family
    || detection?.rawGuides?.globalPattern?.patternProfile?.family
    || null
  );
  const patternMode = globalPattern?.mode || 'mixed';
  if (!['uniform-boundary-grid', 'uniform-cells-with-inner-dashed', 'mixed'].includes(patternMode)) {
    return {
      applied: false,
      reason: 'pattern-not-supported',
      patternMode
    };
  }

  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const baseGray = computeGray(rgbData, info.channels);
  const gray = await buildOuterFrameEnhancedGray(baseGray, info.width, info.height, guides);
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(24, Math.round(getMedianGap(xPeaks, info.width * 0.12)));
  const cellHeight = Math.max(24, Math.round(getMedianGap(yPeaks, info.height * 0.08)));
  const innerLeft = clamp(Math.round(Number(guides.left)), 0, Math.max(0, info.width - 1));
  const innerRight = clamp(Math.round(Number(guides.right)), innerLeft + 1, Math.max(1, info.width - 1));
  const innerTop = clamp(Math.round(Number(guides.top)), 0, Math.max(0, info.height - 1));
  const innerBottom = clamp(Math.round(Number(guides.bottom)), innerTop + 1, Math.max(1, info.height - 1));
  const spanX0 = clamp(innerLeft + Math.round(cellWidth * 0.08), 0, Math.max(0, info.width - 1));
  const spanX1 = clamp(innerRight - Math.round(cellWidth * 0.08), spanX0 + 1, Math.max(1, info.width - 1));
  const spanY0 = clamp(innerTop + Math.round(cellHeight * 0.08), 0, Math.max(0, info.height - 1));
  const spanY1 = clamp(innerBottom - Math.round(cellHeight * 0.08), spanY0 + 1, Math.max(1, info.height - 1));
  const outwardSearchX = Math.max(10, Math.round(cellWidth * 0.22));
  const outwardSearchY = Math.max(10, Math.round(cellHeight * 0.22));
  const minGapX = Math.max(4, Math.round(cellWidth * 0.018));
  const minGapY = Math.max(4, Math.round(cellHeight * 0.018));

  const topPick = pickBestDirectionalIndex(
    clamp(innerTop - outwardSearchY, 0, Math.max(0, info.height - 1)),
    clamp(innerTop - minGapY, 0, Math.max(0, info.height - 1)),
    clamp(innerTop - Math.round(outwardSearchY * 0.72), 0, Math.max(0, info.height - 1)),
    (candidateY) => scoreHorizontalLineAt(gray, info.width, info.height, candidateY, spanX0, spanX1),
    {
      distancePenalty: 0.18,
      outwardTarget: clamp(innerTop - outwardSearchY, 0, Math.max(0, info.height - 1)),
      outwardBias: 0.34
    }
  );
  const bottomPick = pickBestDirectionalIndex(
    clamp(innerBottom + minGapY, 0, Math.max(0, info.height - 1)),
    clamp(innerBottom + outwardSearchY, 0, Math.max(0, info.height - 1)),
    clamp(innerBottom + Math.round(outwardSearchY * 0.72), 0, Math.max(0, info.height - 1)),
    (candidateY) => scoreHorizontalLineAt(gray, info.width, info.height, candidateY, spanX0, spanX1),
    {
      distancePenalty: 0.18,
      outwardTarget: clamp(innerBottom + outwardSearchY, 0, Math.max(0, info.height - 1)),
      outwardBias: 0.34
    }
  );
  const leftPick = pickBestDirectionalIndex(
    clamp(innerLeft - outwardSearchX, 0, Math.max(0, info.width - 1)),
    clamp(innerLeft - minGapX, 0, Math.max(0, info.width - 1)),
    clamp(innerLeft - Math.round(outwardSearchX * 0.72), 0, Math.max(0, info.width - 1)),
    (candidateX) => scoreVerticalLineAt(gray, info.width, info.height, candidateX, spanY0, spanY1),
    {
      distancePenalty: 0.18,
      outwardTarget: clamp(innerLeft - outwardSearchX, 0, Math.max(0, info.width - 1)),
      outwardBias: 0.34
    }
  );
  const rightPick = pickBestDirectionalIndex(
    clamp(innerRight + minGapX, 0, Math.max(0, info.width - 1)),
    clamp(innerRight + outwardSearchX, 0, Math.max(0, info.width - 1)),
    clamp(innerRight + Math.round(outwardSearchX * 0.72), 0, Math.max(0, info.width - 1)),
    (candidateX) => scoreVerticalLineAt(gray, info.width, info.height, candidateX, spanY0, spanY1),
    {
      distancePenalty: 0.18,
      outwardTarget: clamp(innerRight + outwardSearchX, 0, Math.max(0, info.width - 1)),
      outwardBias: 0.34
    }
  );

  const topGap = innerTop - topPick.index;
  const bottomGap = bottomPick.index - innerBottom;
  const leftGap = innerLeft - leftPick.index;
  const rightGap = rightPick.index - innerRight;
  const gaps = [topGap, bottomGap, leftGap, rightGap].filter((value) => Number.isFinite(value) && value > 0);
  const horizontalGaps = [topGap, bottomGap].filter((value) => Number.isFinite(value) && value > 0);
  const verticalGaps = [leftGap, rightGap].filter((value) => Number.isFinite(value) && value > 0);
  const gapRatio = gaps.length ? Math.max(...gaps) / Math.max(1, Math.min(...gaps)) : Number.POSITIVE_INFINITY;
  const horizontalGapRatio = horizontalGaps.length === 2 ? Math.max(...horizontalGaps) / Math.max(1, Math.min(...horizontalGaps)) : Number.POSITIVE_INFINITY;
  const verticalGapRatio = verticalGaps.length === 2 ? Math.max(...verticalGaps) / Math.max(1, Math.min(...verticalGaps)) : Number.POSITIVE_INFINITY;
  const normalizedMarginRatios = {
    top: topGap / Math.max(cellHeight, 1),
    bottom: bottomGap / Math.max(cellHeight, 1),
    left: leftGap / Math.max(cellWidth, 1),
    right: rightGap / Math.max(cellWidth, 1)
  };
  const minHorizontalMarginRatio = Math.min(normalizedMarginRatios.top, normalizedMarginRatios.bottom);
  const minVerticalMarginRatio = Math.min(normalizedMarginRatios.left, normalizedMarginRatios.right);
  const meanHorizontalMarginRatio = average([normalizedMarginRatios.top, normalizedMarginRatios.bottom].filter(Number.isFinite));
  const meanVerticalMarginRatio = average([normalizedMarginRatios.left, normalizedMarginRatios.right].filter(Number.isFinite));
  const axisMarginDominanceRatio = (
    Number.isFinite(meanHorizontalMarginRatio)
    && Number.isFinite(meanVerticalMarginRatio)
    && Math.min(meanHorizontalMarginRatio, meanVerticalMarginRatio) > 1e-6
  )
    ? Math.max(meanHorizontalMarginRatio, meanVerticalMarginRatio) / Math.max(1e-6, Math.min(meanHorizontalMarginRatio, meanVerticalMarginRatio))
    : Number.POSITIVE_INFINITY;
  const lineScores = [topPick.score, bottomPick.score, leftPick.score, rightPick.score].filter(Number.isFinite);
  const strongSideCount = lineScores.filter((score) => score >= 24).length;
  const moderateSideCount = lineScores.filter((score) => score >= 18).length;
  const sideGapCount = gaps.filter((gap) => gap >= 4).length;
  const relaxedFourSideEvidence = Boolean(
    moderateSideCount >= 4
    && strongSideCount >= 3
    && sideGapCount >= 4
    && topPick.score >= 18
    && bottomPick.score >= 18
    && leftPick.score >= 28
    && rightPick.score >= 28
    && horizontalGapRatio <= 3.4
    && verticalGapRatio <= 3.2
  );
  const relaxedEvidenceDiagnostics = evaluateRelaxedOuterFrameEvidence({
    topGap,
    bottomGap,
    leftGap,
    rightGap,
    topScore: topPick.score,
    bottomScore: bottomPick.score,
    leftScore: leftPick.score,
    rightScore: rightPick.score,
    horizontalGapRatio,
    verticalGapRatio,
    cellWidth,
    cellHeight,
    relaxedFourSideEvidence
  });
  const significantGapFlags = {
    top: topGap >= 4,
    bottom: bottomGap >= 4,
    left: leftGap >= 4,
    right: rightGap >= 4
  };
  let outerFramePattern = 'mixed-outer-frame';
  if (significantGapFlags.top && significantGapFlags.bottom && !significantGapFlags.left && !significantGapFlags.right) {
    outerFramePattern = 'top-bottom-separated-outer-frame';
  } else if (!significantGapFlags.top && !significantGapFlags.bottom && significantGapFlags.left && significantGapFlags.right) {
    outerFramePattern = 'left-right-separated-outer-frame';
  } else if (significantGapFlags.top && significantGapFlags.bottom && significantGapFlags.left && significantGapFlags.right) {
    outerFramePattern = 'full-margin-outer-frame';
  } else if ((significantGapFlags.top || significantGapFlags.bottom) && (significantGapFlags.left || significantGapFlags.right)) {
    outerFramePattern = 'three-side-or-asymmetric-outer-frame';
  }
  const requiresPageWindowConfirmation = Boolean(
    patternProfileFamily !== 'circle-mi-grid'
    && (
    outerFramePattern === 'full-margin-outer-frame'
    && (
      relaxedEvidenceDiagnostics.allowRelaxedAcceptance
      || minVerticalMarginRatio < 0.08
      || minHorizontalMarginRatio < 0.08
      || axisMarginDominanceRatio > 2.6
    )
    )
  );
  const weakFullMarginSideMargins = Boolean(
    outerFramePattern === 'full-margin-outer-frame'
    && (
      minVerticalMarginRatio < 0.035
      || minHorizontalMarginRatio < 0.035
      || axisMarginDominanceRatio > 4.2
    )
  );
  const axisAlignedOuterQuad = normalizeCornerQuad([
    [leftPick.index, topPick.index],
    [rightPick.index, topPick.index],
    [rightPick.index, bottomPick.index],
    [leftPick.index, bottomPick.index]
  ]);
  const axisAlignedOuterRect = axisAlignedOuterQuad
    ? {
        left: Math.round(Math.min(...axisAlignedOuterQuad.map((point) => point[0]))),
        right: Math.round(Math.max(...axisAlignedOuterQuad.map((point) => point[0]))),
        top: Math.round(Math.min(...axisAlignedOuterQuad.map((point) => point[1]))),
        bottom: Math.round(Math.max(...axisAlignedOuterQuad.map((point) => point[1])))
      }
    : null;
  const fittedOuterQuad = axisAlignedOuterRect
    ? fitTiltedOuterFrameQuadFromBounds(
      gray,
      info.width,
      info.height,
      axisAlignedOuterRect,
      { left: innerLeft, right: innerRight, top: innerTop, bottom: innerBottom },
      { cellWidth, cellHeight }
    )
    : null;
  const outerQuad = fittedOuterQuad?.quad || axisAlignedOuterQuad;
  const outerRect = fittedOuterQuad?.bounds || axisAlignedOuterRect;
  const wrapsInner = Boolean(
    outerRect
    && outerRect.left <= innerLeft
    && outerRect.right >= innerRight
    && outerRect.top <= innerTop
    && outerRect.bottom >= innerBottom
  );
  const eligible = Boolean(
    outerQuad
    && wrapsInner
    && (strongSideCount >= 4 || relaxedEvidenceDiagnostics.allowRelaxedAcceptance)
    && sideGapCount >= 4
    && horizontalGapRatio <= 6.5
    && verticalGapRatio <= 3.2
    && (
      gapRatio <= 6.5
      || (
        relaxedEvidenceDiagnostics.allowRelaxedAcceptance
        && strongSideCount >= 4
        && outerFramePattern === 'full-margin-outer-frame'
      )
    )
    && (
      Math.max(...gaps) >= Math.max(8, Math.round(Math.min(cellWidth, cellHeight) * 0.06))
      || average(gaps) >= Math.max(6, Math.round(Math.min(cellWidth, cellHeight) * 0.035))
    )
    && (
      outerFramePattern !== 'full-margin-outer-frame'
      || (
        minHorizontalMarginRatio >= 0.04
        && minVerticalMarginRatio >= 0.045
        && axisMarginDominanceRatio <= 4.2
      )
      || (
        relaxedEvidenceDiagnostics.allowRelaxedAcceptance
        && minVerticalMarginRatio >= 0.035
        && minHorizontalMarginRatio >= 0.035
        && axisMarginDominanceRatio <= 3.8
      )
    )
  );
  const broadGuideWindowCandidate = (
    !eligible || requiresPageWindowConfirmation
  )
    ? inferOuterFrameFromBroadGuideWindow(gray, info.width, info.height, detection, {
      cellWidth,
      cellHeight,
      patternProfileFamily
    })
    : null;

  if (!eligible) {
    if (broadGuideWindowCandidate?.applied) {
      return broadGuideWindowCandidate;
    }
    return {
      applied: false,
      reason: weakFullMarginSideMargins
        ? 'pattern-outer-frame-lacks-page-window-confirmation'
        : 'pattern-outer-frame-not-confirmed',
      diagnostics: {
        patternMode,
        gaps: { top: topGap, bottom: bottomGap, left: leftGap, right: rightGap },
        scores: {
          top: Number((topPick.score || 0).toFixed(3)),
          bottom: Number((bottomPick.score || 0).toFixed(3)),
          left: Number((leftPick.score || 0).toFixed(3)),
          right: Number((rightPick.score || 0).toFixed(3))
        },
        outerFramePattern,
        strongSideCount,
        moderateSideCount,
        sideGapCount,
        relaxedFourSideEvidence,
        relaxedEvidenceDiagnostics,
        normalizedMarginRatios: {
          top: Number(normalizedMarginRatios.top.toFixed(4)),
          bottom: Number(normalizedMarginRatios.bottom.toFixed(4)),
          left: Number(normalizedMarginRatios.left.toFixed(4)),
          right: Number(normalizedMarginRatios.right.toFixed(4))
        },
        minHorizontalMarginRatio: Number(minHorizontalMarginRatio.toFixed(4)),
        minVerticalMarginRatio: Number(minVerticalMarginRatio.toFixed(4)),
        axisMarginDominanceRatio: Number.isFinite(axisMarginDominanceRatio)
          ? Number(axisMarginDominanceRatio.toFixed(4))
          : null,
        requiresPageWindowConfirmation,
        weakFullMarginSideMargins,
        broadGuideWindowCandidate: broadGuideWindowCandidate?.diagnostics || null,
        gapRatio: Number.isFinite(gapRatio) ? Number(gapRatio.toFixed(4)) : null,
        horizontalGapRatio: Number.isFinite(horizontalGapRatio) ? Number(horizontalGapRatio.toFixed(4)) : null,
        verticalGapRatio: Number.isFinite(verticalGapRatio) ? Number(verticalGapRatio.toFixed(4)) : null,
        wrapsInner,
        cellWidth,
        cellHeight
      }
    };
  }
  if (requiresPageWindowConfirmation && !broadGuideWindowCandidate?.applied) {
    return {
      applied: false,
      reason: 'pattern-outer-frame-needs-page-window-confirmation',
      diagnostics: {
        patternMode,
        outerFramePattern,
        requiresPageWindowConfirmation,
        weakFullMarginSideMargins,
        gaps: { top: topGap, bottom: bottomGap, left: leftGap, right: rightGap },
        scores: {
          top: Number((topPick.score || 0).toFixed(3)),
          bottom: Number((bottomPick.score || 0).toFixed(3)),
          left: Number((leftPick.score || 0).toFixed(3)),
          right: Number((rightPick.score || 0).toFixed(3))
        },
        normalizedMarginRatios: {
          top: Number(normalizedMarginRatios.top.toFixed(4)),
          bottom: Number(normalizedMarginRatios.bottom.toFixed(4)),
          left: Number(normalizedMarginRatios.left.toFixed(4)),
          right: Number(normalizedMarginRatios.right.toFixed(4))
        },
        minHorizontalMarginRatio: Number(minHorizontalMarginRatio.toFixed(4)),
        minVerticalMarginRatio: Number(minVerticalMarginRatio.toFixed(4)),
        axisMarginDominanceRatio: Number.isFinite(axisMarginDominanceRatio)
          ? Number(axisMarginDominanceRatio.toFixed(4))
          : null,
        strongSideCount,
        moderateSideCount,
        sideGapCount,
        relaxedFourSideEvidence,
        relaxedEvidenceDiagnostics,
        broadGuideWindowCandidate: broadGuideWindowCandidate?.diagnostics || null,
        wrapsInner,
        cellWidth,
        cellHeight
      }
    };
  }
  if (requiresPageWindowConfirmation && broadGuideWindowCandidate?.applied) {
    return {
      ...broadGuideWindowCandidate,
      diagnostics: {
        ...(broadGuideWindowCandidate.diagnostics || {}),
        confirmedPatternCandidate: {
          method: 'pattern-driven-outer-frame-inference',
          outerFramePattern,
          gaps: { top: topGap, bottom: bottomGap, left: leftGap, right: rightGap },
          scores: {
            top: Number((topPick.score || 0).toFixed(3)),
            bottom: Number((bottomPick.score || 0).toFixed(3)),
            left: Number((leftPick.score || 0).toFixed(3)),
            right: Number((rightPick.score || 0).toFixed(3))
          },
          normalizedMarginRatios: {
            top: Number(normalizedMarginRatios.top.toFixed(4)),
            bottom: Number(normalizedMarginRatios.bottom.toFixed(4)),
            left: Number(normalizedMarginRatios.left.toFixed(4)),
            right: Number(normalizedMarginRatios.right.toFixed(4))
          },
          minHorizontalMarginRatio: Number(minHorizontalMarginRatio.toFixed(4)),
          minVerticalMarginRatio: Number(minVerticalMarginRatio.toFixed(4)),
          axisMarginDominanceRatio: Number.isFinite(axisMarginDominanceRatio)
            ? Number(axisMarginDominanceRatio.toFixed(4))
            : null
        },
        confirmedByPageWindow: true
      }
    };
  }

  return {
    applied: true,
    reason: 'pattern-outer-frame-inferred',
    outerQuad,
    refinedOuterFrame: outerRect,
    diagnostics: {
      method: 'pattern-driven-outer-frame-inference',
      patternMode,
      patternProfileFamily,
      patternProfileMode: globalPattern?.patternProfile?.profileMode || null,
      outerFramePattern,
      gaps: { top: topGap, bottom: bottomGap, left: leftGap, right: rightGap },
      scores: {
        top: Number((topPick.score || 0).toFixed(3)),
        bottom: Number((bottomPick.score || 0).toFixed(3)),
        left: Number((leftPick.score || 0).toFixed(3)),
        right: Number((rightPick.score || 0).toFixed(3))
      },
      gapRatio: Number(gapRatio.toFixed(4)),
      horizontalGapRatio: Number.isFinite(horizontalGapRatio) ? Number(horizontalGapRatio.toFixed(4)) : null,
      verticalGapRatio: Number.isFinite(verticalGapRatio) ? Number(verticalGapRatio.toFixed(4)) : null,
      strongSideCount,
      moderateSideCount,
      sideGapCount,
      relaxedFourSideEvidence,
      relaxedEvidenceDiagnostics,
      normalizedMarginRatios: {
        top: Number(normalizedMarginRatios.top.toFixed(4)),
        bottom: Number(normalizedMarginRatios.bottom.toFixed(4)),
        left: Number(normalizedMarginRatios.left.toFixed(4)),
        right: Number(normalizedMarginRatios.right.toFixed(4))
      },
      minHorizontalMarginRatio: Number(minHorizontalMarginRatio.toFixed(4)),
      minVerticalMarginRatio: Number(minVerticalMarginRatio.toFixed(4)),
      axisMarginDominanceRatio: Number.isFinite(axisMarginDominanceRatio)
        ? Number(axisMarginDominanceRatio.toFixed(4))
        : null,
      requiresPageWindowConfirmation,
      innerBounds: { left: innerLeft, right: innerRight, top: innerTop, bottom: innerBottom },
      outerBounds: outerRect,
      tiltedQuadFitted: Boolean(fittedOuterQuad?.quad),
      tiltedQuadFitDiagnostics: fittedOuterQuad?.diagnostics || null,
      cellWidth,
      cellHeight
    }
  };
}

function inferOuterFrameFromGridRectification(gridRectification, detection) {
  const outerQuad = normalizeCornerQuad(gridRectification?.corners || null);
  const guides = detection?.guides || null;
  if (!outerQuad || !guides) {
    return { applied: false, reason: 'missing-grid-rectification-outer-quad' };
  }
  const outerLeft = Math.min(...outerQuad.map((point) => point[0]));
  const outerRight = Math.max(...outerQuad.map((point) => point[0]));
  const outerTop = Math.min(...outerQuad.map((point) => point[1]));
  const outerBottom = Math.max(...outerQuad.map((point) => point[1]));
  const innerLeft = Number(guides.left);
  const innerRight = Number(guides.right);
  const innerTop = Number(guides.top);
  const innerBottom = Number(guides.bottom);
  if (![outerLeft, outerRight, outerTop, outerBottom, innerLeft, innerRight, innerTop, innerBottom].every(Number.isFinite)) {
    return { applied: false, reason: 'invalid-outer-or-inner-bounds' };
  }
  const wrapsInner = (
    outerLeft <= innerLeft + 2
    && outerRight >= innerRight - 2
    && outerTop <= innerTop + 2
    && outerBottom >= innerBottom - 2
  );
  const gaps = {
    top: Math.max(0, Math.round(innerTop - outerTop)),
    bottom: Math.max(0, Math.round(outerBottom - innerBottom)),
    left: Math.max(0, Math.round(innerLeft - outerLeft)),
    right: Math.max(0, Math.round(outerRight - innerRight))
  };
  const gapValues = Object.values(gaps).filter((value) => Number.isFinite(value));
  const significantGapFlags = {
    top: gaps.top >= 4,
    bottom: gaps.bottom >= 4,
    left: gaps.left >= 4,
    right: gaps.right >= 4
  };
  const maxGap = gapValues.length ? Math.max(...gapValues) : 0;
  const minGap = gapValues.length ? Math.min(...gapValues) : 0;
  const nonZeroGapCount = gapValues.filter((value) => value >= 4).length;
  const xGapThreshold = Math.max(
    4,
    Math.round(getMedianGap(guides?.xPeaks || [], Math.max(outerRight - outerLeft, 0) * 0.12) * 0.25)
  );
  const yGapThreshold = Math.max(
    4,
    Math.round(getMedianGap(guides?.yPeaks || [], Math.max(outerBottom - outerTop, 0) * 0.08) * 0.25)
  );
  const allSidesLargeEnough = (
    gaps.top >= yGapThreshold
    && gaps.bottom >= yGapThreshold
    && gaps.left >= xGapThreshold
    && gaps.right >= xGapThreshold
  );
  const gapSimilarityRatio = maxGap > 0 ? minGap / maxGap : 0;
  const allSidesBalanced = gapSimilarityRatio >= 0.58;
  let outerFramePattern = 'mixed-outer-frame';
  if (significantGapFlags.top && significantGapFlags.bottom && !significantGapFlags.left && !significantGapFlags.right) {
    outerFramePattern = 'top-bottom-separated-outer-frame';
  } else if (!significantGapFlags.top && !significantGapFlags.bottom && significantGapFlags.left && significantGapFlags.right) {
    outerFramePattern = 'left-right-separated-outer-frame';
  } else if (significantGapFlags.top && significantGapFlags.bottom && significantGapFlags.left && significantGapFlags.right) {
    outerFramePattern = 'full-margin-outer-frame';
  } else if ((significantGapFlags.top || significantGapFlags.bottom) && (significantGapFlags.left || significantGapFlags.right)) {
    outerFramePattern = 'three-side-or-asymmetric-outer-frame';
  }
  const eligible = (
    wrapsInner
    && significantGapFlags.top
    && significantGapFlags.bottom
    && significantGapFlags.left
    && significantGapFlags.right
    && allSidesLargeEnough
    && allSidesBalanced
    && outerFramePattern === 'full-margin-outer-frame'
  );
  if (!eligible) {
    return {
      applied: false,
      reason: 'grid-rectification-outer-quad-not-four-side-distinct',
      diagnostics: {
        wrapsInner,
        gaps,
        significantGapFlags,
        outerFramePattern,
        maxGap,
        minGap,
        nonZeroGapCount,
        xGapThreshold,
        yGapThreshold,
        allSidesLargeEnough,
        gapSimilarityRatio: Number(gapSimilarityRatio.toFixed(4)),
        allSidesBalanced
      }
    };
  }
  return {
    applied: true,
    reason: 'grid-rectification-outer-frame',
    outerQuad,
    refinedOuterFrame: {
      left: Math.round(outerLeft),
      right: Math.round(outerRight),
      top: Math.round(outerTop),
      bottom: Math.round(outerBottom)
    },
    diagnostics: {
      method: 'grid-rectification-vs-inner-guides',
      wrapsInner,
      gaps,
      significantGapFlags,
      outerFramePattern,
      maxGap,
      minGap,
      nonZeroGapCount,
      xGapThreshold,
      yGapThreshold,
      allSidesLargeEnough,
      gapSimilarityRatio: Number(gapSimilarityRatio.toFixed(4)),
      allSidesBalanced
    }
  };
}

function buildInnerQuadConstrainedByOuterFrame(primaryGuides, fallbackGuides, outerFrame, options = {}) {
  const source = primaryGuides || fallbackGuides || null;
  if (!source || !outerFrame) {
    return null;
  }
  const rawLeft = Number(source.left);
  const rawRight = Number(source.right);
  const rawTop = Number(source.top);
  const rawBottom = Number(source.bottom);
  const outerLeft = Number(outerFrame.left);
  const outerRight = Number(outerFrame.right);
  const outerTop = Number(outerFrame.top);
  const outerBottom = Number(outerFrame.bottom);
  if (![rawLeft, rawRight, rawTop, rawBottom, outerLeft, outerRight, outerTop, outerBottom].every(Number.isFinite)) {
    return null;
  }
  const estimateGuideGap = (peaks) => {
    const sanitized = Array.isArray(peaks)
      ? peaks.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : [];
    if (sanitized.length < 2) {
      return null;
    }
    const gaps = [];
    for (let index = 1; index < sanitized.length; index += 1) {
      const gap = sanitized[index] - sanitized[index - 1];
      if (gap > 8) {
        gaps.push(gap);
      }
    }
    if (!gaps.length) {
      return null;
    }
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  };
  const width = Math.max(1, outerRight - outerLeft);
  const height = Math.max(1, outerBottom - outerTop);
  const minInsetX = Math.max(0, Math.round(width * 0.001));
  const minInsetY = Math.max(0, Math.round(height * 0.001));
  const estimatedCellWidth = (
    estimateGuideGap(source.xPeaks)
    || estimateGuideGap(fallbackGuides?.xPeaks)
    || ((rawRight - rawLeft) > 0 ? (rawRight - rawLeft) / 7 : 0)
  );
  const estimatedCellHeight = (
    estimateGuideGap(source.yPeaks)
    || estimateGuideGap(fallbackGuides?.yPeaks)
    || ((rawBottom - rawTop) > 0 ? (rawBottom - rawTop) / 10 : 0)
  );
  const minimalSemanticInsetX = Math.max(
    minInsetX,
    Math.max(4, Math.round((Number.isFinite(estimatedCellWidth) ? estimatedCellWidth : 0) * 0.03))
  );
  const minimalSemanticInsetY = Math.max(
    minInsetY,
    Math.max(4, Math.round((Number.isFinite(estimatedCellHeight) ? estimatedCellHeight : 0) * 0.03))
  );
  const topCornerCandidate = normalizeCornerQuad(options.topCornerCandidate || null);
  const topGapFromOuter = rawTop - outerTop;
  const leftGapFromOuter = rawLeft - outerLeft;
  const rightGapFromOuter = outerRight - rawRight;
  const bottomGapFromOuter = outerBottom - rawBottom;
  const fallbackTop = Number(fallbackGuides?.top);
  const shallowTopInsetThreshold = Math.max(
    20,
    Math.round((Number.isFinite(estimatedCellHeight) ? estimatedCellHeight : 0) * 0.22)
  );
  const minimalSemanticTopInset = Math.max(
    minimalSemanticInsetY,
    Math.max(2, Math.round((Number.isFinite(estimatedCellHeight) ? estimatedCellHeight : 0) * 0.04))
  );
  const fallbackShowsHigherTop = (
    Number.isFinite(fallbackTop)
    && fallbackTop < rawTop - Math.max(12, Math.round((Number.isFinite(estimatedCellHeight) ? estimatedCellHeight : 0) * 0.12))
  );
  const topInsetLooksLikeThinFrameMargin = (
    topGapFromOuter >= 0
    && topGapFromOuter <= shallowTopInsetThreshold
  );
  const candidateTopShiftThreshold = Math.max(
    14,
    Math.round((Number.isFinite(estimatedCellHeight) ? estimatedCellHeight : 0) * 0.12)
  );
  let candidateTop = null;
  if (topCornerCandidate) {
    const candidateTopYs = [topCornerCandidate[0]?.[1], topCornerCandidate[1]?.[1]]
      .map(Number)
      .filter(Number.isFinite);
    if (candidateTopYs.length === 2) {
      const candidateTopSpread = Math.abs(candidateTopYs[0] - candidateTopYs[1]);
      const candidateTopAverage = average(candidateTopYs);
      if (
        candidateTopSpread <= Math.max(18, Math.round((Number.isFinite(estimatedCellHeight) ? estimatedCellHeight : 0) * 0.16))
        && candidateTopAverage < rawTop - candidateTopShiftThreshold
      ) {
        candidateTop = candidateTopAverage;
      }
    }
  }
  const candidateTopUsable = (
    Number.isFinite(candidateTop)
    && candidateTop >= outerTop + minimalSemanticTopInset
    && candidateTop < rawTop - candidateTopShiftThreshold
  );
  const resolvedRawTop = (
    candidateTopUsable
      ? clamp(
        Math.round(candidateTop),
        Math.round(outerTop + minimalSemanticTopInset),
        Math.round(rawTop - 1)
      )
      : (
        topInsetLooksLikeThinFrameMargin && fallbackShowsHigherTop
          ? outerTop + minimalSemanticTopInset
          : rawTop
      )
  );
  const resolvedRawLeft = (
    leftGapFromOuter < minimalSemanticInsetX
      ? outerLeft + minimalSemanticInsetX
      : rawLeft
  );
  const resolvedRawRight = (
    rightGapFromOuter < minimalSemanticInsetX
      ? outerRight - minimalSemanticInsetX
      : rawRight
  );
  const resolvedRawBottom = (
    bottomGapFromOuter < minimalSemanticInsetY
      ? outerBottom - minimalSemanticInsetY
      : rawBottom
  );
  const left = clamp(
    Math.round(resolvedRawLeft),
    Math.round(outerLeft + minimalSemanticInsetX),
    Math.round(outerRight - minimalSemanticInsetX - 1)
  );
  const right = clamp(
    Math.round(resolvedRawRight),
    left + 1,
    Math.round(outerRight - minimalSemanticInsetX)
  );
  const top = clamp(
    Math.round(resolvedRawTop),
    Math.round(outerTop + minimalSemanticTopInset),
    Math.round(outerBottom - minimalSemanticInsetY - 1)
  );
  const bottom = clamp(
    Math.round(resolvedRawBottom),
    top + 1,
    Math.round(outerBottom - minimalSemanticInsetY)
  );
  return normalizeCornerQuad([
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom]
  ]);
}

function tightenInnerQuadWithinOuterFrame(innerQuad, outerFrame, options = {}) {
  const quad = normalizeCornerQuad(innerQuad);
  if (!quad || !outerFrame) {
    return quad || null;
  }
  const outerLeft = Number(outerFrame.left);
  const outerRight = Number(outerFrame.right);
  const outerTop = Number(outerFrame.top);
  const outerBottom = Number(outerFrame.bottom);
  if (![outerLeft, outerRight, outerTop, outerBottom].every(Number.isFinite)) {
    return quad;
  }
  const cellWidth = Number(options.cellWidth) || 0;
  const cellHeight = Number(options.cellHeight) || 0;
  const insetRatioX = Math.max(0.03, Number(options.insetRatioX) || 0.03);
  const insetRatioY = Math.max(0.03, Number(options.insetRatioY) || 0.03);
  const minInsetX = Math.max(
    4,
    Math.round(Math.max((outerRight - outerLeft) * 0.001, cellWidth * insetRatioX))
  );
  const minInsetY = Math.max(
    4,
    Math.round(Math.max((outerBottom - outerTop) * 0.001, cellHeight * insetRatioY))
  );
  const bounds = {
    left: Math.min(...quad.map((point) => Number(point[0]))),
    right: Math.max(...quad.map((point) => Number(point[0]))),
    top: Math.min(...quad.map((point) => Number(point[1]))),
    bottom: Math.max(...quad.map((point) => Number(point[1])))
  };
  const tightened = {
    left: clamp(Math.round(bounds.left), Math.round(outerLeft + minInsetX), Math.round(outerRight - minInsetX - 1)),
    right: clamp(Math.round(bounds.right), Math.round(outerLeft + minInsetX + 1), Math.round(outerRight - minInsetX)),
    top: clamp(Math.round(bounds.top), Math.round(outerTop + minInsetY), Math.round(outerBottom - minInsetY - 1)),
    bottom: clamp(Math.round(bounds.bottom), Math.round(outerTop + minInsetY + 1), Math.round(outerBottom - minInsetY))
  };
  if (tightened.right <= tightened.left || tightened.bottom <= tightened.top) {
    return quad;
  }
  return normalizeCornerQuad([
    [tightened.left, tightened.top],
    [tightened.right, tightened.top],
    [tightened.right, tightened.bottom],
    [tightened.left, tightened.bottom]
  ]) || quad;
}

function detectRectifiedRegularGridInnerCrop(gray, width, height) {
  if (!gray || width < 240 || height < 240) {
    return null;
  }
  const marginX = clamp(Math.round(width * 0.04), 12, Math.max(12, Math.round(width * 0.12)));
  const marginY = clamp(Math.round(height * 0.04), 12, Math.max(12, Math.round(height * 0.12)));
  const scanTop = clamp(Math.round(height * 0.1), 0, Math.max(0, height - 1));
  const scanBottom = clamp(Math.round(height * 0.9), scanTop + 1, Math.max(1, height - 1));
  const scanLeft = clamp(Math.round(width * 0.08), 0, Math.max(0, width - 1));
  const scanRight = clamp(Math.round(width * 0.92), scanLeft + 1, Math.max(1, width - 1));

  const verticalSeries = new Float32Array(Math.max(0, width - (marginX * 2)));
  for (let x = marginX; x <= width - 1 - marginX; x += 1) {
    verticalSeries[x - marginX] = scoreVerticalLineAt(gray, width, height, x, scanTop, scanBottom);
  }
  const horizontalSeries = new Float32Array(Math.max(0, height - (marginY * 2)));
  for (let y = marginY; y <= height - 1 - marginY; y += 1) {
    horizontalSeries[y - marginY] = scoreHorizontalLineAt(gray, width, height, y, scanLeft, scanRight);
  }
  if (!verticalSeries.length || !horizontalSeries.length) {
    return null;
  }

  const regularVertical = detectRegularLinePeaks(smoothSeries(verticalSeries, 2), {
    minSpacing: Math.max(12, Math.round(width * 0.025)),
    thresholdRatio: 0.48
  });
  const regularHorizontal = detectRegularLinePeaks(smoothSeries(horizontalSeries, 2), {
    minSpacing: Math.max(12, Math.round(height * 0.02)),
    thresholdRatio: 0.48
  });
  if (
    regularVertical.peaks.length < 6
    || regularHorizontal.peaks.length < 8
    || regularVertical.stableGapCount < 4
    || regularHorizontal.stableGapCount < 6
  ) {
    return null;
  }

  const extendPeakBoundary = (series, peak, medianGap, direction) => {
    if (!peak || !Number.isFinite(medianGap) || medianGap <= 0) {
      return peak ? peak.index : null;
    }
    const minGap = Math.max(18, Math.round(medianGap * 0.75));
    const maxGap = Math.max(minGap + 8, Math.round(medianGap * 1.45));
    const threshold = Math.max(12, peak.value * 0.42);
    let best = null;
    if (direction === 'before') {
      const start = Math.max(1, peak.index - maxGap);
      const end = Math.max(start, peak.index - minGap);
      for (let i = start; i <= end; i += 1) {
        const current = Number(series[i]) || 0;
        if (current < threshold) {
          continue;
        }
        if (current < (Number(series[i - 1]) || 0) || current < (Number(series[i + 1]) || 0)) {
          continue;
        }
        if (!best || current > best.value) {
          best = { index: i, value: current };
        }
      }
    } else {
      const start = Math.min(series.length - 2, peak.index + minGap);
      const end = Math.min(series.length - 2, peak.index + maxGap);
      for (let i = start; i <= end; i += 1) {
        const current = Number(series[i]) || 0;
        if (current < threshold) {
          continue;
        }
        if (current < (Number(series[i - 1]) || 0) || current < (Number(series[i + 1]) || 0)) {
          continue;
        }
        if (!best || current > best.value) {
          best = { index: i, value: current };
        }
      }
    }
    return best ? best.index : peak.index;
  };

  const firstVerticalPeak = regularVertical.peaks[0];
  const lastVerticalPeak = regularVertical.peaks[regularVertical.peaks.length - 1];
  const firstHorizontalPeak = regularHorizontal.peaks[0];
  const lastHorizontalPeak = regularHorizontal.peaks[regularHorizontal.peaks.length - 1];
  const regularVerticalGap = Math.max(
    Number(regularVertical.medianGap) || 0,
    regularVertical.peaks.length >= 2
      ? (lastVerticalPeak.index - firstVerticalPeak.index) / Math.max(1, regularVertical.peaks.length - 1)
      : 0
  );
  const regularHorizontalGap = Math.max(
    Number(regularHorizontal.medianGap) || 0,
    regularHorizontal.peaks.length >= 2
      ? (lastHorizontalPeak.index - firstHorizontalPeak.index) / Math.max(1, regularHorizontal.peaks.length - 1)
      : 0
  );
  const left = clamp(
    marginX + extendPeakBoundary(smoothSeries(verticalSeries, 2), firstVerticalPeak, regularVerticalGap, 'before'),
    0,
    width - 1
  );
  const right = clamp(
    marginX + extendPeakBoundary(smoothSeries(verticalSeries, 2), lastVerticalPeak, regularVerticalGap, 'after'),
    left + 1,
    width - 1
  );
  const top = clamp(
    marginY + extendPeakBoundary(smoothSeries(horizontalSeries, 2), firstHorizontalPeak, regularHorizontalGap, 'before'),
    0,
    height - 1
  );
  const bottom = clamp(
    marginY + extendPeakBoundary(smoothSeries(horizontalSeries, 2), lastHorizontalPeak, regularHorizontalGap, 'after'),
    top + 1,
    height - 1
  );
  if (
    (right - left + 1) < Math.round(width * 0.55)
    || (bottom - top + 1) < Math.round(height * 0.55)
  ) {
    return null;
  }

  return {
    cropBox: {
      left: clamp(left - 1, 0, width - 1),
      top: clamp(top - 1, 0, height - 1),
      right: clamp(right + 1, left + 1, width - 1),
      bottom: clamp(bottom + 1, top + 1, height - 1),
      width: clamp(right + 1, left + 1, width - 1) - clamp(left - 1, 0, width - 1) + 1,
      height: clamp(bottom + 1, top + 1, height - 1) - clamp(top - 1, 0, height - 1) + 1
    },
    immediateInnerFrame: { left, right, top, bottom },
    regularGrid: {
      verticalPeakCount: regularVertical.peaks.length,
      verticalMedianGap: Number((regularVertical.medianGap || 0).toFixed(3)),
      verticalStableGapCount: regularVertical.stableGapCount,
      horizontalPeakCount: regularHorizontal.peaks.length,
      horizontalMedianGap: Number((regularHorizontal.medianGap || 0).toFixed(3)),
      horizontalStableGapCount: regularHorizontal.stableGapCount
    },
    method: 'rectified-regular-grid-inner-crop'
  };
}

async function recoverInnerQuadFromRectifiedOuterCrop(imagePath, inferredOuterFrame, options = {}) {
  if (!imagePath || !inferredOuterFrame?.applied) {
    return null;
  }
  const method = String(inferredOuterFrame?.diagnostics?.method || '');
  if (method !== 'broad-raw-guide-window-outer-frame') {
    return null;
  }
  const outerQuad = normalizeCornerQuad(
    inferredOuterFrame?.outerQuad
    || (
      inferredOuterFrame?.refinedOuterFrame
        ? [
            [inferredOuterFrame.refinedOuterFrame.left, inferredOuterFrame.refinedOuterFrame.top],
            [inferredOuterFrame.refinedOuterFrame.right, inferredOuterFrame.refinedOuterFrame.top],
            [inferredOuterFrame.refinedOuterFrame.right, inferredOuterFrame.refinedOuterFrame.bottom],
            [inferredOuterFrame.refinedOuterFrame.left, inferredOuterFrame.refinedOuterFrame.bottom]
          ]
        : null
    )
  );
  const outerBounds = inferredOuterFrame?.refinedOuterFrame || getQuadBounds(outerQuad);
  if (!outerQuad || !outerBounds) {
    return null;
  }
  const cellWidth = Number(options.cellWidth) || Number(inferredOuterFrame?.diagnostics?.cellWidth) || 0;
  const cellHeight = Number(options.cellHeight) || Number(inferredOuterFrame?.diagnostics?.cellHeight) || 0;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outer-inner-recovery-'));
  const rectifiedPath = path.join(tempDir, 'outer_frame_rectified_raw.png');
  const rectifiedMetaPath = path.join(tempDir, 'outer_frame_rectified_raw.json');
  try {
    const rectifiedMeta = await runPaperQuadRectify(imagePath, outerQuad, rectifiedPath, rectifiedMetaPath);
    const { data: rectifiedRgbData, info: rectifiedInfo } = await loadRgbImage(rectifiedPath);
    const analyzedCrop = analyzeRectifiedOuterFrameCrop(rectifiedRgbData, rectifiedInfo);
    const regularGridCrop = detectRectifiedRegularGridInnerCrop(
      computeGray(rectifiedRgbData, rectifiedInfo.channels),
      rectifiedInfo.width,
      rectifiedInfo.height
    );
    const rectifiedCrop = (() => {
      if (regularGridCrop?.cropBox && analyzedCrop?.cropBox) {
        const analyzedInset = Math.min(
          Number(analyzedCrop.cropBox.left) || 0,
          Math.max(0, rectifiedInfo.width - 1 - (Number(analyzedCrop.cropBox.right) || 0)),
          Number(analyzedCrop.cropBox.top) || 0,
          Math.max(0, rectifiedInfo.height - 1 - (Number(analyzedCrop.cropBox.bottom) || 0))
        );
        const regularInset = Math.min(
          Number(regularGridCrop.cropBox.left) || 0,
          Math.max(0, rectifiedInfo.width - 1 - (Number(regularGridCrop.cropBox.right) || 0)),
          Number(regularGridCrop.cropBox.top) || 0,
          Math.max(0, rectifiedInfo.height - 1 - (Number(regularGridCrop.cropBox.bottom) || 0))
        );
        return regularInset >= analyzedInset + 12 ? regularGridCrop : analyzedCrop;
      }
      return regularGridCrop?.cropBox ? regularGridCrop : analyzedCrop;
    })();
    if (!rectifiedCrop?.cropBox) {
      return null;
    }
    const projection = projectRectifiedCropBoxToSourceQuad(
      outerQuad,
      rectifiedMeta || rectifiedInfo,
      rectifiedCrop.cropBox
    );
    if (!projection?.quad || !projection?.bounds) {
      return null;
    }
    const trimLeft = Number(projection.rectifiedTrims?.left) || 0;
    const trimRight = Number(projection.rectifiedTrims?.right) || 0;
    const trimTop = Number(projection.rectifiedTrims?.top) || 0;
    const trimBottom = Number(projection.rectifiedTrims?.bottom) || 0;
    const rectifiedWidth = Number(rectifiedMeta?.targetWidth) || Number(rectifiedInfo?.width) || 0;
    const rectifiedHeight = Number(rectifiedMeta?.targetHeight) || Number(rectifiedInfo?.height) || 0;
    const minTrimX = Math.max(14, Math.round(Math.max(rectifiedWidth * 0.045, cellWidth * 0.45)));
    const minTrimY = Math.max(14, Math.round(Math.max(rectifiedHeight * 0.04, cellHeight * 0.35)));
    const maxTrimX = Math.max(minTrimX + 18, Math.round(rectifiedWidth * 0.22));
    const maxTrimY = Math.max(minTrimY + 18, Math.round(rectifiedHeight * 0.18));
    const meaningfulInset = (
      trimLeft >= minTrimX
      && trimRight >= minTrimX
      && trimTop >= minTrimY
      && trimBottom >= minTrimY
      && trimLeft <= maxTrimX
      && trimRight <= maxTrimX
      && trimTop <= maxTrimY
      && trimBottom <= maxTrimY
    );
    const stillInsideOuter = (
      projection.bounds.left >= Number(outerBounds.left) + 4
      && projection.bounds.right <= Number(outerBounds.right) - 4
      && projection.bounds.top >= Number(outerBounds.top) + 4
      && projection.bounds.bottom <= Number(outerBounds.bottom) - 4
    );
    if (!meaningfulInset || !stillInsideOuter) {
      return null;
    }
    return {
      quad: projection.quad,
      bounds: projection.bounds,
      diagnostics: {
        method: 'rectified-outer-frame-inner-crop-reprojection',
        cropBox: rectifiedCrop.cropBox,
        cropMethod: rectifiedCrop.method || null,
        regularGrid: rectifiedCrop.regularGrid || null,
        rectifiedTrims: projection.rectifiedTrims,
        minTrimX,
        minTrimY,
        maxTrimX,
        maxTrimY
      }
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function refinePatternInferredOuterFrameQuadByBoundaryFits(imagePath, inferredOuterFrame, guides = null) {
  if (!imagePath || !inferredOuterFrame?.applied || !guides) {
    return inferredOuterFrame || null;
  }
  if (String(inferredOuterFrame?.diagnostics?.method || '') !== 'pattern-driven-outer-frame-inference') {
    return inferredOuterFrame || null;
  }
  const outer = inferredOuterFrame?.refinedOuterFrame || null;
  if (!outer) {
    return inferredOuterFrame || null;
  }
  const innerLeft = Number(guides.left);
  const innerRight = Number(guides.right);
  const innerTop = Number(guides.top);
  const innerBottom = Number(guides.bottom);
  const outerLeft = Number(outer.left);
  const outerRight = Number(outer.right);
  const outerTop = Number(outer.top);
  const outerBottom = Number(outer.bottom);
  if (![innerLeft, innerRight, innerTop, innerBottom, outerLeft, outerRight, outerTop, outerBottom].every(Number.isFinite)) {
    return inferredOuterFrame || null;
  }
  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const gray = await buildOuterFrameEnhancedGray(
    computeGray(rgbData, info.channels),
    info.width,
    info.height,
    guides
  );
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(24, Math.round(getMedianGap(xPeaks, Math.max(1, innerRight - innerLeft))));
  const cellHeight = Math.max(24, Math.round(getMedianGap(yPeaks, Math.max(1, innerBottom - innerTop))));
  const sideSearch = Math.max(10, Math.round(cellWidth * 0.12));
  const verticalSearch = Math.max(12, Math.round(cellHeight * 0.14));

  const topPoints = collectGlobalHorizontalBoundaryPoints(gray, info.width, info.height, {
    expectedY: outerTop,
    xStart: outerLeft,
    xEnd: outerRight,
    yStart: clamp(Math.round(outerTop - verticalSearch), 0, Math.max(0, info.height - 1)),
    yEnd: clamp(Math.round(Math.min(innerTop - 2, outerTop + verticalSearch)), 0, Math.max(0, info.height - 1)),
    inwardDir: 1,
    step: 8,
    outwardBias: 0.14
  });
  const bottomPoints = collectGlobalHorizontalBoundaryPoints(gray, info.width, info.height, {
    expectedY: outerBottom,
    xStart: outerLeft,
    xEnd: outerRight,
    yStart: clamp(Math.round(Math.max(innerBottom + 2, outerBottom - verticalSearch)), 0, Math.max(0, info.height - 1)),
    yEnd: clamp(Math.round(outerBottom + verticalSearch), 0, Math.max(0, info.height - 1)),
    inwardDir: -1,
    step: 8,
    outwardBias: 0.14
  });
  const leftPoints = collectGlobalVerticalBoundaryPoints(gray, info.width, info.height, {
    expectedX: outerLeft,
    xStart: clamp(Math.round(outerLeft - sideSearch), 0, Math.max(0, info.width - 1)),
    xEnd: clamp(Math.round(Math.min(innerLeft - 2, outerLeft + sideSearch)), 0, Math.max(0, info.width - 1)),
    yStart: outerTop,
    yEnd: outerBottom,
    inwardDir: 1,
    step: 8,
    outwardBias: 0.14
  });
  const rightPoints = collectGlobalVerticalBoundaryPoints(gray, info.width, info.height, {
    expectedX: outerRight,
    xStart: clamp(Math.round(Math.max(innerRight + 2, outerRight - sideSearch)), 0, Math.max(0, info.width - 1)),
    xEnd: clamp(Math.round(outerRight + sideSearch), 0, Math.max(0, info.width - 1)),
    yStart: outerTop,
    yEnd: outerBottom,
    inwardDir: -1,
    step: 8,
    outwardBias: 0.14
  });

  const topLine = fitLineRobust(topPoints, 4);
  const bottomLine = fitLineRobust(bottomPoints, 4);
  const leftLine = fitLineRobust(leftPoints, 4);
  const rightLine = fitLineRobust(rightPoints, 4);
  const rawBoundaryFitQuad = normalizeCornerQuad([
    intersectLines(topLine, leftLine),
    intersectLines(topLine, rightLine),
    intersectLines(bottomLine, rightLine),
    intersectLines(bottomLine, leftLine)
  ]);
  if (!rawBoundaryFitQuad) {
    return inferredOuterFrame || null;
  }
  const rawBoundaryFitBounds = getQuadBounds(rawBoundaryFitQuad);
  const endpointLiftFit = rawBoundaryFitBounds
    ? fitTiltedOuterFrameQuadFromBounds(
      gray,
      info.width,
      info.height,
      rawBoundaryFitBounds,
      { left: innerLeft, right: innerRight, top: innerTop, bottom: innerBottom },
      { cellWidth, cellHeight }
    )
    : null;
  const boundaryFitEndpointLift = liftAsymmetricTopCornerTowardEndpoint(
    rawBoundaryFitQuad,
    endpointLiftFit?.diagnostics?.verticalEndpoints || null,
    { cellWidth, cellHeight }
  );
  const diagnostics = inferredOuterFrame?.diagnostics || {};
  const pattern = String(diagnostics?.outerFramePattern || '');
  const tightenedByFinalGuides = Boolean(diagnostics?.tightenedByFinalGuides);
  const currentMargins = {
    left: Math.max(0, innerLeft - outerLeft),
    right: Math.max(0, outerRight - innerRight),
    top: Math.max(0, innerTop - outerTop),
    bottom: Math.max(0, outerBottom - innerBottom)
  };
  const maxShiftX = Math.max(10, Math.round(cellWidth * 0.16));
  const maxShiftY = Math.max(10, Math.round(cellHeight * 0.16));
  const evaluateBoundaryFitCandidate = (candidateQuad) => {
    const candidateBounds = getQuadBounds(candidateQuad);
    if (!candidateBounds) {
      return null;
    }
    const withinShiftLimit = (
      Math.abs(candidateBounds.left - outerLeft) <= maxShiftX
      && Math.abs(candidateBounds.right - outerRight) <= maxShiftX
      && Math.abs(candidateBounds.top - outerTop) <= maxShiftY
      && Math.abs(candidateBounds.bottom - outerBottom) <= maxShiftY
    );
    const stillWrapsInner = (
      candidateBounds.left <= innerLeft - 2
      && candidateBounds.right >= innerRight + 2
      && candidateBounds.top <= innerTop - 2
      && candidateBounds.bottom >= innerBottom + 2
    );
    if (!withinShiftLimit || !stillWrapsInner) {
      return null;
    }
    const candidateMargins = {
      left: Math.max(0, innerLeft - candidateBounds.left),
      right: Math.max(0, candidateBounds.right - innerRight),
      top: Math.max(0, innerTop - candidateBounds.top),
      bottom: Math.max(0, candidateBounds.bottom - innerBottom)
    };
    if (tightenedByFinalGuides && pattern === 'full-margin-outer-frame') {
      const marginSlackX = Math.max(4, Math.round(cellWidth * 0.05));
      const marginSlackY = Math.max(4, Math.round(cellHeight * 0.05));
      const expandedOnAllSides = (
        candidateMargins.left >= currentMargins.left
        && candidateMargins.right >= currentMargins.right
        && candidateMargins.top >= currentMargins.top
        && candidateMargins.bottom >= currentMargins.bottom
      );
      const materiallyExpanded = (
        (candidateMargins.left - currentMargins.left) >= marginSlackX
        || (candidateMargins.right - currentMargins.right) >= marginSlackX
        || (candidateMargins.top - currentMargins.top) >= marginSlackY
        || (candidateMargins.bottom - currentMargins.bottom) >= marginSlackY
      );
      const currentAsymmetryX = Math.abs(currentMargins.left - currentMargins.right);
      const currentAsymmetryY = Math.abs(currentMargins.top - currentMargins.bottom);
      const candidateAsymmetryX = Math.abs(candidateMargins.left - candidateMargins.right);
      const candidateAsymmetryY = Math.abs(candidateMargins.top - candidateMargins.bottom);
      const asymmetryWorsened = (
        candidateAsymmetryX > currentAsymmetryX + Math.max(4, Math.round(cellWidth * 0.04))
        || candidateAsymmetryY > currentAsymmetryY + Math.max(4, Math.round(cellHeight * 0.04))
      );
      if (expandedOnAllSides && materiallyExpanded && asymmetryWorsened) {
        return null;
      }
    }
    return {
      quad: candidateQuad,
      bounds: candidateBounds,
      margins: candidateMargins
    };
  };
  const boundaryFitCandidates = [
    boundaryFitEndpointLift?.diagnostics?.applied
      ? {
          quad: boundaryFitEndpointLift.quad,
          endpointLift: boundaryFitEndpointLift.diagnostics
        }
      : null,
    {
      quad: rawBoundaryFitQuad,
      endpointLift: null
    }
  ].filter(Boolean);
  let acceptedBoundaryFit = null;
  let selectedEndpointLift = null;
  for (const candidate of boundaryFitCandidates) {
    const evaluatedCandidate = evaluateBoundaryFitCandidate(candidate.quad);
    if (evaluatedCandidate) {
      acceptedBoundaryFit = evaluatedCandidate;
      selectedEndpointLift = candidate.endpointLift;
      break;
    }
  }
  if (!acceptedBoundaryFit) {
    return inferredOuterFrame || null;
  }
  const nextQuad = acceptedBoundaryFit.quad;
  const nextBounds = acceptedBoundaryFit.bounds;
  const boundaryFitLocalTopCornerRefinement = refineAsymmetricTopCornerByLocalTopSupport(
    gray,
    info.width,
    info.height,
    nextQuad,
    {
      outerBounds: nextBounds,
      innerBounds: { left: innerLeft, right: innerRight, top: innerTop, bottom: innerBottom },
      verticalEndpoints: endpointLiftFit?.diagnostics?.verticalEndpoints || null,
      leftLine,
      rightLine,
      cellWidth,
      cellHeight,
      guides
    }
  );
  const finalQuad = boundaryFitLocalTopCornerRefinement?.diagnostics?.applied
    ? boundaryFitLocalTopCornerRefinement.quad
    : nextQuad;
  return {
    ...inferredOuterFrame,
    outerQuad: finalQuad,
    refinedOuterFrame: nextBounds,
    diagnostics: {
      ...(inferredOuterFrame?.diagnostics || {}),
      boundaryFitAdjusted: true,
      boundaryFitAdjustedFromOuterBounds: outer,
      boundaryFitEndpointLift: selectedEndpointLift || null,
      boundaryFitLocalTopCornerRefinement: boundaryFitLocalTopCornerRefinement?.diagnostics || null,
      boundaryFitShift: {
        left: nextBounds.left - outerLeft,
        right: nextBounds.right - outerRight,
        top: nextBounds.top - outerTop,
        bottom: nextBounds.bottom - outerBottom
      }
    }
  };
}

function refineInferredOuterFrameTopByLocalCorners(inferredOuterFrame, topCornerCandidate, options = {}) {
  if (!inferredOuterFrame?.applied || !inferredOuterFrame?.refinedOuterFrame) {
    return inferredOuterFrame || null;
  }
  if (inferredOuterFrame?.diagnostics?.method === 'broad-raw-guide-window-outer-frame') {
    return inferredOuterFrame;
  }
  const quad = normalizeCornerQuad(topCornerCandidate || null);
  if (!quad) {
    return inferredOuterFrame;
  }
  const topYs = [quad[0]?.[1], quad[1]?.[1]].map(Number).filter(Number.isFinite);
  if (topYs.length !== 2) {
    return inferredOuterFrame;
  }
  const cellHeight = Number(options.cellHeight) || 0;
  const topSpread = Math.abs(topYs[0] - topYs[1]);
  const alignedTolerance = Math.max(18, Math.round(cellHeight * 0.18));
  if (topSpread > alignedTolerance) {
    return inferredOuterFrame;
  }
  const currentTop = Number(inferredOuterFrame.refinedOuterFrame.top);
  if (!Number.isFinite(currentTop)) {
    return inferredOuterFrame;
  }
  const candidateTop = average(topYs);
  const minLift = Math.max(14, Math.round(cellHeight * 0.14));
  if (!(candidateTop < currentTop - minLift)) {
    return inferredOuterFrame;
  }
  const outerInset = Math.max(3, Math.round(cellHeight * 0.02));
  const refinedTop = Math.max(0, Math.round(candidateTop - outerInset));
  if (!(refinedTop < currentTop)) {
    return inferredOuterFrame;
  }
  const currentOuterQuad = normalizeCornerQuad(inferredOuterFrame.outerQuad || null);
  const nextOuterQuad = currentOuterQuad
    ? normalizeCornerQuad([
        [currentOuterQuad[0][0], refinedTop],
        [currentOuterQuad[1][0], refinedTop],
        currentOuterQuad[2],
        currentOuterQuad[3]
      ])
    : null;
  return {
    ...inferredOuterFrame,
    outerQuad: nextOuterQuad || inferredOuterFrame.outerQuad || null,
    refinedOuterFrame: {
      ...inferredOuterFrame.refinedOuterFrame,
      top: refinedTop
    },
    diagnostics: {
      ...(inferredOuterFrame.diagnostics || {}),
      topAdjustedByLocalCorners: true,
      topAdjustedFrom: currentTop,
      topAdjustedTo: refinedTop,
      topAdjustedCandidateTop: Number(candidateTop.toFixed(3)),
      topAdjustedCandidateSpread: Number(topSpread.toFixed(3))
    }
  };
}

function resolveConsistentTopCornerCandidate(cornerDiagnostics, options = {}) {
  const leftTop = cornerDiagnostics?.leftTop?.refined || null;
  const rightTop = cornerDiagnostics?.rightTop?.refined || null;
  const leftY = Number(leftTop?.[1]);
  const rightY = Number(rightTop?.[1]);
  if (!Number.isFinite(leftY) || !Number.isFinite(rightY)) {
    return null;
  }
  const cellHeight = Number(options.cellHeight) || 0;
  const spread = Math.abs(leftY - rightY);
  const maxSpread = Math.max(18, Math.round(cellHeight * 0.18));
  if (spread > maxSpread) {
    return null;
  }
  return {
    top: average([leftY, rightY]),
    spread
  };
}

function shouldRecalibrateInferredOuterFrameAfterCornerRerun(inferredOuterFrame) {
  if (!inferredOuterFrame?.applied) {
    return false;
  }
  const reason = String(inferredOuterFrame.reason || '');
  const method = String(inferredOuterFrame?.diagnostics?.method || '');
  return (
    reason === 'pattern-outer-frame-inferred'
    || method === 'pattern-driven-outer-frame-inference'
  );
}

function shouldRefineInferredOuterFrameToInnerEdge(inferredOuterFrame) {
  if (!inferredOuterFrame?.applied || inferredOuterFrame?.diagnostics?.innerEdgeAdjusted) {
    return false;
  }
  const method = String(inferredOuterFrame?.diagnostics?.method || '');
  return method === 'pattern-driven-outer-frame-inference';
}

async function tightenPatternInferredOuterFrameByFinalGuides(imagePath, inferredOuterFrame, guides = null) {
  if (!imagePath || !guides || !shouldRecalibrateInferredOuterFrameAfterCornerRerun(inferredOuterFrame)) {
    return inferredOuterFrame || null;
  }
  const outer = inferredOuterFrame?.refinedOuterFrame || null;
  if (!outer) {
    return inferredOuterFrame || null;
  }
  const innerLeft = Number(guides.left);
  const innerRight = Number(guides.right);
  const innerTop = Number(guides.top);
  const innerBottom = Number(guides.bottom);
  const outerLeft = Number(outer.left);
  const outerRight = Number(outer.right);
  const outerTop = Number(outer.top);
  const outerBottom = Number(outer.bottom);
  if (![innerLeft, innerRight, innerTop, innerBottom, outerLeft, outerRight, outerTop, outerBottom].every(Number.isFinite)) {
    return inferredOuterFrame || null;
  }
  const { data: rgbData, info } = await loadRgbImage(imagePath);
  const gray = await buildOuterFrameEnhancedGray(
    computeGray(rgbData, info.channels),
    info.width,
    info.height,
    guides
  );
  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks.map(Number).filter(Number.isFinite) : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks.map(Number).filter(Number.isFinite) : [];
  const cellWidth = Math.max(24, Math.round(getMedianGap(xPeaks, Math.max(1, innerRight - innerLeft))));
  const cellHeight = Math.max(24, Math.round(getMedianGap(yPeaks, Math.max(1, innerBottom - innerTop))));
  const spanX0 = clamp(Math.round(innerLeft + cellWidth * 0.08), 0, Math.max(0, info.width - 1));
  const spanX1 = clamp(Math.round(innerRight - cellWidth * 0.08), spanX0 + 1, Math.max(1, info.width - 1));
  const spanY0 = clamp(Math.round(innerTop + cellHeight * 0.08), 0, Math.max(0, info.height - 1));
  const spanY1 = clamp(Math.round(innerBottom - cellHeight * 0.08), spanY0 + 1, Math.max(1, info.height - 1));
  const minInsetX = Math.max(6, Math.round(cellWidth * 0.05));
  const minInsetY = Math.max(8, Math.round(cellHeight * 0.08));
  const minBoundaryGapX = Math.max(10, Math.round(cellWidth * 0.08));
  const minBoundaryGapY = Math.max(12, Math.round(cellHeight * 0.08));
  const nearBoundaryGapX = 2;
  const nearBoundaryGapY = 2;
  const minScoreX = Math.max(22, cellWidth * 0.09);
  const minScoreY = Math.max(22, cellHeight * 0.09);

  const topCandidate = (innerTop - outerTop) > Math.max(minInsetY, minBoundaryGapY)
    ? findStrongDirectionalLine(
      clamp(Math.round(outerTop + 1), 0, Math.max(0, info.height - 1)),
      clamp(Math.round(innerTop - minBoundaryGapY), 0, Math.max(0, info.height - 1)),
      (y) => scoreHorizontalLineAt(gray, info.width, info.height, y, spanX0, spanX1)
    )
    : null;
  const bottomCandidate = (() => {
    if ((outerBottom - innerBottom) <= Math.max(minInsetY, nearBoundaryGapY)) {
      return null;
    }
    const bottomSearchFrom = clamp(Math.round(innerBottom + nearBoundaryGapY), 0, Math.max(0, info.height - 1));
    const bottomSearchTo = clamp(Math.round(outerBottom - 1), bottomSearchFrom, Math.max(0, info.height - 1));
    const scoreAt = (y) => scoreHorizontalLineAt(gray, info.width, info.height, y, spanX0, spanX1);
    return (
      findNearestDirectionalPeak(
        bottomSearchFrom,
        bottomSearchTo,
        scoreAt,
        {
          direction: 'forward',
          minScore: Math.max(16, minScoreY * 0.62)
        }
      )
      || findStrongDirectionalLine(bottomSearchFrom, bottomSearchTo, scoreAt)
    );
  })();
  const leftCandidate = (() => {
    if ((innerLeft - outerLeft) <= Math.max(minInsetX, nearBoundaryGapX)) {
      return null;
    }
    const leftSearchFrom = clamp(Math.round(innerLeft - nearBoundaryGapX), 0, Math.max(0, info.width - 1));
    const leftSearchTo = clamp(Math.round(outerLeft + 1), 0, leftSearchFrom);
    const scoreAt = (x) => scoreVerticalLineAt(gray, info.width, info.height, x, spanY0, spanY1);
    return (
      findNearestDirectionalPeak(
        leftSearchFrom,
        leftSearchTo,
        scoreAt,
        {
          direction: 'backward',
          minScore: Math.max(16, minScoreX * 0.62)
        }
      )
      || findStrongDirectionalLine(leftSearchTo, leftSearchFrom, scoreAt)
    );
  })();
  const rightCandidate = (() => {
    if ((outerRight - innerRight) <= Math.max(minInsetX, nearBoundaryGapX)) {
      return null;
    }
    const rightSearchFrom = clamp(Math.round(innerRight + nearBoundaryGapX), 0, Math.max(0, info.width - 1));
    const rightSearchTo = clamp(Math.round(outerRight - 1), rightSearchFrom, Math.max(0, info.width - 1));
    const scoreAt = (x) => scoreVerticalLineAt(gray, info.width, info.height, x, spanY0, spanY1);
    return (
      findNearestDirectionalPeak(
        rightSearchFrom,
        rightSearchTo,
        scoreAt,
        {
          direction: 'forward',
          minScore: Math.max(16, minScoreX * 0.62)
        }
      )
      || findStrongDirectionalLine(rightSearchFrom, rightSearchTo, scoreAt)
    );
  })();

  const nextOuter = {
    left: leftCandidate && leftCandidate.score >= minScoreX ? leftCandidate.index : outerLeft,
    right: rightCandidate && rightCandidate.score >= minScoreX ? rightCandidate.index : outerRight,
    top: topCandidate && topCandidate.score >= minScoreY ? topCandidate.index : outerTop,
    bottom: bottomCandidate && bottomCandidate.score >= minScoreY ? bottomCandidate.index : outerBottom
  };
  const changed = (
    nextOuter.left !== outerLeft
    || nextOuter.right !== outerRight
    || nextOuter.top !== outerTop
    || nextOuter.bottom !== outerBottom
  );
  if (!changed) {
    return inferredOuterFrame || null;
  }
  const fallbackNextQuad = normalizeCornerQuad([
    [nextOuter.left, nextOuter.top],
    [nextOuter.right, nextOuter.top],
    [nextOuter.right, nextOuter.bottom],
    [nextOuter.left, nextOuter.bottom]
  ]);
  const fittedNextOuter = fitTiltedOuterFrameQuadFromBounds(
    gray,
    info.width,
    info.height,
    nextOuter,
    { left: innerLeft, right: innerRight, top: innerTop, bottom: innerBottom },
    { cellWidth, cellHeight }
  );
  const nextQuad = fittedNextOuter?.quad || fallbackNextQuad;
  if (!nextQuad) {
    return inferredOuterFrame || null;
  }
  const nextTopGap = Math.max(0, innerTop - nextOuter.top);
  const nextBottomGap = Math.max(0, nextOuter.bottom - innerBottom);
  const nextLeftGap = Math.max(0, innerLeft - nextOuter.left);
  const nextRightGap = Math.max(0, nextOuter.right - innerRight);
  const nextGaps = [nextTopGap, nextBottomGap, nextLeftGap, nextRightGap].filter((value) => Number.isFinite(value) && value > 0);
  const nextHorizontalGaps = [nextTopGap, nextBottomGap].filter((value) => Number.isFinite(value) && value > 0);
  const nextVerticalGaps = [nextLeftGap, nextRightGap].filter((value) => Number.isFinite(value) && value > 0);
  const nextNormalizedMarginRatios = {
    top: nextTopGap / Math.max(cellHeight, 1),
    bottom: nextBottomGap / Math.max(cellHeight, 1),
    left: nextLeftGap / Math.max(cellWidth, 1),
    right: nextRightGap / Math.max(cellWidth, 1)
  };
  const nextMeanHorizontalMarginRatio = average([nextNormalizedMarginRatios.top, nextNormalizedMarginRatios.bottom].filter(Number.isFinite));
  const nextMeanVerticalMarginRatio = average([nextNormalizedMarginRatios.left, nextNormalizedMarginRatios.right].filter(Number.isFinite));
  const nextAxisMarginDominanceRatio = (
    Number.isFinite(nextMeanHorizontalMarginRatio)
    && Number.isFinite(nextMeanVerticalMarginRatio)
    && Math.min(nextMeanHorizontalMarginRatio, nextMeanVerticalMarginRatio) > 1e-6
  )
    ? Math.max(nextMeanHorizontalMarginRatio, nextMeanVerticalMarginRatio) / Math.max(1e-6, Math.min(nextMeanHorizontalMarginRatio, nextMeanVerticalMarginRatio))
    : Number.POSITIVE_INFINITY;
  return {
    ...inferredOuterFrame,
    outerQuad: nextQuad,
    refinedOuterFrame: nextOuter,
    diagnostics: {
      ...(inferredOuterFrame?.diagnostics || {}),
      gaps: {
        top: nextTopGap,
        bottom: nextBottomGap,
        left: nextLeftGap,
        right: nextRightGap
      },
      gapRatio: nextGaps.length ? Number((Math.max(...nextGaps) / Math.max(1, Math.min(...nextGaps))).toFixed(4)) : null,
      horizontalGapRatio: nextHorizontalGaps.length === 2
        ? Number((Math.max(...nextHorizontalGaps) / Math.max(1, Math.min(...nextHorizontalGaps))).toFixed(4))
        : null,
      verticalGapRatio: nextVerticalGaps.length === 2
        ? Number((Math.max(...nextVerticalGaps) / Math.max(1, Math.min(...nextVerticalGaps))).toFixed(4))
        : null,
      normalizedMarginRatios: {
        top: Number(nextNormalizedMarginRatios.top.toFixed(4)),
        bottom: Number(nextNormalizedMarginRatios.bottom.toFixed(4)),
        left: Number(nextNormalizedMarginRatios.left.toFixed(4)),
        right: Number(nextNormalizedMarginRatios.right.toFixed(4))
      },
      minHorizontalMarginRatio: Number(Math.min(nextNormalizedMarginRatios.top, nextNormalizedMarginRatios.bottom).toFixed(4)),
      minVerticalMarginRatio: Number(Math.min(nextNormalizedMarginRatios.left, nextNormalizedMarginRatios.right).toFixed(4)),
      axisMarginDominanceRatio: Number.isFinite(nextAxisMarginDominanceRatio)
        ? Number(nextAxisMarginDominanceRatio.toFixed(4))
        : null,
      innerBounds: {
        left: innerLeft,
        right: innerRight,
        top: innerTop,
        bottom: innerBottom
      },
      outerBounds: {
        left: nextOuter.left,
        right: nextOuter.right,
        top: nextOuter.top,
        bottom: nextOuter.bottom
      },
      tiltedQuadFittedAfterTighten: Boolean(fittedNextOuter?.quad),
      tiltedQuadFitDiagnosticsAfterTighten: fittedNextOuter?.diagnostics || null,
      tightenedByFinalGuides: true,
      tightenedFromOuterBounds: outer,
      tightenedCandidates: {
        top: topCandidate ? { index: topCandidate.index, score: Number(topCandidate.score.toFixed(3)) } : null,
        bottom: bottomCandidate ? { index: bottomCandidate.index, score: Number(bottomCandidate.score.toFixed(3)) } : null,
        left: leftCandidate ? { index: leftCandidate.index, score: Number(leftCandidate.score.toFixed(3)) } : null,
        right: rightCandidate ? { index: rightCandidate.index, score: Number(rightCandidate.score.toFixed(3)) } : null
      }
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
    const xPick = pickOutermostStrongDirectionalIndex(
      xFrom,
      xTo,
      Math.round(expectedX),
      (candidateX) => scoreOuterVerticalBoundaryAt(gray, width, height, candidateX, y - 10, y + 10, inwardDir),
      {
        distancePenalty: 0.56,
        outwardTarget: outwardTargetX,
        outwardBias,
        strongScoreRatio: 0.9,
        strongScoreMin: 84
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
        return { removable: false, distance: null, frameToGridGap: null, minRequiredGap: quarterGapLimit };
      }
      const distance = Math.abs(innerLine.index - outerLine.index);
      const frameToGridGap = followGridLine ? Math.abs(followGridLine.index - innerLine.index) : null;
      const minRequiredGap = Math.max(4, Math.floor(quarterGapLimit) + 1);
      const validOuterInnerDistance = distance >= minRequiredGap && distance <= Math.max(minRequiredGap + 16, searchSpan);
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
        minRequiredGap,
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
    const removableDistances = ['top', 'bottom', 'left', 'right']
      .map((key) => Number(removableSides[key]?.distance))
      .filter(Number.isFinite);
    const horizontalGapPair = [
      Number(removableSides.top?.distance),
      Number(removableSides.bottom?.distance)
    ].filter(Number.isFinite);
    const verticalGapPair = [
      Number(removableSides.left?.distance),
      Number(removableSides.right?.distance)
    ].filter(Number.isFinite);
    const marginConsistency = removableDistances.length === 4
      ? {
          minGap: Math.min(...removableDistances),
          maxGap: Math.max(...removableDistances),
          ratio: Math.max(...removableDistances) / Math.max(1, Math.min(...removableDistances))
        }
      : null;
    const pairConsistency = (
      horizontalGapPair.length === 2
      && verticalGapPair.length === 2
    )
      ? {
          horizontal: {
            minGap: Math.min(...horizontalGapPair),
            maxGap: Math.max(...horizontalGapPair),
            ratio: Math.max(...horizontalGapPair) / Math.max(1, Math.min(...horizontalGapPair)),
            delta: Math.abs(horizontalGapPair[0] - horizontalGapPair[1])
          },
          vertical: {
            minGap: Math.min(...verticalGapPair),
            maxGap: Math.max(...verticalGapPair),
            ratio: Math.max(...verticalGapPair) / Math.max(1, Math.min(...verticalGapPair)),
            delta: Math.abs(verticalGapPair[0] - verticalGapPair[1])
          }
        }
      : null;
    const innerFrameDetected = Boolean(
      nearInnerTop
      && nearInnerBottom
      && nearInnerLeft
      && nearInnerRight
      && nearInnerBottom.index > nearInnerTop.index
      && nearInnerRight.index > nearInnerLeft.index
    );
    const similarOuterInnerMargin = Boolean(
      innerFrameDetected
      && marginConsistency
      && marginConsistency.minGap > 0
      && marginConsistency.ratio <= 1.28
      && (marginConsistency.maxGap - marginConsistency.minGap) <= Math.max(12, Math.round(Math.min(estimatedCellGapX, estimatedCellGapY) * 0.15))
      && pairConsistency
      && pairConsistency.horizontal.ratio <= 1.18
      && pairConsistency.vertical.ratio <= 1.18
      && pairConsistency.horizontal.delta <= Math.max(10, Math.round(estimatedCellGapY * 0.12))
      && pairConsistency.vertical.delta <= Math.max(10, Math.round(estimatedCellGapX * 0.12))
    );
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
      && similarOuterInnerMargin
    );
    const hasRelaxedImmediateInnerFrame = hasImmediateInnerFrame;
    const structuralFrameConfirmed = (
      hasImmediateInnerFrame
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
          innerFrameDetected,
          hasImmediateInnerFrame,
          hasRelaxedImmediateInnerFrame,
          structuralFrameConfirmed,
          similarOuterInnerMargin,
          marginConsistency,
          pairConsistency
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
        top: nearInnerTop?.index ?? outerFrame.top,
        bottom: nearInnerBottom?.index ?? outerFrame.bottom,
        left: nearInnerLeft?.index ?? outerFrame.left,
        right: nearInnerRight?.index ?? outerFrame.right
      },
      requiredSideGaps: {
        top: removableSides.top.minRequiredGap,
        bottom: removableSides.bottom.minRequiredGap,
        left: removableSides.left.minRequiredGap,
        right: removableSides.right.minRequiredGap
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
    let innerEdgeProjection = null;
    const fallbackMargins = {
      top: Math.max(1, Math.round(Math.abs((nearInnerTop?.index ?? innerTop?.index ?? outerFrame.top) - outerFrame.top))),
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
      innerEdgeProjection = rectifiedCrop?.cropBox
        ? projectRectifiedCropBoxToSourceQuad(
          outerQuad,
          rectifiedMeta || rectifiedInfo,
          rectifiedCrop.cropBox
        )
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
        refinedOuterFrame: innerEdgeProjection?.bounds || {
          top: outerFrame.top,
          bottom: outerFrame.bottom,
          left: outerFrame.left,
          right: outerFrame.right
        },
        outerQuad: innerEdgeProjection?.quad || outerQuad,
        rectifiedOuterFrame: rectifiedMeta || null,
        croppedInnerFrame: rectifiedCrop?.cropBox || null,
        cropAspectRatio: Number.isFinite(cropAspectRatio) ? Number(cropAspectRatio.toFixed(4)) : null,
        structure: candidateStructure,
        structureScore: Number((candidate.structureScore || 0).toFixed(4)),
        candidateRankSummary,
        separation: separationCheck,
        detectedOuterBorder: {
          refinedOuterFrame: {
            top: outerFrame.top,
            bottom: outerFrame.bottom,
            left: outerFrame.left,
            right: outerFrame.right
          },
          outerQuad
        },
        innerEdgeAdjusted: Boolean(innerEdgeProjection?.quad),
        innerEdgeAdjustedFromRectifiedCrop: innerEdgeProjection
          ? {
              method: rectifiedCrop?.method || null,
              cropBox: rectifiedCrop?.cropBox || null,
              rectifiedTrims: innerEdgeProjection.rectifiedTrims || null
            }
          : null,
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

  const neutralPaperColor = estimateNeutralPaperColor(rgbData, info, {
    x0: width * 0.18,
    y0: height * 0.18,
    x1: width * 0.82,
    y1: height * 0.82
  });
  const cleaned = Buffer.from(rgbData);
  const band = 7;
  const fillNeutralPixel = (x, y) => {
    const px = clamp(x, 0, width - 1);
    const py = clamp(y, 0, height - 1);
    const offset = (py * width + px) * info.channels;
    cleaned[offset] = neutralPaperColor.r;
    cleaned[offset + 1] = neutralPaperColor.g;
    cleaned[offset + 2] = neutralPaperColor.b;
  };
  for (let y = topLine.index - band; y <= topLine.index + band; y += 1) {
    for (let x = leftLine.index - band; x <= rightLine.index + band; x += 1) {
      fillNeutralPixel(x, y);
    }
  }
  for (let y = bottomLine.index - band; y <= bottomLine.index + band; y += 1) {
    for (let x = leftLine.index - band; x <= rightLine.index + band; x += 1) {
      fillNeutralPixel(x, y);
    }
  }
  for (let x = leftLine.index - band; x <= leftLine.index + band; x += 1) {
    for (let y = topLine.index - band; y <= bottomLine.index + band; y += 1) {
      fillNeutralPixel(x, y);
    }
  }
  for (let x = rightLine.index - band; x <= rightLine.index + band; x += 1) {
    for (let y = topLine.index - band; y <= bottomLine.index + band; y += 1) {
      fillNeutralPixel(x, y);
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
    },
    neutralPaperColor
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
  const sideSearch = Math.max(10, Math.round(cellWidth * 0.14));
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
  const rawGuideHints = inferGridOuterBoundHints(
    options.rawGuides || null,
    cellWidth,
    cellHeight,
    info.width,
    info.height,
    {
      gridCols: Array.isArray(guides?.xPeaks) ? Math.max(1, guides.xPeaks.length - 1) : 0,
      gridRows: Array.isArray(guides?.yPeaks) ? Math.max(1, guides.yPeaks.length - 1) : 0
    }
  );
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
  const searchX = Math.max(6, Math.round(cellWidth * 0.16));
  const searchY = Math.max(6, Math.round(cellHeight * 0.28));
  const topSearchUpY = Math.max(searchY, Math.round(cellHeight * 0.58));
  const topSearchDownY = Math.max(4, Math.round(cellHeight * 0.08));
  const bottomSearchOutwardX = Math.max(8, Math.round(cellWidth * 0.14));
  const bottomSearchUpY = Math.max(6, Math.round(cellHeight * 0.08));
  const bottomSearchDownY = Math.max(10, Math.round(cellHeight * 0.42));
  const verticalSpan = Math.max(18, Math.round(cellHeight * 1.1));
  const horizontalSpan = Math.max(18, Math.round(cellWidth * 1.1));
  const globalGuidePattern = guides?.globalPattern || rawGuideHints?.diagnostics?.globalPattern || null;
  const overallGuidePattern = globalGuidePattern?.mode || rawGuideHints?.diagnostics?.overallPattern || 'mixed';
  const patternProfile = globalGuidePattern?.patternProfile || null;
  const profileSettings = patternProfile?.settings || null;
  const topGuideConfirmation = options.topGuideConfirmation || null;
  const confirmedTopGuideY = Number(topGuideConfirmation?.refinedTop);
  const leftBottomJointSupport = rawGuideHints?.diagnostics?.leftBottomJointSupport || null;
  const leftIntervalPriorityEvidence = buildInnerGridIntervalEvidence({
    firstGap: rawGuideHints?.diagnostics?.leftFirstGap,
    secondGap: rawGuideHints?.diagnostics?.leftSecondGap,
    medianGap: rawGuideHints?.medianXGap || cellWidth,
    stableRun: rawGuideHints?.diagnostics?.leftStableInnerRun,
    globalStableCount: rawGuideHints?.diagnostics?.xGlobalStableGapCount
  });
  const bottomIntervalPriorityEvidence = buildInnerGridIntervalEvidence({
    firstGap: rawGuideHints?.diagnostics?.bottomLastGap,
    secondGap: rawGuideHints?.diagnostics?.bottomPrevGap,
    medianGap: rawGuideHints?.medianYGap || cellHeight,
    stableRun: rawGuideHints?.diagnostics?.bottomStableInnerRun,
    globalStableCount: rawGuideHints?.diagnostics?.yGlobalStableGapCount
  });
  const leftBottomPriorityByInterval = Boolean(
    !options.outerFrameDetected
    && (
      (Number(leftIntervalPriorityEvidence?.pairConsistencyScore) || 0) >= 0.76
      || (Number(leftIntervalPriorityEvidence?.supportScore) || 0) >= 0.72
      || (Number(bottomIntervalPriorityEvidence?.pairConsistencyScore) || 0) >= 0.82
      || (Number(bottomIntervalPriorityEvidence?.supportScore) || 0) >= 0.78
    )
  );
  const leftBottomPriorityByOuterFrame = Boolean(
    options.outerFrameDetected
    && (
      (
        leftBottomJointSupport?.eligibilityMode === 'soft-high-score'
        && (Number(leftBottomJointSupport?.leftGapScore) || 0) >= 0.72
        && (Number(leftBottomJointSupport?.bottomGapScore) || 0) >= 0.55
        && (Number(leftBottomJointSupport?.continuityScore) || 0) >= 0.88
      )
      || (
        (Number(leftBottomJointSupport?.score) || 0) >= 0.84
        && (Number(leftBottomJointSupport?.leftGapScore) || 0) >= 0.82
        && (Number(leftBottomJointSupport?.bottomGapScore) || 0) >= 0.62
        && (Number(leftBottomJointSupport?.continuityScore) || 0) >= 0.9
      )
    )
  );
  const leftBottomPriorityMode = (
    options.forceLeftBottomPriority
    || Boolean(profileSettings?.preferLeftBottomTraversal)
    || leftBottomPriorityByInterval
    || leftBottomPriorityByOuterFrame
    || (
      !options.outerFrameDetected
      && (
      overallGuidePattern === 'uniform-cells-with-inner-dashed'
      || overallGuidePattern === 'uniform-boundary-grid'
      || overallGuidePattern === 'mixed'
      )
    )
  );
  const cornerSpecMap = {
    leftTop: { name: 'leftTop', index: 0, xDir: 1, yDir: 1 },
    rightTop: { name: 'rightTop', index: 1, xDir: -1, yDir: 1 },
    rightBottom: { name: 'rightBottom', index: 2, xDir: -1, yDir: -1 },
    leftBottom: { name: 'leftBottom', index: 3, xDir: 1, yDir: -1 }
  };
  const cornerSpecs = leftBottomPriorityMode
    ? [
        cornerSpecMap.leftBottom,
        cornerSpecMap.leftTop,
        cornerSpecMap.rightBottom,
        cornerSpecMap.rightTop
      ]
    : [
        cornerSpecMap.leftTop,
        cornerSpecMap.rightTop,
        cornerSpecMap.rightBottom,
        cornerSpecMap.leftBottom
      ];

  let refinedCorners = [...quad];
  const diagnostics = {};
  const resolvedCornerByName = {};
  const innerFrameOutwardClampX = Math.max(8, Math.round(cellWidth * 0.03));
  const innerFrameInwardClampX = Math.max(24, Math.round(cellWidth * 0.16));
  const preferTightTopWindow = Boolean(
    leftBottomPriorityMode
    && !options.outerFrameDetected
    && (
      patternProfile?.family === 'inner-dashed-box-grid'
      || patternProfile?.family === 'diagonal-mi-grid'
      || overallGuidePattern === 'uniform-boundary-grid'
      || overallGuidePattern === 'uniform-cells-with-inner-dashed'
    )
  );
  const innerFrameTopClampUp = preferTightTopWindow ? 4 : Math.max(6, Math.round(cellHeight * 0.035));
  const innerFrameTopClampDown = preferTightTopWindow ? 4 : Math.max(10, Math.round(cellHeight * 0.06));
  const innerFrameBottomClampUp = Math.max(10, Math.round(cellHeight * 0.08));
  const innerFrameBottomClampDown = Math.max(18, Math.round(cellHeight * 0.1));
  const resolveCornerExpected = (spec) => {
    const baseExpected = quad[spec.index] || [0, 0];
    let expectedX = Number(baseExpected[0]);
    let expectedY = Number(baseExpected[1]);
    let source = 'input-quad';
    if (!leftBottomPriorityMode) {
      return { expectedX, expectedY, source };
    }
    if (spec.name === 'leftBottom') {
      expectedX = Number.isFinite(guideLeft) ? guideLeft : expectedX;
      expectedY = Number.isFinite(guideBottom) ? guideBottom : expectedY;
      source = 'left-bottom-guides';
    } else if (spec.name === 'leftTop') {
      expectedX = Number.isFinite(resolvedCornerByName.leftBottom?.[0])
        ? Number(resolvedCornerByName.leftBottom[0])
        : (Number.isFinite(guideLeft) ? guideLeft : expectedX);
      expectedY = Number.isFinite(confirmedTopGuideY)
        ? confirmedTopGuideY
        : (Number.isFinite(guideTop) ? guideTop : expectedY);
      source = Number.isFinite(resolvedCornerByName.leftBottom?.[0])
        ? 'left-bottom-propagated-left-side'
        : 'left-guide-top-guide';
    } else if (spec.name === 'rightBottom') {
      const preferGuideAnchoredRightBottom = (
        leftBottomPriorityMode
        && !options.outerFrameDetected
        && Number.isFinite(guideRight)
      );
      expectedX = preferGuideAnchoredRightBottom
        ? guideRight
        : (Number.isFinite(guideRight) ? guideRight : expectedX);
      expectedY = Number.isFinite(resolvedCornerByName.leftBottom?.[1])
        ? Number(resolvedCornerByName.leftBottom[1])
        : (Number.isFinite(guideBottom) ? guideBottom : expectedY);
      source = preferGuideAnchoredRightBottom
        ? 'right-guide-bottom-guide-preferred'
        : (
          Number.isFinite(resolvedCornerByName.leftBottom?.[1])
            ? 'left-bottom-propagated-bottom-side'
            : 'right-guide-bottom-guide'
        );
    } else if (spec.name === 'rightTop') {
      const preferGuideAnchoredRightTop = (
        preferTightTopWindow
        && !options.outerFrameDetected
        && Number.isFinite(guideRight)
      );
      expectedX = preferGuideAnchoredRightTop
        ? guideRight
        : (
          Number.isFinite(resolvedCornerByName.rightBottom?.[0])
            ? Number(resolvedCornerByName.rightBottom[0])
            : (Number.isFinite(guideRight) ? guideRight : expectedX)
        );
      expectedY = Number.isFinite(resolvedCornerByName.leftTop?.[1])
        ? Number(resolvedCornerByName.leftTop[1])
        : (
          Number.isFinite(confirmedTopGuideY)
            ? confirmedTopGuideY
            : (Number.isFinite(guideTop) ? guideTop : expectedY)
        );
      source = preferGuideAnchoredRightTop
        ? 'right-guide-top-guide-preferred'
        : (
          (
            Number.isFinite(resolvedCornerByName.rightBottom?.[0])
            || Number.isFinite(resolvedCornerByName.leftTop?.[1])
          )
            ? 'left-bottom-propagated-rectangle'
            : 'right-guide-top-guide'
        );
    }
    return { expectedX, expectedY, source };
  };

  for (const spec of cornerSpecs) {
    const expected = quad[spec.index];
    const resolvedExpected = resolveCornerExpected(spec);
    const expectedX = resolvedExpected.expectedX;
    const expectedY = resolvedExpected.expectedY;
    const isBottomCorner = spec.yDir < 0;
    const isTopCorner = spec.yDir > 0;
    const leftBottomSearchBoost = leftBottomPriorityMode && spec.name === 'leftBottom' ? 1.4 : 1;
    const topWindowX = preferTightTopWindow && isTopCorner
      ? Math.max(18, Math.round(searchX * 0.55))
      : searchX;
    const topWindowUp = preferTightTopWindow && isTopCorner
      ? Math.max(16, Math.round(topSearchUpY * 0.4))
      : topSearchUpY;
    const topWindowDown = preferTightTopWindow && isTopCorner
      ? Math.max(8, Math.round(topSearchDownY * 0.55))
      : topSearchDownY;
    const rightTopOutwardSearch = (
      spec.name === 'rightTop'
      && preferTightTopWindow
      && !options.outerFrameDetected
      && Number.isFinite(guideRight)
    ) ? Math.max(12, Math.round(cellWidth * 0.12)) : 0;
    const xSearchStart = clamp(
      isBottomCorner
        ? (expectedX - bottomSearchOutwardX * leftBottomSearchBoost)
        : (
          spec.xDir > 0
            ? expectedX
            : (expectedX - topWindowX)
        ),
      0,
      Math.max(0, info.width - 1)
    );
    const xSearchEnd = clamp(
      isBottomCorner
        ? (expectedX + bottomSearchOutwardX * leftBottomSearchBoost)
        : (
          spec.xDir > 0
            ? (expectedX + topWindowX)
            : (expectedX + rightTopOutwardSearch)
        ),
      0,
      Math.max(0, info.width - 1)
    );
    const ySearchStart = clamp(
      isBottomCorner
        ? (expectedY - bottomSearchUpY * leftBottomSearchBoost)
        : (spec.yDir > 0 ? (expectedY - topWindowUp) : (expectedY - searchY)),
      0,
      Math.max(0, info.height - 1)
    );
    const ySearchEnd = clamp(
      isBottomCorner
        ? (expectedY + bottomSearchDownY * leftBottomSearchBoost)
        : (spec.yDir > 0 ? (expectedY + topWindowDown) : expectedY),
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
      const keepRightBottomNearGuide = (
        spec.name === 'rightBottom'
        && leftBottomPriorityMode
        && !options.outerFrameDetected
        && Number.isFinite(guideRight)
      );
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
        let anchoredPoint = [bottomAnchor.x, bottomAnchor.y];
        if (keepRightBottomNearGuide) {
          const outwardTolerance = Math.max(8, Math.round(cellWidth * 0.035));
          const inwardTolerance = Math.max(8, Math.round(cellWidth * 0.03));
          anchoredPoint = [
            clamp(anchoredPoint[0], guideRight - inwardTolerance, guideRight + outwardTolerance),
            anchoredPoint[1]
          ];
        }
        refinedPoint = anchoredPoint;
        xScore = Math.max(xScore, bottomAnchor.score * 0.72);
        yScore = Math.max(yScore, bottomAnchor.score * 0.72);
        bottomCornerAnchor.afterClamp = [...refinedPoint];
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

    if (leftBottomPriorityMode) {
      if ((spec.name === 'leftBottom' || spec.name === 'leftTop') && Number.isFinite(guideLeft)) {
        refinedPoint = [
          clamp(refinedPoint[0], guideLeft - innerFrameOutwardClampX, guideLeft + innerFrameInwardClampX),
          refinedPoint[1]
        ];
      }
      if ((spec.name === 'rightBottom' || spec.name === 'rightTop') && Number.isFinite(guideRight)) {
        refinedPoint = [
          clamp(refinedPoint[0], guideRight - innerFrameInwardClampX, guideRight + innerFrameOutwardClampX),
          refinedPoint[1]
        ];
      }
      if (isTopCorner && Number.isFinite(guideTop) && preferTightTopWindow) {
        const topClampBaseY = Number.isFinite(confirmedTopGuideY) ? confirmedTopGuideY : guideTop;
        refinedPoint = [
          refinedPoint[0],
          clamp(refinedPoint[1], topClampBaseY - innerFrameTopClampUp, topClampBaseY + innerFrameTopClampDown)
        ];
      }
      if (isBottomCorner && Number.isFinite(guideBottom)) {
        refinedPoint = [
          refinedPoint[0],
          clamp(refinedPoint[1], guideBottom - innerFrameBottomClampUp, guideBottom + innerFrameBottomClampDown)
        ];
      }
    }

    let topGuideAdjusted = null;
    const coarseTopGuideY = Number(coarseGuideBounds?.top);
    if (
      isTopCorner
      && preferTightTopWindow
      && Number.isFinite(confirmedTopGuideY)
      && Number.isFinite(coarseTopGuideY)
      && Math.abs(coarseTopGuideY - confirmedTopGuideY) <= Math.max(12, Math.round(cellHeight * 0.18))
      && !options.outerFrameDetected
    ) {
      const topGuideSnapTolerance = Math.max(8, Math.round(cellHeight * 0.045));
      const beforeY = refinedPoint[1];
      const deltaToConfirmedTop = Math.abs(beforeY - confirmedTopGuideY);
      if (deltaToConfirmedTop <= topGuideSnapTolerance) {
        refinedPoint = [refinedPoint[0], confirmedTopGuideY];
        topGuideAdjusted = {
          beforeY,
          afterY: confirmedTopGuideY,
          delta: Number(deltaToConfirmedTop.toFixed(3)),
          tolerance: topGuideSnapTolerance,
          applied: beforeY !== confirmedTopGuideY
        };
      } else {
        topGuideAdjusted = {
          beforeY,
          afterY: beforeY,
          delta: Number(deltaToConfirmedTop.toFixed(3)),
          tolerance: topGuideSnapTolerance,
          applied: false
        };
      }
    }

    const cornerScore = (xScore + yScore) / 2;

    refinedCorners[spec.index] = refinedPoint;
    diagnostics[spec.name] = {
      expected: [expectedX, expectedY],
      refined: refinedPoint,
      cornerScore: Number((cornerScore || 0).toFixed(3)),
      mode: 'local-axis-line-search',
      expectedSource: resolvedExpected.source,
      traversalMode: leftBottomPriorityMode ? 'left-bottom-first' : 'default-sequential',
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
      topGuideAdjusted,
      bottomCornerAnchor,
      bottomCornerConfirmation
    };
    resolvedCornerByName[spec.name] = refinedPoint;
  }

  refinedCorners = applyVerticalSideConsistency(refinedCorners, diagnostics, {
    enabled: leftBottomPriorityMode && !options.outerFrameDetected,
    guideLeft,
    guideRight,
    cellWidth
  });
  refinedCorners = applyVerticalSideTiltConsistency(refinedCorners, diagnostics, {
    enabled: leftBottomPriorityMode && !options.outerFrameDetected,
    coarseVerticalEndpoints: coarseGuideBounds?.diagnostics?.verticalEndpoints || null,
    guideLeft,
    guideRight,
    cellWidth
  });

  let normalizedRefined = normalizeCornerQuad(refinedCorners);
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
  const localTopBandY = average(
    [normalizedRefined?.[0]?.[1], normalizedRefined?.[1]?.[1]]
      .map(Number)
      .filter(Number.isFinite)
  );
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
  const topBandTooDeepVsLocal = (
    Number.isFinite(preferredTopBandY)
    && Number.isFinite(localTopBandY)
    && preferredTopBandY > localTopBandY + Math.max(22, cellHeight * 0.3)
  );
  if (topBandTooDeepVsLocal && topContinuityWeak) {
    const topBandFallbackCandidates = [
      localTopBandY,
      coarseVerticalEndpointTopY,
      coarseTopY
    ].filter((value) => Number.isFinite(value) && value <= preferredTopBandY);
    const fallbackTopBandY = topBandFallbackCandidates.length
      ? Math.min(...topBandFallbackCandidates)
      : localTopBandY;
    if (Number.isFinite(fallbackTopBandY)) {
      preferredTopBandY = fallbackTopBandY;
    }
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
  const sideAnchorXTolerance = Math.max(18, Math.round(cellWidth * 0.08));
  const localLeftTopX = Number(normalizedRefined?.[0]?.[0]);
  const localLeftBottomX = Number(normalizedRefined?.[3]?.[0]);
  const localRightTopX = Number(normalizedRefined?.[1]?.[0]);
  const localRightBottomX = Number(normalizedRefined?.[2]?.[0]);
  if (effectiveLeftTopAnchor && Number.isFinite(localLeftTopX)) {
    effectiveLeftTopAnchor = [
      clamp(effectiveLeftTopAnchor[0], localLeftTopX - sideAnchorXTolerance, localLeftTopX + sideAnchorXTolerance),
      effectiveLeftTopAnchor[1]
    ];
  }
  let adjustedLeftBottomAnchor = effectiveLeftBottomAnchor;
  if (adjustedLeftBottomAnchor && Number.isFinite(localLeftBottomX)) {
    adjustedLeftBottomAnchor = [
      clamp(adjustedLeftBottomAnchor[0], localLeftBottomX - sideAnchorXTolerance, localLeftBottomX + sideAnchorXTolerance),
      adjustedLeftBottomAnchor[1]
    ];
  }
  if (effectiveRightTopAnchor && Number.isFinite(localRightTopX)) {
    effectiveRightTopAnchor = [
      clamp(effectiveRightTopAnchor[0], localRightTopX - sideAnchorXTolerance, localRightTopX + sideAnchorXTolerance),
      effectiveRightTopAnchor[1]
    ];
  }
  let adjustedRightBottomAnchor = effectiveRightBottomAnchor;
  if (adjustedRightBottomAnchor && Number.isFinite(localRightBottomX)) {
    adjustedRightBottomAnchor = [
      clamp(adjustedRightBottomAnchor[0], localRightBottomX - sideAnchorXTolerance, localRightBottomX + sideAnchorXTolerance),
      adjustedRightBottomAnchor[1]
    ];
  }
  const sideHardClampTolerance = Math.max(10, Math.round(cellWidth * 0.05));
  const sideHardClampOutwardFlex = Math.max(8, Math.round(cellWidth * 0.03));
  const leftHintUsable = Number.isFinite(guideLeft);
  const rightHintUsable = Number.isFinite(guideRight);
  if (leftHintUsable && effectiveLeftTopAnchor) {
    effectiveLeftTopAnchor = [
      clamp(effectiveLeftTopAnchor[0], guideLeft - sideHardClampOutwardFlex, guideLeft + sideHardClampTolerance),
      effectiveLeftTopAnchor[1]
    ];
  }
  if (leftHintUsable && adjustedLeftBottomAnchor) {
    adjustedLeftBottomAnchor = [
      clamp(adjustedLeftBottomAnchor[0], guideLeft - sideHardClampOutwardFlex, guideLeft + sideHardClampTolerance),
      adjustedLeftBottomAnchor[1]
    ];
  }
  if (rightHintUsable && effectiveRightTopAnchor) {
    effectiveRightTopAnchor = [
      clamp(effectiveRightTopAnchor[0], guideRight - sideHardClampTolerance, guideRight + sideHardClampOutwardFlex),
      effectiveRightTopAnchor[1]
    ];
  }
  if (rightHintUsable && adjustedRightBottomAnchor) {
    adjustedRightBottomAnchor = [
      clamp(adjustedRightBottomAnchor[0], guideRight - sideHardClampTolerance, guideRight + sideHardClampOutwardFlex),
      adjustedRightBottomAnchor[1]
    ];
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
  const topProjectionXGuardTolerance = Math.max(18, Math.round(cellWidth * 0.08));
  let guardedProjectedTopLeftAnchor = projectedTopLeftAnchor;
  let guardedProjectedTopRightAnchor = projectedTopRightAnchor;
  const topBandShouldYieldToSideAnchors = topContinuityWeak || (edgeLineQuality.top.confidence ?? 0) < 0.78;
  if (
    topBandShouldYieldToSideAnchors
    && guardedProjectedTopLeftAnchor
    && effectiveLeftTopAnchor
    && Math.abs(guardedProjectedTopLeftAnchor[0] - effectiveLeftTopAnchor[0]) > topProjectionXGuardTolerance
  ) {
    guardedProjectedTopLeftAnchor = null;
  }
  if (
    topBandShouldYieldToSideAnchors
    && guardedProjectedTopRightAnchor
    && effectiveRightTopAnchor
    && Math.abs(guardedProjectedTopRightAnchor[0] - effectiveRightTopAnchor[0]) > topProjectionXGuardTolerance
  ) {
    guardedProjectedTopRightAnchor = null;
  }
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
    projectedTopLeftAnchor: guardedProjectedTopLeftAnchor,
    projectedTopRightAnchor: guardedProjectedTopRightAnchor,
    projectedBottomLeftAnchor,
    projectedBottomRightAnchor
  });
  const safeProjectedTopLeftAnchor = initialGuard.rejectProjectedTopAnchors ? null : guardedProjectedTopLeftAnchor;
  const safeProjectedTopRightAnchor = initialGuard.rejectProjectedTopAnchors ? null : guardedProjectedTopRightAnchor;
  const safeProjectedBottomLeftAnchor = initialGuard.rejectProjectedBottomAnchors ? null : projectedBottomLeftAnchor;
  const safeProjectedBottomRightAnchor = initialGuard.rejectProjectedBottomAnchors ? null : projectedBottomRightAnchor;
  const preferredTopLeftAnchor = topBandShouldYieldToSideAnchors
    ? (effectiveLeftTopAnchor || safeProjectedTopLeftAnchor || topLeftAnchor)
    : (safeProjectedTopLeftAnchor || topLeftAnchor || effectiveLeftTopAnchor);
  const preferredTopRightAnchor = topBandShouldYieldToSideAnchors
    ? (effectiveRightTopAnchor || safeProjectedTopRightAnchor || topRightAnchor)
    : (safeProjectedTopRightAnchor || topRightAnchor || effectiveRightTopAnchor);
  normalizedRefined = applyHorizontalTiltConsistency(normalizedRefined, diagnostics, {
    enabled: true,
    leftBottomPriorityMode,
    outerFrameDetected: Boolean(options.outerFrameDetected),
    preferredTopLeftAnchor,
    preferredTopRightAnchor,
    preferredBottomLeftAnchor: safeProjectedBottomLeftAnchor || bottomLeftAnchor || adjustedLeftBottomAnchor,
    preferredBottomRightAnchor: safeProjectedBottomRightAnchor || bottomRightAnchor || adjustedRightBottomAnchor,
    guideLeft,
    guideRight,
    cellWidth,
    cellHeight
  });
  const dominantTopLine = buildLineFromEndAnchors(
    preferredTopLeftAnchor,
    preferredTopRightAnchor,
    topLine
  ) || topLine;
  const dominantBottomLine = buildLineFromEndAnchors(
    safeProjectedBottomLeftAnchor || bottomLeftAnchor || adjustedLeftBottomAnchor,
    safeProjectedBottomRightAnchor || bottomRightAnchor || adjustedRightBottomAnchor,
    extremeBottomPoints.length ? shiftLineToPoints(bottomLine, extremeBottomPoints) : bottomLine
  ) || (extremeBottomPoints.length ? shiftLineToPoints(bottomLine, extremeBottomPoints) : bottomLine);
  const endAnchoredLeftLine = buildLineFromEndAnchors(effectiveLeftTopAnchor, adjustedLeftBottomAnchor, leftLine) || leftLine;
  const endAnchoredRightLine = buildLineFromEndAnchors(effectiveRightTopAnchor, adjustedRightBottomAnchor, rightLine) || rightLine;
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
  preferredTopBandY = resolveWeakTopBandPreference({
    preferredTopBandY,
    localTopBandY: Number(finalGuard?.localTopBandY),
    coarseTopY,
    coarseVerticalEndpointTopY,
    topContinuityWeak,
    cellHeight
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
  const consistencyAdjustment = computeConsistencyAdjustmentDiagnostics(diagnostics);
  const consistencyAdjustmentSignals = consistencyAdjustment.signals;
  const consistencyAdjustmentScore = consistencyAdjustment.score;
  const edgeConfidence = average([
    edgeLineQuality.top.confidence,
    edgeLineQuality.bottom.confidence,
    edgeLineQuality.left.confidence,
    edgeLineQuality.right.confidence
  ].filter((value) => Number.isFinite(value)));
  const localInnerGridSupportPreview = evaluateInnerGridSupportFromRawHints(
    normalizedRefined,
    rawGuideHints,
    {
      cellWidth,
      cellHeight
    }
  );
  const dominantInnerGridSupportPreview = edgeQuad
    ? evaluateInnerGridSupportFromRawHints(
      edgeQuad,
      rawGuideHints,
      {
        cellWidth,
        cellHeight
      }
    )
    : null;
  const suppressDominantDirectBypass = (
    !options.outerFrameDetected
    && overallGuidePattern === 'uniform-cells-with-inner-dashed'
  );
  let finalRefined = normalizedRefined;
  let outputSource = 'local-corner-fallback';
  let dominantBoundaryRole = 'inner-frame';
  let quadSelectionDiagnostics = null;
  if (dominantLineReady && !suppressDominantDirectBypass) {
    finalRefined = stabilizeQuadGeometry(edgeQuad, { blend: 0.32 }) || edgeQuad;
    outputSource = 'dominant-edge-lines';
    dominantBoundaryRole = options.outerFrameDetected ? 'outer-frame' : 'inner-frame';
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
    const wholeCornerConsistencyQuad = fitQuadToWholeCornerConsistency(localStabilizedQuad, { blend: 0.78 }) || localStabilizedQuad;
    const uncertaintyRetainedQuad = blendQuadByCornerStability(
      normalizedRefined,
      edgeStabilizedQuad,
      perCornerConfidence,
      cornerWeights,
      { maxShift: Math.max(28, Math.round(cellHeight * 0.32)), minBlend: 0.03, maxBlend: 0.82 }
    ) || mergedQuad;
    const supportAlignedQuad = buildSupportAlignedGuideQuad(rawGuideHints, info.width, info.height, {
      referenceQuad: normalizedRefined,
      cornerDiagnostics: diagnostics
    });
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
    const selectiveWholeCornerConsistencyQuad = fitQuadToWholeCornerConsistency(
      selectiveReplacementQuad || uncertaintyRetainedQuad || localStabilizedQuad,
      { blend: 0.82 }
    ) || selectiveReplacementQuad || uncertaintyRetainedQuad || localStabilizedQuad;
    const topAnchorBandAlignedQuad = buildTopAnchorBandAlignedQuad(
      selectiveWholeCornerConsistencyQuad,
      {
        preferredTopLeftAnchor,
        preferredTopRightAnchor,
        preferredTopBandY,
        cellHeight,
        topContinuity: edgeLineQuality.top.continuity || null
      }
    ) || null;
    const candidateEntries = buildQuadCandidateEntries({
      normalizedRefined,
      localCornerConfidence,
      consistencyAdjustmentScore,
      edgeQuad,
      edgeConfidence,
      localStabilizedQuad,
      edgeStabilizedQuad,
      wholeCornerConsistencyQuad,
      selectiveWholeCornerConsistencyQuad,
      topAnchorBandAlignedQuad,
      uncertaintyRetainedQuad,
      supportAlignedQuad,
      selectiveReplacementQuad,
      mergedQuad,
      cellHeight
    });

    const scoredCandidates = scoreQuadCandidates(candidateEntries, {
      guides,
      rawGuideHints,
      cellWidth,
      cellHeight,
      edgeLineInputs,
      gray,
      imageWidth: info.width,
      imageHeight: info.height,
      normalizedRefined,
      perCornerConfidence,
      preferredTopBandY,
      preferredBottomBandY
    });
    const {
      bestCandidate,
      overrideReason
    } = selectBestQuadCandidate(scoredCandidates, {
      cellHeight,
      patternProfile,
      outerFrameDetected: options.outerFrameDetected
    });
    if (bestCandidate?.quad) {
      finalRefined = bestCandidate.quad;
      outputSource = bestCandidate.name;
      dominantBoundaryRole = bestCandidate.name.startsWith('dominant-edge')
        ? (options.outerFrameDetected ? 'outer-frame' : 'inner-frame')
        : 'inner-frame';
    } else {
      finalRefined = mergedQuad;
      dominantBoundaryRole = 'inner-frame';
    }
    quadSelectionDiagnostics = {
      localCornerConfidence: Number((localCornerConfidence || 0).toFixed(3)),
      consistencyAdjustmentScore: Number((consistencyAdjustmentScore || 0).toFixed(3)),
      edgeConfidence: Number((edgeConfidence || 0).toFixed(3)),
      winner: outputSource,
      winnerSemanticRole: dominantBoundaryRole,
      overrideReason,
      selectiveCornerReplacement: selectiveCornerReplacement?.replacements || null,
      candidates: scoredCandidates.map((entry) => ({
        name: entry.name,
        totalScore: Number((entry.totalScore || 0).toFixed(4)),
        supportScore: Number((entry.supportScore || 0).toFixed(4)),
        rectangleScore: Number((entry.rectangularity?.score || 0).toFixed(4)),
        innerGridSupportScore: Number((entry.innerGridSupport?.supportScore || 0).toFixed(4)),
        innerGridSupportEligible: Boolean(entry.innerGridSupport?.eligible),
        innerGridSupportEligibleCount: Number(entry.innerGridSupport?.eligibleCount || 0),
        edgeInkScore: Number((entry.edgeInkQuality?.overallConfidence || 0).toFixed(4)),
        edgeDarknessScore: Number((entry.edgeInkQuality?.overallDarkness || 0).toFixed(4)),
        weakestEdge: entry.edgeInkQuality?.weakestEdge || null,
        structuralMinEdgeScore: Number((entry.edgeInkQuality?.structuralMinConfidence || 0).toFixed(4)),
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
        midpointGap: Number((entry.rectangularity?.midpointGap || 0).toFixed(3)),
        innerGridSupport: entry.innerGridSupport?.sides || null
      }))
    };
  }

  const collapsedTopSpanProtection = protectCollapsedTopSpan(
    finalRefined,
    diagnostics,
    guides,
    { cellWidth }
  );
  if (collapsedTopSpanProtection?.applied && collapsedTopSpanProtection?.corners) {
    finalRefined = collapsedTopSpanProtection.corners;
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
      outputFrameRole: 'inner-frame',
      dominantBoundaryRole,
      globalPattern: globalGuidePattern,
      patternProfile,
      cornerTraversalMode: leftBottomPriorityMode ? 'left-bottom-first' : 'default-sequential',
      leftBottomPriorityByOuterFrame,
      leftBottomPriorityByInterval,
      leftBottomIntervalPriorityEvidence: leftIntervalPriorityEvidence,
      bottomIntervalPriorityEvidence,
      cornerTraversalOrder: cornerSpecs.map((spec) => spec.name),
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
        dominantDirectBypassSuppressed: Boolean(suppressDominantDirectBypass),
        dominantDirectBypassReason: suppressDominantDirectBypass
          ? 'uniform-cells-with-inner-dashed-without-outer-frame-must-pass-inner-grid-candidate-check'
          : null,
        overallGuidePattern,
        globalPattern: globalGuidePattern,
        cornerTraversalMode: leftBottomPriorityMode ? 'left-bottom-first' : 'default-sequential',
        leftBottomJointSupport,
        dominantBoundaryRole,
        consistencyAdjustmentScore: Number((consistencyAdjustmentScore || 0).toFixed(3)),
        consistencyAdjustmentSignals: consistencyAdjustment.perCorner,
        innerGridSupportPreview: {
          local: localInnerGridSupportPreview,
          dominant: dominantInnerGridSupportPreview
        },
        quadSelection: quadSelectionDiagnostics,
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
          left: preferredTopLeftAnchor ? preferredTopLeftAnchor.map((value) => Number(value.toFixed(3))) : null,
          right: preferredTopRightAnchor ? preferredTopRightAnchor.map((value) => Number(value.toFixed(3))) : null
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
          bottom: adjustedLeftBottomAnchor ? adjustedLeftBottomAnchor.map((value) => Number(value.toFixed(3))) : null
        },
        dominantRightAnchors: {
          top: effectiveRightTopAnchor ? effectiveRightTopAnchor.map((value) => Number(value.toFixed(3))) : null,
          bottom: adjustedRightBottomAnchor ? adjustedRightBottomAnchor.map((value) => Number(value.toFixed(3))) : null
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
        }
      },
      quadSelectionDiagnostics,
      collapsedTopSpanProtection: collapsedTopSpanProtection?.diagnostics || null,
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

  const expandedBounds = expandGuideBounds(guideMaskInfo, width, height, options);
  if (!expandedBounds) {
    return null;
  }

  return buildGuideMask(
    width,
    height,
    {
      ...expandedBounds,
      xPeaks: guideMaskInfo.xPeaks,
      yPeaks: guideMaskInfo.yPeaks
    },
    Math.max(1, guideMaskInfo.yPeaks.length - 1),
    Math.max(1, guideMaskInfo.xPeaks.length - 1)
  );
}

function expandGuideBounds(guideMaskInfo, width, height, options = {}) {
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

  return {
    left: clamp(guideMaskInfo.left - padLeft, 0, width),
    right: clamp(guideMaskInfo.right + padRight, 0, width),
    top: clamp(guideMaskInfo.top - padTop, 0, height),
    bottom: clamp(guideMaskInfo.bottom + padBottom, 0, height)
  };
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

function estimateNeutralPaperColor(rgbData, info, options = {}) {
  if (!rgbData || !info || !info.width || !info.height || !info.channels) {
    return {
      ...DEFAULT_NEUTRAL_PAPER_COLOR,
      sampleCount: 0
    };
  }

  const width = Math.max(1, Number(info.width) || 0);
  const height = Math.max(1, Number(info.height) || 0);
  const channels = Math.max(3, Number(info.channels) || 3);
  const excludeMask = options.excludeMask || null;
  const x0 = clamp(
    Math.floor(Number.isFinite(options.x0) ? Number(options.x0) : 0),
    0,
    Math.max(0, width - 1)
  );
  const y0 = clamp(
    Math.floor(Number.isFinite(options.y0) ? Number(options.y0) : 0),
    0,
    Math.max(0, height - 1)
  );
  const x1 = clamp(
    Math.ceil(Number.isFinite(options.x1) ? Number(options.x1) : width),
    x0 + 1,
    width
  );
  const y1 = clamp(
    Math.ceil(Number.isFinite(options.y1) ? Number(options.y1) : height),
    y0 + 1,
    height
  );
  const minGray = Number.isFinite(options.minGray) ? Number(options.minGray) : 168;
  const maxGray = Number.isFinite(options.maxGray) ? Number(options.maxGray) : 245;
  const maxColorSpan = Number.isFinite(options.maxColorSpan) ? Number(options.maxColorSpan) : 34;
  const stride = Math.max(1, Math.round(Math.min(width, height) / 420));
  const centerX = (x0 + x1 - 1) / 2;
  const centerY = (y0 + y1 - 1) / 2;
  const centerScaleX = Math.max(1, (x1 - x0) / 2);
  const centerScaleY = Math.max(1, (y1 - y0) / 2);
  const candidates = [];
  const relaxedCandidates = [];

  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const index = y * width + x;
      if (excludeMask && excludeMask[index]) {
        continue;
      }
      const offset = index * channels;
      const r = rgbData[offset];
      const g = rgbData[offset + 1];
      const b = rgbData[offset + 2];
      const gray = (0.299 * r) + (0.587 * g) + (0.114 * b);
      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      const colorSpan = maxChannel - minChannel;
      if (gray < 145 || gray > 250) {
        continue;
      }
      const normalizedDx = Math.abs(x - centerX) / centerScaleX;
      const normalizedDy = Math.abs(y - centerY) / centerScaleY;
      const centerPenalty = ((normalizedDx * normalizedDx) + (normalizedDy * normalizedDy)) * 7;
      const candidate = {
        r,
        g,
        b,
        gray,
        colorSpan,
        score: gray - (colorSpan * 1.9) - centerPenalty
      };
      if (gray >= minGray && gray <= maxGray && colorSpan <= maxColorSpan) {
        candidates.push(candidate);
      } else if (gray >= 152 && gray <= 248 && colorSpan <= maxColorSpan + 18) {
        relaxedCandidates.push(candidate);
      }
    }
  }

  let selected = candidates;
  let relaxed = false;
  if (selected.length < 24) {
    selected = candidates.concat(relaxedCandidates);
    relaxed = true;
  }
  if (selected.length < 12) {
    return {
      ...DEFAULT_NEUTRAL_PAPER_COLOR,
      sampleCount: 0
    };
  }

  selected.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.gray !== left.gray) {
      return right.gray - left.gray;
    }
    return left.colorSpan - right.colorSpan;
  });
  const sampleCount = Math.min(
    320,
    Math.max(
      relaxed ? 24 : 20,
      Math.round(selected.length * (relaxed ? 0.18 : 0.14))
    ),
    selected.length
  );
  const shortlisted = selected.slice(0, sampleCount).sort((left, right) => left.gray - right.gray);
  const trimCount = shortlisted.length >= 8 ? Math.max(1, Math.floor(shortlisted.length * 0.12)) : 0;
  const trimmed = trimCount > 0
    ? shortlisted.slice(trimCount, shortlisted.length - trimCount)
    : shortlisted;
  const usable = trimmed.length ? trimmed : shortlisted;
  const r = clamp(Math.round(median(usable.map((item) => item.r))), 176, 232);
  const g = clamp(Math.round(median(usable.map((item) => item.g))), 176, 232);
  const b = clamp(Math.round(median(usable.map((item) => item.b))), 176, 232);

  return {
    r,
    g,
    b,
    gray: clamp(Math.round((r * 0.299) + (g * 0.587) + (b * 0.114)), 176, 232),
    sampleCount: usable.length
  };
}

function buildNeutralGuideRemovedRgb(rgbData, blurredRgbData, info, guideMaskInfo) {
  if (!guideMaskInfo) {
    return Buffer.from(rgbData);
  }

  const { mask } = guideMaskInfo;
  const output = Buffer.from(rgbData);
  const neutralPaperColor = estimateNeutralPaperColor(blurredRgbData, info, {
    excludeMask: mask,
    x0: info.width * 0.12,
    y0: info.height * 0.08,
    x1: info.width * 0.88,
    y1: info.height * 0.92
  });
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
    output[offset] = clamp(Math.round((r * 0.14) + (blurredR * 0.46) + (neutralPaperColor.r * 0.4)), 0, 232);
    output[offset + 1] = clamp(Math.round((g * 0.14) + (blurredG * 0.46) + (neutralPaperColor.g * 0.4)), 0, 232);
    output[offset + 2] = clamp(Math.round((b * 0.14) + (blurredB * 0.46) + (neutralPaperColor.b * 0.4)), 0, 232);
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

function buildReadablePreprocess(gray, blurredGray, width, height, guideMaskInfo = null, options = {}) {
  const normalized = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    normalized[i] = clamp((gray[i] * 255) / Math.max(blurredGray[i], 1), 0, 255);
  }

  const pageFlattened = flattenVerticalBackground(normalized, width, height, null);
  const focusBounds = guideMaskInfo
    ? expandGuideBounds(
      guideMaskInfo,
      width,
      height,
      {
        topPadRatio: Number.isFinite(options.topPadRatio) ? Number(options.topPadRatio) : 0.12,
        bottomPadRatio: Number.isFinite(options.bottomPadRatio) ? Number(options.bottomPadRatio) : 0.12,
        leftPadRatio: Number.isFinite(options.leftPadRatio) ? Number(options.leftPadRatio) : 0.1,
        rightPadRatio: Number.isFinite(options.rightPadRatio) ? Number(options.rightPadRatio) : 0.1
      }
    )
    : null;
  const focusVerticalFlattened = focusBounds
    ? flattenVerticalBackground(normalized, width, height, focusBounds)
    : pageFlattened;
  const focusFlattened = guideMaskInfo
    ? flattenCellBackground(focusVerticalFlattened, width, height, guideMaskInfo)
    : focusVerticalFlattened;
  const output = Buffer.alloc(gray.length);
  const focusBand = guideMaskInfo
    ? Math.max(12, Math.round(Math.min(guideMaskInfo.avgCellW, guideMaskInfo.avgCellH) * 0.14))
    : 0;

  for (let i = 0; i < gray.length; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    let focusWeight = 0;
    if (focusBounds) {
      const dx = x < focusBounds.left
        ? focusBounds.left - x
        : (x >= focusBounds.right ? x - focusBounds.right + 1 : 0);
      const dy = y < focusBounds.top
        ? focusBounds.top - y
        : (y >= focusBounds.bottom ? y - focusBounds.bottom + 1 : 0);
      const rectDistance = Math.max(dx, dy);
      if (rectDistance <= 0) {
        focusWeight = 1;
      } else if (rectDistance < focusBand) {
        focusWeight = 1 - (rectDistance / focusBand);
      }
    }

    const baseValue = pageFlattened[i];
    const focusValue = focusFlattened[i];
    const blendedValue = focusWeight > 0
      ? ((baseValue * (1 - (focusWeight * 0.74))) + (focusValue * (focusWeight * 0.74)))
      : baseValue;
    const isFocusRegion = focusWeight >= 0.35;
    const darkness = clamp(255 - blendedValue, 0, isFocusRegion ? 160 : 150);
    const liftedDarkness = Math.max(0, darkness - (isFocusRegion ? 34 : 28));
    let enhanced = 255 - clamp(liftedDarkness * (isFocusRegion ? 2.25 : 1.95), 0, 255);
    if (enhanced >= (isFocusRegion ? 228 : 234)) {
      enhanced = 255;
    } else if (enhanced >= (isFocusRegion ? 216 : 224)) {
      enhanced = Math.min(255, enhanced + (isFocusRegion ? 8 : 6));
    }
    output[i] = clamp(Math.round(enhanced), 0, 255);
  }

  return output;
}

function buildFallbackReadablePreprocess(baseGray, guideGray, blurredGuideGray, options = {}) {
  const blendWeight = Number.isFinite(options.blendWeight) ? Number(options.blendWeight) : 0.5;
  const normalizedGuideWeight = Number.isFinite(options.normalizedGuideWeight)
    ? Number(options.normalizedGuideWeight)
    : 0.12;
  const guideLift = Number.isFinite(options.guideLift) ? Number(options.guideLift) : 8;
  const guideCap = Number.isFinite(options.guideCap) ? Number(options.guideCap) : 238;
  const output = Buffer.alloc(baseGray.length);

  for (let i = 0; i < baseGray.length; i++) {
    const baseValue = clamp(baseGray[i], 0, 255);
    const normalizedGuide = clamp((guideGray[i] * 255) / Math.max(blurredGuideGray[i], 1), 0, 255);
    const mildGuide = clamp(
      Math.round((normalizedGuide * normalizedGuideWeight) + (guideGray[i] * (1 - normalizedGuideWeight)) + guideLift),
      0,
      guideCap
    );
    let effectiveBlendWeight = blendWeight;
    if (baseValue <= 42) {
      effectiveBlendWeight = 0.12;
    } else if (baseValue <= 84) {
      effectiveBlendWeight = 0.26;
    }
    output[i] = clamp(
      Math.round((baseValue * (1 - effectiveBlendWeight)) + (mildGuide * effectiveBlendWeight)),
      0,
      255
    );
  }

  return output;
}

async function applyFallbackReadablePreprocess(options = {}) {
  const {
    outputPath = null,
    segmentationOutputPath = null,
    guideSourcePath = null,
    blurSigma = 18
  } = options;

  if (!outputPath || !guideSourcePath || !fs.existsSync(outputPath) || !fs.existsSync(guideSourcePath)) {
    return {
      applied: false,
      reason: 'missing-output-or-guide-source'
    };
  }

  const baseImage = await sharp(outputPath)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const guideImage = await sharp(guideSourcePath)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (baseImage.info.width !== guideImage.info.width || baseImage.info.height !== guideImage.info.height) {
    return {
      applied: false,
      reason: 'dimension-mismatch',
      outputSize: {
        width: baseImage.info.width,
        height: baseImage.info.height
      },
      guideSize: {
        width: guideImage.info.width,
        height: guideImage.info.height
      }
    };
  }

  const blurredGuide = await sharp(guideSourcePath)
    .removeAlpha()
    .greyscale()
    .blur(Math.max(1, blurSigma))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const refined = buildFallbackReadablePreprocess(
    baseImage.data,
    guideImage.data,
    blurredGuide.data
  );

  await sharp(refined, {
    raw: {
      width: baseImage.info.width,
      height: baseImage.info.height,
      channels: 1
    }
  }).png().toFile(outputPath);

  if (segmentationOutputPath && segmentationOutputPath !== outputPath) {
    await sharp(refined, {
      raw: {
        width: baseImage.info.width,
        height: baseImage.info.height,
        channels: 1
      }
    }).png().toFile(segmentationOutputPath);
  }

  return {
    applied: true,
    method: 'fallback-readable-preprocess-blend',
    guideSourcePath,
    outputPath,
    segmentationOutputPath: segmentationOutputPath || outputPath
  };
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
  let neutralGuideRemovedRgb = null;
  if (guideRemovedInputPath) {
    const guideRemovedInput = await loadRgbImage(guideRemovedInputPath);
    neutralGuideRemovedRgb = guideRemovedInput.data;
  } else {
    const blurredRgbData = await blurRgbChannels(rgbData, info, guideBlurSigma);
    neutralGuideRemovedRgb = buildNeutralGuideRemovedRgb(rgbData, blurredRgbData, info, guideRemovalMaskInfo);
  }
  const refinedRgb = Buffer.from(neutralGuideRemovedRgb);
  const refinedGray = computeGray(refinedRgb, info.channels);
  const refinedBlurredGray = await blurGray(refinedGray, info.width, info.height, Math.max(1, blurSigma));

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
      const readablePreprocess = buildReadablePreprocess(
        refinedGray,
        refinedBlurredGray,
        info.width,
        info.height,
        segmentationGuideMaskInfoBase
      );
      await sharp(readablePreprocess, {
        raw: {
          width: info.width,
          height: info.height,
          channels: 1
        }
      }).png().toFile(outputPath);
    } else if (!fs.existsSync(outputPath)) {
      await fs.promises.copyFile(preprocessInputPath, outputPath);
    }
  }

  const gridDetectionInputPath = outputPath || baseImagePath;
  let gridDetectionRgbData = rgbData;
  let gridDetectionInfo = info;
  let gridDetectionGray = refinedGray;
  let gridDetectionBlurredGray = refinedBlurredGray;

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
  const extraQuads = Array.isArray(options.extraQuads)
    ? options.extraQuads.filter((item) => normalizeCornerQuad(item?.corners))
    : [];
  const extraHorizontalLines = Array.isArray(options.extraHorizontalLines)
    ? options.extraHorizontalLines.filter((item) => Number.isFinite(Number(item?.y)))
    : [];
  const extraPointMarkers = Array.isArray(options.extraPointMarkers)
    ? options.extraPointMarkers.filter((item) => Number.isFinite(Number(item?.x)) && Number.isFinite(Number(item?.y)))
    : [];
  const extraRectangles = Array.isArray(options.extraRectangles)
    ? options.extraRectangles.filter((item) => item?.box && Number.isFinite(Number(item.box?.left)) && Number.isFinite(Number(item.box?.top)))
    : [];
  const hasExactGuideCounts =
    Array.isArray(guides.xPeaks) &&
    Array.isArray(guides.yPeaks) &&
    (!gridCols || guides.xPeaks.length === gridCols + 1) &&
    (!gridRows || guides.yPeaks.length === gridRows + 1);
  const normalizedGuides = hasExactGuideCounts
    ? guides
    : (normalizeGridBoundaryGuides({ gridRectification, gridRows, gridCols }) || guides);
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
  const extraHorizontalOverlays = extraHorizontalLines.map((item) => {
    const lineY = clamp(Math.round(Number(item.y)), 0, Math.max(0, height - 1));
    const stroke = String(item.stroke || '#0f766e');
    const dasharray = item.dasharray ? ` stroke-dasharray="${item.dasharray}"` : '';
    return `<line x1="0" y1="${lineY}" x2="${width}" y2="${lineY}" stroke="${stroke}" stroke-width="3"${dasharray} stroke-opacity="0.92"/>`;
  }).join('\n');
  const extraHorizontalLabels = extraHorizontalLines.map((item, index) => {
    const lineY = clamp(Math.round(Number(item.y)), 18, Math.max(18, height - 18));
    const label = String(item.label || `H${index}`);
    const stroke = String(item.stroke || '#0f766e');
    return `
      <rect x="${Math.max(16, width - 260)}" y="${Math.max(8, lineY - 18)}" width="232" height="22" rx="6" ry="6" fill="rgba(255,255,255,0.9)" stroke="${stroke}" stroke-width="2"/>
      <text x="${Math.max(24, width - 252)}" y="${Math.max(23, lineY - 3)}" font-size="14" fill="#111827">${label}</text>
    `;
  }).join('\n');
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
  const extraQuadPolygons = extraQuads.map((item) => {
    const quad = normalizeCornerQuad(item.corners);
    if (!quad) {
      return '';
    }
    const stroke = String(item.stroke || '#7c3aed');
    const fill = String(item.fill || 'none');
    const dasharray = item.dasharray ? ` stroke-dasharray="${item.dasharray}"` : '';
    return `<polygon points="${quad.map((point) => `${point[0]},${point[1]}`).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="6"${dasharray}/>`;
  }).join('\n');
  const extraQuadPoints = extraQuads.map((item, quadIndex) => {
    const quad = normalizeCornerQuad(item.corners);
    if (!quad) {
      return '';
    }
    const stroke = String(item.stroke || '#7c3aed');
    const fill = String(item.pointFill || stroke);
    const prefix = String(item.pointPrefix || `Q${quadIndex}`);
    return quad.map((point, pointIndex) => {
      const x = clamp(Math.round(point[0]), 0, Math.max(0, width - 1));
      const y = clamp(Math.round(point[1]), 0, Math.max(0, height - 1));
      return `
        <circle cx="${x}" cy="${y}" r="8" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
        <rect x="${x + 10}" y="${y + 10}" width="62" height="22" rx="7" ry="7" fill="rgba(255,255,255,0.92)" stroke="${stroke}" stroke-width="2"/>
        <text x="${x + 18}" y="${y + 26}" font-size="14" fill="#111827">${prefix}${pointIndex}</text>
      `;
    }).join('\n');
  }).join('\n');
  const extraMarkerPoints = extraPointMarkers.map((item, markerIndex) => {
    const x = clamp(Math.round(Number(item.x)), 0, Math.max(0, width - 1));
    const y = clamp(Math.round(Number(item.y)), 0, Math.max(0, height - 1));
    const stroke = String(item.stroke || '#0369a1');
    const fill = String(item.fill || '#38bdf8');
    const label = String(item.label || `M${markerIndex}`);
    const labelWidth = Math.max(58, Math.min(220, 18 + label.length * 8));
    return `
      <circle cx="${x}" cy="${y}" r="8" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
      <rect x="${x + 10}" y="${Math.max(8, y - 32)}" width="${labelWidth}" height="22" rx="7" ry="7" fill="rgba(255,255,255,0.92)" stroke="${stroke}" stroke-width="2"/>
      <text x="${x + 18}" y="${Math.max(23, y - 16)}" font-size="14" fill="#111827">${label}</text>
    `;
  }).join('\n');
  const extraRects = extraRectangles.map((item, rectIndex) => {
    const left = clamp(Math.round(Number(item.box.left)), 0, Math.max(0, width - 1));
    const top = clamp(Math.round(Number(item.box.top)), 0, Math.max(0, height - 1));
    const right = clamp(Math.round(Number(item.box.right ?? (item.box.left + item.box.width))), left + 1, Math.max(1, width));
    const bottom = clamp(Math.round(Number(item.box.bottom ?? (item.box.top + item.box.height))), top + 1, Math.max(1, height));
    const stroke = String(item.stroke || '#0369a1');
    const dasharray = item.dasharray ? ` stroke-dasharray="${item.dasharray}"` : '';
    const label = String(item.label || `W${rectIndex}`);
    const labelWidth = Math.max(70, Math.min(240, 20 + label.length * 8));
    return `
      <rect x="${left}" y="${top}" width="${Math.max(1, right - left)}" height="${Math.max(1, bottom - top)}" fill="none" stroke="${stroke}" stroke-width="3"${dasharray}/>
      <rect x="${left}" y="${Math.max(8, top - 24)}" width="${labelWidth}" height="20" rx="6" ry="6" fill="rgba(255,255,255,0.92)" stroke="${stroke}" stroke-width="2"/>
      <text x="${left + 8}" y="${Math.max(22, top - 10)}" font-size="13" fill="#111827">${label}</text>
    `;
  }).join('\n');

  const polygon = corners.length === 4
    ? `<polygon points="${corners.map((point) => `${point[0]},${point[1]}`).join(' ')}" fill="none" stroke="#16a34a" stroke-width="6"/>`
    : '';
  const guidesRect = showGuides && normalizedGuides.left !== undefined && normalizedGuides.right !== undefined && normalizedGuides.top !== undefined && normalizedGuides.bottom !== undefined
    ? `<rect x="${normalizedGuides.left}" y="${normalizedGuides.top}" width="${Math.max(1, normalizedGuides.right - normalizedGuides.left)}" height="${Math.max(1, normalizedGuides.bottom - normalizedGuides.top)}" fill="none" stroke="#22c55e" stroke-width="4" stroke-dasharray="12 10"/>`
    : '';
  const infoLines = [annotationSubtitle, annotationDetail]
    .filter(Boolean)
    .flatMap((line) => String(line).split('\n').map((item) => item.trim()).filter(Boolean));
  const infoPanelHeight = 64 + infoLines.length * 24;
  const infoPanelWidth = Math.min(720, Math.max(420, width - 28));
  const infoText = infoLines.map((line, index) => (
    `<text x="30" y="${76 + index * 22}" font-size="18" fill="#374151">${line}</text>`
  )).join('\n');

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${extraQuadPolygons}
      ${polygon}
      ${guidesRect}
      ${peakLines.join('\n')}
      ${extraHorizontalOverlays}
      ${replacementTrails}
      ${extraQuadPoints}
      ${extraMarkerPoints}
      ${extraRects}
      ${extraHorizontalLabels}
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
  requiredSideGaps = null,
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

  const resolvedRequiredSideGaps = {
    top: Math.max(3, Math.round(Number(requiredSideGaps?.top) || 0)),
    bottom: Math.max(3, Math.round(Number(requiredSideGaps?.bottom) || 0)),
    left: Math.max(3, Math.round(Number(requiredSideGaps?.left) || 0)),
    right: Math.max(3, Math.round(Number(requiredSideGaps?.right) || 0))
  };
  const maxAdjacentUnrelatedDarkRatio = 0.035;
  const maxCandidateOverlapRatio = 0.45;
  const sides = { top: topGap, bottom: bottomGap, left: leftGap, right: rightGap };
  const sideFlags = Object.fromEntries(
    Object.entries(sides).map(([key, metrics]) => ([
      key,
      metrics.gap >= resolvedRequiredSideGaps[key]
      && metrics.candidateRatio <= maxCandidateOverlapRatio
      && metrics.adjacentUnrelatedDarkRatio <= maxAdjacentUnrelatedDarkRatio
    ]))
  );
  const gapValues = Object.values(sides).map((metrics) => metrics.gap).filter(Number.isFinite);
  const horizontalGapPair = [topGap.gap, bottomGap.gap].filter(Number.isFinite);
  const verticalGapPair = [leftGap.gap, rightGap.gap].filter(Number.isFinite);
  const gapConsistency = gapValues.length === 4
    ? {
        minGap: Math.min(...gapValues),
        maxGap: Math.max(...gapValues),
        ratio: Math.max(...gapValues) / Math.max(1, Math.min(...gapValues))
      }
    : null;
  const pairConsistency = (
    horizontalGapPair.length === 2
    && verticalGapPair.length === 2
  )
    ? {
        horizontal: {
          minGap: Math.min(...horizontalGapPair),
          maxGap: Math.max(...horizontalGapPair),
          ratio: Math.max(...horizontalGapPair) / Math.max(1, Math.min(...horizontalGapPair)),
          delta: Math.abs(horizontalGapPair[0] - horizontalGapPair[1])
        },
        vertical: {
          minGap: Math.min(...verticalGapPair),
          maxGap: Math.max(...verticalGapPair),
          ratio: Math.max(...verticalGapPair) / Math.max(1, Math.min(...verticalGapPair)),
          delta: Math.abs(verticalGapPair[0] - verticalGapPair[1])
        }
      }
    : null;
  const innerFrameDetected = (
    Number.isFinite(immediateInnerFrame.top)
    && Number.isFinite(immediateInnerFrame.bottom)
    && Number.isFinite(immediateInnerFrame.left)
    && Number.isFinite(immediateInnerFrame.right)
    && immediateInnerFrame.bottom > immediateInnerFrame.top
    && immediateInnerFrame.right > immediateInnerFrame.left
  );
  const similarOuterInnerMargin = Boolean(
    innerFrameDetected
    && gapConsistency
    && gapConsistency.minGap > 0
    && gapConsistency.ratio <= 1.28
    && (gapConsistency.maxGap - gapConsistency.minGap) <= Math.max(12, Math.round(gapConsistency.minGap * 0.35))
    && pairConsistency
    && pairConsistency.horizontal.ratio <= 1.18
    && pairConsistency.vertical.ratio <= 1.18
    && pairConsistency.horizontal.delta <= Math.max(10, Math.round(gapConsistency.minGap * 0.22))
    && pairConsistency.vertical.delta <= Math.max(10, Math.round(gapConsistency.minGap * 0.22))
  );
  const eligible = Object.values(sideFlags).every(Boolean) && similarOuterInnerMargin;
  return {
    eligible,
    reason: eligible
      ? 'ok'
      : (!innerFrameDetected
        ? 'inner-frame-not-found'
        : (!Object.values(sideFlags).every(Boolean) ? 'inner-content-too-close-to-outer-frame' : 'outer-inner-gap-not-similar')),
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
      sideFlags,
      requiredSideGaps: resolvedRequiredSideGaps,
      innerFrameDetected,
      similarOuterInnerMargin,
      pairConsistency: pairConsistency
        ? {
            horizontal: {
              minGap: pairConsistency.horizontal.minGap,
              maxGap: pairConsistency.horizontal.maxGap,
              ratio: Number(pairConsistency.horizontal.ratio.toFixed(4)),
              delta: pairConsistency.horizontal.delta
            },
            vertical: {
              minGap: pairConsistency.vertical.minGap,
              maxGap: pairConsistency.vertical.maxGap,
              ratio: Number(pairConsistency.vertical.ratio.toFixed(4)),
              delta: pairConsistency.vertical.delta
            }
          }
        : null,
      gapConsistency: gapConsistency
        ? {
            minGap: gapConsistency.minGap,
            maxGap: gapConsistency.maxGap,
            ratio: Number(gapConsistency.ratio.toFixed(4))
          }
        : null
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

function liftAsymmetricTopCornerTowardEndpoint(baseQuad, verticalEndpoints, options = {}) {
  const base = normalizeCornerQuad(baseQuad);
  if (!base) {
    return {
      quad: null,
      diagnostics: {
        applied: false,
        reason: 'missing-base-quad'
      }
    };
  }
  const cellWidth = Math.max(1, Math.round(Number(options.cellWidth) || 0));
  const cellHeight = Math.max(1, Math.round(Number(options.cellHeight) || 0));
  const minLift = Math.max(12, Math.round(cellHeight * 0.04));
  const peerSlack = Math.max(10, Math.round(cellHeight * 0.03));
  const maxLift = Math.max(10, Math.round(cellHeight * 0.04));
  const maxXShift = Math.max(3, Math.round(cellWidth * 0.012));
  const liftBlend = 0.18;
  const topCandidates = [
    { index: 0, name: 'leftTop', endpoint: verticalEndpoints?.leftTop },
    { index: 1, name: 'rightTop', endpoint: verticalEndpoints?.rightTop }
  ].map((candidate) => {
    const current = base[candidate.index];
    const endpoint = Array.isArray(candidate.endpoint)
      ? [Number(candidate.endpoint[0]), Number(candidate.endpoint[1])]
      : null;
    const lift = endpoint ? (Number(current[1]) - Number(endpoint[1])) : null;
    return {
      ...candidate,
      current,
      endpoint,
      lift: Number.isFinite(lift) ? lift : null
    };
  });
  const positiveCandidates = topCandidates.filter((candidate) => Number.isFinite(candidate.lift) && candidate.lift >= minLift);
  if (positiveCandidates.length !== 1) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: positiveCandidates.length > 1 ? 'multi-corner-lift-suppressed' : 'lift-too-small',
        minLift,
        peerSlack,
        maxLift,
        candidates: topCandidates.map((candidate) => ({
          name: candidate.name,
          currentY: Number(candidate.current[1].toFixed(3)),
          endpointY: candidate.endpoint ? Number(candidate.endpoint[1].toFixed(3)) : null,
          lift: Number.isFinite(candidate.lift) ? Number(candidate.lift.toFixed(3)) : null
        }))
      }
    };
  }
  const target = positiveCandidates[0];
  const peer = topCandidates.find((candidate) => candidate.index !== target.index) || null;
  if (peer && Number.isFinite(peer.lift) && peer.lift >= (target.lift - peerSlack)) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'peer-needs-similar-lift',
        minLift,
        peerSlack,
        maxLift,
        target: target.name,
        targetLift: Number(target.lift.toFixed(3)),
        peerLift: Number(peer.lift.toFixed(3))
      }
    };
  }
  const appliedLift = Math.min(maxLift, target.lift * liftBlend);
  const dx = Number(target.endpoint[0]) - Number(target.current[0]);
  const appliedDx = clamp(dx * 0.12, -maxXShift, maxXShift);
  const adjusted = base.map(([x, y]) => [x, y]);
  adjusted[target.index] = [
    target.current[0] + appliedDx,
    target.current[1] - appliedLift
  ];
  return {
    quad: normalizeCornerQuad(adjusted) || base,
    diagnostics: {
      applied: true,
      reason: 'single-top-corner-lifted-toward-endpoint',
      minLift,
      peerSlack,
      maxLift,
      liftBlend,
      corner: target.name,
      current: target.current.map((value) => Number(value.toFixed(3))),
      endpoint: target.endpoint.map((value) => Number(value.toFixed(3))),
      peerLift: Number.isFinite(peer?.lift) ? Number(peer.lift.toFixed(3)) : null,
      appliedDx: Number(appliedDx.toFixed(3)),
      appliedLift: Number(appliedLift.toFixed(3))
    }
  };
}

function refineAsymmetricTopCornerByLocalTopSupport(gray, width, height, baseQuad, options = {}) {
  const base = normalizeCornerQuad(baseQuad);
  if (!gray || !base || width <= 0 || height <= 0) {
    return {
      quad: base || null,
      diagnostics: {
        applied: false,
        reason: 'missing-base-inputs'
      }
    };
  }
  const outerBounds = options.outerBounds || getQuadBounds(base);
  const innerBounds = options.innerBounds || null;
  const verticalEndpoints = options.verticalEndpoints || null;
  const leftLine = options.leftLine || buildLineFromEndAnchors(base[0], base[3], null);
  const rightLine = options.rightLine || buildLineFromEndAnchors(base[1], base[2], null);
  if (!outerBounds || !innerBounds || !leftLine || !rightLine) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'missing-boundary-context'
      }
    };
  }
  const cellWidth = Math.max(1, Math.round(Number(options.cellWidth) || 0));
  const cellHeight = Math.max(1, Math.round(Number(options.cellHeight) || 0));
  const minLift = Math.max(12, Math.round(cellHeight * 0.04));
  const peerSlack = Math.max(10, Math.round(cellHeight * 0.03));
  const minImprovement = Math.max(6, Math.round(cellHeight * 0.02));
  const defaultMaxAdditionalLift = Math.max(10, Math.round(cellHeight * 0.038));
  const defaultSupportBlend = 0.6;
  const endpointSafety = Math.max(20, Math.round(cellHeight * 0.07));
  const localSpanWidth = Math.max(
    Math.round((Number(outerBounds.right) - Number(outerBounds.left) + 1) * 0.3),
    Math.round(cellWidth * 2.2),
    220
  );
  const maxSearchY = clamp(Math.round(Number(innerBounds.top) - 2), 0, Math.max(0, height - 1));
  const topCandidates = [
    { index: 0, name: 'leftTop', endpoint: verticalEndpoints?.leftTop, line: leftLine },
    { index: 1, name: 'rightTop', endpoint: verticalEndpoints?.rightTop, line: rightLine }
  ].map((candidate) => {
    const current = base[candidate.index];
    const endpoint = Array.isArray(candidate.endpoint)
      ? [Number(candidate.endpoint[0]), Number(candidate.endpoint[1])]
      : null;
    const lift = endpoint ? (Number(current[1]) - Number(endpoint[1])) : null;
    return {
      ...candidate,
      current,
      endpoint,
      lift: Number.isFinite(lift) ? lift : null
    };
  });
  const positiveCandidates = topCandidates.filter((candidate) => Number.isFinite(candidate.lift) && candidate.lift >= minLift);
  if (positiveCandidates.length !== 1) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: positiveCandidates.length > 1 ? 'multi-corner-local-support-suppressed' : 'lift-too-small',
        minLift,
        peerSlack,
        candidates: topCandidates.map((candidate) => ({
          name: candidate.name,
          currentY: Number(candidate.current[1].toFixed(3)),
          endpointY: candidate.endpoint ? Number(candidate.endpoint[1].toFixed(3)) : null,
          lift: Number.isFinite(candidate.lift) ? Number(candidate.lift.toFixed(3)) : null
        }))
      }
    };
  }
  const target = positiveCandidates[0];
  const peer = topCandidates.find((candidate) => candidate.index !== target.index) || null;
  const maxAdditionalLift = target.index === 0
    ? Math.max(defaultMaxAdditionalLift, Math.round(cellHeight * 0.05))
    : defaultMaxAdditionalLift;
  const supportBlend = target.index === 0 ? 0.78 : defaultSupportBlend;
  if (peer && Number.isFinite(peer.lift) && peer.lift >= (target.lift - peerSlack)) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'peer-needs-similar-lift',
        minLift,
        peerSlack,
        target: target.name,
        targetLift: Number(target.lift.toFixed(3)),
        peerLift: Number(peer.lift.toFixed(3))
      }
    };
  }

  const expectedY = clamp(
    Math.round(average([
      Number(target.current[1]),
      Number(target.endpoint[1]) + endpointSafety
    ])),
    0,
    maxSearchY
  );
  const searchUp = Math.max(24, Math.round(cellHeight * 0.14));
  const searchDown = Math.max(8, Math.round(cellHeight * 0.04));
  const localXStart = target.index === 0
    ? clamp(Math.round(Number(outerBounds.left)), 0, Math.max(0, width - 1))
    : clamp(Math.round(Number(outerBounds.right) - localSpanWidth), 0, Math.max(0, width - 1));
  const localXEnd = target.index === 0
    ? clamp(Math.round(Number(outerBounds.left) + localSpanWidth), localXStart + 1, Math.max(1, width - 1))
    : clamp(Math.round(Number(outerBounds.right)), localXStart + 1, Math.max(1, width - 1));
  const localYStart = clamp(
    Math.round(Math.min(expectedY, Number(target.current[1]) - 4) - searchUp),
    0,
    maxSearchY
  );
  const localYEnd = clamp(
    Math.round(Math.max(expectedY, Number(target.current[1]) - 6) + searchDown),
    localYStart,
    maxSearchY
  );
  if (localYEnd - localYStart < 8) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'local-window-too-small',
        localWindow: {
          x: [localXStart, localXEnd],
          y: [localYStart, localYEnd]
        }
      }
    };
  }

  const localTopPoints = collectGlobalHorizontalBoundaryPoints(gray, width, height, {
    expectedY,
    xStart: localXStart,
    xEnd: localXEnd,
    yStart: localYStart,
    yEnd: localYEnd,
    inwardDir: 1,
    step: 6,
    outwardBias: 0.22
  });
  const localTopLine = fitLineRobust(localTopPoints, 4);
  if (!localTopLine) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'local-top-line-fit-failed',
        localWindow: {
          x: [localXStart, localXEnd],
          y: [localYStart, localYEnd]
        },
        localPointCount: localTopPoints.length
      }
    };
  }
  const localExtremeTopPoints = extractExtremeSupportPoints(
    localTopLine,
    localTopPoints,
    (point) => scoreOuterHorizontalBoundaryAt(gray, width, height, point[1], point[0] - 10, point[0] + 10, 1),
    'top',
    { ratio: 0.24 }
  );
  const pointHalves = splitSupportPointsByAxis(localExtremeTopPoints, 0);
  const supportPoints = target.index === 0
    ? (pointHalves.first.length ? pointHalves.first : localExtremeTopPoints)
    : (pointHalves.second.length ? pointHalves.second : localExtremeTopPoints);
  if (!supportPoints.length) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'no-local-support-points',
        localWindow: {
          x: [localXStart, localXEnd],
          y: [localYStart, localYEnd]
        },
        localPointCount: localTopPoints.length,
        localExtremePointCount: localExtremeTopPoints.length
      }
    };
  }
  const supportAnchor = [
    average(supportPoints.map((point) => point[0])),
    average(supportPoints.map((point) => point[1]))
  ];
  const supportTargetY = clamp(
    Number(supportAnchor[1]),
    Number(target.endpoint[1]) + endpointSafety,
    Number(target.current[1]) - minImprovement
  );
  const supportLift = Number(target.current[1]) - supportTargetY;
  if (!Number.isFinite(supportLift) || supportLift < minImprovement) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'local-support-improvement-too-small',
        supportAnchor: supportAnchor.map((value) => Number(value.toFixed(3))),
        supportLift: Number.isFinite(supportLift) ? Number(supportLift.toFixed(3)) : null
      }
    };
  }
  const appliedLift = Math.min(maxAdditionalLift, supportLift * supportBlend);
  const targetY = Number(target.current[1]) - appliedLift;
  const solvedX = solveLineXAtY(target.line, targetY);
  const candidatePoint = [
    Number.isFinite(solvedX) ? solvedX : Number(target.current[0]),
    targetY
  ];
  const adjusted = base.map((point) => [...point]);
  adjusted[target.index] = candidatePoint;
  const candidateQuad = normalizeCornerQuad(adjusted) || base;
  const baseQuality = evaluateRectangularQuadQuality(base, { guides: options.guides || innerBounds });
  const candidateQuality = evaluateRectangularQuadQuality(candidateQuad, { guides: options.guides || innerBounds });
  const baseScore = Number(baseQuality?.rotatedRectangleScore || 0);
  const candidateScore = Number(candidateQuality?.rotatedRectangleScore || 0);
  const minCandidateScore = target.index === 0 ? 0.77 : 0.78;
  const allowedRegression = target.index === 0 ? 0.065 : 0.06;
  if (candidateScore < Math.max(minCandidateScore, baseScore - allowedRegression)) {
    return {
      quad: base,
      diagnostics: {
        applied: false,
        reason: 'rectangularity-regressed-too-much',
        baseScore: Number(baseScore.toFixed(4)),
        candidateScore: Number(candidateScore.toFixed(4)),
        supportAnchor: supportAnchor.map((value) => Number(value.toFixed(3))),
        candidatePoint: candidatePoint.map((value) => Number(value.toFixed(3)))
      }
    };
  }
  return {
    quad: candidateQuad,
    diagnostics: {
      applied: true,
      reason: 'single-top-corner-refined-by-local-support',
      corner: target.name,
      minLift,
      minImprovement,
      endpointSafety,
      maxAdditionalLift,
      supportBlend,
      current: target.current.map((value) => Number(value.toFixed(3))),
      endpoint: target.endpoint.map((value) => Number(value.toFixed(3))),
      supportAnchor: supportAnchor.map((value) => Number(value.toFixed(3))),
      localWindow: {
        x: [localXStart, localXEnd],
        y: [localYStart, localYEnd]
      },
      localPointCount: localTopPoints.length,
      localExtremePointCount: localExtremeTopPoints.length,
      supportPointCount: supportPoints.length,
      supportLift: Number(supportLift.toFixed(3)),
      appliedLift: Number(appliedLift.toFixed(3)),
      candidatePoint: candidatePoint.map((value) => Number(value.toFixed(3))),
      baseRectangularity: Number(baseScore.toFixed(4)),
      candidateRectangularity: Number(candidateScore.toFixed(4))
    }
  };
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
    const candidatePoint = target[index];
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
  const acceptedLifts = [];
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
    acceptedLifts.push(Math.min(lift, maxLift));
  }
  if (!acceptedLifts.length) {
    return base;
  }
  const sharedLift = Math.min(...acceptedLifts);
  if (!(sharedLift > 4)) {
    return base;
  }
  for (const spec of topSpecs) {
    merged[spec.index][1] = Number(base[spec.index][1]) - sharedLift;
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

function evaluateSegmentCoverageAlongEdge(points, start, end, options = {}) {
  if (!Array.isArray(points) || !points.length || !Array.isArray(start) || !Array.isArray(end)) {
    return null;
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  const binSize = Math.max(10, Number(options.binSize) || Math.round(length / 24));
  const binCount = Math.max(3, Math.ceil(length / Math.max(1, binSize)));
  const occupied = new Array(binCount).fill(false);
  for (const point of points) {
    const tRaw = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (length * length);
    const t = clamp(tRaw, 0, 1);
    const index = clamp(Math.floor(t * binCount), 0, binCount - 1);
    occupied[index] = true;
  }
  let covered = 0;
  let longest = 0;
  let run = 0;
  let maxGap = 0;
  let gap = 0;
  for (const flag of occupied) {
    if (flag) {
      covered += 1;
      run += 1;
      longest = Math.max(longest, run);
      gap = 0;
    } else {
      run = 0;
      gap += 1;
      maxGap = Math.max(maxGap, gap);
    }
  }
  return {
    coverageRatio: covered / Math.max(1, binCount),
    longestRunRatio: longest / Math.max(1, binCount),
    endpointCoverage: (occupied[0] ? 0.5 : 0) + (occupied[binCount - 1] ? 0.5 : 0),
    maxGapRatio: maxGap / Math.max(1, binCount)
  };
}

function evaluateCandidateEdgeInk(points, start, end, scoreAtPoint, options = {}) {
  if (!Array.isArray(points) || !points.length || !Array.isArray(start) || !Array.isArray(end)) {
    return {
      confidence: 0,
      darknessScore: 0,
      averageScore: 0,
      matchedPointCount: 0,
      supportRatio: 0,
      continuity: null
    };
  }
  const length = Math.max(1, Math.hypot(end[0] - start[0], end[1] - start[1]));
  const baseBand = Math.max(3, length * 0.014);
  let matched = points.filter((point) => pointSegmentDistance(point, start, end) <= baseBand);
  if (matched.length < 12) {
    const relaxedBand = Math.max(6, baseBand * 1.8);
    matched = points.filter((point) => pointSegmentDistance(point, start, end) <= relaxedBand);
  }
  const scores = matched.map((point) => scoreAtPoint(point)).filter(Number.isFinite);
  const averageScore = average(scores);
  const supportRatio = matched.length / Math.max(1, points.length);
  const continuity = evaluateSegmentCoverageAlongEdge(matched, start, end, {
    binSize: Math.max(10, length / 22)
  });
  const darknessScore = clamp01((averageScore - 88) / 138);
  const supportConfidence = clamp01((supportRatio - 0.08) / 0.42);
  const continuityConfidence = continuity
    ? clamp01(
        continuity.coverageRatio * 0.26
        + continuity.longestRunRatio * 0.34
        + continuity.endpointCoverage * 0.24
        + (1 - continuity.maxGapRatio) * 0.16
      )
    : 0;
  return {
    confidence: darknessScore * 0.5 + continuityConfidence * 0.34 + supportConfidence * 0.16,
    darknessScore,
    averageScore,
    matchedPointCount: matched.length,
    supportRatio,
    continuity
  };
}

function evaluateCandidateQuadInkQuality(quad, edgeLineInputs, gray, width, height) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized || !edgeLineInputs) {
    return null;
  }
  const [lt, rt, rb, lb] = normalized;
  const edges = {
    top: evaluateCandidateEdgeInk(
      edgeLineInputs.top || [],
      lt,
      rt,
      (point) => scoreOuterHorizontalBoundaryAt(gray, width, height, point[1], point[0] - 10, point[0] + 10, 1)
    ),
    right: evaluateCandidateEdgeInk(
      edgeLineInputs.right || [],
      rt,
      rb,
      (point) => scoreOuterVerticalBoundaryAt(gray, width, height, point[0], point[1] - 10, point[1] + 10, -1)
    ),
    bottom: evaluateCandidateEdgeInk(
      edgeLineInputs.bottom || [],
      lb,
      rb,
      (point) => scoreOuterHorizontalBoundaryAt(gray, width, height, point[1], point[0] - 10, point[0] + 10, -1)
    ),
    left: evaluateCandidateEdgeInk(
      edgeLineInputs.left || [],
      lt,
      lb,
      (point) => scoreOuterVerticalBoundaryAt(gray, width, height, point[0], point[1] - 10, point[1] + 10, 1)
    )
  };
  const entries = Object.entries(edges);
  const confidences = entries.map(([, value]) => value.confidence).sort((a, b) => b - a);
  const darknesses = entries.map(([, value]) => value.darknessScore).sort((a, b) => b - a);
  const strongThreeConfidence = average(confidences.slice(0, 3));
  const strongThreeDarkness = average(darknesses.slice(0, 3));
  const overallConfidence = strongThreeConfidence * 0.82 + average(confidences) * 0.18;
  const overallDarkness = strongThreeDarkness * 0.82 + average(darknesses) * 0.18;
  const weakest = entries
    .map(([name, value]) => ({ name, confidence: value.confidence }))
    .sort((a, b) => a.confidence - b.confidence)[0] || null;
  const structuralMinConfidence = Math.min(
    edges.left.confidence,
    edges.right.confidence,
    edges.bottom.confidence
  );
  return {
    edges,
    overallConfidence,
    overallDarkness,
    weakestEdge: weakest,
    structuralMinConfidence
  };
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

function evaluateInnerGridSupportFromRawHints(quad, rawGuideHints, options = {}) {
  const normalized = normalizeCornerQuad(quad);
  if (!normalized || !rawGuideHints) {
    return null;
  }
  const diagnostics = rawGuideHints.diagnostics || {};
  const medianXGap = Number(rawGuideHints.medianXGap) || Number(options.cellWidth) || 0;
  const medianYGap = Number(rawGuideHints.medianYGap) || Number(options.cellHeight) || 0;
  const candidateBounds = buildQuadAverageBounds(normalized);
  if (!candidateBounds) {
    return null;
  }

  const majorXGap = Number(diagnostics.majorXGap) || 0;
  const majorYGap = Number(diagnostics.majorYGap) || 0;
  const strictTopLeftIntervalPattern = shouldApplyStrictTopLeftIntervalGateFromDiagnostics(diagnostics);
  const leftIntervalEvidence = buildInnerGridIntervalEvidence({
    firstGap: diagnostics.leftFirstGap,
    secondGap: diagnostics.leftSecondGap,
    medianGap: medianXGap,
    stableRun: diagnostics.leftStableInnerRun,
    globalStableCount: diagnostics.xGlobalStableGapCount
  });
  const rightIntervalEvidence = buildInnerGridIntervalEvidence({
    firstGap: diagnostics.rightLastGap,
    secondGap: diagnostics.rightPrevGap,
    medianGap: medianXGap,
    stableRun: diagnostics.rightStableInnerRun,
    globalStableCount: diagnostics.xGlobalStableGapCount
  });
  const topIntervalEvidence = buildInnerGridIntervalEvidence({
    firstGap: diagnostics.topFirstGap,
    secondGap: diagnostics.topSecondGap,
    medianGap: medianYGap,
    stableRun: diagnostics.topStableInnerRun,
    globalStableCount: diagnostics.yGlobalStableGapCount
  });
  const bottomIntervalEvidence = buildInnerGridIntervalEvidence({
    firstGap: diagnostics.bottomLastGap,
    secondGap: diagnostics.bottomPrevGap,
    medianGap: medianYGap,
    stableRun: diagnostics.bottomStableInnerRun,
    globalStableCount: diagnostics.yGlobalStableGapCount
  });
  const sides = {
    left: evaluateInnerGridSideSupport({
      side: 'left',
      gap: Number(diagnostics.firstInnerX) - candidateBounds.left,
      medianGap: medianXGap,
      boundaryGap: majorXGap,
      stableRun: diagnostics.leftStableInnerRun,
      globalStableCount: diagnostics.xGlobalStableGapCount,
      intervalEvidence: leftIntervalEvidence
    }),
    right: evaluateInnerGridSideSupport({
      side: 'right',
      gap: candidateBounds.right - Number(diagnostics.lastInnerX),
      medianGap: medianXGap,
      boundaryGap: majorXGap,
      stableRun: diagnostics.rightStableInnerRun,
      globalStableCount: diagnostics.xGlobalStableGapCount,
      intervalEvidence: rightIntervalEvidence
    }),
    top: evaluateInnerGridSideSupport({
      side: 'top',
      gap: Number(diagnostics.firstInnerY) - candidateBounds.top,
      medianGap: medianYGap,
      boundaryGap: majorYGap,
      stableRun: diagnostics.topStableInnerRun,
      globalStableCount: diagnostics.yGlobalStableGapCount,
      requireInferStableRun: 2,
      intervalEvidence: topIntervalEvidence
    }),
    bottom: evaluateInnerGridSideSupport({
      side: 'bottom',
      gap: candidateBounds.bottom - Number(diagnostics.lastInnerY),
      medianGap: medianYGap,
      boundaryGap: majorYGap,
      stableRun: diagnostics.bottomStableInnerRun,
      globalStableCount: diagnostics.yGlobalStableGapCount,
      intervalEvidence: bottomIntervalEvidence
    })
  };

  const entries = Object.values(sides);
  if (strictTopLeftIntervalPattern) {
    for (const sideName of ['left', 'top']) {
      const side = sides[sideName];
      const intervalSupported = Boolean(side?.intervalEvidence?.supported);
      const pairConsistencyStrong = (Number(side?.intervalEvidence?.pairConsistencyScore) || 0) >= 0.82;
      const boundaryStrong = side?.mode === 'aligned-with-major-boundary-guide' && (Number(side?.score) || 0) >= 0.84;
      const strongDirectSupport = (Number(side?.score) || 0) >= 0.84;
      if (
        side?.eligible
        && !intervalSupported
        && !pairConsistencyStrong
        && !boundaryStrong
        && !strongDirectSupport
      ) {
        side.eligible = false;
        side.mode = `${side.mode || 'unsupported'}-rejected-by-top-left-interval-gate`;
      }
    }
  }
  const eligibleCount = entries.filter((entry) => entry.eligible).length;
  const leftBottomJointSupport = diagnostics.leftBottomJointSupport || null;
  const supportScore = average(entries.map((entry) => entry.score));
  const anchoredScore = leftBottomJointSupport
    ? average([supportScore, Number(leftBottomJointSupport.score) || 0])
    : supportScore;
  return {
    eligible: eligibleCount === 4 && (!leftBottomJointSupport || Boolean(leftBottomJointSupport.eligible)),
    supportScore: anchoredScore,
    eligibleCount,
    sides,
    leftBottomJointSupport,
    intervalSupport: {
      left: leftIntervalEvidence,
      right: rightIntervalEvidence,
      top: topIntervalEvidence,
      bottom: bottomIntervalEvidence
    }
  };
}

function buildSupportAlignedGuideQuad(rawGuideHints, width, height, options = {}) {
  if (!rawGuideHints) {
    return null;
  }
  const diagnostics = rawGuideHints.diagnostics || {};
  const overallPattern = diagnostics.overallPattern || 'mixed';
  const medianXGap = Number(rawGuideHints.medianXGap) || 0;
  const medianYGap = Number(rawGuideHints.medianYGap) || 0;
  if (!Number.isFinite(medianXGap) || !Number.isFinite(medianYGap) || medianXGap <= 0 || medianYGap <= 0) {
    return null;
  }
  const firstInnerX = Number(diagnostics.firstInnerX);
  const lastInnerX = Number(diagnostics.lastInnerX);
  const firstInnerY = Number(diagnostics.firstInnerY);
  const lastInnerY = Number(diagnostics.lastInnerY);
  if (![firstInnerX, lastInnerX, firstInnerY, lastInnerY].every(Number.isFinite)) {
    return null;
  }
  const inferredLeft = clamp(Math.round(firstInnerX - medianXGap), 0, Math.max(0, width - 1));
  const inferredRight = clamp(Math.round(lastInnerX + medianXGap), inferredLeft + 1, Math.max(1, width - 1));
  const inferredTop = clamp(Math.round(firstInnerY - medianYGap), 0, Math.max(0, height - 1));
  const inferredBottom = clamp(Math.round(lastInnerY + medianYGap), inferredTop + 1, Math.max(1, height - 1));
  const inferredWidth = inferredRight - inferredLeft;
  const inferredHeight = inferredBottom - inferredTop;
  if (!(inferredWidth > 1) || !(inferredHeight > 1)) {
    return null;
  }
  const leftBottomJointSupport = diagnostics.leftBottomJointSupport || null;
  if (
    leftBottomJointSupport
    && (
      !leftBottomJointSupport.eligible
      || (Number(leftBottomJointSupport.score) || 0) < 0.72
    )
  ) {
    return null;
  }

  const referenceQuad = normalizeCornerQuad(options.referenceQuad || null);
  const leftBottomDetail = options.cornerDiagnostics?.leftBottom || null;
  const rightBottomDetail = options.cornerDiagnostics?.rightBottom || null;
  const leftBottomAnchor = Array.isArray(leftBottomDetail?.refined)
    ? leftBottomDetail.refined.map(Number)
    : (referenceQuad ? referenceQuad[3] : null);
  const rightBottomAnchor = Array.isArray(rightBottomDetail?.refined)
    ? rightBottomDetail.refined.map(Number)
    : (referenceQuad ? referenceQuad[2] : null);

  let horizontalUnit = [1, 0];
  let verticalUnit = [0, -1];
  if (referenceQuad) {
    const bottomVector = [
      referenceQuad[2][0] - referenceQuad[3][0],
      referenceQuad[2][1] - referenceQuad[3][1]
    ];
    const leftVector = [
      referenceQuad[0][0] - referenceQuad[3][0],
      referenceQuad[0][1] - referenceQuad[3][1]
    ];
    const normalizedHorizontal = normalizeVector(bottomVector);
    const normalizedVertical = normalizeVector(leftVector);
    if (normalizedHorizontal) {
      horizontalUnit = normalizedHorizontal;
    }
    if (normalizedVertical) {
      verticalUnit = normalizedVertical;
    }
  }

  const anchorToleranceX = Math.max(10, Math.round(medianXGap * 0.12));
  const anchorToleranceY = Math.max(10, Math.round(medianYGap * 0.12));
  const anchoredLeftBottom = leftBottomAnchor
    ? [
        clamp(leftBottomAnchor[0], inferredLeft - anchorToleranceX, inferredLeft + anchorToleranceX),
        clamp(leftBottomAnchor[1], inferredBottom - anchorToleranceY, inferredBottom + anchorToleranceY)
      ]
    : [inferredLeft, inferredBottom];

  let anchoredRightBottom = rightBottomAnchor
    ? [
        clamp(rightBottomAnchor[0], inferredRight - anchorToleranceX, inferredRight + anchorToleranceX),
        clamp(rightBottomAnchor[1], inferredBottom - anchorToleranceY, inferredBottom + anchorToleranceY)
      ]
    : null;

  if (anchoredRightBottom) {
    const anchoredBottomVector = [
      anchoredRightBottom[0] - anchoredLeftBottom[0],
      anchoredRightBottom[1] - anchoredLeftBottom[1]
    ];
    const anchoredHorizontal = normalizeVector(anchoredBottomVector);
    if (
      anchoredHorizontal
      && Math.hypot(anchoredBottomVector[0], anchoredBottomVector[1]) >= Math.max(12, inferredWidth * 0.4)
    ) {
      horizontalUnit = anchoredHorizontal;
    }
  }

  const lb = anchoredLeftBottom;
  const rb = anchoredRightBottom || [
    lb[0] + horizontalUnit[0] * inferredWidth,
    lb[1] + horizontalUnit[1] * inferredWidth
  ];
  let lt = [
    lb[0] + verticalUnit[0] * inferredHeight,
    lb[1] + verticalUnit[1] * inferredHeight
  ];
  let rt = [
    rb[0] + verticalUnit[0] * inferredHeight,
    rb[1] + verticalUnit[1] * inferredHeight
  ];
  if (overallPattern === 'uniform-cells-with-inner-dashed' || overallPattern === 'uniform-boundary-grid') {
    const inferredTopLeft = [inferredLeft, inferredTop];
    const inferredTopRight = [inferredRight, inferredTop];
    lt = [
      average([lt[0], inferredTopLeft[0]]),
      average([lt[1], inferredTopLeft[1]])
    ];
    rt = [
      average([rt[0], inferredTopRight[0]]),
      average([rt[1], inferredTopRight[1]])
    ];
  }

  return normalizeCornerQuad([lt, rt, rb, lb]);
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

function fitQuadToWholeCornerConsistency(corners, options = {}) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  const blend = Number.isFinite(options.blend) ? options.blend : 0.72;
  const [lt, rt, rb, lb] = quad.map(([x, y]) => [Number(x), Number(y)]);
  const centroid = [
    average(quad.map((point) => point[0])),
    average(quad.map((point) => point[1]))
  ];
  const topVector = [rt[0] - lt[0], rt[1] - lt[1]];
  const bottomVector = [rb[0] - lb[0], rb[1] - lb[1]];
  const horizontalDirection = normalizeVector([
    topVector[0] / Math.max(Math.hypot(...topVector), 1e-6) + bottomVector[0] / Math.max(Math.hypot(...bottomVector), 1e-6),
    topVector[1] / Math.max(Math.hypot(...topVector), 1e-6) + bottomVector[1] / Math.max(Math.hypot(...bottomVector), 1e-6)
  ], [1, 0]);
  const rotationAngle = Math.atan2(horizontalDirection[1], horizontalDirection[0]);
  const cosTheta = Math.cos(-rotationAngle);
  const sinTheta = Math.sin(-rotationAngle);
  const rotate = ([x, y]) => {
    const dx = x - centroid[0];
    const dy = y - centroid[1];
    return [
      dx * cosTheta - dy * sinTheta,
      dx * sinTheta + dy * cosTheta
    ];
  };
  const unrotate = ([x, y]) => {
    const cosBack = Math.cos(rotationAngle);
    const sinBack = Math.sin(rotationAngle);
    return [
      centroid[0] + x * cosBack - y * sinBack,
      centroid[1] + x * sinBack + y * cosBack
    ];
  };
  const rotated = quad.map(rotate);
  const leftX = average([rotated[0][0], rotated[3][0]]);
  const rightX = average([rotated[1][0], rotated[2][0]]);
  const topY = average([rotated[0][1], rotated[1][1]]);
  const bottomY = average([rotated[2][1], rotated[3][1]]);
  const fitted = [
    [leftX, topY],
    [rightX, topY],
    [rightX, bottomY],
    [leftX, bottomY]
  ].map(unrotate);
  const blended = quad.map((point, index) => ([
    point[0] * (1 - blend) + fitted[index][0] * blend,
    point[1] * (1 - blend) + fitted[index][1] * blend
  ]));
  return normalizeCornerQuad(blended) || quad;
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

async function exportInferredOuterFrameRectified(imagePath, outputPath, inferredOuterFrame, gridBoundaryDetection, metaPath = null) {
  const outerQuad = normalizeCornerQuad(
    inferredOuterFrame?.outerQuad
    || (
      inferredOuterFrame?.refinedOuterFrame
        ? [
            [inferredOuterFrame.refinedOuterFrame.left, inferredOuterFrame.refinedOuterFrame.top],
            [inferredOuterFrame.refinedOuterFrame.right, inferredOuterFrame.refinedOuterFrame.top],
            [inferredOuterFrame.refinedOuterFrame.right, inferredOuterFrame.refinedOuterFrame.bottom],
            [inferredOuterFrame.refinedOuterFrame.left, inferredOuterFrame.refinedOuterFrame.bottom]
          ]
        : null
    )
  );
  if (!imagePath || !outputPath || !outerQuad) {
    return {
      applied: false,
      reason: 'missing-inferred-outer-quad'
    };
  }

  const refinedOuterFrame = inferredOuterFrame?.refinedOuterFrame || getQuadBounds(outerQuad);
  const innerReferenceQuad = normalizeCornerQuad(
    gridBoundaryDetection?.cornerAnchors?.corners
    || gridBoundaryDetection?.corners
    || buildCornerPointsFromGuides(gridBoundaryDetection?.guides || null)
  );
  const innerReferenceBounds = (
    gridBoundaryDetection?.guides
      ? {
          left: Math.round(Number(gridBoundaryDetection.guides.left || 0)),
          right: Math.round(Number(gridBoundaryDetection.guides.right || 0)),
          top: Math.round(Number(gridBoundaryDetection.guides.top || 0)),
          bottom: Math.round(Number(gridBoundaryDetection.guides.bottom || 0))
        }
      : getQuadBounds(innerReferenceQuad)
  );
  let sourceMargins = (
    refinedOuterFrame
    && innerReferenceBounds
    && innerReferenceBounds.right > innerReferenceBounds.left
    && innerReferenceBounds.bottom > innerReferenceBounds.top
  )
    ? {
        top: Math.max(0, Math.round(innerReferenceBounds.top - refinedOuterFrame.top)),
        bottom: Math.max(0, Math.round(refinedOuterFrame.bottom - innerReferenceBounds.bottom)),
        left: Math.max(0, Math.round(innerReferenceBounds.left - refinedOuterFrame.left)),
        right: Math.max(0, Math.round(refinedOuterFrame.right - innerReferenceBounds.right))
      }
    : null;

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'inferred-outer-frame-'));
  const rawOutputPath = path.join(tempDir, 'outer_frame_rectified_raw.png');
  const rawMetaPath = path.join(tempDir, 'outer_frame_rectified_raw.json');
  let rectifiedMeta = null;
  let croppedOutput = null;
  try {
    rectifiedMeta = await runPaperQuadRectify(imagePath, outerQuad, rawOutputPath, rawMetaPath);
    const { data: rectifiedRgbData, info: rectifiedInfo } = await loadRgbImage(rawOutputPath);
    const projectedInnerReference = innerReferenceQuad
      ? projectSourceQuadToRectifiedPlane(outerQuad, rectifiedMeta, innerReferenceQuad)
      : null;
    if (projectedInnerReference?.bounds) {
      sourceMargins = {
        top: Math.max(0, Math.round(projectedInnerReference.bounds.top)),
        bottom: Math.max(0, Math.round((rectifiedInfo.height - 1) - projectedInnerReference.bounds.bottom)),
        left: Math.max(0, Math.round(projectedInnerReference.bounds.left)),
        right: Math.max(0, Math.round((rectifiedInfo.width - 1) - projectedInnerReference.bounds.right))
      };
    }
    let rectifiedCrop = analyzeRectifiedOuterFrameCrop(rectifiedRgbData, rectifiedInfo);
    if (!rectifiedCrop?.cropBox && innerReferenceBounds) {
      const fallbackMargins = {
        top: Math.max(0, Math.round((innerReferenceBounds.top || refinedOuterFrame.top) - refinedOuterFrame.top)),
        bottom: Math.max(0, Math.round(refinedOuterFrame.bottom - (innerReferenceBounds.bottom || refinedOuterFrame.bottom))),
        left: Math.max(0, Math.round((innerReferenceBounds.left || refinedOuterFrame.left) - refinedOuterFrame.left)),
        right: Math.max(0, Math.round(refinedOuterFrame.right - (innerReferenceBounds.right || refinedOuterFrame.right)))
      };
      const directionalTrimCount = Object.values(fallbackMargins).filter((value) => value >= 1).length;
      if (directionalTrimCount >= 1) {
      const rawWidth = rectifiedInfo.width || 0;
      const rawHeight = rectifiedInfo.height || 0;
      const fallbackLeft = clamp(fallbackMargins.left, 0, Math.max(0, rawWidth - 2));
      const fallbackTop = clamp(fallbackMargins.top, 0, Math.max(0, rawHeight - 2));
      const fallbackRight = clamp(rawWidth - 1 - fallbackMargins.right, fallbackLeft + 1, Math.max(1, rawWidth - 1));
      const fallbackBottom = clamp(rawHeight - 1 - fallbackMargins.bottom, fallbackTop + 1, Math.max(1, rawHeight - 1));
      rectifiedCrop = {
        cropBox: {
          left: fallbackLeft,
          top: fallbackTop,
          right: fallbackRight,
          bottom: fallbackBottom,
          width: fallbackRight - fallbackLeft + 1,
          height: fallbackBottom - fallbackTop + 1
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
        method: 'inferred-outer-frame-margin-fallback'
      };
      }
    }

    const trimWouldCollapseOuterMargin = Boolean(
      rectifiedCrop?.cropBox
      && sourceMargins
      && (
        rectifiedCrop.cropBox.left >= Math.max(8, sourceMargins.left - 2)
        || rectifiedCrop.cropBox.top >= Math.max(8, sourceMargins.top - 2)
        || ((rectifiedInfo.width - 1 - rectifiedCrop.cropBox.right) >= Math.max(8, sourceMargins.right - 2))
        || ((rectifiedInfo.height - 1 - rectifiedCrop.cropBox.bottom) >= Math.max(8, sourceMargins.bottom - 2))
      )
    );
    if (trimWouldCollapseOuterMargin) {
      rectifiedCrop = null;
    }

    if (rectifiedCrop?.cropBox) {
      const cropBox = rectifiedCrop.cropBox;
      await sharp(rawOutputPath)
        .extract({
          left: cropBox.left,
          top: cropBox.top,
          width: cropBox.width,
          height: cropBox.height
        })
        .png()
        .toFile(outputPath);
      croppedOutput = {
        width: cropBox.width,
        height: cropBox.height,
        cropBox,
        method: rectifiedCrop.method || 'rectified-outer-frame-inner-crop',
        immediateInnerFrame: rectifiedCrop.immediateInnerFrame || null,
        removableSides: rectifiedCrop.removableSides || null
      };
    } else {
      await sharp(rawOutputPath).png().toFile(outputPath);
      croppedOutput = {
        width: rectifiedInfo.width || 0,
        height: rectifiedInfo.height || 0,
        cropBox: {
          left: 0,
          top: 0,
          right: Math.max(0, (rectifiedInfo.width || 1) - 1),
          bottom: Math.max(0, (rectifiedInfo.height || 1) - 1),
          width: rectifiedInfo.width || 0,
          height: rectifiedInfo.height || 0
        },
        method: 'rectified-outer-frame-raw'
      };
    }
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  const exportResult = {
    applied: true,
    reason: 'inferred-outer-frame-rectify',
    source: 'inferred_outer_frame',
    outputMode: croppedOutput?.cropBox ? 'outer-frame-rectify-then-crop' : 'outer-frame-rectify-raw',
    outputPath,
    outerQuad,
    refinedOuterFrame,
    innerReference: {
      bounds: innerReferenceBounds || null,
      corners: innerReferenceQuad || null
    },
    sourceMargins: sourceMargins || null,
    rectifiedOuterFrame: rectifiedMeta || null,
    croppedOutput: croppedOutput || null,
    inferredDiagnostics: inferredOuterFrame?.diagnostics || null
  };

  if (metaPath) {
    await fs.promises.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.promises.writeFile(metaPath, `${JSON.stringify(exportResult, null, 2)}\n`, 'utf8');
  }

  return exportResult;
}

function confirmInferredOuterFrameAsRealExtraction(
  inferredOuterFrame,
  inferredOuterFrameRectified = null,
  gridBoundaryDetection = null
) {
  if (!inferredOuterFrame?.applied || !inferredOuterFrameRectified?.applied) {
    return null;
  }
  const diagnostics = inferredOuterFrame?.diagnostics || {};
  const method = String(diagnostics?.method || '');
  const pattern = String(diagnostics?.outerFramePattern || '');
  if (method !== 'pattern-driven-outer-frame-inference' || pattern !== 'full-margin-outer-frame') {
    return null;
  }
  const strongSideCount = Number(diagnostics?.strongSideCount) || 0;
  const moderateSideCount = Number(diagnostics?.moderateSideCount) || 0;
  const sideGapCount = Number(diagnostics?.sideGapCount) || 0;
  const cropMethod = String(inferredOuterFrameRectified?.croppedOutput?.method || '');
  const boundaryConfirmed = Boolean(
    diagnostics?.boundaryFitAdjusted
    || diagnostics?.tiltedQuadFittedAfterTighten
    || diagnostics?.tiltedQuadFitted
  );
  const outerQuad = normalizeCornerQuad(
    inferredOuterFrame?.outerQuad
    || diagnostics?.detectedOuterBorder?.outerQuad
    || null
  );
  const refinedOuterFrame = inferredOuterFrame?.refinedOuterFrame
    || diagnostics?.outerBounds
    || getQuadBounds(outerQuad);
  const innerBounds = gridBoundaryDetection?.guides
    ? {
        left: Math.round(Number(gridBoundaryDetection.guides.left || 0)),
        right: Math.round(Number(gridBoundaryDetection.guides.right || 0)),
        top: Math.round(Number(gridBoundaryDetection.guides.top || 0)),
        bottom: Math.round(Number(gridBoundaryDetection.guides.bottom || 0))
      }
    : (diagnostics?.innerBounds || null);
  const wrapsInner = Boolean(
    refinedOuterFrame
    && innerBounds
    && refinedOuterFrame.left <= innerBounds.left - 2
    && refinedOuterFrame.right >= innerBounds.right + 2
    && refinedOuterFrame.top <= innerBounds.top - 2
    && refinedOuterFrame.bottom >= innerBounds.bottom + 2
  );
  const gapRatio = Number(diagnostics?.gapRatio);
  const horizontalGapRatio = Number(diagnostics?.horizontalGapRatio);
  const verticalGapRatio = Number(diagnostics?.verticalGapRatio);
  const reliablePatternCandidate = Boolean(
    strongSideCount >= 4
    && moderateSideCount >= 4
    && sideGapCount >= 4
    && (!Number.isFinite(gapRatio) || gapRatio <= 8.5)
    && (!Number.isFinite(horizontalGapRatio) || horizontalGapRatio <= 8.5)
    && (!Number.isFinite(verticalGapRatio) || verticalGapRatio <= 3.5)
  );
  const stableRectifiedExport = cropMethod === 'rectified-outer-frame-raw';
  if (!boundaryConfirmed || !outerQuad || !refinedOuterFrame || !wrapsInner || !reliablePatternCandidate || !stableRectifiedExport) {
    return null;
  }
  const cropBox = inferredOuterFrameRectified?.croppedOutput?.cropBox || null;
  const cropAspectRatio = cropBox?.width && cropBox?.height
    ? Number((cropBox.width / cropBox.height).toFixed(4))
    : null;
  return {
    applied: true,
    reason: 'outer-frame-confirmed-from-pattern-boundary-fit',
    component: {
      refinedOuterFrame,
      outerQuad,
      rectifiedOuterFrame: inferredOuterFrameRectified?.rectifiedOuterFrame || null,
      croppedInnerFrame: cropBox,
      cropAspectRatio,
      detectedOuterBorder: diagnostics?.detectedOuterBorder || {
        refinedOuterFrame,
        outerQuad
      },
      innerEdgeAdjusted: Boolean(diagnostics?.innerEdgeAdjusted),
      innerEdgeAdjustedFromRectifiedCrop: diagnostics?.innerEdgeAdjustedFromRectifiedCrop || null,
      immediateInnerFrame: innerBounds ? { ...innerBounds } : null,
      separation: {
        eligible: true,
        reason: 'confirmed-from-pattern-boundary-fit',
        metrics: {
          outerFramePattern: pattern,
          strongSideCount,
          moderateSideCount,
          sideGapCount,
          gapRatio: Number.isFinite(gapRatio) ? Number(gapRatio.toFixed(4)) : null,
          horizontalGapRatio: Number.isFinite(horizontalGapRatio) ? Number(horizontalGapRatio.toFixed(4)) : null,
          verticalGapRatio: Number.isFinite(verticalGapRatio) ? Number(verticalGapRatio.toFixed(4)) : null,
          cropMethod,
          patternProfileFamily: diagnostics?.patternProfileFamily || null,
          patternProfileMode: diagnostics?.patternProfileMode || null
        }
      },
      promotedFromInferred: true,
      promotedFromReason: inferredOuterFrame?.reason || null,
      promotedFromDiagnostics: {
        method,
        boundaryFitAdjusted: Boolean(diagnostics?.boundaryFitAdjusted),
        tiltedQuadFitted: Boolean(diagnostics?.tiltedQuadFitted),
        tiltedQuadFittedAfterTighten: Boolean(diagnostics?.tiltedQuadFittedAfterTighten),
        tightenedByFinalGuides: Boolean(diagnostics?.tightenedByFinalGuides),
        inferredRectifiedOutputMode: inferredOuterFrameRectified?.outputMode || null
      }
    }
  };
}

async function refineOuterFrameEstimateToInnerEdge(imagePath, frameEstimate) {
  const outerQuad = normalizeCornerQuad(
    frameEstimate?.outerQuad
    || (
      frameEstimate?.refinedOuterFrame
        ? [
            [frameEstimate.refinedOuterFrame.left, frameEstimate.refinedOuterFrame.top],
            [frameEstimate.refinedOuterFrame.right, frameEstimate.refinedOuterFrame.top],
            [frameEstimate.refinedOuterFrame.right, frameEstimate.refinedOuterFrame.bottom],
            [frameEstimate.refinedOuterFrame.left, frameEstimate.refinedOuterFrame.bottom]
          ]
        : null
    )
  );
  if (!imagePath || !outerQuad) {
    return frameEstimate || null;
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outer-frame-inner-edge-'));
  const rectifiedPath = path.join(tempDir, 'outer_frame_raw.png');
  const rectifiedMetaPath = path.join(tempDir, 'outer_frame_raw.json');
  try {
    const rectifiedMeta = await runPaperQuadRectify(imagePath, outerQuad, rectifiedPath, rectifiedMetaPath);
    const { data: rectifiedRgbData, info: rectifiedInfo } = await loadRgbImage(rectifiedPath);
    const rectifiedCrop = analyzeRectifiedOuterFrameCrop(rectifiedRgbData, rectifiedInfo);
    if (!rectifiedCrop?.cropBox) {
      return frameEstimate;
    }
    const innerEdgeProjection = projectRectifiedCropBoxToSourceQuad(
      outerQuad,
      rectifiedMeta || rectifiedInfo,
      rectifiedCrop.cropBox
    );
    if (!innerEdgeProjection?.quad || !innerEdgeProjection?.bounds) {
      return frameEstimate;
    }
    const trimValues = Object.values(innerEdgeProjection.rectifiedTrims || {}).filter((value) => Number.isFinite(value));
    const meaningfulTrimCount = trimValues.filter((value) => value >= 2).length;
    if (!meaningfulTrimCount) {
      return frameEstimate;
    }
    const trimLeft = Number(innerEdgeProjection.rectifiedTrims?.left) || 0;
    const trimTop = Number(innerEdgeProjection.rectifiedTrims?.top) || 0;
    const trimRight = Number(innerEdgeProjection.rectifiedTrims?.right) || 0;
    const trimBottom = Number(innerEdgeProjection.rectifiedTrims?.bottom) || 0;
    const rectifiedWidth = Number(rectifiedInfo?.width) || 0;
    const rectifiedHeight = Number(rectifiedInfo?.height) || 0;
    const diagnostics = frameEstimate?.diagnostics || {};
    const pattern = String(diagnostics?.outerFramePattern || '');
    const method = String(diagnostics?.method || '');
    const isStandardLikeOuterFrame = (
      pattern === 'full-margin-outer-frame'
      && method === 'pattern-driven-outer-frame-inference'
    );
    const maxTrimRatioX = isStandardLikeOuterFrame ? 0.06 : 0.12;
    const maxTrimRatioY = isStandardLikeOuterFrame ? 0.06 : 0.12;
    const maxTrimX = Math.max(
      24,
      Math.round(rectifiedWidth * maxTrimRatioX)
    );
    const maxTrimY = Math.max(
      24,
      Math.round(rectifiedHeight * maxTrimRatioY)
    );
    if (trimLeft > maxTrimX || trimRight > maxTrimX || trimTop > maxTrimY || trimBottom > maxTrimY) {
      return frameEstimate;
    }
    const gapHints = diagnostics?.gaps || null;
    if (gapHints && typeof gapHints === 'object') {
      const pairs = [
        ['left', trimLeft, rectifiedWidth],
        ['right', trimRight, rectifiedWidth],
        ['top', trimTop, rectifiedHeight],
        ['bottom', trimBottom, rectifiedHeight]
      ];
      const violatesGapHint = pairs.some(([key, trimValue, span]) => {
        const hintedGap = Number(gapHints[key]);
        if (!Number.isFinite(hintedGap) || hintedGap <= 0) {
          return false;
        }
        const allowedByHint = Math.max(
          12,
          Math.round(hintedGap * (isStandardLikeOuterFrame ? 3.0 : 4.0))
        );
        const allowedBySpan = Math.max(16, Math.round((Number(span) || 0) * (isStandardLikeOuterFrame ? 0.08 : 0.14)));
        return trimValue > Math.min(allowedByHint, allowedBySpan);
      });
      if (violatesGapHint) {
        return frameEstimate;
      }
    }
    return {
      ...frameEstimate,
      outerQuad: innerEdgeProjection.quad,
      refinedOuterFrame: innerEdgeProjection.bounds,
      diagnostics: {
        ...(frameEstimate?.diagnostics || {}),
        innerEdgeAdjusted: true,
        innerEdgeAdjustedFromRectifiedCrop: {
          method: rectifiedCrop.method || null,
          cropBox: rectifiedCrop.cropBox,
          rectifiedTrims: innerEdgeProjection.rectifiedTrims
        },
        detectedOuterBorder: {
          outerQuad,
          refinedOuterFrame: frameEstimate?.refinedOuterFrame || getQuadBounds(outerQuad)
        }
      }
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function detectDenseEdgeBand(values, options = {}) {
  const series = Array.isArray(values)
    ? values.map((value) => Number(value) || 0)
    : [];
  if (!series.length) {
    return null;
  }
  const fromEnd = Boolean(options.fromEnd);
  const length = series.length;
  const searchDepth = clamp(
    Math.round(options.searchDepth ?? Math.max(10, Math.min(length, length * 0.09))),
    4,
    length
  );
  const edgeValues = fromEnd
    ? series.slice(length - searchDepth)
    : series.slice(0, searchDepth);
  const edgeMax = Math.max(...edgeValues);
  const highThreshold = Math.max(
    Number(options.minHighThreshold) || 0.16,
    edgeMax * (Number(options.edgeKeepRatio) || 0.28)
  );
  if (!(edgeMax >= highThreshold)) {
    return null;
  }
  const sustainThreshold = Math.max(
    Number(options.minSustainThreshold) || 0.08,
    highThreshold * (Number(options.sustainRatio) || 0.4)
  );
  const maxGap = Math.max(1, Math.round(Number(options.maxGap) || 2));
  let started = false;
  let gapRun = 0;
  let lastDenseOffset = -1;
  for (let offset = 0; offset < searchDepth; offset += 1) {
    const index = fromEnd ? (length - 1 - offset) : offset;
    const value = series[index];
    if (value >= highThreshold) {
      started = true;
      gapRun = 0;
      lastDenseOffset = offset;
      continue;
    }
    if (started && value >= sustainThreshold) {
      gapRun = 0;
      lastDenseOffset = offset;
      continue;
    }
    if (!started) {
      if (offset >= maxGap) {
        break;
      }
      continue;
    }
    gapRun += 1;
    if (gapRun > maxGap) {
      break;
    }
  }
  if (lastDenseOffset < 0) {
    return null;
  }
  const trim = lastDenseOffset + 1;
  const lastDenseIndex = fromEnd
    ? (length - 1 - lastDenseOffset)
    : lastDenseOffset;
  return {
    trim,
    edgeMax: Number(edgeMax.toFixed(4)),
    highThreshold: Number(highThreshold.toFixed(4)),
    sustainThreshold: Number(sustainThreshold.toFixed(4)),
    lastDenseIndex
  };
}

function detectRectifiedOuterFrameEdgeCrop(gray, width, height) {
  if (!gray || width < 120 || height < 120) {
    return null;
  }
  const spanX0 = clamp(Math.round(width * 0.18), 0, Math.max(0, width - 1));
  const spanX1 = clamp(Math.round(width * 0.82), spanX0 + 1, Math.max(1, width));
  const spanY0 = clamp(Math.round(height * 0.18), 0, Math.max(0, height - 1));
  const spanY1 = clamp(Math.round(height * 0.82), spanY0 + 1, Math.max(1, height));
  const rowDarkRatios = new Array(height).fill(0);
  const colDarkRatios = new Array(width).fill(0);
  const rowSpan = Math.max(1, spanX1 - spanX0);
  const colSpan = Math.max(1, spanY1 - spanY0);
  for (let y = 0; y < height; y += 1) {
    let darkCount = 0;
    for (let x = spanX0; x < spanX1; x += 1) {
      if (gray[y * width + x] < 170) {
        darkCount += 1;
      }
    }
    rowDarkRatios[y] = darkCount / rowSpan;
  }
  for (let x = 0; x < width; x += 1) {
    let darkCount = 0;
    for (let y = spanY0; y < spanY1; y += 1) {
      if (gray[y * width + x] < 170) {
        darkCount += 1;
      }
    }
    colDarkRatios[x] = darkCount / colSpan;
  }

  const topBand = detectDenseEdgeBand(rowDarkRatios, {
    searchDepth: Math.max(12, Math.round(height * 0.08)),
    minHighThreshold: 0.13,
    minSustainThreshold: 0.06,
    maxGap: 2
  });
  const bottomBand = detectDenseEdgeBand(rowDarkRatios, {
    fromEnd: true,
    searchDepth: Math.max(12, Math.round(height * 0.08)),
    minHighThreshold: 0.13,
    minSustainThreshold: 0.06,
    maxGap: 2
  });
  const leftBand = detectDenseEdgeBand(colDarkRatios, {
    searchDepth: Math.max(12, Math.round(width * 0.1)),
    minHighThreshold: 0.18,
    minSustainThreshold: 0.08,
    maxGap: 2
  });
  const rightBand = detectDenseEdgeBand(colDarkRatios, {
    fromEnd: true,
    searchDepth: Math.max(12, Math.round(width * 0.1)),
    minHighThreshold: 0.18,
    minSustainThreshold: 0.08,
    maxGap: 2
  });

  const cropLeft = topBand || bottomBand || leftBand || rightBand
    ? clamp((leftBand?.trim || 0), 0, Math.max(0, width - 2))
    : 0;
  const cropTop = topBand || bottomBand || leftBand || rightBand
    ? clamp((topBand?.trim || 0), 0, Math.max(0, height - 2))
    : 0;
  const cropRight = topBand || bottomBand || leftBand || rightBand
    ? clamp(width - 1 - (rightBand?.trim || 0), cropLeft + 1, Math.max(1, width - 1))
    : width - 1;
  const cropBottom = topBand || bottomBand || leftBand || rightBand
    ? clamp(height - 1 - (bottomBand?.trim || 0), cropTop + 1, Math.max(1, height - 1))
    : height - 1;

  const trimmed = {
    top: topBand?.trim || 0,
    bottom: bottomBand?.trim || 0,
    left: leftBand?.trim || 0,
    right: rightBand?.trim || 0
  };
  const activeSides = Object.values(trimmed).filter((value) => value >= 2).length;
  if (
    activeSides < 2
    || cropRight - cropLeft < Math.round(width * 0.55)
    || cropBottom - cropTop < Math.round(height * 0.55)
  ) {
    return null;
  }

  return {
    cropBox: {
      left: cropLeft,
      top: cropTop,
      right: cropRight,
      bottom: cropBottom,
      width: cropRight - cropLeft + 1,
      height: cropBottom - cropTop + 1
    },
    denseEdgeBands: {
      top: topBand || null,
      bottom: bottomBand || null,
      left: leftBand || null,
      right: rightBand || null
    },
    method: 'rectified-edge-dense-band-crop'
  };
}

function analyzeRectifiedOuterFrameCrop(rgbData, info) {
  const width = info.width || 0;
  const height = info.height || 0;
  if (width < 120 || height < 120) {
    return null;
  }
  const gray = computeGray(rgbData, info.channels);
  const edgeDenseCrop = detectRectifiedOuterFrameEdgeCrop(gray, width, height);
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
    return edgeDenseCrop || null;
  }
  const cropPad = 1;
  const cropLeft = clamp(nearInnerLeft.index - cropPad, 0, width - 1);
  const cropRight = clamp(nearInnerRight.index + cropPad, cropLeft + 1, width - 1);
  const cropTop = clamp(nearInnerTop.index - cropPad, 0, height - 1);
  const cropBottom = clamp(nearInnerBottom.index + cropPad, cropTop + 1, height - 1);
  const cropResult = {
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
    removableSides,
    method: 'rectified-outer-frame-inner-crop'
  };
  if (!edgeDenseCrop?.cropBox) {
    return cropResult;
  }
  const mergedLeft = Math.max(cropResult.cropBox.left, edgeDenseCrop.cropBox.left);
  const mergedTop = Math.max(cropResult.cropBox.top, edgeDenseCrop.cropBox.top);
  const mergedRight = Math.min(cropResult.cropBox.right, edgeDenseCrop.cropBox.right);
  const mergedBottom = Math.min(cropResult.cropBox.bottom, edgeDenseCrop.cropBox.bottom);
  if (mergedRight <= mergedLeft || mergedBottom <= mergedTop) {
    return cropResult;
  }
  return {
    ...cropResult,
    cropBox: {
      left: mergedLeft,
      top: mergedTop,
      right: mergedRight,
      bottom: mergedBottom,
      width: mergedRight - mergedLeft + 1,
      height: mergedBottom - mergedTop + 1
    },
    method: 'rectified-outer-frame-inner-crop+edge-dense-trim',
    denseEdgeBands: edgeDenseCrop.denseEdgeBands || null
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
    outerFrameRectifiedOutputPath = null,
    outerFrameRectifiedMetaPath = null,
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
    outerFrameRectifiedOutputPath = null,
    outerFrameRectifiedMetaPath = null,
    gridAnnotatedOutputPath = null,
    debugPath = null,
    cropToPaper = true,
    ignoreRedGrid = true,
    gridRows = null,
    gridCols = null,
    gridType = 'square',
    disableInternalGridGuideCleanup = false
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
  if (disableInternalGridGuideCleanup) {
    args.push('--disable-internal-grid-guide-cleanup');
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
      headerSuppressionDiagnostics: meta.headerSuppressionDiagnostics || null,
      segmentationReadyDiagnostics: meta.segmentationReadyDiagnostics || null,
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
    outerFrameRectifiedOutputPath = null,
    outerFrameRectifiedMetaPath = null,
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
    enableA4GuideConstraint = processNo === '02',
    disableOuterFrameCleanup = false
  } = options;

  const resolvedOutputPath = outputPath || preprocessInputPath || null;
  const resolvedSegmentationPath = segmentationOutputPath || null;
  const resolvedGuideRemovedPath = guideRemovedOutputPath || null;
  const decoupleOuterFrameFromInnerFrame = processNo === '03';

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
  let effectiveGridRows = orientedGrid.gridRows;
  let effectiveGridCols = orientedGrid.gridCols;

  let outerFrameCleanup = {
    applied: false,
    reason: disableOuterFrameCleanup ? 'disabled' : 'not-attempted'
  };
  let outerFrameExtraction = {
    applied: false,
    reason: outerFrameRectifiedOutputPath ? 'not-attempted' : 'no-output-path'
  };
  if (processNo === '03' && outerFrameRectifiedOutputPath) {
    try {
      await fs.promises.mkdir(path.dirname(outerFrameRectifiedOutputPath), { recursive: true });
      outerFrameExtraction = await removeObviousOuterFrameLines(preprocessInputPath, outerFrameRectifiedOutputPath) || outerFrameExtraction;
      if (outerFrameExtraction?.applied && outerFrameRectifiedMetaPath) {
        await fs.promises.mkdir(path.dirname(outerFrameRectifiedMetaPath), { recursive: true });
        await fs.promises.writeFile(
          outerFrameRectifiedMetaPath,
          `${JSON.stringify(outerFrameExtraction, null, 2)}\n`,
          'utf8'
        );
      } else {
        if (!outerFrameExtraction?.applied) {
          await fs.promises.rm(outerFrameRectifiedOutputPath, { force: true });
        }
        if (outerFrameRectifiedMetaPath) {
          await fs.promises.rm(outerFrameRectifiedMetaPath, { force: true });
        }
      }
    } catch (outerFrameExtractionError) {
      outerFrameExtraction = {
        applied: false,
        reason: 'outer-frame-extraction-error',
        error: outerFrameExtractionError.message
      };
      await fs.promises.rm(outerFrameRectifiedOutputPath, { force: true }).catch(() => {});
      if (outerFrameRectifiedMetaPath) {
        await fs.promises.rm(outerFrameRectifiedMetaPath, { force: true }).catch(() => {});
      }
    }
  }
  let lockedOuterFrameExtraction = (
    decoupleOuterFrameFromInnerFrame
    && outerFrameExtraction?.applied
  )
    ? cloneSerializable(outerFrameExtraction)
    : null;
  if (processNo === '03' && resolvedOutputPath && !disableOuterFrameCleanup) {
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
      const detectionCrop = disableOuterFrameCleanup
        ? null
        : buildGridDetectionCrop(preprocessMeta.width || 0, preprocessMeta.height || 0);
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
        ) || normalizeGridBoundaryGuides({
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
          guides: normalizedGuides,
          globalPattern: normalizedGuides?.globalPattern || null
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

  let topLeadingRowRepair = null;
  if (processNo === '03' && gridBoundaryDetection && !gridBoundaryDetection.error) {
    const leadingRowRepairGuides = buildNormalizedGuideSet(
      gridBoundaryDetection.guides || gridBoundaryDetection.rawGuides || null,
      effectiveGridRows,
      effectiveGridCols
    ) || gridBoundaryDetection.guides || null;
    const repairedTopRows = repairLeadingUniformRowLoss(
      leadingRowRepairGuides,
      gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null,
      await sharp(boundaryInputPath).metadata(),
      effectiveGridRows,
      effectiveGridCols
    );
    topLeadingRowRepair = repairedTopRows?.applied
      ? {
          applied: true,
          ...repairedTopRows.diagnostics
        }
      : {
          applied: false,
          reason: repairedTopRows?.reason || 'not-applicable',
          ...(repairedTopRows?.diagnostics || {})
        };
    if (repairedTopRows?.applied && repairedTopRows.guides && repairedTopRows.corners) {
      effectiveGridRows = Math.max(effectiveGridRows, Number(repairedTopRows.repairedGridRows) || effectiveGridRows);
      const repairedGlobalPattern = detectGlobalGridPattern(
        repairedTopRows.guides,
        gridBoundaryDetection.rawGuides || null,
        effectiveGridRows,
        effectiveGridCols
      );
      gridBoundaryDetection = {
        ...gridBoundaryDetection,
        corners: repairedTopRows.corners,
        cornerAnchors: buildGridCornerAnchors(repairedTopRows.corners, {
          ...repairedTopRows.guides,
          globalPattern: repairedGlobalPattern
        }),
        guides: {
          ...repairedTopRows.guides,
          globalPattern: repairedGlobalPattern
        },
        globalPattern: repairedGlobalPattern
      };
      if (guideRemovalBoundaryDetection && !guideRemovalBoundaryDetection.error) {
        guideRemovalBoundaryDetection = {
          ...guideRemovalBoundaryDetection,
          corners: repairedTopRows.corners,
          cornerAnchors: buildGridCornerAnchors(repairedTopRows.corners, {
            ...repairedTopRows.guides,
            globalPattern: repairedGlobalPattern
          }),
          guides: {
            ...repairedTopRows.guides,
            globalPattern: repairedGlobalPattern
          },
          globalPattern: repairedGlobalPattern
        };
      }
    }
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
  let inferredOuterFrame = null;
  let lockedInferredOuterFrame = null;
  const lockCurrentInferredOuterFrame = (lockedAt) => {
    if (!decoupleOuterFrameFromInnerFrame || lockedInferredOuterFrame || !inferredOuterFrame?.applied) {
      return;
    }
    lockedInferredOuterFrame = buildLockedInferredOuterFrameSnapshot(inferredOuterFrame, lockedAt);
  };
  if (
    processNo === '03'
    && gridBoundaryDetection
    && !gridBoundaryDetection.error
    && !outerFrameExtraction?.applied
    && gridRectification
    && !gridRectification.error
  ) {
    inferredOuterFrame = inferOuterFrameFromGridRectification(
      gridRectification,
      gridBoundaryDetection
    );
    lockCurrentInferredOuterFrame('grid-rectification-inference');
  }
  let detectedPatternProfile = null;
  if (gridBoundaryDetection && !gridBoundaryDetection.error && gridBoundaryDetection.guides) {
    try {
      const resolvedOuterPattern = (
        outerFrameExtraction?.component?.separation?.metrics?.outerFramePattern
        || (inferredOuterFrame?.applied ? inferredOuterFrame?.diagnostics?.outerFramePattern : null)
        || null
      );
      detectedPatternProfile = await analyzeGridPatternProfileByCells(
        boundaryInputPath,
        gridBoundaryDetection.guides,
        {
          outerFramePattern: resolvedOuterPattern,
          colorImagePath: warpedImagePath
        }
      );
      if (detectedPatternProfile) {
        const profiledGuides = mergePatternProfileIntoGuides(
          gridBoundaryDetection.guides,
          detectedPatternProfile,
          resolvedOuterPattern
        );
        gridBoundaryDetection = {
          ...gridBoundaryDetection,
          guides: profiledGuides,
          globalPattern: profiledGuides?.globalPattern || gridBoundaryDetection.globalPattern || null
        };
      }
    } catch (patternProfileError) {
      detectedPatternProfile = {
        error: patternProfileError.message
      };
    }
  }
  if (gridBoundaryDetection && !gridBoundaryDetection.error) {
    try {
      const refinedCorners = await refineGridCornerAnchorsByImage(
        boundaryInputPath,
        gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null,
        gridBoundaryDetection.guides || null,
        {
          rawGuides: gridBoundaryDetection.rawGuides || null,
      topGuideConfirmation: topGuideConfirmation || null,
      topLeadingRowRepair: topLeadingRowRepair || null,
      outerFrameDetected: Boolean(outerFrameExtraction?.applied || inferredOuterFrame?.applied)
        }
      );
      const currentQuad = normalizeCornerQuad(
        gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null
      );
      let finalAppliedQuad = null;
      let refinedQuad = normalizeCornerQuad(refinedCorners?.corners || null);
      let topCornerRecovery = null;
      let standaloneTopExpansionGuard = null;
      let topIntervalPreview = null;
      let topRecoveryIntervalTrusted = false;
      let topRecoveryNeedsIntervalGate = false;
      if (refinedQuad) {
        topCornerRecovery = await recoverTopCornersByInnerGuide(
          boundaryInputPath,
          refinedQuad,
          gridBoundaryDetection.guides || null
        );
        const topRecoveryApplied = Boolean(
          topCornerRecovery?.diagnostics?.corners?.leftTop?.applied
          || topCornerRecovery?.diagnostics?.corners?.rightTop?.applied
        );
        topIntervalPreview = (
          refinedCorners?.diagnostics?.edgeLineFit?.innerGridSupportPreview?.local?.sides?.top?.intervalEvidence
          || refinedCorners?.diagnostics?.edgeLineFit?.innerGridSupportPreview?.dominant?.sides?.top?.intervalEvidence
          || null
        );
        topRecoveryIntervalTrusted = Boolean(
          (Number(topIntervalPreview?.pairConsistencyScore) || 0) >= 0.78
          || (Number(topIntervalPreview?.supportScore) || 0) >= 0.68
        );
        topRecoveryNeedsIntervalGate = Boolean(
          (
            refinedCorners?.diagnostics?.cornerTraversalMode === 'left-bottom-first'
            && refinedCorners?.diagnostics?.leftBottomPriorityByInterval
          )
          && (
            refinedCorners?.diagnostics?.patternProfile?.family === 'inner-dashed-box-grid'
            || refinedCorners?.diagnostics?.globalPattern?.patternProfile?.family === 'inner-dashed-box-grid'
          )
        );
        const dominantTopWeak = (
          (refinedCorners?.diagnostics?.rawGuideHints?.reasons?.top === 'infer-missing-top-line')
          || ((refinedCorners?.diagnostics?.edgeLineFit?.quality?.top?.confidence ?? 1) < 0.8)
          || ((refinedCorners?.diagnostics?.edgeLineFit?.quality?.top?.continuity?.longestRunRatio ?? 1) < 0.5)
          || ((refinedCorners?.diagnostics?.edgeLineFit?.quality?.top?.continuity?.endpointCoverage ?? 1) < 0.75)
        );
        const keepCurrentTopStrongerThanRecovered = (
          refinedCorners?.diagnostics?.cornerTraversalMode === 'left-bottom-first'
          && (refinedCorners?.diagnostics?.edgeLineFit?.quality?.top?.confidence ?? 0) >= 0.84
          && (refinedCorners?.diagnostics?.edgeLineFit?.quality?.top?.continuity?.longestRunRatio ?? 0) >= 0.82
          && (refinedCorners?.diagnostics?.edgeLineFit?.quality?.top?.continuity?.endpointCoverage ?? 0) >= 0.9
        );
        if (
          topCornerRecovery?.corners
          && (!topRecoveryNeedsIntervalGate || topRecoveryIntervalTrusted || !topRecoveryApplied)
          && !keepCurrentTopStrongerThanRecovered
          && (
            !['dominant-edge-lines', 'dominant-edge-stabilized'].includes(refinedCorners?.diagnostics?.outputSource)
            || (topRecoveryApplied && dominantTopWeak)
          )
        ) {
          refinedQuad = mergeTopCornerRecoveryHint(
            refinedQuad,
            topCornerRecovery.corners,
            topCornerRecovery.diagnostics || null,
            refinedCorners?.diagnostics?.cellHeight || 0
          );
        }
        if (processNo === '03') {
          const topExpansionGuardResult = preventStandaloneTopOutwardExpansion(
            refinedQuad,
            gridBoundaryDetection.guides || null,
            topGuideConfirmation || null,
            {
              cellWidth: refinedCorners?.diagnostics?.cellWidth || 0,
              cellHeight: refinedCorners?.diagnostics?.cellHeight || 0
            }
          );
          standaloneTopExpansionGuard = topExpansionGuardResult?.diagnostics || null;
          if (topExpansionGuardResult?.applied && topExpansionGuardResult?.corners) {
            refinedQuad = topExpansionGuardResult.corners;
          }
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
          const resolvedOuterPattern = (
            outerFrameExtraction?.component?.separation?.metrics?.outerFramePattern
            || (inferredOuterFrame?.applied ? inferredOuterFrame?.diagnostics?.outerFramePattern : null)
            || null
          );
          const mergedGuidesWithProfile = detectedPatternProfile
            ? mergePatternProfileIntoGuides(mergedGuides, detectedPatternProfile, resolvedOuterPattern)
            : mergedGuides;
          gridBoundaryDetection = {
            ...gridBoundaryDetection,
            corners: outputQuad,
            cornerAnchors: buildGridCornerAnchors(outputQuad, mergedGuidesWithProfile),
            guides: {
              ...mergedGuidesWithProfile,
              globalPattern: detectGlobalGridPattern(
                mergedGuidesWithProfile,
                gridBoundaryDetection.rawGuides || null,
                effectiveGridRows,
                effectiveGridCols
              ),
              xSource: `${gridBoundaryDetection.guides?.xSource || '外边界固定 + 内部均分'} + 四角点校准`,
              ySource: `${gridBoundaryDetection.guides?.ySource || '外边界固定 + 内部均分'} + 四角点独立校准`
            },
              globalPattern: detectGlobalGridPattern(
                mergedGuidesWithProfile,
                gridBoundaryDetection.rawGuides || null,
                effectiveGridRows,
                effectiveGridCols
              )
            };
            finalAppliedQuad = outputQuad;
            appliedToOutput = true;
          }
        }
      cornerRefinement = refinedCorners?.diagnostics
        ? {
            ...refinedCorners.diagnostics,
            topCornerRecovery: topCornerRecovery?.diagnostics || null,
            topRecoveryNeedsIntervalGate,
            topRecoveryIntervalTrusted,
            topRecoveryIntervalEvidence: topIntervalPreview,
            standaloneTopExpansionGuard,
            appliedToOutput,
            note: appliedToOutput
              ? '四个角点已按局部横竖线交点独立校准，并回写主流程 corners/guides'
              : '当前仅输出四角点独立检测诊断，未覆盖主流程 corners'
          }
        : null;
      cornerRefinement = attachFinalAppliedCornerDiagnostics(cornerRefinement, finalAppliedQuad);

      if (processNo === '03' && !outerFrameExtraction?.applied && !inferredOuterFrame?.applied) {
        inferredOuterFrame = await inferOuterFrameFromPattern(
          boundaryInputPath,
          gridBoundaryDetection,
          cornerRefinement || null,
          {
            processNo
          }
        );
        if (inferredOuterFrame?.applied) {
          lockCurrentInferredOuterFrame('pattern-driven-inference');
          let rerunCornerRefinement = null;
          try {
            let rerunFinalAppliedQuad = null;
            const rerunRefinedCorners = await refineGridCornerAnchorsByImage(
              boundaryInputPath,
              gridBoundaryDetection.cornerAnchors?.corners || gridBoundaryDetection.corners || null,
              gridBoundaryDetection.guides || null,
              {
                rawGuides: gridBoundaryDetection.rawGuides || null,
                topGuideConfirmation: topGuideConfirmation || null,
                outerFrameDetected: true
              }
            );
            const rerunQuad = normalizeCornerQuad(rerunRefinedCorners?.corners || null);
            if (rerunQuad) {
              const rerunGuides = buildGuidesFromCornerQuad(
                rerunQuad,
                gridBoundaryDetection.guides || null,
                effectiveGridRows,
                effectiveGridCols
              );
              if (rerunGuides) {
                const rerunGuidesWithProfile = detectedPatternProfile
                  ? mergePatternProfileIntoGuides(
                    rerunGuides,
                    detectedPatternProfile,
                    (inferredOuterFrame?.applied ? inferredOuterFrame?.diagnostics?.outerFramePattern : null) || null
                  )
                  : rerunGuides;
                gridBoundaryDetection = {
                  ...gridBoundaryDetection,
                  corners: rerunQuad,
                  cornerAnchors: buildGridCornerAnchors(rerunQuad, rerunGuidesWithProfile),
                  guides: {
                    ...rerunGuidesWithProfile,
                    globalPattern: detectGlobalGridPattern(
                      rerunGuidesWithProfile,
                      gridBoundaryDetection.rawGuides || null,
                      effectiveGridRows,
                      effectiveGridCols
                    ),
                    xSource: `${gridBoundaryDetection.guides?.xSource || '外边界固定 + 内部均分'} + 外框语义重跑`,
                    ySource: `${gridBoundaryDetection.guides?.ySource || '外边界固定 + 内部均分'} + 外框语义重跑`
                  },
                  globalPattern: detectGlobalGridPattern(
                    rerunGuidesWithProfile,
                    gridBoundaryDetection.rawGuides || null,
                    effectiveGridRows,
                    effectiveGridCols
                  )
                };
                rerunFinalAppliedQuad = rerunQuad;
              }
            }
            rerunCornerRefinement = rerunRefinedCorners?.diagnostics
              ? {
                  ...rerunRefinedCorners.diagnostics,
                  rerunTriggeredByOuterFrameInference: true,
                  inferredOuterFrame: inferredOuterFrame.diagnostics || null,
                  appliedToOutput: Boolean(rerunQuad),
                  note: '检测到外框后，已按“内框必定存在、外框为附加语义”重新校准内框四角点'
                }
              : null;
            rerunCornerRefinement = attachFinalAppliedCornerDiagnostics(rerunCornerRefinement, rerunFinalAppliedQuad);
          } catch (rerunError) {
            rerunCornerRefinement = {
              method: 'per-corner local line search',
              rerunTriggeredByOuterFrameInference: true,
              appliedToOutput: false,
              error: rerunError.message
            };
          }
          if (rerunCornerRefinement) {
            cornerRefinement = rerunCornerRefinement;
          }
          if (
            !decoupleOuterFrameFromInnerFrame
            && shouldRecalibrateInferredOuterFrameAfterCornerRerun(inferredOuterFrame)
          ) {
            try {
              const recalibratedOuterFrame = await inferOuterFrameFromPattern(
                boundaryInputPath,
                gridBoundaryDetection,
                cornerRefinement || null,
                {
                  processNo,
                  triggeredByCornerRerun: true
                }
              );
              if (recalibratedOuterFrame?.applied) {
                inferredOuterFrame = {
                  ...recalibratedOuterFrame,
                  diagnostics: {
                    ...(recalibratedOuterFrame.diagnostics || {}),
                    recalibratedAfterInnerCornerRerun: true,
                    previousInference: inferredOuterFrame?.diagnostics || null
                  }
                };
              }
            } catch (recalibrateOuterFrameError) {
              inferredOuterFrame = {
                ...inferredOuterFrame,
                diagnostics: {
                  ...(inferredOuterFrame?.diagnostics || {}),
                  recalibratedAfterInnerCornerRerun: false,
                  recalibrateOuterFrameError: recalibrateOuterFrameError.message
                }
              };
            }
          }
        }
      }

      if (
        processNo === '03'
        && inferredOuterFrame?.applied
        && gridBoundaryDetection?.guides
      ) {
        const guideAlignedSource = gridBoundaryDetection.guides || gridBoundaryDetection.rawGuides || null;
        const guideAlignedTopCornerCandidate = normalizeCornerQuad(
          ['leftTop', 'rightTop', 'rightBottom', 'leftBottom'].map((key) => {
            const point = cornerRefinement?.corners?.[key]?.refined || null;
            return Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
              ? [Number(point[0]), Number(point[1])]
              : null;
          })
        );
        const refinedOuterFrameForInnerRecovery = refineInferredOuterFrameTopByLocalCorners(
          inferredOuterFrame,
          guideAlignedTopCornerCandidate,
          {
            cellHeight: refinedCorners?.diagnostics?.cellHeight || 0
          }
        ) || inferredOuterFrame;
        const innerRecoveryOuterFrame = decoupleOuterFrameFromInnerFrame
          ? refinedOuterFrameForInnerRecovery
          : (inferredOuterFrame = refinedOuterFrameForInnerRecovery);
        const consistentTopCandidate = resolveConsistentTopCornerCandidate(
          cornerRefinement?.corners || null,
          {
            cellHeight: refinedCorners?.diagnostics?.cellHeight || 0
          }
        );
        const rectifiedCropRecoveredInner = await recoverInnerQuadFromRectifiedOuterCrop(
          boundaryInputPath,
          innerRecoveryOuterFrame,
          {
            cellWidth: refinedCorners?.diagnostics?.cellWidth || 0,
            cellHeight: refinedCorners?.diagnostics?.cellHeight || 0
          }
        );
        let guideAlignedInnerQuad = null;
        if (
          consistentTopCandidate
          && guideAlignedSource
          && innerRecoveryOuterFrame?.refinedOuterFrame
        ) {
          const outerLeft = Number(innerRecoveryOuterFrame.refinedOuterFrame.left);
          const outerRight = Number(innerRecoveryOuterFrame.refinedOuterFrame.right);
          const outerTop = Number(innerRecoveryOuterFrame.refinedOuterFrame.top);
          const outerBottom = Number(innerRecoveryOuterFrame.refinedOuterFrame.bottom);
          const left = clamp(
            Math.round(Number(guideAlignedSource.left)),
            Math.round(outerLeft),
            Math.round(outerRight - 1)
          );
          const right = clamp(
            Math.round(Number(guideAlignedSource.right)),
            left + 1,
            Math.round(outerRight)
          );
          const bottom = clamp(
            Math.round(Number(guideAlignedSource.bottom)),
            Math.round(outerTop + 1),
            Math.round(outerBottom)
          );
          const topInset = Math.max(2, Math.round((refinedCorners?.diagnostics?.cellHeight || 0) * 0.02));
          const top = clamp(
            Math.round(consistentTopCandidate.top),
            Math.round(outerTop + topInset),
            bottom - 1
          );
          guideAlignedInnerQuad = normalizeCornerQuad([
            [left, top],
            [right, top],
            [right, bottom],
            [left, bottom]
          ]);
          if (String(innerRecoveryOuterFrame?.diagnostics?.method || '') === 'broad-raw-guide-window-outer-frame') {
            guideAlignedInnerQuad = tightenInnerQuadWithinOuterFrame(
              guideAlignedInnerQuad,
              innerRecoveryOuterFrame.refinedOuterFrame || null,
              {
                cellWidth: refinedCorners?.diagnostics?.cellWidth || 0,
                cellHeight: refinedCorners?.diagnostics?.cellHeight || 0,
                insetRatioX: 0.04,
                insetRatioY: 0.05
              }
            );
          }
        }
        if (rectifiedCropRecoveredInner?.quad) {
          const currentBounds = getQuadBounds(guideAlignedInnerQuad);
          const recoveredBounds = rectifiedCropRecoveredInner.bounds || getQuadBounds(rectifiedCropRecoveredInner.quad);
          const recoveredMoreInset = (
            !currentBounds
            || (
              recoveredBounds
              && recoveredBounds.left >= currentBounds.left + 12
              && recoveredBounds.right <= currentBounds.right - 12
              && recoveredBounds.top >= currentBounds.top + 12
              && recoveredBounds.bottom <= currentBounds.bottom - 12
            )
          );
          if (recoveredMoreInset) {
            guideAlignedInnerQuad = rectifiedCropRecoveredInner.quad;
          }
        }
        if (!guideAlignedInnerQuad) {
          guideAlignedInnerQuad = buildInnerQuadConstrainedByOuterFrame(
            gridBoundaryDetection.guides || null,
            gridBoundaryDetection.rawGuides || null,
            innerRecoveryOuterFrame?.refinedOuterFrame || null,
            {
              topCornerCandidate: guideAlignedTopCornerCandidate
            }
          );
        }
        if (guideAlignedInnerQuad) {
          const guideAlignedGuides = buildGuidesFromCornerQuad(
            guideAlignedInnerQuad,
            gridBoundaryDetection.rawGuides || gridBoundaryDetection.guides || null,
            effectiveGridRows,
            effectiveGridCols
          );
          if (guideAlignedGuides) {
            const guideAlignedGuidesWithProfile = detectedPatternProfile
              ? mergePatternProfileIntoGuides(
                guideAlignedGuides,
                detectedPatternProfile,
                (inferredOuterFrame?.applied ? inferredOuterFrame?.diagnostics?.outerFramePattern : null) || null
              )
              : guideAlignedGuides;
            gridBoundaryDetection = {
              ...gridBoundaryDetection,
              corners: guideAlignedInnerQuad,
              cornerAnchors: buildGridCornerAnchors(guideAlignedInnerQuad, guideAlignedGuidesWithProfile),
              guides: {
                ...guideAlignedGuidesWithProfile,
                globalPattern: detectGlobalGridPattern(
                  guideAlignedGuidesWithProfile,
                  gridBoundaryDetection.rawGuides || null,
                  effectiveGridRows,
                  effectiveGridCols
                ),
                xSource: `${gridBoundaryDetection.guides?.xSource || '外边界固定 + 内部均分'} + 外框语义内框回收`,
                ySource: `${gridBoundaryDetection.guides?.ySource || '外边界固定 + 内部均分'} + 外框语义内框回收`
              },
              globalPattern: detectGlobalGridPattern(
                guideAlignedGuidesWithProfile,
                gridBoundaryDetection.rawGuides || null,
                effectiveGridRows,
                effectiveGridCols
              )
            };
            cornerRefinement = attachFinalAppliedCornerDiagnostics(cornerRefinement, guideAlignedInnerQuad, {
              outputSource: 'guide-aligned-inner-frame-after-outer-frame-detection',
              inferredOuterFrame: innerRecoveryOuterFrame?.diagnostics || null,
              rectifiedOuterCropInnerRecovery: rectifiedCropRecoveredInner?.diagnostics || null,
              note: '检测到外框后，内框四角点回收到 guides 语义，避免上下角点落在不同层级的框线上'
            });
          }
        }
      }

      if (
        processNo === '03'
        && !decoupleOuterFrameFromInnerFrame
        && shouldRecalibrateInferredOuterFrameAfterCornerRerun(inferredOuterFrame)
        && gridBoundaryDetection?.guides
      ) {
        try {
          const finalRecalibratedOuterFrame = await inferOuterFrameFromPattern(
            boundaryInputPath,
            gridBoundaryDetection,
            cornerRefinement || null,
            {
              processNo,
              triggeredByFinalInnerFrame: true
            }
          );
          if (finalRecalibratedOuterFrame?.applied) {
            inferredOuterFrame = {
              ...finalRecalibratedOuterFrame,
              diagnostics: {
                ...(finalRecalibratedOuterFrame.diagnostics || {}),
                recalibratedAfterFinalInnerFrame: true,
                previousInference: inferredOuterFrame?.diagnostics || null
              }
            };
          }
        } catch (finalRecalibrateOuterFrameError) {
          inferredOuterFrame = {
            ...inferredOuterFrame,
            diagnostics: {
              ...(inferredOuterFrame?.diagnostics || {}),
              recalibratedAfterFinalInnerFrame: false,
              finalRecalibrateOuterFrameError: finalRecalibrateOuterFrameError.message
            }
          };
        }
      }

      if (
        processNo === '03'
        && !decoupleOuterFrameFromInnerFrame
        && shouldRecalibrateInferredOuterFrameAfterCornerRerun(inferredOuterFrame)
        && gridBoundaryDetection?.guides
      ) {
        inferredOuterFrame = await tightenPatternInferredOuterFrameByFinalGuides(
          boundaryInputPath,
          inferredOuterFrame,
          gridBoundaryDetection.guides
        ) || inferredOuterFrame;
        inferredOuterFrame = await refinePatternInferredOuterFrameQuadByBoundaryFits(
          boundaryInputPath,
          inferredOuterFrame,
          gridBoundaryDetection.guides
        ) || inferredOuterFrame;
      }

      if (
        processNo === '03'
        && !decoupleOuterFrameFromInnerFrame
        && inferredOuterFrame?.applied
        && preprocessInputPath
        && shouldRefineInferredOuterFrameToInnerEdge(inferredOuterFrame)
      ) {
        inferredOuterFrame = await refineOuterFrameEstimateToInnerEdge(
          preprocessInputPath,
          inferredOuterFrame
        ) || inferredOuterFrame;
      }
    } catch (cornerRefineError) {
      cornerRefinement = {
        method: 'per-corner local line search',
        appliedToOutput: false,
        error: cornerRefineError.message
      };
    }
  }

  const outwardOuterFrameExtraction = lockedOuterFrameExtraction || outerFrameExtraction;
  const outwardInferredOuterFrame = lockedInferredOuterFrame || inferredOuterFrame;

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
    const patternDiagnostics = cornerRefinement?.rawGuideHints?.diagnostics || null;
    const globalPatternDiagnostics = (
      cornerRefinement?.globalPattern
      || patternDiagnostics?.globalPattern
      || gridBoundaryDetection?.guides?.globalPattern
      || gridBoundaryDetection?.globalPattern
      || null
    );
    const patternDetail = patternDiagnostics
      ? [
          `pattern=${describeGridPatternMode(patternDiagnostics.overallPattern)}`,
          `x=${describeGridPatternMode(patternDiagnostics.xPattern)}`,
          `y=${describeGridPatternMode(patternDiagnostics.yPattern)}`
        ].join(' ; ')
      : null;
    const globalPatternDetail = globalPatternDiagnostics
      ? [
          `global-grid=${describeGridPatternMode(globalPatternDiagnostics.mode)}`,
          globalPatternDiagnostics.specificMode ? `subdivision=${globalPatternDiagnostics.specificMode}` : null,
          globalPatternDiagnostics.patternProfile?.family ? `profile=${globalPatternDiagnostics.patternProfile.family}` : null,
          globalPatternDiagnostics.patternProfile?.profileMode ? `profile-mode=${globalPatternDiagnostics.patternProfile.profileMode}` : null,
          globalPatternDiagnostics.x?.dominantDividerType ? `divider-x=${globalPatternDiagnostics.x.dominantDividerType}` : null,
          globalPatternDiagnostics.y?.dominantDividerType ? `divider-y=${globalPatternDiagnostics.y.dominantDividerType}` : null
        ].filter(Boolean).join(' ; ')
      : null;
    const normalizedGuideDiagnostics = gridBoundaryDetection?.guides || null;
    const repairDetail = normalizedGuideDiagnostics
      ? [
          normalizedGuideDiagnostics.xSource ? `x-source=${normalizedGuideDiagnostics.xSource}` : null,
          normalizedGuideDiagnostics.ySource ? `y-source=${normalizedGuideDiagnostics.ySource}` : null,
          normalizedGuideDiagnostics.xPatternDiagnostics?.forcedUniformRepair ? 'x-repair=uniform-dominant' : null,
          normalizedGuideDiagnostics.yPatternDiagnostics?.forcedUniformRepair ? 'y-repair=uniform-dominant' : null
        ].filter(Boolean).join(' ; ')
      : null;
    const topGuideLine = Number(topGuideConfirmation?.refinedTop);
    const topGuideAnchorLeft = topGuideConfirmation?.anchors?.leftTop || null;
    const topGuideAnchorRight = topGuideConfirmation?.anchors?.rightTop || null;
    const leftBottomAnchor = gridBoundaryDetection?.cornerAnchors?.namedCorners?.leftBottom || null;
    const cornerSearchWindows = cornerRefinement?.corners || null;
    const localConsistencyQuad = normalizeCornerQuad(['leftTop', 'rightTop', 'rightBottom', 'leftBottom'].map((key) => {
      const point = cornerRefinement?.corners?.[key]?.refined || null;
      return Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
        ? [Number(point[0]), Number(point[1])]
        : null;
    }));
    const localCornerMarkers = ['leftTop', 'rightTop', 'rightBottom', 'leftBottom'].map((key) => {
      const refinedPoint = cornerRefinement?.corners?.[key]?.refined || null;
      if (!Array.isArray(refinedPoint) || !Number.isFinite(Number(refinedPoint[0])) || !Number.isFinite(Number(refinedPoint[1]))) {
        return null;
      }
      const shortLabel = ({
        leftTop: 'LT',
        rightTop: 'RT',
        rightBottom: 'RB',
        leftBottom: 'LB'
      })[key] || key;
      return {
        x: Number(refinedPoint[0]),
        y: Number(refinedPoint[1]),
        stroke: '#1d4ed8',
        fill: '#93c5fd',
        label: `${shortLabel}-local (${Math.round(Number(refinedPoint[0]))},${Math.round(Number(refinedPoint[1]))})`
      };
    }).filter(Boolean);
    const finalCornerMarkers = ['leftTop', 'rightTop', 'rightBottom', 'leftBottom'].map((key) => {
      const finalPoint = cornerRefinement?.finalAppliedCorners?.[key] || null;
      if (!Array.isArray(finalPoint) || !Number.isFinite(Number(finalPoint[0])) || !Number.isFinite(Number(finalPoint[1]))) {
        return null;
      }
      const shortLabel = ({
        leftTop: 'LT',
        rightTop: 'RT',
        rightBottom: 'RB',
        leftBottom: 'LB'
      })[key] || key;
      return {
        x: Number(finalPoint[0]),
        y: Number(finalPoint[1]),
        stroke: '#047857',
        fill: '#6ee7b7',
        label: `${shortLabel}-final (${Math.round(Number(finalPoint[0]))},${Math.round(Number(finalPoint[1]))})`
      };
    }).filter(Boolean);
    const sourceDetail = cornerRefinement
      ? [
          `source=${cornerRefinement.outputSource || 'unknown'}`,
          `role=${cornerRefinement.outputFrameRole || 'inner-frame'}`,
          cornerRefinement.dominantBoundaryRole ? `darkest=${cornerRefinement.dominantBoundaryRole}` : null,
          (outwardInferredOuterFrame?.applied && outwardInferredOuterFrame?.diagnostics?.outerFramePattern)
            ? `outer-pattern=${outwardInferredOuterFrame.diagnostics.outerFramePattern}`
            : null,
          cornerRefinement.cornerTraversalMode ? `corner-order=${cornerRefinement.cornerTraversalMode}` : null,
          cornerRefinement.edgeLineFit?.preferredBandY?.rejectProjectedTopAnchors ? 'guard=reject-top-projected-anchor' : null,
          cornerRefinement.edgeLineFit?.preferredBandY?.rejectProjectedBottomAnchors ? 'guard=reject-bottom-projected-anchor' : null
        ].filter(Boolean).join(' ; ')
      : null;
    const annotationDetail = [patternDetail, globalPatternDetail, repairDetail, sourceDetail].filter(Boolean).join('\n');
    const outerQuad = normalizeCornerQuad(
      outwardOuterFrameExtraction?.component?.outerQuad
      || outwardInferredOuterFrame?.outerQuad
      || (
        outwardOuterFrameExtraction?.component?.refinedOuterFrame
          ? [
              [outwardOuterFrameExtraction.component.refinedOuterFrame.left, outwardOuterFrameExtraction.component.refinedOuterFrame.top],
              [outwardOuterFrameExtraction.component.refinedOuterFrame.right, outwardOuterFrameExtraction.component.refinedOuterFrame.top],
              [outwardOuterFrameExtraction.component.refinedOuterFrame.right, outwardOuterFrameExtraction.component.refinedOuterFrame.bottom],
              [outwardOuterFrameExtraction.component.refinedOuterFrame.left, outwardOuterFrameExtraction.component.refinedOuterFrame.bottom]
            ]
          : (
            outwardInferredOuterFrame?.refinedOuterFrame
              ? [
                  [outwardInferredOuterFrame.refinedOuterFrame.left, outwardInferredOuterFrame.refinedOuterFrame.top],
                  [outwardInferredOuterFrame.refinedOuterFrame.right, outwardInferredOuterFrame.refinedOuterFrame.top],
                  [outwardInferredOuterFrame.refinedOuterFrame.right, outwardInferredOuterFrame.refinedOuterFrame.bottom],
                  [outwardInferredOuterFrame.refinedOuterFrame.left, outwardInferredOuterFrame.refinedOuterFrame.bottom]
                ]
              : null
          )
      )
    );
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
        extraHorizontalLines: Number.isFinite(topGuideLine)
          ? [{
              y: topGuideLine,
              stroke: '#0f766e',
              dasharray: '12 8',
              label: `top-confirm=${Math.round(topGuideLine)}`
            }]
          : [],
        extraPointMarkers: [
          (topGuideAnchorLeft && Number.isFinite(Number(topGuideAnchorLeft.x)) && Number.isFinite(Number(topGuideAnchorLeft.y)))
            ? {
                x: Number(topGuideAnchorLeft.x),
                y: Number(topGuideAnchorLeft.y),
                stroke: '#0f766e',
                fill: '#6ee7b7',
                label: `LT-anchor (${Math.round(Number(topGuideAnchorLeft.x))},${Math.round(Number(topGuideAnchorLeft.y))})`
              }
            : null,
          (topGuideAnchorRight && Number.isFinite(Number(topGuideAnchorRight.x)) && Number.isFinite(Number(topGuideAnchorRight.y)))
            ? {
                x: Number(topGuideAnchorRight.x),
                y: Number(topGuideAnchorRight.y),
                stroke: '#0f766e',
                fill: '#6ee7b7',
                label: `RT-anchor (${Math.round(Number(topGuideAnchorRight.x))},${Math.round(Number(topGuideAnchorRight.y))})`
              }
            : null,
          (Array.isArray(leftBottomAnchor) && Number.isFinite(Number(leftBottomAnchor[0])) && Number.isFinite(Number(leftBottomAnchor[1])))
            ? {
                x: Number(leftBottomAnchor[0]),
                y: Number(leftBottomAnchor[1]),
                stroke: '#7c2d12',
                fill: '#fdba74',
                label: `LB-start (${Math.round(Number(leftBottomAnchor[0]))},${Math.round(Number(leftBottomAnchor[1]))})`
              }
            : null
        ].concat(localCornerMarkers, finalCornerMarkers).filter(Boolean),
        extraRectangles: [
          ['leftTop', 'LT-window', '#0369a1'],
          ['rightTop', 'RT-window', '#0369a1'],
          ['leftBottom', 'LB-window', '#7c2d12']
        ].map(([key, label, stroke]) => {
          const window = cornerSearchWindows?.[key]?.searchWindow || null;
          if (!window || !Array.isArray(window.x) || !Array.isArray(window.y)) {
            return null;
          }
          return {
            box: {
              left: Number(window.x[0]),
              right: Number(window.x[1]),
              top: Number(window.y[0]),
              bottom: Number(window.y[1])
            },
            stroke,
            dasharray: '10 8',
            label
          };
        }).filter(Boolean),
        extraQuads: [
          localConsistencyQuad
            ? {
                corners: localConsistencyQuad,
                stroke: '#0f766e',
                pointFill: '#34d399',
                pointPrefix: 'L',
                dasharray: '10 8'
              }
            : null,
          outerQuad
            ? {
                corners: outerQuad,
                stroke: '#7c3aed',
                pointFill: '#8b5cf6',
                pointPrefix: 'O',
                dasharray: '14 10'
              }
            : null
        ].filter(Boolean),
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

  let inferredOuterFrameRectified = null;
  if (
    processNo === '03'
    && outerFrameRectifiedOutputPath
    && outwardInferredOuterFrame?.applied
    && !(outerFrameExtraction && !outerFrameExtraction.error && outerFrameExtraction.applied)
  ) {
    try {
      inferredOuterFrameRectified = await exportInferredOuterFrameRectified(
        preprocessInputPath,
        outerFrameRectifiedOutputPath,
        outwardInferredOuterFrame,
        gridBoundaryDetection,
        outerFrameRectifiedMetaPath
      );
    } catch (inferredOuterFrameExportError) {
      inferredOuterFrameRectified = {
        applied: false,
        reason: 'inferred-outer-frame-export-error',
        error: inferredOuterFrameExportError.message
      };
      await fs.promises.rm(outerFrameRectifiedOutputPath, { force: true }).catch(() => {});
      if (outerFrameRectifiedMetaPath) {
        await fs.promises.rm(outerFrameRectifiedMetaPath, { force: true }).catch(() => {});
      }
    }
  }
  if (
    processNo === '03'
    && !(outerFrameExtraction && !outerFrameExtraction.error && outerFrameExtraction.applied)
    && outwardInferredOuterFrame?.applied
  ) {
    const promotedOuterFrameExtraction = confirmInferredOuterFrameAsRealExtraction(
      outwardInferredOuterFrame,
      inferredOuterFrameRectified,
      gridBoundaryDetection
    );
    if (promotedOuterFrameExtraction?.applied) {
      outerFrameExtraction = promotedOuterFrameExtraction;
      if (decoupleOuterFrameFromInnerFrame) {
        lockedOuterFrameExtraction = cloneSerializable(promotedOuterFrameExtraction);
      }
    }
  }

  const returnedOuterFrameExtraction = lockedOuterFrameExtraction || outerFrameExtraction;
  const returnedInferredOuterFrame = outwardInferredOuterFrame;

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
    outerFrameRectifiedOutputPath: (
      (returnedOuterFrameExtraction && !returnedOuterFrameExtraction.error && returnedOuterFrameExtraction.applied)
      || inferredOuterFrameRectified?.applied
    )
      ? outerFrameRectifiedOutputPath
      : null,
    outerFrameRectifiedMetaPath: (
      (returnedOuterFrameExtraction && !returnedOuterFrameExtraction.error && returnedOuterFrameExtraction.applied)
      || inferredOuterFrameRectified?.applied
    )
      ? outerFrameRectifiedMetaPath
      : null,
    gridRectifiedOutputPath: correctedGridRectified && !correctedGridRectified.error ? gridRectifiedOutputPath : null,
    gridRectification,
    correctedGridRectified,
    gridRectifiedSourceStep: correctedGridRectified && !correctedGridRectified.error
      ? '03_0_方格背景与边界检测.json'
      : null,
    guideRemovalBoundaryDetection,
    gridBoundaryDetection,
    outerFrameExtraction: returnedOuterFrameExtraction,
    inferredOuterFrame: returnedInferredOuterFrame,
    inferredOuterFrameRectified,
    outerFrameCleanup,
    guideConstraintRepair,
    topGuideConfirmation,
    topLeadingRowRepair,
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
    let fallbackReadableRefinement = null;
    if (result.method === 'fallback_no_quad' && options.enableFallbackReadableRefinement === true) {
      fallbackReadableRefinement = await applyFallbackReadablePreprocess({
        outputPath: options.outputPath || outputPath,
        segmentationOutputPath: options.segmentationOutputPath || result.segmentationOutputPath || outputPath,
        guideSourcePath: result.guideRemovedOutputPath || result.warpedOutputPath || null,
        blurSigma: options.blurSigma || 18
      });
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
      fallbackReadableRefinement,
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
  evaluateDominantEdgeQuadGuard,
  evaluateRelaxedOuterFrameEvidence,
  __internals: {
    estimateNeutralPaperColor,
    buildReadablePreprocess
  }
};
