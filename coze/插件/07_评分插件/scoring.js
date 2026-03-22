const sharp = require('sharp');
const { resolveConfig } = require('./config');

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value) {
  return Math.round(value * 100) / 100;
}

function normalizeGridType(gridType) {
  if (!gridType) {
    return 'square';
  }

  const value = String(gridType).trim().toLowerCase();
  if (['square', 'normal', 'plain', '普通', '方格'].includes(value)) {
    return 'square';
  }
  if (['tian', '田', '田字格'].includes(value)) {
    return 'tian';
  }
  if (['mi', '米', '米字格'].includes(value)) {
    return 'mi';
  }
  return 'square';
}

function isGuideTemplatePixel(x, y, width, height, gridType) {
  const normalizedType = normalizeGridType(gridType);
  if (normalizedType === 'square') {
    return false;
  }

  const nx = (x + 0.5) / Math.max(width, 1);
  const ny = (y + 0.5) / Math.max(height, 1);
  const centerBand = Math.max(0.018, 2.2 / Math.max(Math.min(width, height), 1));
  const diagonalBand = Math.max(0.02, 2.8 / Math.max(Math.min(width, height), 1));
  const onCenterCross =
    Math.abs(nx - 0.5) <= centerBand ||
    Math.abs(ny - 0.5) <= centerBand;

  if (normalizedType === 'tian') {
    return onCenterCross;
  }

  const onDiagonalA = Math.abs(nx - ny) <= diagonalBand;
  const onDiagonalB = Math.abs(nx + ny - 1) <= diagonalBand;
  return onCenterCross || onDiagonalA || onDiagonalB;
}

function scoreCenterOffset(offset, scale) {
  return Math.max(0, 100 - scale * Math.abs(offset));
}

function scoreRatioInRange(value, idealLow, idealHigh, penaltyScale) {
  if (value >= idealLow && value <= idealHigh) {
    return 100;
  }

  const distance = value < idealLow ? idealLow - value : value - idealHigh;
  return Math.max(0, 100 - penaltyScale * distance);
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

function buildForegroundMask(data, info, threshold, config) {
  const { width, height, channels } = info;
  const mask = new Uint8Array(width * height);
  const insetX = Math.floor(width * config.image.analysis_inset_ratio);
  const insetY = Math.floor(height * config.image.analysis_inset_ratio);
  const gridType = normalizeGridType(config.image.grid_type || 'square');
  let graySum = 0;
  let grayCount = 0;

  for (let y = insetY; y < height - insetY; y++) {
    for (let x = insetX; x < width - insetX; x++) {
      const index = y * width + x;
      const offset = index * channels;
      const r = data[offset];
      const g = channels > 1 ? data[offset + 1] : data[offset];
      const b = channels > 2 ? data[offset + 2] : data[offset];
      const isRedGrid =
        config.image.ignore_red_grid &&
        r > 150 &&
        g < 170 &&
        b < 170 &&
        r - g > 30 &&
        r - b > 30;

      if (isRedGrid) {
        continue;
      }

      graySum += 0.299 * r + 0.587 * g + 0.114 * b;
      grayCount++;
    }
  }

  const meanGray = grayCount ? graySum / grayCount : 255;
  const effectiveThreshold = Math.max(90, Math.min(threshold, meanGray - 35));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const offset = index * channels;

      if (x < insetX || x >= width - insetX || y < insetY || y >= height - insetY) {
        mask[index] = 0;
        continue;
      }

      const r = data[offset];
      const g = channels > 1 ? data[offset + 1] : data[offset];
      const b = channels > 2 ? data[offset + 2] : data[offset];
      const isRedGrid =
        config.image.ignore_red_grid &&
        r > 150 &&
        g < 170 &&
        b < 170 &&
        r - g > 30 &&
        r - b > 30;

      if (isRedGrid) {
        mask[index] = 0;
        continue;
      }

      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const guideThreshold = isGuideTemplatePixel(x, y, width, height, gridType)
        ? Math.max(60, effectiveThreshold - 28)
        : effectiveThreshold;
      mask[index] = gray < guideThreshold ? 1 : 0;
    }
  }

  return mask;
}

function connectedComponents(mask, width, height, options = {}) {
  const includePixels = Boolean(options.includePixels);
  const visited = new Uint8Array(width * height);
  const components = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const startIndex = y * width + x;
      if (!mask[startIndex] || visited[startIndex]) {
        continue;
      }

      const queue = [[x, y]];
      visited[startIndex] = 1;
      let head = 0;
      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let sumX = 0;
      let sumY = 0;
      const pixels = includePixels ? [] : null;

      while (head < queue.length) {
        const [cx, cy] = queue[head++];
        const index = cy * width + cx;

        area++;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        sumX += cx;
        sumY += cy;
        if (pixels) {
          pixels.push(index);
        }

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

          const neighborIndex = ny * width + nx;
          if (!mask[neighborIndex] || visited[neighborIndex]) {
            continue;
          }

          visited[neighborIndex] = 1;
          queue.push([nx, ny]);
        }
      }

      components.push({
        area,
        left: minX,
        top: minY,
        right: maxX,
        bottom: maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        centerX: sumX / area,
        centerY: sumY / area,
        pixels
      });
    }
  }

  return components.sort((a, b) => b.area - a.area);
}

