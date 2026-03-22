const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const gridBoundsDetectPlugin = require('../05_1网格范围检测插件/index');
const boundaryGuideSegmentationPlugin = require('../05_2边界引导切分插件/index');
const segmentationDebugRenderPlugin = require('../05_3切分调试渲染插件/index');
const cellCropPlugin = require('../05_4单格裁切插件/index');

const DEFAULT_GRID_COLS = 10;
const DEFAULT_GRID_ROWS = 7;
const DEFAULT_THRESHOLD = 210;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildDarkMask(data, info, threshold) {
  const { width, height, channels } = info;
  const mask = new Uint8Array(width * height);

  for (let index = 0; index < width * height; index++) {
    const offset = index * channels;
    let intensity = 255;

    for (let channel = 0; channel < Math.min(channels, 3); channel++) {
      intensity = Math.min(intensity, data[offset + channel]);
    }

    mask[index] = intensity < threshold ? 1 : 0;
  }

  return mask;
}

function sumMaskByAxis(mask, width, height, axis) {
  if (axis === 'x') {
    const sums = new Array(width).fill(0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        sums[x] += mask[y * width + x];
      }
    }
    return sums;
  }

  const sums = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sums[y] += mask[y * width + x];
    }
  }
  return sums;
}

function sumMaskWindowByAxis(mask, width, height, axis, window = null) {
  if (!window) {
    return sumMaskByAxis(mask, width, height, axis);
  }

  const left = clamp(window.left, 0, width - 1);
  const right = clamp(window.right, left + 1, width);
  const top = clamp(window.top, 0, height - 1);
  const bottom = clamp(window.bottom, top + 1, height);

  if (axis === 'x') {
    const sums = new Array(width).fill(0);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        sums[x] += mask[y * width + x];
      }
    }
    return sums;
  }

  const sums = new Array(height).fill(0);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      sums[y] += mask[y * width + x];
    }
  }
  return sums;
}

function averageGrayWindowByAxis(data, info, axis, window = null) {
  const { width, height, channels } = info;
  const left = window ? clamp(window.left, 0, width - 1) : 0;
  const right = window ? clamp(window.right, left + 1, width) : width;
  const top = window ? clamp(window.top, 0, height - 1) : 0;
  const bottom = window ? clamp(window.bottom, top + 1, height) : height;

  if (axis === 'y') {
    const values = new Array(height).fill(0);
    const counts = new Array(height).fill(0);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const offset = (y * width + x) * channels;
        let intensity = 255;
        for (let channel = 0; channel < Math.min(channels, 3); channel++) {
          intensity = Math.min(intensity, data[offset + channel]);
        }
        values[y] += 255 - intensity;
        counts[y] += 1;
      }
    }
    return values.map((sum, index) => (counts[index] ? sum / counts[index] : 0));
  }

  const values = new Array(width).fill(0);
  const counts = new Array(width).fill(0);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * channels;
      let intensity = 255;
      for (let channel = 0; channel < Math.min(channels, 3); channel++) {
        intensity = Math.min(intensity, data[offset + channel]);
      }
      values[x] += 255 - intensity;
      counts[x] += 1;
    }
  }
  return values.map((sum, index) => (counts[index] ? sum / counts[index] : 0));
}

function detectLineCenters(sums, axisLength, minimumCoverageRatio) {
  const minimumDarkPixels = Math.max(1, Math.floor(axisLength * minimumCoverageRatio));
  const centers = [];
  let start = -1;

  for (let i = 0; i < sums.length; i++) {
    if (sums[i] >= minimumDarkPixels) {
      if (start === -1) {
        start = i;
      }
      continue;
    }

    if (start !== -1) {
      centers.push(Math.round((start + i - 1) / 2));
      start = -1;
    }
  }

  if (start !== -1) {
    centers.push(Math.round((start + sums.length - 1) / 2));
  }

  return centers;
}

function mergeNearbyCenters(lineCenters, mergeGap) {
  if (!lineCenters.length) {
    return [];
  }

  const sorted = [...lineCenters].sort((a, b) => a - b);
  const groups = [[sorted[0]]];

  for (let index = 1; index < sorted.length; index++) {
    const value = sorted[index];
    const group = groups[groups.length - 1];
    if (value - group[group.length - 1] <= mergeGap) {
      group.push(value);
      continue;
    }
    groups.push([value]);
  }

  return groups.map((group) => Math.round(group.reduce((sum, value) => sum + value, 0) / group.length));
}

function pickBestLineWindow(lineCenters, expectedCount, axisLength) {
  if (lineCenters.length < expectedCount) {
    return null;
  }

  if (lineCenters.length === expectedCount) {
    return lineCenters;
  }

  let best = null;

  for (let start = 0; start <= lineCenters.length - expectedCount; start++) {
    const candidate = lineCenters.slice(start, start + expectedCount);
    const diffs = [];
    for (let index = 1; index < candidate.length; index++) {
      diffs.push(candidate[index] - candidate[index - 1]);
    }

    const span = candidate[candidate.length - 1] - candidate[0];
    const meanDiff = diffs.reduce((sum, value) => sum + value, 0) / Math.max(diffs.length, 1);
    const variance = diffs.reduce((sum, value) => sum + Math.pow(value - meanDiff, 2), 0) / Math.max(diffs.length, 1);
    const deviation = Math.sqrt(variance);
    const edgePenalty = Math.min(candidate[0], axisLength - candidate[candidate.length - 1]);
    const score = span - deviation * 4 + Math.min(edgePenalty, axisLength * 0.08);

    if (!best || score > best.score) {
      best = { score, candidate };
    }
  }

  return best ? best.candidate : null;
}

function selectGridLines(lineCenters, expectedCount, axisLength, options = {}) {
  const {
    mergeGap = Math.max(6, Math.floor(axisLength * 0.006)),
    edgeIgnoreRatio = 0.05
  } = options;

  const merged = mergeNearbyCenters(lineCenters, mergeGap);
  const interior = merged.filter((center) => center > axisLength * edgeIgnoreRatio && center < axisLength * (1 - edgeIgnoreRatio));
  const primary = interior.length >= expectedCount ? interior : merged;

  return pickBestLineWindow(primary, expectedCount, axisLength);
}

function buildGrayProfiles(data, info) {
  const { width, height, channels } = info;
  const xProfile = new Array(width).fill(0);
  const yProfile = new Array(height).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      let intensity = 255;

      for (let channel = 0; channel < Math.min(channels, 3); channel++) {
        intensity = Math.min(intensity, data[offset + channel]);
      }

      const darkness = 255 - intensity;
      xProfile[x] += darkness;
      yProfile[y] += darkness;
    }
  }

  for (let x = 0; x < width; x++) {
    xProfile[x] /= height;
  }

  for (let y = 0; y < height; y++) {
    yProfile[y] /= width;
  }

  return { xProfile, yProfile };
}

function smoothProfile(profile, radius = 3) {
  if (!profile.length || radius <= 0) {
    return [...profile];
  }

  const smoothed = new Array(profile.length).fill(0);
  for (let index = 0; index < profile.length; index++) {
    let sum = 0;
    let count = 0;
    for (let delta = -radius; delta <= radius; delta++) {
      const target = index + delta;
      if (target < 0 || target >= profile.length) {
        continue;
      }
      sum += profile[target];
      count += 1;
    }
    smoothed[index] = count ? sum / count : profile[index];
  }

  return smoothed;
}

