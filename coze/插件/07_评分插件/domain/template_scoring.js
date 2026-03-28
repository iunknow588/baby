const sharp = require('sharp');
const { resolveConfig } = require('../config');
const { clamp, average, roundScore } = require('../shared/math');
const { buildForegroundMask, decodeCellImage } = require('../../utils/cell_image_analysis');

function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderTargetTemplate(targetChar, size, config = resolveConfig()) {
  const fontFamily = config.image.template_font_family || 'sans-serif';
  const fontSize = Math.floor(size * (config.image.template_font_size_ratio || 0.58));
  const baselineY = size * (config.image.template_baseline_y_ratio || 0.5);
  let svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';
  svg += `<text x="${size / 2}" y="${baselineY}" font-family="${escapeSvgText(fontFamily)}" font-size="${fontSize}" text-anchor="middle" dominant-baseline="middle" fill="black">${escapeSvgText(targetChar)}</text>`;
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function resizeMaskFromBuffer(buffer, size, threshold, config) {
  const image = sharp(buffer).ensureAlpha().resize(size, size, { fit: 'fill' });
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  return buildForegroundMask(data, info, threshold, config);
}

function calculateHuMoments(mask, side) {
  let m00 = 0;
  let m10 = 0;
  let m01 = 0;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const value = mask[y * side + x];
      if (!value) {
        continue;
      }
      m00 += 1;
      m10 += x;
      m01 += y;
    }
  }
  if (!m00) {
    return new Array(7).fill(0);
  }
  const cx = m10 / m00;
  const cy = m01 / m00;
  let mu11 = 0;
  let mu20 = 0;
  let mu02 = 0;
  let mu30 = 0;
  let mu03 = 0;
  let mu12 = 0;
  let mu21 = 0;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const value = mask[y * side + x];
      if (!value) {
        continue;
      }
      const dx = x - cx;
      const dy = y - cy;
      mu11 += dx * dy;
      mu20 += dx * dx;
      mu02 += dy * dy;
      mu30 += dx * dx * dx;
      mu03 += dy * dy * dy;
      mu12 += dx * dy * dy;
      mu21 += dx * dx * dy;
    }
  }
  const n20 = mu20 / Math.pow(m00, 2);
  const n02 = mu02 / Math.pow(m00, 2);
  const n11 = mu11 / Math.pow(m00, 2);
  const n30 = mu30 / Math.pow(m00, 2.5);
  const n03 = mu03 / Math.pow(m00, 2.5);
  const n12 = mu12 / Math.pow(m00, 2.5);
  const n21 = mu21 / Math.pow(m00, 2.5);
  return [
    n20 + n02,
    Math.pow(n20 - n02, 2) + 4 * Math.pow(n11, 2),
    Math.pow(n30 - 3 * n12, 2) + Math.pow(3 * n21 - n03, 2),
    Math.pow(n30 + n12, 2) + Math.pow(n21 + n03, 2),
    (n30 - 3 * n12) * (n30 + n12) * (Math.pow(n30 + n12, 2) - 3 * Math.pow(n21 + n03, 2)) +
      (3 * n21 - n03) * (n21 + n03) * (3 * Math.pow(n30 + n12, 2) - Math.pow(n21 + n03, 2)),
    (n20 - n02) * (Math.pow(n30 + n12, 2) - Math.pow(n21 + n03, 2)) + 4 * n11 * (n30 + n12) * (n21 + n03),
    (3 * n21 - n03) * (n30 + n12) * (Math.pow(n30 + n12, 2) - 3 * Math.pow(n21 + n03, 2)) -
      (n30 - 3 * n12) * (n21 + n03) * (3 * Math.pow(n30 + n12, 2) - Math.pow(n21 + n03, 2))
  ];
}