function zeroOutRuns(mask, width, height, sums, coverageThreshold, maxRunWidth, edgeRatio, axis) {
  const axisLength = axis === 'x' ? height : width;
  const runLength = axis === 'x' ? width : height;
  let start = -1;

  for (let index = 0; index <= sums.length; index++) {
    const active = index < sums.length && sums[index] >= axisLength * coverageThreshold;

    if (active && start === -1) {
      start = index;
      continue;
    }

    if (active || start === -1) {
      continue;
    }

    const end = index - 1;
    const runWidth = end - start + 1;
    const runCenter = (start + end) / 2;
    const distanceToEdge = Math.min(runCenter, runLength - 1 - runCenter);
    const nearEdge = distanceToEdge <= runLength * edgeRatio;

    if (runWidth <= maxRunWidth && nearEdge) {
      for (let runIndex = start; runIndex <= end; runIndex++) {
        if (axis === 'x') {
          for (let y = 0; y < height; y++) {
            mask[y * width + runIndex] = 0;
          }
        } else {
          for (let x = 0; x < width; x++) {
            mask[runIndex * width + x] = 0;
          }
        }
      }
    }

    start = -1;
  }
}

function removeGuideLineRuns(mask, width, height, config) {
  const cleaned = Uint8Array.from(mask);
  const columnSums = new Array(width).fill(0);
  const rowSums = new Array(height).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = cleaned[y * width + x];
      columnSums[x] += value;
      rowSums[y] += value;
    }
  }

  zeroOutRuns(
    cleaned,
    width,
    height,
    columnSums,
    config.blank_cleanup.column_coverage_min,
    config.blank_cleanup.max_line_run_px,
    config.blank_cleanup.line_run_edge_ratio,
    'x'
  );
  zeroOutRuns(
    cleaned,
    width,
    height,
    rowSums,
    config.blank_cleanup.row_coverage_min,
    config.blank_cleanup.max_line_run_px,
    config.blank_cleanup.line_run_edge_ratio,
    'y'
  );

  return cleaned;
}

function isGuideLineComponent(component, width, height, config) {
  const totalPixels = width * height;
  const longSide = Math.max(component.width, component.height);
  const shortSide = Math.min(component.width, component.height);
  const aspectRatio = longSide / Math.max(shortSide, 1);
  const maxThickness = Math.min(
    config.blank_cleanup.guide_component_max_thickness_px,
    Math.max(2, Math.floor(Math.min(width, height) * config.blank_cleanup.guide_component_max_thickness_ratio))
  );
  const minLength = Math.max(6, Math.floor(Math.max(width, height) * config.blank_cleanup.guide_component_min_length_ratio));
  const edgeMarginX = Math.floor(width * config.blank_cleanup.guide_component_edge_ratio);
  const edgeMarginY = Math.floor(height * config.blank_cleanup.guide_component_edge_ratio);
  const nearEdge =
    component.left <= edgeMarginX ||
    component.right >= width - edgeMarginX - 1 ||
    component.top <= edgeMarginY ||
    component.bottom >= height - edgeMarginY - 1;

  return (
    nearEdge &&
    shortSide <= maxThickness &&
    longSide >= minLength &&
    aspectRatio >= config.blank_cleanup.guide_component_min_aspect_ratio &&
    component.area / totalPixels <= config.blank_cleanup.guide_component_max_area_ratio
  );
}

function removeGuideLineComponents(mask, width, height, config) {
  const cleaned = Uint8Array.from(mask);
  const components = connectedComponents(cleaned, width, height, { includePixels: true });

  for (const component of components) {
    if (!isGuideLineComponent(component, width, height, config)) {
      continue;
    }

    for (const index of component.pixels || []) {
      cleaned[index] = 0;
    }
  }

  return cleaned;
}

function removeOuterBandComponents(mask, width, height) {
  const cleaned = Uint8Array.from(mask);
  const components = connectedComponents(cleaned, width, height, { includePixels: true });
  const totalPixels = width * height;

  for (const component of components) {
    const longSide = Math.max(component.width, component.height);
    const shortSide = Math.min(component.width, component.height);
    const aspectRatio = longSide / Math.max(shortSide, 1);
    const centerX = (component.left + component.right) / 2 / Math.max(width - 1, 1);
    const centerY = (component.top + component.bottom) / 2 / Math.max(height - 1, 1);
    const horizontalOuterBand = component.width >= component.height && (centerY <= 0.24 || centerY >= 0.76);
    const verticalOuterBand = component.height > component.width && (centerX <= 0.24 || centerX >= 0.76);

    if (
      aspectRatio >= 5 &&
      shortSide <= Math.max(12, Math.floor(Math.min(width, height) * 0.08)) &&
      longSide >= Math.max(width, height) * 0.18 &&
      component.area / totalPixels <= 0.08 &&
      (horizontalOuterBand || verticalOuterBand)
    ) {
      for (const index of component.pixels || []) {
        cleaned[index] = 0;
      }
    }
  }

  return cleaned;
}