function detectProfilePeakCenters(profile, axisLength, cellCount, options = {}) {
  if (!profile.length) {
    return [];
  }

  const {
    peakRatio = 1.35,
    extraOffset = 8
  } = options;
  const smoothed = smoothProfile(profile, Math.max(2, Math.floor(axisLength * 0.002)));
  const baseline = averageProfileValue(smoothed);
  const minPeakValue = Math.max(baseline * peakRatio, baseline + extraOffset);
  const minDistance = Math.max(10, Math.floor((axisLength / Math.max(cellCount, 1)) * 0.35));
  const peaks = [];

  for (let index = 1; index < smoothed.length - 1; index++) {
    const value = smoothed[index];
    if (value < minPeakValue) {
      continue;
    }
    if (value < smoothed[index - 1] || value < smoothed[index + 1]) {
      continue;
    }

    if (peaks.length && index - peaks[peaks.length - 1] < minDistance) {
      if (value > peaks[peaks.length - 1].value) {
        peaks[peaks.length - 1] = { index, value };
      }
      continue;
    }

    peaks.push({ index, value });
  }

  return peaks.map((item) => item.index);
}

function pickBestRegularPeakWindow(peakCenters, expectedCount) {
  if (!peakCenters || peakCenters.length < expectedCount) {
    return null;
  }

  if (peakCenters.length === expectedCount) {
    return peakCenters;
  }

  let best = null;
  for (let start = 0; start <= peakCenters.length - expectedCount; start++) {
    const candidate = peakCenters.slice(start, start + expectedCount);
    const diffs = [];
    for (let index = 1; index < candidate.length; index++) {
      diffs.push(candidate[index] - candidate[index - 1]);
    }
    const meanDiff = diffs.reduce((sum, value) => sum + value, 0) / Math.max(diffs.length, 1);
    const variance = diffs.reduce((sum, value) => sum + Math.pow(value - meanDiff, 2), 0) / Math.max(diffs.length, 1);
    const deviation = Math.sqrt(variance);
    const minimumGap = Math.min(...diffs);
    const maximumGap = Math.max(...diffs);

    if (minimumGap < meanDiff * 0.55) {
      continue;
    }

    if (maximumGap > meanDiff * 1.45) {
      continue;
    }

    const score = meanDiff * 0.4 - deviation * 4 + minimumGap * 0.2;

    if (!best || score > best.score) {
      best = { score, candidate };
    }
  }

  return best ? best.candidate : null;
}

function averageProfileValue(profile) {
  if (!profile.length) {
    return 0;
  }
  return profile.reduce((sum, value) => sum + value, 0) / profile.length;
}

function detectUniformGridByProfile(profile, axisLength, cellCount) {
  const expectedLineCount = cellCount + 1;
  if (!profile.length || axisLength <= cellCount) {
    return null;
  }

  const smoothed = smoothProfile(profile, Math.max(2, Math.floor(axisLength * 0.0025)));
  const average = averageProfileValue(smoothed);
  const estimatedCell = (axisLength - 1) / cellCount;
  const tolerance = Math.max(3, Math.floor(estimatedCell * 0.12));
  const lines = [];
  let interiorStrength = 0;
  let interiorGain = 0;
  let totalOffset = 0;

  for (let index = 0; index < expectedLineCount; index++) {
    const target = Math.round(index * estimatedCell);
    const isEdge = index === 0 || index === expectedLineCount - 1;
    const localTolerance = isEdge
      ? Math.max(tolerance + 6, Math.floor(estimatedCell * 0.18))
      : tolerance;
    let bestPos = target;
    const targetPos = Math.min(Math.max(target, 0), smoothed.length - 1);
    const targetValue = smoothed[targetPos] || 0;
    let bestValue = targetValue;
    let bestScore = bestValue;

    for (let delta = -localTolerance; delta <= localTolerance; delta++) {
      const pos = target + delta;
      if (pos < 0 || pos >= smoothed.length) {
        continue;
      }
      const value = smoothed[pos];
      const offsetPenalty = Math.abs(delta) * (isEdge ? 0.12 : 0.18);
      const score = value - offsetPenalty;
      if (score > bestScore) {
        bestValue = value;
        bestPos = pos;
        bestScore = score;
      }
    }

    if (isEdge && Math.abs(bestPos - targetPos) > Math.max(4, Math.floor(estimatedCell * 0.05))) {
      const requiredGain = Math.max(8, average * 0.4);
      if (bestValue - targetValue < requiredGain) {
        bestPos = targetPos;
        bestValue = targetValue;
      }
    }

    lines.push(bestPos);
    if (!isEdge) {
      interiorStrength += bestValue;
      interiorGain += bestValue - (smoothed[target] || 0);
      totalOffset += Math.abs(bestPos - target);
    }
  }

  const mergedLines = mergeNearbyCenters(lines, Math.max(2, Math.floor(estimatedCell * 0.04)));
  if (mergedLines.length !== expectedLineCount) {
    return null;
  }

  const diffs = [];
  for (let index = 1; index < mergedLines.length; index++) {
    diffs.push(mergedLines[index] - mergedLines[index - 1]);
  }
  const meanDiff = diffs.reduce((sum, value) => sum + value, 0) / Math.max(diffs.length, 1);
  const variance = diffs.reduce((sum, value) => sum + Math.pow(value - meanDiff, 2), 0) / Math.max(diffs.length, 1);
  const deviation = Math.sqrt(variance);
  const averageStrength = interiorStrength / Math.max(expectedLineCount - 2, 1);
  const averageGain = interiorGain / Math.max(expectedLineCount - 2, 1);
  const averageOffset = totalOffset / Math.max(expectedLineCount - 2, 1);

  if (averageStrength < Math.max(average * 1.08, 1.0)) {
    return null;
  }

  if (averageGain < 0.3 || averageOffset > tolerance * 0.9 || deviation > estimatedCell * 0.12) {
    return null;
  }

  return {
    score: averageStrength - deviation,
    lines: mergedLines,
    averageStrength,
    deviation
  };
}

function detectSquareGridHorizontalLines(mask, width, height, verticalLines, gridRows) {
  if (!verticalLines || verticalLines.length < 2) {
    return null;
  }

  const averageCellSize = (verticalLines[verticalLines.length - 1] - verticalLines[0]) / (verticalLines.length - 1);
  const minCellSize = Math.max(20, Math.round(averageCellSize * 0.9));
  const maxCellSize = Math.max(minCellSize, Math.round(averageCellSize * 1.1));
  const window = {
    left: Math.max(0, verticalLines[0] - 8),
    right: Math.min(width, verticalLines[verticalLines.length - 1] + 8),
    top: 0,
    bottom: height
  };
  const rowSums = sumMaskWindowByAxis(mask, width, height, 'y', window);
  let best = null;

  for (let cellSize = minCellSize; cellSize <= maxCellSize; cellSize++) {
    const maxTop = Math.min(height - cellSize * gridRows - 1, Math.round(cellSize * 1.2));
    if (maxTop < 0) {
      continue;
    }

    const tolerance = Math.max(4, Math.floor(cellSize * 0.03));
    for (let top = 0; top <= maxTop; top++) {
      const lines = [];
      let score = 0;

      for (let index = 0; index <= gridRows; index++) {
        const target = Math.round(top + index * cellSize);
        let bestValue = 0;
        let bestY = target;

        for (let delta = -tolerance; delta <= tolerance; delta++) {
          const y = target + delta;
          if (y < 0 || y >= rowSums.length) {
            continue;
          }
          if (rowSums[y] > bestValue) {
            bestValue = rowSums[y];
            bestY = y;
          }
        }

        lines.push(bestY);
        score += bestValue;
      }

      score -= top * 0.15;

      if (!best || score > best.score) {
        best = {
          score,
          lines: mergeNearbyCenters(lines, Math.max(4, Math.floor(cellSize * 0.05)))
        };
      }
    }
  }

  return best && best.lines.length === gridRows + 1 ? best.lines : null;
}