function calculateHuSimilarity(maskA, maskB, side, config) {
  const huA = calculateHuMoments(maskA, side);
  const huB = calculateHuMoments(maskB, side);
  let distance = 0;
  for (let i = 0; i < huA.length; i++) {
    const a = huA[i];
    const b = huB[i];
    const logA = a === 0 ? 0 : Math.sign(a) * Math.log10(Math.abs(a));
    const logB = b === 0 ? 0 : Math.sign(b) * Math.log10(Math.abs(b));
    distance += Math.abs(logA - logB);
  }
  const normalizedDistance = distance / huA.length;
  const good = config.similarity.hu_distance_good;
  const bad = config.similarity.hu_distance_bad;
  const similarity = normalizedDistance <= good
    ? 1
    : clamp(1 - ((normalizedDistance - good) / Math.max(bad - good, 1e-6)), 0, 1);
  return {
    similarity,
    distance: normalizedDistance
  };
}

function calculateEdgeDirectionHistogram(mask, side) {
  const bins = [0, 0, 0, 0];
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const gx =
        mask[y * side + (x + 1)] - mask[y * side + (x - 1)] +
        0.5 * (mask[(y + 1) * side + (x + 1)] - mask[(y + 1) * side + (x - 1)]) +
        0.5 * (mask[(y - 1) * side + (x + 1)] - mask[(y - 1) * side + (x - 1)]);
      const gy =
        mask[(y + 1) * side + x] - mask[(y - 1) * side + x] +
        0.5 * (mask[(y + 1) * side + (x + 1)] - mask[(y - 1) * side + (x + 1)]) +
        0.5 * (mask[(y + 1) * side + (x - 1)] - mask[(y - 1) * side + (x - 1)]);
      const magnitude = Math.hypot(gx, gy);
      if (magnitude <= 0.01) {
        continue;
      }
      let angle = Math.atan2(gy, gx);
      if (angle < 0) {
        angle += Math.PI;
      }
      const bin = Math.min(3, Math.floor((angle / Math.PI) * 4));
      bins[bin] += magnitude;
    }
  }
  const sum = bins.reduce((acc, value) => acc + value, 0);
  return sum ? bins.map((value) => value / sum) : bins;
}

function calculateHistogramCorrelation(a, b) {
  const meanA = average(a);
  const meanB = average(b);
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) {
    return 0;
  }
  return clamp((numerator / Math.sqrt(denomA * denomB) + 1) / 2, 0, 1);
}

function calculateMaskIoU(maskA, maskB) {
  let intersection = 0;
  let union = 0;

  for (let i = 0; i < maskA.length; i++) {
    const a = maskA[i];
    const b = maskB[i];
    if (a || b) {
      union++;
      if (a && b) {
        intersection++;
      }
    }
  }

  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

function calculateGridDensity(mask, gridSize) {
  const side = Math.round(Math.sqrt(mask.length));
  const cellSize = side / gridSize;
  const densities = [];

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      let ink = 0;
      let total = 0;
      const startX = Math.floor(col * cellSize);
      const endX = Math.floor((col + 1) * cellSize);
      const startY = Math.floor(row * cellSize);
      const endY = Math.floor((row + 1) * cellSize);

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          ink += mask[y * side + x];
          total++;
        }
      }

      densities.push(total ? ink / total : 0);
    }
  }

  return densities;
}

function summarizeDensityRegions(density, gridSize) {
  const rows = Array.from({ length: gridSize }, (_, row) => {
    let sum = 0;
    for (let col = 0; col < gridSize; col++) {
      sum += density[row * gridSize + col];
    }
    return sum / gridSize;
  });

  const cols = Array.from({ length: gridSize }, (_, col) => {
    let sum = 0;
    for (let row = 0; row < gridSize; row++) {
      sum += density[row * gridSize + col];
    }
    return sum / gridSize;
  });

  const half = Math.floor(gridSize / 2);
  const sumRegion = (rowStart, rowEnd, colStart, colEnd) => {
    let sum = 0;
    let count = 0;
    for (let row = rowStart; row < rowEnd; row++) {
      for (let col = colStart; col < colEnd; col++) {
        sum += density[row * gridSize + col];
        count++;
      }
    }
    return count ? sum / count : 0;
  };

  return {
    left: average(cols.slice(0, half)),
    right: average(cols.slice(half)),
    top: average(rows.slice(0, half)),
    bottom: average(rows.slice(half)),
    topLeft: sumRegion(0, half, 0, half),
    topRight: sumRegion(0, half, half, gridSize),
    bottomLeft: sumRegion(half, gridSize, 0, half),
    bottomRight: sumRegion(half, gridSize, half, gridSize)
  };
}