function buildBlankAnalysisMask(mask, width, height, config) {
  if (!config.blank_cleanup.enabled) {
    return mask;
  }

  return removeOuterBandComponents(
    removeGuideLineComponents(
      removeGuideLineRuns(mask, width, height, config),
      width,
      height,
      config
    ),
    width,
    height
  );
}

function filterEdgeTouchingComponents(components, width, height, config) {
  if (!config.components.ignore_edge_touching_components) {
    return components;
  }

  const edgeMargin = config.components.edge_margin_px;
  const areaRatioMax = config.components.edge_component_max_area_ratio;
  const totalPixels = width * height;

  return components.filter((component) => {
    const touchesEdge =
      component.left <= edgeMargin ||
      component.top <= edgeMargin ||
      component.right >= width - edgeMargin - 1 ||
      component.bottom >= height - edgeMargin - 1;

    if (!touchesEdge) {
      return true;
    }

    return component.area / totalPixels > areaRatioMax;
  });
}

function calculateCentralInkRatio(mask, width, height) {
  const startX = Math.floor(width * 0.3);
  const endX = Math.ceil(width * 0.7);
  const startY = Math.floor(height * 0.3);
  const endY = Math.ceil(height * 0.7);
  let ink = 0;
  let total = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      ink += mask[y * width + x];
      total++;
    }
  }

  return total ? ink / total : 0;
}

function summarizeMaskFeatures(mask, width, height, config) {
  const rawComponents = connectedComponents(mask, width, height);
  const components = filterEdgeTouchingComponents(rawComponents, width, height, config);
  const totalPixels = width * height;
  const inkPixels = components.reduce((sum, component) => sum + component.area, 0);
  const inkRatio = inkPixels / totalPixels;
  const centralInkRatio = calculateCentralInkRatio(mask, width, height);
  const largeComponentMinArea = Math.max(12, Math.floor(totalPixels * 0.0015));
  const mainComponents = components.filter((component) => component.area >= largeComponentMinArea);
  const primary = mainComponents[0] || components[0] || null;

  if (!primary) {
    return {
      width,
      height,
      inkRatio,
      componentCount: 0,
      noiseComponentCount: 0,
      primaryAreaRatio: 0,
      bboxRatio: 0,
      centralInkRatio,
      centerDx: 0,
      centerDy: 0,
      marginTop: 1,
      marginBottom: 1,
      marginLeft: 1,
      marginRight: 1,
      marginBalanceX: 1,
      marginBalanceY: 1,
      aspectRatio: 0,
      strokeDensity: 0
    };
  }

  const cellCenterX = (width - 1) / 2;
  const cellCenterY = (height - 1) / 2;
  const bboxArea = primary.width * primary.height;
  const marginTop = primary.top / height;
  const marginBottom = (height - (primary.top + primary.height)) / height;
  const marginLeft = primary.left / width;
  const marginRight = (width - (primary.left + primary.width)) / width;
  const safeMarginX = Math.max(marginLeft, marginRight, 1e-6);
  const safeMarginY = Math.max(marginTop, marginBottom, 1e-6);
  const noiseComponentCount = components.filter((component) => component.area < largeComponentMinArea).length;

  return {
    width,
    height,
    inkRatio,
    componentCount: components.length,
    noiseComponentCount,
    primaryAreaRatio: primary.area / totalPixels,
    bboxRatio: bboxArea / totalPixels,
    centralInkRatio,
    centerDx: (primary.centerX - cellCenterX) / width,
    centerDy: (primary.centerY - cellCenterY) / height,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
    marginBalanceX: Math.min(marginLeft, marginRight) / safeMarginX,
    marginBalanceY: Math.min(marginTop, marginBottom) / safeMarginY,
    aspectRatio: primary.width / Math.max(primary.height, 1),
    strokeDensity: primary.area / Math.max(bboxArea, 1)
  };
}

async function decodeCellImage(cellImage) {
  if (Buffer.isBuffer(cellImage)) {
    return cellImage;
  }

  if (typeof cellImage === 'string' && !cellImage.trim()) {
    throw new Error('cell_image为空字符串');
  }

  if (typeof cellImage === 'string') {
    return Buffer.from(cellImage, 'base64');
  }

  throw new Error('仅支持Buffer或base64字符串格式的单格图像');
}

