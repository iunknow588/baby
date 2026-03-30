const { requireSharp } = require('../utils/require_sharp');
const sharp = requireSharp();

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function smoothProfile(profile, radius = 5) {
  if (!profile.length || radius <= 0) {
    return [...profile];
  }
  const output = new Array(profile.length).fill(0);
  for (let index = 0; index < profile.length; index++) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const target = index + offset;
      if (target < 0 || target >= profile.length) {
        continue;
      }
      sum += profile[target];
      count += 1;
    }
    output[index] = count ? sum / count : profile[index];
  }
  return output;
}

function findBestGridCount(profile, axisLength, minCells, maxCells) {
  const smoothed = smoothProfile(profile, Math.max(3, Math.floor(axisLength / 240)));
  const band = Math.max(2, Math.floor(axisLength / 180));
  let best = null;

  for (let cellCount = minCells; cellCount <= maxCells; cellCount++) {
    const gap = axisLength / cellCount;
    const phaseStep = Math.max(1, Math.floor(gap / 10));
    const maxPhase = Math.max(phaseStep, Math.floor(gap));

    for (let phase = 0; phase < maxPhase; phase += phaseStep) {
      const samples = [];
      const positions = [];
      for (let lineIndex = 0; lineIndex <= cellCount; lineIndex++) {
        const center = Math.round(phase + lineIndex * gap);
        if (center < 0 || center >= axisLength) {
          continue;
        }
        let localMax = -Infinity;
        let localPos = center;
        for (let delta = -band; delta <= band; delta++) {
          const target = center + delta;
          if (target < 0 || target >= axisLength) {
            continue;
          }
          if (smoothed[target] > localMax) {
            localMax = smoothed[target];
            localPos = target;
          }
        }
        samples.push(localMax);
        positions.push(localPos);
      }

      if (samples.length < Math.max(4, cellCount - 1)) {
        continue;
      }

      const gaps = [];
      for (let index = 1; index < positions.length; index++) {
        gaps.push(positions[index] - positions[index - 1]);
      }
      const meanSample = average(samples);
      const meanGap = average(gaps);
      const gapDeviation = gaps.length
        ? Math.sqrt(average(gaps.map((value) => Math.pow(value - meanGap, 2))))
        : gap;
      const edgePenalty = Math.abs(positions[0]) + Math.abs((axisLength - 1) - positions[positions.length - 1]);
      const score = meanSample * 2.4 - gapDeviation * 1.6 - edgePenalty * 0.06;

      if (!best || score > best.score) {
        best = {
          cellCount,
          score,
          gap: Math.round(gap * 100) / 100,
          positions,
          meanStrength: Math.round(meanSample * 100) / 100,
          gapDeviation: Math.round(gapDeviation * 100) / 100
        };
      }
    }
  }

  return best;
}

function resolveEstimatedCellCount(candidate, axisLength) {
  if (!candidate) {
    return null;
  }
  const gap = candidate.gap || (axisLength / Math.max(candidate.cellCount, 1));
  const positions = candidate.positions || [];
  const startNearEdge = positions.length ? positions[0] <= gap * 0.35 : false;
  const endNearEdge = positions.length ? (axisLength - 1 - positions[positions.length - 1]) <= gap * 0.35 : false;
  if (startNearEdge || endNearEdge) {
    return candidate.cellCount;
  }
  return Math.max(1, candidate.cellCount - 1);
}

async function estimateGridSize(imagePath, options = {}) {
  const {
    minRows = 6,
    maxRows = 16,
    minCols = 5,
    maxCols = 12
  } = options;

  const { data, info } = await sharp(imagePath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const xProfile = new Array(info.width).fill(0);
  const yProfile = new Array(info.height).fill(0);
  const xInverseProfile = new Array(info.width).fill(0);
  const yInverseProfile = new Array(info.height).fill(0);
  let brightPixels = 0;
  let darkPixels = 0;
  let midPixels = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const value = data[y * info.width + x];
      if (value >= 220) {
        brightPixels += 1;
      } else if (value <= 35) {
        darkPixels += 1;
      } else {
        midPixels += 1;
      }
      const darkness = 255 - value;
      xProfile[x] += darkness;
      yProfile[y] += darkness;
      xInverseProfile[x] += value;
      yInverseProfile[y] += value;
    }
  }

  for (let x = 0; x < info.width; x++) {
    xProfile[x] /= info.height;
    xInverseProfile[x] /= info.height;
  }
  for (let y = 0; y < info.height; y++) {
    yProfile[y] /= info.width;
    yInverseProfile[y] /= info.width;
  }

  const totalPixels = info.width * info.height;
  const binaryLikeRatio = totalPixels ? (brightPixels + darkPixels) / totalPixels : 0;
  const brightRatio = totalPixels ? brightPixels / totalPixels : 0;
  const darkRatio = totalPixels ? darkPixels / totalPixels : 0;

  const darkCols = findBestGridCount(xProfile, info.width, minCols, maxCols);
  const darkRows = findBestGridCount(yProfile, info.height, minRows, maxRows);
  const lightCols = findBestGridCount(xInverseProfile, info.width, minCols, maxCols);
  const lightRows = findBestGridCount(yInverseProfile, info.height, minRows, maxRows);

  const darkScore = average([darkCols?.score || 0, darkRows?.score || 0]);
  const lightScore = average([lightCols?.score || 0, lightRows?.score || 0]);
  const forcedLightOnDark = binaryLikeRatio >= 0.96 && brightRatio > 0.01 && brightRatio < 0.3 && darkRatio > 0.6;
  const signalMode = forcedLightOnDark ? 'light_on_dark' : (lightScore > darkScore ? 'light_on_dark' : 'dark_on_light');
  const cols = signalMode === 'light_on_dark' ? lightCols : darkCols;
  const rows = signalMode === 'light_on_dark' ? lightRows : darkRows;

  const confidenceBase = [cols?.score || 0, rows?.score || 0].filter((value) => value > 0);
  const confidence = confidenceBase.length
    ? Math.max(0, Math.min(1, average(confidenceBase) / 220))
    : 0;

  return {
    imagePath,
    width: info.width,
    height: info.height,
    signalMode,
    imageStats: {
      brightRatio: Math.round(brightRatio * 10000) / 10000,
      darkRatio: Math.round(darkRatio * 10000) / 10000,
      midRatio: Math.round((totalPixels ? midPixels / totalPixels : 0) * 10000) / 10000,
      binaryLikeRatio: Math.round(binaryLikeRatio * 10000) / 10000
    },
    estimatedGridRows: resolveEstimatedCellCount(rows, info.height),
    estimatedGridCols: resolveEstimatedCellCount(cols, info.width),
    confidence: Math.round(confidence * 10000) / 10000,
    rowCandidate: rows,
    colCandidate: cols
  };
}

module.exports = {
  estimateGridSize
};