function detectHorizontalLinesBySide(mask, data, info, width, height, verticalLines, gridRows, side) {
  if (!verticalLines || verticalLines.length < 2) {
    return null;
  }

  const expectedCount = gridRows + 1;
  const cellWidth = (verticalLines[verticalLines.length - 1] - verticalLines[0]) / (verticalLines.length - 1);
  const bandWidth = Math.max(10, Math.min(20, Math.round(cellWidth * 0.08)));
  const anchorX = side === 'left' ? verticalLines[0] : verticalLines[verticalLines.length - 1];
  const window = side === 'left'
    ? { left: Math.max(0, anchorX - bandWidth), right: Math.min(width, anchorX + bandWidth), top: 0, bottom: height }
    : { left: Math.max(0, anchorX - bandWidth), right: Math.min(width, anchorX + bandWidth), top: 0, bottom: height };

  const rowSums = sumMaskWindowByAxis(mask, width, height, 'y', window);
  const raw = detectLineCenters(rowSums, window.right - window.left, 0.12);
  const selected = selectGridLines(raw, expectedCount, height, {
    mergeGap: Math.max(8, Math.floor(height * 0.008)),
    edgeIgnoreRatio: 0.005
  });
  if (selected && selected.length === expectedCount) {
    return selected;
  }

  const grayProfile = averageGrayWindowByAxis(data, info, 'y', window);
  const byUniform = detectUniformGridByProfile(grayProfile, height, gridRows);
  if (byUniform && byUniform.lines.length === expectedCount) {
    return byUniform.lines;
  }

  const strongPeaks = pickBestRegularPeakWindow(
    detectProfilePeakCenters(grayProfile, height, gridRows, {
      peakRatio: 1.55,
      extraOffset: 10
    }),
    expectedCount
  );
  return strongPeaks && strongPeaks.length === expectedCount ? strongPeaks : null;
}

function mergeSideHorizontalLines(centerLines, leftLines, rightLines) {
  if (!centerLines) {
    return leftLines || rightLines || null;
  }

  if (!leftLines && !rightLines) {
    return centerLines;
  }

  const merged = [];
  for (let index = 0; index < centerLines.length; index++) {
    const candidates = [centerLines[index]];
    if (leftLines && leftLines[index] !== undefined) {
      candidates.push(leftLines[index]);
    }
    if (rightLines && rightLines[index] !== undefined) {
      candidates.push(rightLines[index]);
    }
    merged.push(Math.round(candidates.reduce((sum, value) => sum + value, 0) / candidates.length));
  }
  return merged;
}

function fitUniformLinesFromAnchors(lineCenters, axisLength, cellCount) {
  const expectedCount = cellCount + 1;
  if (!lineCenters || lineCenters.length !== expectedCount) {
    return null;
  }

  const start = lineCenters[0];
  const end = lineCenters[lineCenters.length - 1];
  if (end <= start) {
    return null;
  }

  const fitted = [];
  for (let index = 0; index < expectedCount; index++) {
    fitted.push(Math.round(start + ((end - start) * index) / cellCount));
  }

  if (fitted[0] < 0 || fitted[fitted.length - 1] >= axisLength) {
    return null;
  }

  return fitted;
}