async function renderTargetTemplate(targetChar, size) {
  const fontSize = Math.floor(size * 0.58);
  let svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';
  svg += `<text x="${size / 2}" y="${size / 2}" font-family="sans-serif" font-size="${fontSize}" text-anchor="middle" dominant-baseline="middle" fill="black">${targetChar}</text>`;
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function resizeMaskFromBuffer(buffer, size, threshold, config) {
  const image = sharp(buffer).ensureAlpha().resize(size, size, { fit: 'fill' });
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  return buildForegroundMask(data, info, threshold, config);
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

function calculateDensitySimilarity(densityA, densityB) {
  let diff = 0;
  for (let i = 0; i < densityA.length; i++) {
    diff += Math.abs(densityA[i] - densityB[i]);
  }
  const normalized = diff / densityA.length;
  return clamp(1 - normalized, 0, 1);
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

async function extractFeatures(cellImage, options = {}) {
  const config = options.config || resolveConfig();
  const threshold = options.threshold || config.image.threshold;
  const buffer = await decodeCellImage(cellImage);
  const image = sharp(buffer).ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });

  const mask = buildForegroundMask(data, info, threshold, config);
  const blankMask = buildBlankAnalysisMask(mask, info.width, info.height, config);

  return {
    ...summarizeMaskFeatures(mask, info.width, info.height, config),
    blankDetection: summarizeMaskFeatures(blankMask, info.width, info.height, config)
  };
}

async function extractCellLayers(cellImage, options = {}) {
  const config = options.config || resolveConfig();
  const threshold = options.threshold || config.image.threshold;
  const buffer = await decodeCellImage(cellImage);
  const image = sharp(buffer).ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  const mask = buildForegroundMask(data, info, threshold, config);
  const blankMask = buildBlankAnalysisMask(mask, info.width, info.height, config);
  const textOnly = Buffer.alloc(info.width * info.height * 4, 255);
  const backgroundOnly = Buffer.alloc(info.width * info.height * 4, 255);
  const maskBuffer = Buffer.alloc(info.width * info.height);
  const blankMaskBuffer = Buffer.alloc(info.width * info.height);
  let foregroundPixels = 0;

  for (let index = 0; index < info.width * info.height; index++) {
    const maskValue = mask[index] ? 255 : 0;
    const cleanedMaskValue = blankMask[index] ? 255 : 0;
    const offset = index * info.channels;
    const rgbaOffset = index * 4;

    maskBuffer[index] = maskValue;
    blankMaskBuffer[index] = cleanedMaskValue;

    if (cleanedMaskValue) {
      foregroundPixels += 1;
      textOnly[rgbaOffset] = data[offset];
      textOnly[rgbaOffset + 1] = data[offset + Math.min(1, info.channels - 1)];
      textOnly[rgbaOffset + 2] = data[offset + Math.min(2, info.channels - 1)];
      textOnly[rgbaOffset + 3] = 255;
    }

    if (!cleanedMaskValue) {
      backgroundOnly[rgbaOffset] = data[offset];
      backgroundOnly[rgbaOffset + 1] = data[offset + Math.min(1, info.channels - 1)];
      backgroundOnly[rgbaOffset + 2] = data[offset + Math.min(2, info.channels - 1)];
      backgroundOnly[rgbaOffset + 3] = 255;
    }
  }

  return {
    info,
    stats: {
      totalPixels: info.width * info.height,
      foregroundPixels,
      foregroundRatio: roundScore(foregroundPixels / Math.max(1, info.width * info.height))
    },
    buffers: {
      original: await sharp(buffer).png().toBuffer(),
      foregroundMask: await sharp(maskBuffer, {
        raw: { width: info.width, height: info.height, channels: 1 }
      }).png().toBuffer(),
      cleanedForegroundMask: await sharp(blankMaskBuffer, {
        raw: { width: info.width, height: info.height, channels: 1 }
      }).png().toBuffer(),
      textOnly: await sharp(textOnly, {
        raw: { width: info.width, height: info.height, channels: 4 }
      }).png().toBuffer(),
      backgroundOnly: await sharp(backgroundOnly, {
        raw: { width: info.width, height: info.height, channels: 4 }
      }).png().toBuffer()
    }
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
  const templateBuffer = await renderTargetTemplate(targetChar, templateSize);
  const cellMask = await resizeMaskFromBuffer(cellBuffer, templateSize, threshold, config);
  const templateMask = await resizeMaskFromBuffer(templateBuffer, templateSize, threshold, config);
  const iou = calculateMaskIoU(cellMask, templateMask);
  const densitySimilarity = calculateDensitySimilarity(
    calculateGridDensity(cellMask, 4),
    calculateGridDensity(templateMask, 4)
  );

  const similarity = 100 * (0.6 * iou + 0.4 * densitySimilarity);
  return {
    score: roundScore(similarity),
    iou: roundScore(iou),
    density_similarity: roundScore(densitySimilarity)
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
  const templateBuffer = await renderTargetTemplate(targetChar, templateSize);
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
  const structureScore = roundScore(clamp(100 * (1 - meanRegionDiff * config.structure.score_scale), 0, 100));

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

function detectBlank(features, config) {
  const blankFeatures = features.blankDetection || features;
  const isStrongBlank = (candidateFeatures, requireCentralLow = false) =>
    candidateFeatures.inkRatio < config.blank.strong_ink_ratio_max &&
    candidateFeatures.primaryAreaRatio < config.blank.strong_primary_area_ratio_max &&
    candidateFeatures.bboxRatio < config.blank.strong_bbox_ratio_max &&
    (!requireCentralLow || candidateFeatures.centralInkRatio < config.blank.strong_center_ink_ratio_max);
  const edgeFragmentLikelyCharacter = (candidateFeatures) =>
    candidateFeatures.inkRatio >= 0.0018 &&
    candidateFeatures.componentCount >= 40 &&
    candidateFeatures.noiseComponentCount >= 35 &&
    candidateFeatures.strokeDensity >= 0.35 &&
    (
      candidateFeatures.marginBalanceX < 0.28 ||
      candidateFeatures.marginBalanceY < 0.28
    );
  const blankProbFromFeatures = (candidateFeatures) => clamp(
    1 -
      candidateFeatures.inkRatio * config.blank.ink_ratio_weight -
      candidateFeatures.primaryAreaRatio * config.blank.primary_area_ratio_weight -
      candidateFeatures.bboxRatio * config.blank.bbox_ratio_weight -
      candidateFeatures.componentCount * config.blank.component_count_weight,
    0,
    1
  );
  const strongBlank = isStrongBlank(features, false) || isStrongBlank(blankFeatures, true);
  const shouldRescueEdgeFragment =
    edgeFragmentLikelyCharacter(features) ||
    edgeFragmentLikelyCharacter(blankFeatures);
  const isBlank =
    (strongBlank && !shouldRescueEdgeFragment) ||
    (
      blankFeatures.inkRatio < config.blank.ink_ratio_max &&
      blankFeatures.primaryAreaRatio < config.blank.primary_area_ratio_max &&
      blankFeatures.bboxRatio < config.blank.bbox_ratio_max &&
      blankFeatures.centralInkRatio < config.blank.center_ink_ratio_max &&
      blankFeatures.componentCount <= config.blank.component_count_max
    );
  const residualFragmentBlank =
    blankFeatures.inkRatio < 0.012 &&
    blankFeatures.primaryAreaRatio < 0.0022 &&
    blankFeatures.bboxRatio < 0.003 &&
    blankFeatures.centralInkRatio < 0.05 &&
    blankFeatures.componentCount <= 8;
  const blankProb = Math.max(blankProbFromFeatures(features), blankProbFromFeatures(blankFeatures));

  return {
    isBlank: (isBlank || residualFragmentBlank) && !shouldRescueEdgeFragment,
    blankProb: residualFragmentBlank && !shouldRescueEdgeFragment ? Math.max(blankProb, 0.92) : blankProb
  };
}

function calculateLayoutScore(features, config) {
  const scoreCenterX = scoreCenterOffset(features.centerDx, config.layout.center_penalty_scale);
  const scoreCenterY = scoreCenterOffset(features.centerDy, config.layout.center_penalty_scale);
  const scoreCenter = average([scoreCenterX, scoreCenterY]);
  const scoreMargin = 50 * features.marginBalanceX + 50 * features.marginBalanceY;
  return roundScore(config.layout.center_weight * scoreCenter + config.layout.margin_weight * scoreMargin);
}

function calculateSizeScore(features, config) {
  return roundScore(
    scoreRatioInRange(
      features.bboxRatio,
      config.size.ideal_bbox_ratio_low,
      config.size.ideal_bbox_ratio_high,
      config.size.penalty_scale
    )
  );
}

function calculateStabilityScore(features, config) {
  let stability = 100;
  stability -= Math.min(config.stability.noise_component_penalty_max, features.noiseComponentCount * config.stability.noise_component_penalty);
  stability -= Math.min(
    config.stability.component_overflow_penalty_max,
    Math.max(0, features.componentCount - 3) * config.stability.component_overflow_penalty
  );
  stability -= Math.min(
    config.stability.stroke_density_penalty_max,
    Math.abs(features.strokeDensity - config.stability.stroke_density_target) * config.stability.stroke_density_penalty_scale
  );
  return roundScore(Math.max(0, stability));
}

function buildPenalties(features, config, structure = null) {
  const penalties = [];

  if (features.centerDx < -config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_LEFT', message: '字心偏左', severity: roundScore(Math.abs(features.centerDx)) });
  }
  if (features.centerDx > config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_RIGHT', message: '字心偏右', severity: roundScore(Math.abs(features.centerDx)) });
  }
  if (features.centerDy < -config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_UP', message: '字心偏上', severity: roundScore(Math.abs(features.centerDy)) });
  }
  if (features.centerDy > config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_DOWN', message: '字心偏下', severity: roundScore(Math.abs(features.centerDy)) });
  }
  if (features.bboxRatio < config.size.ideal_bbox_ratio_low) {
    penalties.push({ code: 'LOW_BBOX_RATIO', message: '整体偏小', severity: roundScore(config.size.ideal_bbox_ratio_low - features.bboxRatio) });
  }
  if (features.bboxRatio > config.size.ideal_bbox_ratio_high) {
    penalties.push({ code: 'HIGH_BBOX_RATIO', message: '整体偏大', severity: roundScore(features.bboxRatio - config.size.ideal_bbox_ratio_high) });
  }
  if (features.marginBalanceX < config.penalties.margin_balance_threshold) {
    penalties.push({ code: 'MARGIN_X_UNBALANCED', message: '左右留白不均', severity: roundScore(1 - features.marginBalanceX) });
  }
  if (features.marginBalanceY < config.penalties.margin_balance_threshold) {
    penalties.push({ code: 'MARGIN_Y_UNBALANCED', message: '上下留白不均', severity: roundScore(1 - features.marginBalanceY) });
  }
  if (features.noiseComponentCount >= config.penalties.noise_component_threshold) {
    penalties.push({ code: 'NOISE_COMPONENTS', message: '噪点较多', severity: roundScore(features.noiseComponentCount / 10) });
  }

  if (structure) {
    if (structure.score < config.structure.template_mismatch_score_threshold) {
      penalties.push({
        code: 'STRUCTURE_TEMPLATE_MISMATCH',
        message: '整体结构与目标字存在差异',
        severity: roundScore(
          (config.structure.template_mismatch_score_threshold - structure.score) /
            config.structure.template_mismatch_score_threshold
        )
      });
    }
    if (
      structure.region_diffs.left > config.structure.left_right_diff_threshold &&
      structure.region_diffs.right > config.structure.left_right_diff_threshold
    ) {
      penalties.push({ code: 'STRUCTURE_LR_IMBALANCE', message: '左右结构分布失衡', severity: roundScore(Math.max(structure.region_diffs.left, structure.region_diffs.right)) });
    }
    if (
      structure.region_diffs.top > config.structure.up_down_diff_threshold &&
      structure.region_diffs.bottom > config.structure.up_down_diff_threshold
    ) {
      penalties.push({ code: 'STRUCTURE_UD_IMBALANCE', message: '上下结构分布失衡', severity: roundScore(Math.max(structure.region_diffs.top, structure.region_diffs.bottom)) });
    }
    if (
      structure.region_diffs.topLeft > config.structure.diagonal_diff_threshold ||
      structure.region_diffs.bottomRight > config.structure.diagonal_diff_threshold
    ) {
      penalties.push({ code: 'STRUCTURE_DIAGONAL_MISMATCH', message: '对角结构与标准字差异较大', severity: roundScore(Math.max(structure.region_diffs.topLeft, structure.region_diffs.bottomRight)) });
    }
  }

  return penalties;
}

function levelFromScore(score) {
  if (score >= 90) {
    return 'excellent';
  }
  if (score >= 75) {
    return 'good';
  }
  if (score >= 60) {
    return 'pass';
  }
  return 'poor';
}

function normalizeContentBox(cell) {
  if (!cell) {
    return null;
  }
  if (cell.content_box) {
    return cell.content_box;
  }
  if (cell.page_box) {
    return {
      left: 0,
      top: 0,
      width: cell.page_box.width,
      height: cell.page_box.height
    };
  }
  return null;
}

function labelFromResult(result, config) {
  if (result.status === 'blank') {
    return '空白';
  }

  if (result.total_score >= config.display.excellent_min) {
    return '优秀';
  }
  if (result.total_score >= config.display.good_min) {
    return '良好';
  }
  if (result.total_score >= config.display.pass_min) {
    return '及格';
  }
  return '待提升';
}

function actionFromResult(result, config) {
  if (result.status === 'blank') {
    return 'mark_blank';
  }
  if (result.total_score < config.review.low_score_threshold) {
    return 'review';
  }
  return 'pass';
}

function colorFromResult(result, config) {
  if (result.status === 'blank') {
    return '#6b7280';
  }
  if (result.total_score >= config.display.excellent_min) {
    return '#15803d';
  }
  if (result.total_score >= config.display.good_min) {
    return '#2563eb';
  }
  if (result.total_score >= config.display.pass_min) {
    return '#d97706';
  }
  return '#dc2626';
}

function blankReasonFromFeatures(features) {
  const blankFeatures = features.blankDetection || features;

  if (blankFeatures.componentCount === 0 || blankFeatures.primaryAreaRatio === 0) {
    return 'NO_FOREGROUND';
  }
  if (blankFeatures.inkRatio < 0.003) {
    return 'LOW_INK_RATIO';
  }
  if (blankFeatures.bboxRatio < 0.01) {
    return 'LOW_BBOX_RATIO';
  }
  return 'LIKELY_EMPTY_CELL';
}

function buildPageStats(results, config, gridRows, gridCols) {
  const blankCells = results.filter((item) => item.status === 'blank');
  const scoredCells = results.filter((item) => item.status === 'scored');
  const lowScoreCells = scoredCells.filter((item) => item.total_score !== null && item.total_score < config.review.low_score_threshold);
  const reviewCells = results.filter((item) => {
    if (item.status === 'blank') {
      return true;
    }
    if (item.total_score !== null && item.total_score < config.review.low_score_threshold) {
      return true;
    }
    return item.model_outputs && item.model_outputs.blank_prob >= config.review.blank_prob_review_threshold;
  });

  const statusMatrix = Array.from({ length: gridRows }, () => Array(gridCols).fill(null));
  for (const item of results) {
    statusMatrix[item.row][item.col] = item.status;
  }

  return {
    blank_cell_ids: blankCells.map((item) => item.cell_id),
    scored_cell_ids: scoredCells.map((item) => item.cell_id),
    low_score_cell_ids: lowScoreCells.map((item) => item.cell_id),
    review_cell_ids: reviewCells.map((item) => item.cell_id),
    status_matrix: statusMatrix
  };
}

function buildGridResults(results, config, gridRows, gridCols) {
  const grid = Array.from({ length: gridRows }, () => Array(gridCols).fill(null));

  for (const item of results) {
    grid[item.row][item.col] = {
      cell_id: item.cell_id,
      row: item.row,
      col: item.col,
      target_char: item.target_char,
      status: item.status,
      label: labelFromResult(item, config),
      action: actionFromResult(item, config),
      color: colorFromResult(item, config),
      total_score: item.total_score,
      score_level: item.score_level,
      blank_reason: item.blank_reason,
      penalty_count: item.penalties.length,
      top_penalty: item.penalties.length ? item.penalties[0].message : null
    };
  }

  return grid;
}

function buildChineseScoringView(result) {
  return {
    任务ID: result.task_id,
    图片ID: result.image_id,
    汇总信息: result.中文结果?.汇总信息 || null,
    页面统计: result.中文结果?.页面统计 || null,
    网格结果: result.中文结果?.网格结果 || null,
    单格结果: result.中文结果?.单格结果 || null,
    输出目录: result.outputDir || null,
    单格评分目录: result.cellsRootDir || null
  };
}

async function renderAnnotatedPage({ imagePath, scoringResult, outputImagePath, outputSummaryPath = null, options = {} }) {
  const fs = require('fs');
  const config = resolveConfig(options.config);
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const overlays = [];
  const summaryLines = [];

  for (const result of scoringResult.results) {
    if (!result.page_box) {
      continue;
    }

    const color = colorFromResult(result, config);
    const box = result.page_box;
    const title = result.status === 'blank' ? '空白' : `${Math.round(result.total_score)}`;
    const subtitle = result.status === 'blank'
      ? (result.blank_reason || '空白格')
      : (result.penalties.slice(0, 2).map((item) => item.message).join(' / ') || '无明显扣分');
    const fontSize = Math.max(18, Math.floor(Math.min(box.width, box.height) * 0.12));
    const tagHeight = Math.max(28, Math.floor(fontSize * 1.6));
    const tagWidth = Math.min(box.width, Math.max(70, Math.floor(box.width * 0.78)));

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="4"/>
        <rect x="${box.left}" y="${box.top}" width="${tagWidth}" height="${tagHeight}" rx="6" ry="6" fill="${color}" fill-opacity="0.88"/>
        <text x="${box.left + 8}" y="${box.top + Math.floor(tagHeight * 0.72)}" font-family="sans-serif" font-size="${fontSize}" fill="white">${title}</text>
      </svg>
    `;

    overlays.push({ input: Buffer.from(svg), top: 0, left: 0 });
    summaryLines.push(`${result.cell_id}\t${result.status}\t${title}\t${subtitle}`);
  }

  await sharp(imagePath).composite(overlays).png().toFile(outputImagePath);

  if (outputSummaryPath) {
    const lines = [
      `image: ${imagePath}`,
      `blank_cells: ${scoringResult.summary.blank_cells}`,
      `avg_score: ${scoringResult.summary.avg_score}`,
      '',
      'cell_id\tstatus\tscore_or_mark\tpenalties',
      ...summaryLines
    ];
    await fs.promises.writeFile(outputSummaryPath, `${lines.join('\n')}\n`, 'utf8');
  }

  return {
    outputImagePath,
    outputSummaryPath
  };
}

async function scoreCell(cell, options = {}, outputDir = null) {
  const config = resolveConfig(options.config);
  const cellFeatureExtractPlugin = require('../07_1单格特征提取插件/index');
  const blankCellJudgePlugin = require('../07_2空白格判定插件/index');
  const cellStructureScorePlugin = require('../07_3单格结构评分插件/index');
  const cellSimilarityScorePlugin = require('../07_4单格相似度评分插件/index');
  const cellFinalScorePlugin = require('../07_5单格总评分插件/index');
  const fs = require('fs');
  const path = require('path');

  const step07_1Dir = outputDir ? path.join(outputDir, '07_1_单格特征提取') : null;
  const step07_2Dir = outputDir ? path.join(outputDir, '07_2_空白格判定') : null;
  const step07_3Dir = outputDir ? path.join(outputDir, '07_3_单格结构评分') : null;
  const step07_4Dir = outputDir ? path.join(outputDir, '07_4_单格相似度评分') : null;
  const step07_5Dir = outputDir ? path.join(outputDir, '07_5_单格总评分') : null;
  const ensureStepDirs = async () => {
    if (!outputDir) return;
    await fs.promises.mkdir(step07_1Dir, { recursive: true });
    await fs.promises.mkdir(step07_2Dir, { recursive: true });
    await fs.promises.mkdir(step07_3Dir, { recursive: true });
    await fs.promises.mkdir(step07_4Dir, { recursive: true });
    await fs.promises.mkdir(step07_5Dir, { recursive: true });
  };
  const writeStepMeta = async (dir, suffix, payload) => {
    if (!outputDir) return null;
    const metaPath = path.join(dir, `${suffix}.json`);
    await fs.promises.writeFile(metaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return metaPath;
  };

  await ensureStepDirs();

  const step07_1 = await cellFeatureExtractPlugin.execute({
    cellImage: cell.cell_image,
    options: { ...options, config }
  });
  step07_1.sourceStep = '06_4_单格文字图';
  step07_1.inputPath = cell.cell_image_path || null;
  const features = step07_1.features;
  const step07_2 = blankCellJudgePlugin.execute({ features, config });
  step07_2.sourceStep = '07_1_单格特征提取';
  step07_2.inputPath = cell.cell_image_path || null;
  const { blankResult, blankReason } = step07_2;
  const stepMetaPaths = {
    step07_1: await writeStepMeta(step07_1Dir, '07_1_单格特征提取', step07_1),
    step07_2: await writeStepMeta(step07_2Dir, '07_2_空白格判定', step07_2),
    step07_3: null,
    step07_4: null,
    step07_5: null
  };
  const stepDirs = outputDir
    ? {
        step07_1: step07_1Dir,
        step07_2: step07_2Dir,
        step07_3: step07_3Dir,
        step07_4: step07_4Dir,
        step07_5: step07_5Dir
      }
    : {};

  if (blankResult.isBlank) {
    const step07_5 = {
      processNo: '07_5',
      processName: '07_5_单格总评分',
      sourceStep: '07_2_空白格判定',
      inputPath: cell.cell_image_path || null,
      status: 'blank',
      blankResult,
      blankReason
    };
    stepMetaPaths.step07_5 = await writeStepMeta(step07_5Dir, '07_5_单格总评分', step07_5);
    return {
      cell_id: cell.cell_id,
      row: cell.row,
      col: cell.col,
      target_char: cell.target_char || null,
      page_box: cell.page_box || null,
      content_box: normalizeContentBox(cell),
      status: 'blank',
      is_blank: true,
      blank_reason: blankReason,
      total_score: null,
      score_level: null,
      sub_scores: {},
      penalties: [],
      features,
      model_outputs: {
        blank_prob: roundScore(blankResult.blankProb)
      },
      stepDirs,
      stepMetaPaths
    };
  }

  const step07_3 = await cellStructureScorePlugin.execute({
    cellImage: cell.cell_image,
    targetChar: cell.target_char,
    options: { ...options, config }
  });
  step07_3.sourceStep = '07_2_空白格判定';
  step07_3.inputPath = cell.cell_image_path || null;
  const structure = step07_3.structure;
  const step07_4 = await cellSimilarityScorePlugin.execute({
    cellImage: cell.cell_image,
    targetChar: cell.target_char,
    options: { ...options, config }
  });
  step07_4.sourceStep = '07_2_空白格判定';
  step07_4.inputPath = cell.cell_image_path || null;
  const similarity = step07_4.similarity;
  const step07_5 = cellFinalScorePlugin.execute({
    features,
    structure,
    similarity,
    config
  });
  step07_5.sourceStep = '07_3_单格结构评分 + 07_4_单格相似度评分';
  step07_5.inputPath = cell.cell_image_path || null;
  const finalScore = step07_5;
  stepMetaPaths.step07_3 = await writeStepMeta(step07_3Dir, '07_3_单格结构评分', step07_3);
  stepMetaPaths.step07_4 = await writeStepMeta(step07_4Dir, '07_4_单格相似度评分', step07_4);
  stepMetaPaths.step07_5 = await writeStepMeta(step07_5Dir, '07_5_单格总评分', step07_5);

  return {
    cell_id: cell.cell_id,
    row: cell.row,
    col: cell.col,
    target_char: cell.target_char || null,
    page_box: cell.page_box || null,
    content_box: normalizeContentBox(cell),
    status: 'scored',
    is_blank: false,
    blank_reason: null,
    total_score: finalScore.total,
    score_level: finalScore.scoreLevel,
    sub_scores: finalScore.subScores,
    penalties: finalScore.penalties,
    features,
    model_outputs: {
      blank_prob: roundScore(blankResult.blankProb),
      structure_regions: structure ? structure.region_diffs : null,
      similarity_iou: similarity ? similarity.iou : null,
      similarity_density: similarity ? similarity.density_similarity : null
    },
    stepDirs,
    stepMetaPaths
  };
}

async function scoreSegmentation(payload) {
  const {
    task_id = null,
    image_id = null,
    target_chars = [],
    segmentation,
    cellLayerExtraction = null,
    options = {},
    outputDir = null
  } = payload || {};

  if (!segmentation || !Array.isArray(segmentation.matrix) || !Array.isArray(segmentation.cells)) {
    throw new Error('segmentation.matrix 和 segmentation.cells 是必需的');
  }

  const config = resolveConfig(options.config);
  const pageScoringAggregatePlugin = require('../07_0页面评分汇总插件/index');
  const aggregated = await pageScoringAggregatePlugin.execute({
    segmentation,
    cellLayerExtraction,
    target_chars,
    options,
    outputDir,
    buildPageStats,
    buildGridResults,
    config
  });
  return {
    task_id,
    image_id,
    summary: aggregated.summary,
    outputDir: aggregated.outputDir || null,
    cellsRootDir: aggregated.cellsRootDir || null,
    page_stats: aggregated.page_stats,
    grid_results: aggregated.grid_results,
    results: aggregated.results,
    中文结果: buildChineseScoringView({
      task_id,
      image_id,
      outputDir: aggregated.outputDir || null,
      cellsRootDir: aggregated.cellsRootDir || null,
      中文结果: aggregated.中文结果
    })
  };
}

module.exports = {
  extractFeatures,
  extractCellLayers,
  detectBlank,
  calculateSimilarityScore,
  calculateStructureScore,
  calculateLayoutScore,
  calculateSizeScore,
  calculateStabilityScore,
  buildPenalties,
  levelFromScore,
  blankReasonFromFeatures,
  roundScore,
  scoreCell,
  buildPageStats,
  buildGridResults,
  scoreSegmentation,
  renderAnnotatedPage
};