async function calculateSimilarityScore(cellImage, targetChar, options = {}) {
  if (!targetChar) {
    return null;
  }

  const config = options.config || resolveConfig();
  const threshold = options.threshold || config.image.threshold;
  const templateSize = config.image.template_size;
  const cellBuffer = await decodeCellImage(cellImage);
  const templateBuffer = await renderTargetTemplate(targetChar, templateSize, config);
  const cellMask = await resizeMaskFromBuffer(cellBuffer, templateSize, threshold, config);
  const templateMask = await resizeMaskFromBuffer(templateBuffer, templateSize, threshold, config);
  const iou = calculateMaskIoU(cellMask, templateMask);
  const hu = calculateHuSimilarity(cellMask, templateMask, templateSize, config);
  const edgeHistogramCorrelation = calculateHistogramCorrelation(
    calculateEdgeDirectionHistogram(cellMask, templateSize),
    calculateEdgeDirectionHistogram(templateMask, templateSize)
  );
  const similarity = 100 * (
    config.similarity.weights.iou * iou +
    config.similarity.weights.hu * hu.similarity +
    config.similarity.weights.edge_direction * edgeHistogramCorrelation
  );
  return {
    score: roundScore(similarity),
    iou: roundScore(iou),
    hu_similarity: roundScore(hu.similarity),
    hu_distance: roundScore(hu.distance),
    edge_direction_similarity: roundScore(edgeHistogramCorrelation)
  };
}

async function calculateStructureScore(cellImage, targetChar, options = {}) {
  if (!targetChar) {
    return null;
  }

  const config = options.config || resolveConfig();
  const threshold = options.threshold || config.image.threshold;
  const templateSize = config.image.template_size;
  const cellBuffer = await decodeCellImage(cellImage);
  const templateBuffer = await renderTargetTemplate(targetChar, templateSize, config);
  const cellMask = await resizeMaskFromBuffer(cellBuffer, templateSize, threshold, config);
  const templateMask = await resizeMaskFromBuffer(templateBuffer, templateSize, threshold, config);
  const cellDensity = calculateGridDensity(cellMask, 4);
  const templateDensity = calculateGridDensity(templateMask, 4);
  const cellRegions = summarizeDensityRegions(cellDensity, 4);
  const templateRegions = summarizeDensityRegions(templateDensity, 4);

  const regionKeys = ['left', 'right', 'top', 'bottom', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  const regionDiffs = Object.fromEntries(
    regionKeys.map((key) => [key, Math.abs(cellRegions[key] - templateRegions[key])])
  );
  const meanRegionDiff = average(Object.values(regionDiffs));
  const structureScore = roundScore(clamp(100 - meanRegionDiff * config.structure_accuracy.region_diff_penalty_scale, 0, 100));

  return {
    score: structureScore,
    region_diffs: Object.fromEntries(
      Object.entries(regionDiffs).map(([key, value]) => [key, roundScore(value)])
    ),
    cell_regions: Object.fromEntries(
      Object.entries(cellRegions).map(([key, value]) => [key, roundScore(value)])
    ),
    template_regions: Object.fromEntries(
      Object.entries(templateRegions).map(([key, value]) => [key, roundScore(value)])
    )
  };
}

module.exports = {
  renderTargetTemplate,
  calculateSimilarityScore,
  calculateStructureScore
};