function buildSideConsensusLines(leftLines, rightLines, axisLength, cellCount) {
  const expectedCount = cellCount + 1;
  if ((!leftLines || leftLines.length !== expectedCount) && (!rightLines || rightLines.length !== expectedCount)) {
    return null;
  }

  const merged = [];
  for (let index = 0; index < expectedCount; index++) {
    const values = [];
    if (leftLines && leftLines[index] !== undefined) {
      values.push(leftLines[index]);
    }
    if (rightLines && rightLines[index] !== undefined) {
      values.push(rightLines[index]);
    }
    if (!values.length) {
      return null;
    }
    merged.push(Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
  }

  return fitUniformLinesFromAnchors(merged, axisLength, cellCount);
}

function evaluateTailLineUniformity(lineCenters, fromIndex = 0) {
  if (!lineCenters || lineCenters.length < 2 || fromIndex >= lineCenters.length - 1) {
    return null;
  }

  const diffs = [];
  for (let index = fromIndex + 1; index < lineCenters.length; index++) {
    diffs.push(lineCenters[index] - lineCenters[index - 1]);
  }
  if (!diffs.length) {
    return null;
  }

  const meanDiff = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const variance = diffs.reduce((sum, value) => sum + Math.pow(value - meanDiff, 2), 0) / diffs.length;
  return {
    meanDiff,
    deviation: Math.sqrt(variance),
    maxGap: Math.max(...diffs),
    minGap: Math.min(...diffs)
  };
}

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function applyAnomalousHorizontalCorrection(primaryLines, candidateLines, gridRows) {
  if (!primaryLines || !candidateLines || primaryLines.length !== candidateLines.length) {
    return {
      lines: primaryLines,
      corrections: []
    };
  }

  const expectedCount = gridRows + 1;
  if (primaryLines.length !== expectedCount) {
    return {
      lines: primaryLines,
      corrections: []
    };
  }

  const primaryDiffs = [];
  const candidateDiffs = [];
  for (let index = 1; index < expectedCount; index++) {
    primaryDiffs.push(primaryLines[index] - primaryLines[index - 1]);
    candidateDiffs.push(candidateLines[index] - candidateLines[index - 1]);
  }

  const targetGap = median(primaryDiffs.slice(0, Math.max(3, primaryDiffs.length - 2)));
  const improvementCandidates = [];
  for (let index = 0; index < primaryDiffs.length; index++) {
    const primaryError = Math.abs(primaryDiffs[index] - targetGap);
    const candidateError = Math.abs(candidateDiffs[index] - targetGap);
    const boundaryShift = Math.abs(candidateLines[index + 1] - primaryLines[index + 1]);
    const improves = primaryError - candidateError;
    if (improves >= 6 && boundaryShift <= targetGap * 0.22) {
      improvementCandidates.push({ index, improves, boundaryShift });
    }
  }

  if (!improvementCandidates.length) {
    return {
      lines: primaryLines,
      corrections: []
    };
  }

  improvementCandidates.sort((a, b) => b.improves - a.improves);
  const corrected = [...primaryLines];
  const corrections = [];
  let activeScore = null;

  for (const item of improvementCandidates.slice(0, 5)) {
    const gapIndex = item.index;
    const trial = [...corrected];
    trial[gapIndex + 1] = candidateLines[gapIndex + 1];
    const startIndex = Math.max(0, gapIndex - 1);
    const baselineEval = evaluateTailLineUniformity(corrected, startIndex);
    const trialEval = evaluateTailLineUniformity(trial, startIndex);
    if (!baselineEval || !trialEval) {
      continue;
    }

    const baselineScore = baselineEval.deviation * 2 + (baselineEval.maxGap - baselineEval.minGap);
    const trialScore = trialEval.deviation * 2 + (trialEval.maxGap - trialEval.minGap);
    if (trialScore + 2 >= baselineScore) {
      continue;
    }

    corrected[gapIndex + 1] = candidateLines[gapIndex + 1];
    corrections.push({
      boundaryIndex: gapIndex + 1,
      from: primaryLines[gapIndex + 1],
      to: candidateLines[gapIndex + 1]
    });
    activeScore = trialScore;
  }

  if (corrections.length) {
    const startIndex = Math.max(0, Math.min(...corrections.map((item) => item.boundaryIndex - 1)) - 1);
    const primaryEval = evaluateTailLineUniformity(primaryLines, startIndex);
    const correctedEval = evaluateTailLineUniformity(corrected, startIndex);
    if (!primaryEval || !correctedEval) {
      return {
        lines: primaryLines,
        corrections: []
      };
    }

    const primaryScore = primaryEval.deviation * 2 + (primaryEval.maxGap - primaryEval.minGap);
    const correctedScore = activeScore ?? (correctedEval.deviation * 2 + (correctedEval.maxGap - correctedEval.minGap));

    if (correctedScore + 4 < primaryScore) {
      return {
        lines: corrected,
        corrections
      };
    }
  }

  return {
    lines: primaryLines,
    corrections: []
  };
}

function looksLikeCompleteGridLines(lineCenters, axisLength, averageCellSize) {
  if (!lineCenters || lineCenters.length < 2) {
    return false;
  }

  return (
    lineCenters[0] <= averageCellSize * 0.75 &&
    axisLength - lineCenters[lineCenters.length - 1] <= averageCellSize * 0.75
  );
}

function evaluateGridLineSet(lineCenters, axisLength, cellCount) {
  const expectedCount = cellCount + 1;
  if (!lineCenters || lineCenters.length !== expectedCount) {
    return null;
  }

  const sorted = [...lineCenters].sort((a, b) => a - b);
  const diffs = [];
  for (let index = 1; index < sorted.length; index++) {
    diffs.push(sorted[index] - sorted[index - 1]);
  }

  const expectedCellSize = (axisLength - 1) / cellCount;
  const meanDiff = diffs.reduce((sum, value) => sum + value, 0) / Math.max(diffs.length, 1);
  const variance = diffs.reduce((sum, value) => sum + Math.pow(value - meanDiff, 2), 0) / Math.max(diffs.length, 1);
  const deviation = Math.sqrt(variance);
  const meanError = Math.abs(meanDiff - expectedCellSize);
  const startGap = Math.abs(sorted[0] - 0);
  const endGap = Math.abs((axisLength - 1) - sorted[sorted.length - 1]);
  const span = sorted[sorted.length - 1] - sorted[0];
  const expectedSpan = axisLength - 1;
  const spanError = Math.abs(span - expectedSpan);
  const minimumGap = Math.min(...diffs);
  const maximumGap = Math.max(...diffs);

  if (minimumGap < expectedCellSize * 0.45) {
    return null;
  }

  if (maximumGap > expectedCellSize * 1.75) {
    return null;
  }

  const score =
    200 -
    deviation * 1.8 -
    meanError * 2.2 -
    startGap * 1.4 -
    endGap * 1.4 -
    spanError * 0.6 +
    Math.min(20, minimumGap * 0.05);

  return {
    lines: sorted,
    score,
    deviation,
    meanError,
    startGap,
    endGap,
    spanError
  };
}

function chooseBestGridLines(primaryLines, secondaryLines, axisLength, cellCount) {
  const primary = evaluateGridLineSet(primaryLines, axisLength, cellCount);
  const secondary = evaluateGridLineSet(secondaryLines, axisLength, cellCount);

  if (!primary) {
    return secondary ? secondary.lines : null;
  }
  if (!secondary) {
    return primary.lines;
  }

  return secondary.score > primary.score ? secondary.lines : primary.lines;
}

function chooseBestGridLinesFromCandidates(candidates, axisLength, cellCount) {
  let best = null;
  for (const lineCenters of candidates) {
    const evaluated = evaluateGridLineSet(lineCenters, axisLength, cellCount);
    if (!evaluated) {
      continue;
    }
    if (!best || evaluated.score > best.score) {
      best = evaluated;
    }
  }
  return best ? best.lines : null;
}

function buildBoundariesFromLines(lineCenters, fullLength, expectedCellCount) {
  if (lineCenters.length !== expectedCellCount + 1) {
    return null;
  }

  const boundaries = [];
  for (let i = 0; i < lineCenters.length - 1; i++) {
    const left = lineCenters[i];
    const right = lineCenters[i + 1];
    if (right <= left) {
      return null;
    }
    boundaries.push([left, right]);
  }

  if (boundaries[0][0] < 0 || boundaries[boundaries.length - 1][1] > fullLength) {
    return null;
  }

  return boundaries;
}

function buildUniformBoundaries(start, end, cellCount) {
  const length = end - start;
  if (length <= 0) {
    throw new Error('检测到的网格区域无效');
  }

  const boundaries = [];
  for (let i = 0; i < cellCount; i++) {
    const cellStart = Math.round(start + (length * i) / cellCount);
    const cellEnd = Math.round(start + (length * (i + 1)) / cellCount);
    boundaries.push([cellStart, cellEnd]);
  }

  return boundaries;
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildGridAlignmentStats(cells, gridRows, gridCols) {
  const rowHeights = [];
  const colWidths = [];

  for (let row = 0; row < gridRows; row++) {
    const heights = [];
    for (let col = 0; col < gridCols; col++) {
      heights.push(cells[row * gridCols + col].pageBox.height);
    }
    rowHeights.push(Math.round(average(heights) * 100) / 100);
  }

  for (let col = 0; col < gridCols; col++) {
    const widths = [];
    for (let row = 0; row < gridRows; row++) {
      widths.push(cells[row * gridCols + col].pageBox.width);
    }
    colWidths.push(Math.round(average(widths) * 100) / 100);
  }

  const avgRowHeight = average(rowHeights);
  const avgColWidth = average(colWidths);
  const rowHeightDeviation = rowHeights.map((value) => Math.round(Math.abs(value - avgRowHeight) * 100) / 100);
  const colWidthDeviation = colWidths.map((value) => Math.round(Math.abs(value - avgColWidth) * 100) / 100);

  return {
    averageRowHeight: Math.round(avgRowHeight * 100) / 100,
    averageColWidth: Math.round(avgColWidth * 100) / 100,
    rowHeights,
    colWidths,
    rowHeightDeviation,
    colWidthDeviation,
    maxRowHeightDeviation: rowHeightDeviation.length ? Math.max(...rowHeightDeviation) : 0,
    maxColWidthDeviation: colWidthDeviation.length ? Math.max(...colWidthDeviation) : 0
  };
}

function evaluateBoundaryQuality(boundariesX, boundariesY, data, info) {
  if (!boundariesX || !boundariesY) {
    return null;
  }

  const metrics = [];
  for (const [left, right] of boundariesX) {
    for (const [top, bottom] of boundariesY) {
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) {
        return null;
      }

      let darkPixels = 0;
      let weightedX = 0;
      let weightedY = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * info.width + x) * info.channels;
          let intensity = 255;
          for (let channel = 0; channel < Math.min(info.channels, 3); channel++) {
            intensity = Math.min(intensity, data[offset + channel]);
          }
          const darkness = 255 - intensity;
          if (darkness < 48) {
            continue;
          }
          darkPixels += 1;
          weightedX += x - left;
          weightedY += y - top;
        }
      }

      const area = width * height;
      const darkRatio = area > 0 ? darkPixels / area : 0;
      const centerX = darkPixels ? weightedX / darkPixels / width : 0.5;
      const centerY = darkPixels ? weightedY / darkPixels / height : 0.5;
      const centerOffset = Math.abs(centerX - 0.5) + Math.abs(centerY - 0.5);
      metrics.push({
        darkRatio,
        blank: darkRatio < 0.012,
        centerOffset
      });
    }
  }

  const blankCount = metrics.filter((item) => item.blank).length;
  const nonBlank = metrics.filter((item) => !item.blank);
  const averageDarkRatio = average(nonBlank.map((item) => item.darkRatio));
  const averageCenterOffset = average(nonBlank.map((item) => item.centerOffset));
  const score =
    averageDarkRatio * 900 -
    averageCenterOffset * 120 -
    blankCount * 2;

  return {
    blankCount,
    averageDarkRatio: Math.round(averageDarkRatio * 10000) / 10000,
    averageCenterOffset: Math.round(averageCenterOffset * 10000) / 10000,
    score: Math.round(score * 100) / 100
  };
}

function detectGridBounds(mask, width, height) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) {
        continue;
      }

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX === -1 || maxY === -1) {
    return {
      minX: 0,
      maxX: width,
      minY: 0,
      maxY: height,
      width,
      height
    };
  }

  return {
    minX,
    maxX: maxX + 1,
    minY,
    maxY: maxY + 1,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function expandBounds(bounds, width, height, paddingRatio = 0.015) {
  const paddingX = Math.max(2, Math.floor(bounds.width * paddingRatio));
  const paddingY = Math.max(2, Math.floor(bounds.height * paddingRatio));
  const left = clamp(bounds.minX - paddingX, 0, width - 1);
  const top = clamp(bounds.minY - paddingY, 0, height - 1);
  const right = clamp(bounds.maxX + paddingX, left + 1, width);
  const bottom = clamp(bounds.maxY + paddingY, top + 1, height);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  };
}

function resolveGridSlices(mask, width, height, gridCols, gridRows, grayProfiles = null, workingData = null, workingInfo = null) {
  const expectedVerticalCount = gridCols + 1;
  const expectedHorizontalCount = gridRows + 1;
  const columnSums = sumMaskByAxis(mask, width, height, 'x');
  const verticalCandidates = detectLineCenters(columnSums, height, 0.45);
  let verticalLines = selectGridLines(verticalCandidates, expectedVerticalCount, width);
  const profileVertical = grayProfiles
    ? detectUniformGridByProfile(grayProfiles.xProfile, width, gridCols)
    : null;
  const strongVerticalPeaks = grayProfiles
    ? pickBestRegularPeakWindow(
        detectProfilePeakCenters(grayProfiles.xProfile, width, gridCols, {
          peakRatio: 2.3,
          extraOffset: 20
        }),
        expectedVerticalCount
      )
    : null;
  const profileVerticalPeaks = grayProfiles
    ? pickBestRegularPeakWindow(
        detectProfilePeakCenters(grayProfiles.xProfile, width, gridCols),
        expectedVerticalCount
      )
    : null;
  verticalLines = chooseBestGridLines(
    verticalLines,
    profileVertical ? profileVertical.lines : (strongVerticalPeaks || profileVerticalPeaks),
    width,
    gridCols
  );

  const directXBoundaries = verticalLines
    ? buildBoundariesFromLines(verticalLines, width, gridCols)
    : null;
  const outerRectVerticalLines = verticalLines
    ? (fitUniformLinesFromAnchors(verticalLines, width, gridCols) || verticalLines)
    : null;
  const outerRectXBoundaries = outerRectVerticalLines
    ? buildBoundariesFromLines(outerRectVerticalLines, width, gridCols)
    : null;
  let xBoundaries = directXBoundaries || outerRectXBoundaries;

  let horizontalLines = null;
  let leftHorizontalLines = null;
  let rightHorizontalLines = null;
  if (verticalLines) {
    const horizontalWindow = {
      left: Math.max(0, verticalLines[0] - 8),
      right: Math.min(width, verticalLines[verticalLines.length - 1] + 8),
      top: 0,
      bottom: height
    };
    const rowSums = sumMaskWindowByAxis(mask, width, height, 'y', horizontalWindow);
    const rawHorizontal = detectLineCenters(rowSums, horizontalWindow.right - horizontalWindow.left, 0.45);
    const selectedHorizontal = selectGridLines(rawHorizontal, expectedHorizontalCount, height, {
      mergeGap: Math.max(8, Math.floor(height * 0.008)),
      edgeIgnoreRatio: 0.01
    });
    const averageCellSize = (verticalLines[verticalLines.length - 1] - verticalLines[0]) / (verticalLines.length - 1);

    horizontalLines = looksLikeCompleteGridLines(selectedHorizontal, height, averageCellSize)
      ? selectedHorizontal
      : detectSquareGridHorizontalLines(mask, width, height, verticalLines, gridRows);

    if (workingData && workingInfo) {
      leftHorizontalLines = detectHorizontalLinesBySide(
        mask,
        workingData,
        workingInfo,
        width,
        height,
        verticalLines,
        gridRows,
        'left'
      );
      rightHorizontalLines = detectHorizontalLinesBySide(
        mask,
        workingData,
        workingInfo,
        width,
        height,
        verticalLines,
        gridRows,
        'right'
      );
    }
  }

  if (!horizontalLines) {
    const rowSums = sumMaskByAxis(mask, width, height, 'y');
    const rawHorizontal = detectLineCenters(rowSums, width, 0.45);
    horizontalLines = selectGridLines(rawHorizontal, expectedHorizontalCount, height, {
      mergeGap: Math.max(8, Math.floor(height * 0.008)),
      edgeIgnoreRatio: 0.01
    });
  }

  const profileHorizontal = grayProfiles
    ? detectUniformGridByProfile(grayProfiles.yProfile, height, gridRows)
    : null;
  const profileHorizontalPeaks = grayProfiles
    ? pickBestRegularPeakWindow(
        detectProfilePeakCenters(grayProfiles.yProfile, height, gridRows),
        expectedHorizontalCount
      )
    : null;
  const sideConsensusHorizontal = buildSideConsensusLines(
    leftHorizontalLines,
    rightHorizontalLines,
    height,
    gridRows
  );
  const horizontalLinesBeforeAnomalousCorrection = horizontalLines ? [...horizontalLines] : [];
  horizontalLines = chooseBestGridLines(
    horizontalLines,
    profileHorizontal ? profileHorizontal.lines : profileHorizontalPeaks,
    height,
    gridRows
  );
  const horizontalLinesBeforeCorrection = horizontalLines ? [...horizontalLines] : [];
  const anomalousHorizontalCorrection = applyAnomalousHorizontalCorrection(
    horizontalLines,
    sideConsensusHorizontal,
    gridRows
  );
  horizontalLines = anomalousHorizontalCorrection.lines;

  const directYBoundaries = horizontalLines
    ? buildBoundariesFromLines(horizontalLines, height, gridRows)
    : null;
  const outerRectHorizontalLines = horizontalLines
    ? (fitUniformLinesFromAnchors(horizontalLines, height, gridRows) || horizontalLines)
    : null;
  const outerRectYBoundaries = outerRectHorizontalLines
    ? buildBoundariesFromLines(outerRectHorizontalLines, height, gridRows)
    : null;
  let yBoundaries = directYBoundaries || outerRectYBoundaries;

  const directBoundaryQuality = (directXBoundaries && directYBoundaries && workingData && workingInfo)
    ? evaluateBoundaryQuality(directXBoundaries, directYBoundaries, workingData, workingInfo)
    : null;
  const outerRectBoundaryQuality = (outerRectXBoundaries && outerRectYBoundaries && workingData && workingInfo)
    ? evaluateBoundaryQuality(outerRectXBoundaries, outerRectYBoundaries, workingData, workingInfo)
    : null;

  let selectedBoundaryMode = '直接检测线';
  if (outerRectXBoundaries && outerRectYBoundaries) {
    xBoundaries = outerRectXBoundaries;
    yBoundaries = outerRectYBoundaries;
    selectedBoundaryMode = '外框均分';

    if (directXBoundaries && directYBoundaries && outerRectBoundaryQuality && directBoundaryQuality) {
      if (directBoundaryQuality.score > outerRectBoundaryQuality.score + 8) {
        xBoundaries = directXBoundaries;
        yBoundaries = directYBoundaries;
        selectedBoundaryMode = '直接检测线';
      }
    }
  } else if (directXBoundaries && directYBoundaries) {
    xBoundaries = directXBoundaries;
    yBoundaries = directYBoundaries;
    selectedBoundaryMode = '直接检测线';
  }

  let fallbackUsed = false;

  if (!xBoundaries || !yBoundaries) {
    const bounds = detectGridBounds(mask, width, height);
    fallbackUsed = true;
    xBoundaries = xBoundaries || buildUniformBoundaries(bounds.minX, bounds.maxX, gridCols);
    yBoundaries = yBoundaries || buildUniformBoundaries(bounds.minY, bounds.maxY, gridRows);
  }

  return {
    xBoundaries,
    yBoundaries,
    debug: {
      verticalCandidates,
      verticalLines,
      outerRectVerticalLines,
      selectedBoundaryMode,
      directBoundaryQuality,
      outerRectBoundaryQuality,
      horizontalLinesBeforeAnomalousCorrection,
      horizontalLinesBeforeCorrection,
      horizontalLines,
      outerRectHorizontalLines,
      leftHorizontalLines: leftHorizontalLines || [],
      rightHorizontalLines: rightHorizontalLines || [],
      sideConsensusHorizontalLines: sideConsensusHorizontal || [],
      anomalousHorizontalCorrection,
      fallbackUsed,
      profileVerticalLines: profileVertical
        ? profileVertical.lines
        : (strongVerticalPeaks || profileVerticalPeaks || []),
      profileHorizontalLines: profileHorizontal ? profileHorizontal.lines : (profileHorizontalPeaks || [])
    }
  };
}

async function renderGridDebugImage(imageInput, debugOutputPath, debugData) {
  const image = sharp(imageInput).ensureAlpha();
  const metadata = await image.metadata();
  const width = metadata.width;
  const height = metadata.height;
  const overlays = [];

  const addLine = (x1, y1, x2, y2, color, strokeWidth = 3, dashArray = null) => {
    const dash = dashArray ? `stroke-dasharray="${dashArray}"` : '';
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}" ${dash}/>
      </svg>
    `;
    overlays.push({ input: Buffer.from(svg), top: 0, left: 0 });
  };

  const addRect = (box, color, strokeWidth = 4) => {
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>
      </svg>
    `;
    overlays.push({ input: Buffer.from(svg), top: 0, left: 0 });
  };

  const addLabel = (x, y, text, color) => {
    const safeText = String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${x}" y="${y}" width="120" height="24" rx="4" ry="4" fill="${color}" fill-opacity="0.85"/>
        <text x="${x + 8}" y="${y + 17}" font-family="sans-serif" font-size="14" fill="white">${safeText}</text>
      </svg>
    `;
    overlays.push({ input: Buffer.from(svg), top: 0, left: 0 });
  };

  const isBoundaryGuideMode = debugData.selectedBoundaryMode === '边界引导';
  const primaryVerticalColor = isBoundaryGuideMode ? '#0f766e' : '#2563eb';
  const primaryHorizontalColor = isBoundaryGuideMode ? '#7c3aed' : '#dc2626';
  const primaryStrokeWidth = isBoundaryGuideMode ? 5 : 4;

  if (debugData.gridBounds) {
    addRect(debugData.gridBounds, '#22c55e', 5);
  }

  for (const center of debugData.verticalCandidates || []) {
    addLine(center, 0, center, height, '#f59e0b', 2, '8 8');
  }
  for (const center of debugData.verticalLines || []) {
    addLine(center, 0, center, height, primaryVerticalColor, primaryStrokeWidth);
  }
  for (const center of debugData.outerRectVerticalLines || []) {
    addLine(center, 0, center, height, '#059669', 2, '10 6');
  }
  for (const center of debugData.profileVerticalLines || []) {
    addLine(center, 0, center, height, '#14b8a6', 2, '4 6');
  }
  for (const center of debugData.horizontalLines || []) {
    addLine(0, center, width, center, primaryHorizontalColor, primaryStrokeWidth);
  }
  for (const center of debugData.outerRectHorizontalLines || []) {
    addLine(0, center, width, center, '#16a34a', 2, '10 6');
  }
  for (const center of debugData.horizontalLinesBeforeCorrection || []) {
    addLine(0, center, width, center, '#fb7185', 2, '12 8');
  }
  for (const center of debugData.leftHorizontalLines || []) {
    addLine(0, center, Math.round(width * 0.18), center, '#0f766e', 3, '6 6');
  }
  for (const center of debugData.rightHorizontalLines || []) {
    addLine(Math.round(width * 0.82), center, width, center, '#7c3aed', 3, '6 6');
  }
  for (const center of debugData.sideConsensusHorizontalLines || []) {
    addLine(0, center, width, center, '#0891b2', 2, '10 8');
  }
  for (const center of debugData.profileHorizontalLines || []) {
    addLine(0, center, width, center, '#8b5cf6', 2, '4 6');
  }
  for (const correction of debugData.horizontalCorrections || []) {
    addLabel(
      Math.max(16, Math.round(width * 0.74)),
      clamp(correction.to - 12, 40, Math.max(40, height - 40)),
      `纠偏${correction.boundaryIndex}: ${correction.from}->${correction.to}`,
      '#0f766e'
    );
  }
  for (const box of debugData.pageBoxes || []) {
    addRect(box, '#111827', 2);
  }

  addLabel(16, 16, `回退切分: ${debugData.fallbackUsed ? '是' : '否'}`, debugData.fallbackUsed ? '#dc2626' : '#15803d');
  addLabel(
    16,
    48,
    `纠偏次数: ${(debugData.horizontalCorrections || []).length}`,
    (debugData.horizontalCorrections || []).length ? '#0f766e' : '#475569'
  );
  addLabel(
    16,
    80,
    `切分模式: ${debugData.selectedBoundaryMode || '未知'}`,
    debugData.selectedBoundaryMode === '外框均分'
      ? '#166534'
      : debugData.selectedBoundaryMode === '边界引导'
        ? '#0f766e'
        : '#1d4ed8'
  );
  addLabel(16, 112, '图例: 橙色=候选线', '#92400e');
  addLabel(
    16,
    144,
    isBoundaryGuideMode ? '引导竖横线=深青/紫' : '选中竖横线=蓝/红',
    isBoundaryGuideMode ? '#0f766e' : '#1d4ed8'
  );
  addLabel(16, 176, '绿色虚线=外框锚线', '#166534');
  addLabel(16, 208, '青/粉=轮廓或纠偏前', '#475569');

  await image.composite(overlays).png().toFile(debugOutputPath);
}

function cropMaskBounds(mask, width, height, thresholdRatio = 0.003) {
  const minimumDarkPixelsPerLine = Math.max(1, Math.floor(Math.max(width, height) * thresholdRatio));
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    let rowDarkPixels = 0;
    for (let x = 0; x < width; x++) {
      const value = mask[y * width + x];
      rowDarkPixels += value;
      if (value) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }

    if (rowDarkPixels >= minimumDarkPixelsPerLine) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX === -1 || maxY === -1) {
    return null;
  }

  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

async function trimCellToContent(cellBuffer, threshold) {
  const image = sharp(cellBuffer).ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  const mask = buildDarkMask(data, info, threshold);
  const bounds = cropMaskBounds(mask, info.width, info.height);

  if (!bounds) {
    return {
      buffer: await image.png().toBuffer(),
      contentBox: {
        left: 0,
        top: 0,
        width: info.width,
        height: info.height
      }
    };
  }

  const paddingX = Math.max(2, Math.floor(bounds.width * 0.08));
  const paddingY = Math.max(2, Math.floor(bounds.height * 0.08));
  const left = clamp(bounds.left - paddingX, 0, info.width - 1);
  const top = clamp(bounds.top - paddingY, 0, info.height - 1);
  const width = clamp(bounds.width + paddingX * 2, 1, info.width - left);
  const height = clamp(bounds.height + paddingY * 2, 1, info.height - top);

  return {
    buffer: await image
      .extract({ left, top, width, height })
      .png()
      .toBuffer(),
    contentBox: { left, top, width, height }
  };
}

/**
 * 汉字切分插件
 * 从A4白纸图像中提取方格汉字
 * @param {string} imagePath - 输入图像路径
 * @param {Object} options - 可选配置
 * @returns {Promise<Array<Array<Buffer>>>} 行列矩阵，每个元素为汉字图像Buffer
 */
async function segmentHanzi(imagePath, options = {}) {
  try {
    const {
      gridCols = DEFAULT_GRID_COLS,
      gridRows = DEFAULT_GRID_ROWS,
      threshold = DEFAULT_THRESHOLD,
      cellInsetRatio = 0,
      trimContent = false,
      cropToGrid = true,
      pageBounds = null,
      boundaryGuides = null,
      forceUniformGrid = false,
      gridGuideMaskPath = null,
      debugOutputPath = null,
      debugMetaPath = null
    } = options;

    const input = imagePath;
    const sourceImage = sharp(input).ensureAlpha();
    const { data, info } = await sourceImage.clone().raw().toBuffer({ resolveWithObject: true });
    const sourceWidth = info.width;
    const sourceHeight = info.height;
    const sourceMask = buildDarkMask(data, info, threshold);
    let sourceGuideMask = null;
    if (gridGuideMaskPath) {
      try {
        const { data: guideData, info: guideInfo } = await sharp(gridGuideMaskPath)
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (guideInfo.width === sourceWidth && guideInfo.height === sourceHeight) {
          sourceGuideMask = new Uint8Array(sourceWidth * sourceHeight);
          for (let index = 0; index < sourceGuideMask.length; index++) {
            sourceGuideMask[index] = guideData[index] >= 128 ? 1 : 0;
          }
        }
      } catch (error) {
        sourceGuideMask = null;
      }
    }
    const gridBoundsResult = gridBoundsDetectPlugin.execute({
      pageBounds,
      cropToGrid,
      sourceGuideMask,
      sourceMask,
      sourceWidth,
      sourceHeight
    });
    const gridBounds = gridBoundsResult.gridBounds;

    const workingImage = sourceImage.clone().extract(gridBounds);
    const { data: workingData, info: workingInfo } = await workingImage
      .clone()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let workingGuideMask = null;
    if (sourceGuideMask) {
      workingGuideMask = new Uint8Array(gridBounds.width * gridBounds.height);
      for (let y = 0; y < gridBounds.height; y++) {
        for (let x = 0; x < gridBounds.width; x++) {
          const sourceIndex = (gridBounds.top + y) * sourceWidth + (gridBounds.left + x);
          workingGuideMask[y * gridBounds.width + x] = sourceGuideMask[sourceIndex];
        }
      }
    }
    let xBoundaries;
    let yBoundaries;
    let debug;
    let step05_2Result;
    const normalizedBoundaryGuides = boundaryGuides
      ? {
          left: boundaryGuides.left ?? 0,
          right: boundaryGuides.right ?? workingInfo.width,
          top: boundaryGuides.top ?? 0,
          bottom: boundaryGuides.bottom ?? workingInfo.height,
          xPeaks: Array.isArray(boundaryGuides.xPeaks) ? boundaryGuides.xPeaks : [],
          yPeaks: Array.isArray(boundaryGuides.yPeaks) ? boundaryGuides.yPeaks : []
        }
      : null;

    if (forceUniformGrid) {
      xBoundaries = buildUniformBoundaries(0, workingInfo.width, gridCols);
      yBoundaries = buildUniformBoundaries(0, workingInfo.height, gridRows);
      const uniformVerticalLines = xBoundaries.map((boundary) => boundary[0]).concat([xBoundaries[xBoundaries.length - 1][1] - 1]);
      const uniformHorizontalLines = yBoundaries.map((boundary) => boundary[0]).concat([yBoundaries[yBoundaries.length - 1][1] - 1]);
      debug = {
        verticalCandidates: [],
        verticalLines: uniformVerticalLines,
        outerRectVerticalLines: uniformVerticalLines,
        selectedBoundaryMode: '整图均分',
        directBoundaryQuality: null,
        outerRectBoundaryQuality: null,
        horizontalLinesBeforeAnomalousCorrection: [],
        horizontalLinesBeforeCorrection: [],
        horizontalLines: uniformHorizontalLines,
        outerRectHorizontalLines: uniformHorizontalLines,
        leftHorizontalLines: [],
        rightHorizontalLines: [],
        sideConsensusHorizontalLines: [],
        anomalousHorizontalCorrection: { lines: [], corrections: [] },
        fallbackUsed: false,
        profileVerticalLines: [],
        profileHorizontalLines: []
      };
      step05_2Result = {
        processNo: '05_2',
        processName: '05_2_边界引导切分',
        sourceStep: '05_1_网格范围检测',
        inputPath: imagePath,
        mode: '整图均分',
        xBoundaries,
        yBoundaries,
        debug
      };
    } else if (normalizedBoundaryGuides) {
      const guidedSegmentation = boundaryGuideSegmentationPlugin.execute({
        boundaryGuides: normalizedBoundaryGuides,
        gridRows,
        gridCols,
        width: workingInfo.width,
        height: workingInfo.height
      });
      if (guidedSegmentation) {
        xBoundaries = guidedSegmentation.xBoundaries;
        yBoundaries = guidedSegmentation.yBoundaries;
        debug = guidedSegmentation.debug;
        step05_2Result = {
          processNo: '05_2',
          processName: '05_2_边界引导切分',
          sourceStep: '05_1_网格范围检测',
          inputPath: imagePath,
          mode: '边界引导',
          xBoundaries,
          yBoundaries,
          debug
        };
      }
    } else {
      const workingMask = workingGuideMask || buildDarkMask(workingData, workingInfo, threshold);
      const grayProfiles = buildGrayProfiles(workingData, workingInfo);
      const resolved = resolveGridSlices(
        workingMask,
        workingInfo.width,
        workingInfo.height,
        gridCols,
        gridRows,
        grayProfiles,
        workingData,
        workingInfo
      );
      xBoundaries = resolved.xBoundaries;
      yBoundaries = resolved.yBoundaries;
      debug = resolved.debug;
      step05_2Result = {
        processNo: '05_2',
        processName: '05_2_边界引导切分',
        sourceStep: '05_1_网格范围检测',
        inputPath: imagePath,
        mode: '直接检测线',
        xBoundaries,
        yBoundaries,
        debug
      };
    }
    const result = Array(gridRows).fill().map(() => Array(gridCols).fill(null));
    const cells = [];

    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        const croppedCell = await cellCropPlugin.execute({
          sourceImage,
          gridBounds,
          xBoundaries,
          yBoundaries,
          row,
          col,
          gridRows,
          gridCols,
          cellInsetRatio,
          trimContent,
          threshold
        });

        result[row][col] = croppedCell.buffer;
        cells.push({
          row,
          col,
          pageBox: croppedCell.pageBox,
          contentBox: croppedCell.contentBox
        });
      }
    }

    const safeDebug = debug || {};
    const debugInfo = {
      imagePath,
      gridRows,
      gridCols,
      threshold,
      gridGuideMaskPath,
      gridBounds,
      workingSize: {
        width: workingInfo.width,
        height: workingInfo.height
      },
      boundaryGuides: normalizedBoundaryGuides,
      debugLegend: {
        gridBounds: '#22c55e',
        verticalCandidates: '#f59e0b',
        selectedVerticalLines: safeDebug.selectedBoundaryMode === '边界引导' ? '#0f766e' : '#2563eb',
        selectedHorizontalLines: safeDebug.selectedBoundaryMode === '边界引导' ? '#7c3aed' : '#dc2626',
        outerRectVerticalLines: '#059669',
        outerRectHorizontalLines: '#16a34a',
        profileVerticalLines: '#14b8a6',
        profileHorizontalLines: '#8b5cf6',
        horizontalLinesBeforeCorrection: '#fb7185'
      },
      guideMaskUsed: Boolean(workingGuideMask),
      verticalCandidates: (safeDebug.verticalCandidates || []).map((value) => gridBounds.left + value),
      verticalLines: (safeDebug.verticalLines || []).map((value) => gridBounds.left + value),
      outerRectVerticalLines: (safeDebug.outerRectVerticalLines || []).map((value) => gridBounds.left + value),
      selectedBoundaryMode: safeDebug.selectedBoundaryMode || '直接检测线',
      directBoundaryQuality: safeDebug.directBoundaryQuality || null,
      outerRectBoundaryQuality: safeDebug.outerRectBoundaryQuality || null,
      horizontalLinesBeforeAnomalousCorrection: (safeDebug.horizontalLinesBeforeAnomalousCorrection || []).map((value) => gridBounds.top + value),
      horizontalLinesBeforeCorrection: (safeDebug.horizontalLinesBeforeCorrection || []).map((value) => gridBounds.top + value),
      horizontalLines: (safeDebug.horizontalLines || []).map((value) => gridBounds.top + value),
      outerRectHorizontalLines: (safeDebug.outerRectHorizontalLines || []).map((value) => gridBounds.top + value),
      leftHorizontalLines: (safeDebug.leftHorizontalLines || []).map((value) => gridBounds.top + value),
      rightHorizontalLines: (safeDebug.rightHorizontalLines || []).map((value) => gridBounds.top + value),
      sideConsensusHorizontalLines: (safeDebug.sideConsensusHorizontalLines || []).map((value) => gridBounds.top + value),
      profileVerticalLines: (safeDebug.profileVerticalLines || []).map((value) => gridBounds.left + value),
      profileHorizontalLines: (safeDebug.profileHorizontalLines || []).map((value) => gridBounds.top + value),
      horizontalCorrections: (safeDebug.anomalousHorizontalCorrection?.corrections || []).map((item) => ({
        boundaryIndex: item.boundaryIndex,
        from: gridBounds.top + item.from,
        to: gridBounds.top + item.to
      })),
      fallbackUsed: Boolean(safeDebug.fallbackUsed),
      pageBoxes: cells.map((cell) => cell.pageBox)
    };
    const alignmentStats = buildGridAlignmentStats(cells, gridRows, gridCols);

    if (debugOutputPath) {
      await segmentationDebugRenderPlugin.execute({
        imageInput: input,
        debugOutputPath,
        debugData: debugInfo
      });
    }

    if (debugMetaPath) {
      await fs.promises.writeFile(debugMetaPath, `${JSON.stringify(debugInfo, null, 2)}\n`, 'utf8');
    }

    return {
      matrix: result,
      cells,
      gridBounds,
      alignmentStats,
      debug: debugInfo,
      stepResults: {
        step05_1: gridBoundsResult,
        step05_2: step05_2Result,
        step05_3: {
          processNo: '05_3',
          processName: '05_3_切分调试渲染',
          sourceStep: '05_2_边界引导切分',
          inputPath: imagePath,
          debugOutputPath: debugOutputPath || null,
          debugMetaPath: debugMetaPath || null
        },
        step05_4: {
          processNo: '05_4',
          processName: '05_4_单格裁切',
          sourceStep: '05_2_边界引导切分',
          inputPath: imagePath,
          totalCells: cells.length,
          cells
        }
      }
    };
  } catch (error) {
    console.error('汉字切分失败:', error);
    throw error;
  }
}

function matrixToBase64(matrix) {
  return matrix.map((row) => row.map((buffer) => buffer.toString('base64')));
}

function formatCellFileName(row, col) {
  return `05_单格_row${String(row + 1).padStart(2, '0')}_col${String(col + 1).padStart(2, '0')}.png`;
}

async function saveMatrixToFiles(matrix, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix[row].length; col++) {
      const filename = formatCellFileName(row, col);
      const filepath = path.join(outputDir, filename);
      await fs.promises.writeFile(filepath, matrix[row][col]);
    }
  }
}

async function renderMatrixOverview(matrix, outputPath, options = {}) {
  const {
    cellSize = 128,
    padding = 8,
    background = { r: 245, g: 245, b: 245, alpha: 1 }
  } = options;

  const rows = matrix.length;
  const cols = rows ? matrix[0].length : 0;
  if (!rows || !cols) {
    throw new Error('matrix为空，无法生成总览图');
  }

  const width = cols * cellSize + (cols + 1) * padding;
  const height = rows * cellSize + (rows + 1) * padding;
  const composites = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = padding + col * (cellSize + padding);
      const top = padding + row * (cellSize + padding);
      const resized = await sharp(matrix[row][col])
        .resize(cellSize, cellSize, {
          fit: 'contain',
          background: 'white'
        })
        .png()
        .toBuffer();

      composites.push({ input: resized, left, top });
    }
  }

  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background
    }
  })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

module.exports = {
  segmentHanzi,
  matrixToBase64,
  saveMatrixToFiles,
  renderMatrixOverview,
  DEFAULT_GRID_COLS,
  DEFAULT_GRID_ROWS
};
