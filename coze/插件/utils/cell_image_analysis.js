const path = require('path');
const { requireSharp } = require('./require_sharp');
const sharp = requireSharp([path.join(__dirname, '..', '07_评分插件')]);
const { resolveConfig } = require('../07_评分插件/config');
const { clamp, average, roundScore } = require('../07_评分插件/shared/math');

function normalizeGridType(gridType) {
  if (!gridType) {
    return 'square';
  }

  const value = String(gridType).trim().toLowerCase();
  if (['circle_mi', 'circle-mi', '圆形米字格', '圆圈米字格'].includes(value)) {
    return 'circle_mi';
  }
  if (['circle_tian', 'circle-tian', '圆形田字格', '圆圈田字格'].includes(value)) {
    return 'circle_tian';
  }
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

function inferGuideGridType(config, options = {}) {
  const explicitType = normalizeGridType(config?.image?.grid_type || 'square');
  if (explicitType !== 'square') {
    return explicitType;
  }

  const patternProfile = options.patternProfile || options.pattern_profile || null;
  if (!patternProfile) {
    return explicitType;
  }

  const hintText = [
    patternProfile.family,
    patternProfile.profileMode,
    patternProfile.globalMode,
    patternProfile.globalSpecificMode,
    patternProfile.id,
    patternProfile.reason
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    (hintText.includes('circle') || hintText.includes('round') || hintText.includes('圆')) &&
    (hintText.includes('米') || hintText.includes('mi') || hintText.includes('diagonal'))
  ) {
    return 'circle_mi';
  }

  if (
    (hintText.includes('circle') || hintText.includes('round') || hintText.includes('圆')) &&
    (hintText.includes('田') || hintText.includes('tian') || hintText.includes('cross'))
  ) {
    return 'circle_tian';
  }

  if (
    hintText.includes('米') ||
    hintText.includes('mi') ||
    hintText.includes('diagonal')
  ) {
    return 'mi';
  }

  if (
    hintText.includes('田') ||
    hintText.includes('tian') ||
    hintText.includes('cross')
  ) {
    return 'tian';
  }

  const signals = patternProfile.signals || patternProfile.sampling?.averagedSignals || {};
  const diagonalSignal = Number(signals.diagonalSignal ?? signals.diagonalDarkness ?? 0);
  const crossSignal = Number(signals.crossSignal ?? signals.crossDarkness ?? 0);
  const centerSignal = Number(signals.centerSignal ?? signals.centerDarkness ?? 0);

  if (diagonalSignal >= 0.16 && crossSignal >= 0.16) {
    return 'mi';
  }

  if (crossSignal >= 0.18 && centerSignal >= 0.18) {
    return 'tian';
  }

  return explicitType;
}

function withGuideGridType(config, options = {}) {
  const inferredGridType = inferGuideGridType(config, options);
  if (inferredGridType === normalizeGridType(config?.image?.grid_type || 'square')) {
    return config;
  }

  return {
    ...config,
    image: {
      ...(config.image || {}),
      grid_type: inferredGridType
    }
  };
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
  const radialBand = Math.max(0.02, 2.8 / Math.max(Math.min(width, height), 1));
  const onCenterCross =
    Math.abs(nx - 0.5) <= centerBand ||
    Math.abs(ny - 0.5) <= centerBand;
  const dx = nx - 0.5;
  const dy = ny - 0.5;
  const radius = Math.sqrt(dx * dx + dy * dy);
  const circleGuideRadius = 0.41;
  const onCircleRing = Math.abs(radius - circleGuideRadius) <= radialBand;

  if (normalizedType === 'tian' || normalizedType === 'circle_tian') {
    return normalizedType === 'circle_tian'
      ? (onCenterCross || onCircleRing)
      : onCenterCross;
  }

  if (normalizedType === 'circle_mi') {
    const onDiagonalA = Math.abs(nx - ny) <= diagonalBand;
    const onDiagonalB = Math.abs(nx + ny - 1) <= diagonalBand;
    return onCenterCross || onDiagonalA || onDiagonalB || onCircleRing;
  }

  if (normalizedType === 'mi') {
    const onDiagonalA = Math.abs(nx - ny) <= diagonalBand;
    const onDiagonalB = Math.abs(nx + ny - 1) <= diagonalBand;
    return onCenterCross || onDiagonalA || onDiagonalB;
  }

  if (normalizedType === 'tian') {
    return onCenterCross;
  }
  return onCenterCross || onCircleRing;
}

function buildGuideTemplateMask(width, height, gridType) {
  const normalizedType = normalizeGridType(gridType);
  const templateMask = new Uint8Array(width * height);
  if (normalizedType === 'square') {
    return templateMask;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isGuideTemplatePixel(x, y, width, height, normalizedType)) {
        templateMask[y * width + x] = 1;
      }
    }
  }

  return templateMask;
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

function removeTemplateGuideComponents(mask, width, height, config, guideType) {
  const normalizedType = normalizeGridType(guideType);
  if (normalizedType === 'square') {
    return mask;
  }

  const cleaned = Uint8Array.from(mask);
  const components = connectedComponents(cleaned, width, height, { includePixels: true });
  const templateMask = buildGuideTemplateMask(width, height, normalizedType);
  const totalPixels = width * height;
  const maxThickness = Math.min(
    config.blank_cleanup.template_fragment_max_thickness_px,
    Math.max(2, Math.floor(Math.min(width, height) * config.blank_cleanup.template_fragment_max_thickness_ratio))
  );

  for (const component of components) {
    const areaRatio = component.area / totalPixels;
    const bboxRatio = (component.width * component.height) / totalPixels;
    if (
      areaRatio > config.blank_cleanup.template_fragment_max_area_ratio ||
      bboxRatio > config.blank_cleanup.template_fragment_max_bbox_ratio
    ) {
      continue;
    }

    let overlapPixels = 0;
    for (const index of component.pixels || []) {
      if (templateMask[index]) {
        overlapPixels++;
      }
    }

    const overlapRatio = overlapPixels / Math.max(component.area, 1);
    const centerBiasX = Math.abs(component.centerX / Math.max(width - 1, 1) - 0.5);
    const centerBiasY = Math.abs(component.centerY / Math.max(height - 1, 1) - 0.5);
    const isCentralGuideFragment =
      Math.max(centerBiasX, centerBiasY) <= config.blank_cleanup.template_fragment_center_bias_ratio &&
      areaRatio <= config.blank_cleanup.template_fragment_center_max_area_ratio &&
      overlapRatio >= config.blank_cleanup.template_fragment_center_overlap_min;

    if (
      (overlapRatio >= config.blank_cleanup.template_fragment_overlap_min || isCentralGuideFragment) &&
      Math.min(component.width, component.height) <= maxThickness
    ) {
      for (const index of component.pixels || []) {
        cleaned[index] = 0;
      }
    }
  }

  return cleaned;
}

function suppressGuideTemplateForBlankLikeCells(mask, width, height, config, guideType) {
  const normalizedType = normalizeGridType(guideType);
  if (normalizedType === 'square') {
    return mask;
  }

  const features = summarizeMaskFeatures(mask, width, height, config);
  const significantComponentCount = features.significantComponentCount || 0;
  const isBlankLikeGuideResidual =
    features.inkRatio <= config.blank_cleanup.template_blanklike_ink_ratio_max &&
    features.primaryAreaRatio <= config.blank_cleanup.template_blanklike_primary_area_ratio_max &&
    features.bboxRatio <= config.blank_cleanup.template_blanklike_bbox_ratio_max &&
    features.centralInkRatio <= config.blank_cleanup.template_blanklike_central_ink_ratio_max &&
    significantComponentCount <= config.blank_cleanup.template_blanklike_significant_components_max;

  if (!isBlankLikeGuideResidual) {
    return mask;
  }

  const cleaned = Uint8Array.from(mask);
  const templateMask = buildGuideTemplateMask(width, height, normalizedType);
  for (let index = 0; index < cleaned.length; index++) {
    if (templateMask[index]) {
      cleaned[index] = 0;
    }
  }

  return cleaned;
}

function buildBlankAnalysisMask(mask, width, height, config, guideType) {
  if (!config.blank_cleanup.enabled) {
    return mask;
  }

  const cleanedMask = removeOuterBandComponents(
    removeGuideLineComponents(
      removeGuideLineRuns(mask, width, height, config),
      width,
      height,
      config
    ),
    width,
    height
  );

  return suppressGuideTemplateForBlankLikeCells(
    removeTemplateGuideComponents(cleanedMask, width, height, config, guideType),
    width,
    height,
    config,
    guideType
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

function standardDeviation(values) {
  if (!values.length) {
    return 0;
  }
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) * (value - mean)));
  return Math.sqrt(Math.max(variance, 0));
}

function countTransitionsInLine(mask, width, height, axis, index) {
  const length = axis === 'row' ? width : height;
  let transitions = 0;
  let prev = 0;
  for (let offset = 0; offset < length; offset++) {
    const x = axis === 'row' ? offset : index;
    const y = axis === 'row' ? index : offset;
    const value = mask[y * width + x];
    if (offset > 0 && value !== prev) {
      transitions++;
    }
    prev = value;
  }
  return transitions;
}

function buildProjectionFeatures(mask, width, height, primary) {
  if (!primary) {
    return {
      rowTransitionMean: 0,
      colTransitionMean: 0,
      rowWidthStdRatio: 0,
      colWidthStdRatio: 0,
      rowCenterJitter: 0,
      edgeTouchInkRatio: 0
    };
  }

  const rowWidths = [];
  const colWidths = [];
  const rowTransitions = [];
  const colTransitions = [];
  const rowCenters = [];
  let edgeTouchInk = 0;

  for (let y = primary.top; y <= primary.bottom; y++) {
    let rowInk = 0;
    let sumX = 0;
    for (let x = primary.left; x <= primary.right; x++) {
      const value = mask[y * width + x];
      if (!value) {
        continue;
      }
      rowInk++;
      sumX += x;
      if (
        y === primary.top ||
        y === primary.bottom ||
        x === primary.left ||
        x === primary.right
      ) {
        edgeTouchInk++;
      }
    }
    if (rowInk > 0) {
      rowWidths.push(rowInk);
      rowTransitions.push(countTransitionsInLine(mask, width, height, 'row', y));
      rowCenters.push(sumX / rowInk);
    }
  }

  for (let x = primary.left; x <= primary.right; x++) {
    let colInk = 0;
    for (let y = primary.top; y <= primary.bottom; y++) {
      if (mask[y * width + x]) {
        colInk++;
      }
    }
    if (colInk > 0) {
      colWidths.push(colInk);
      colTransitions.push(countTransitionsInLine(mask, width, height, 'col', x));
    }
  }

  const rowCenterDiffs = [];
  for (let i = 1; i < rowCenters.length; i++) {
    rowCenterDiffs.push(Math.abs(rowCenters[i] - rowCenters[i - 1]) / Math.max(primary.width, 1));
  }

  const rowWidthMean = average(rowWidths);
  const colWidthMean = average(colWidths);
  return {
    rowTransitionMean: average(rowTransitions),
    colTransitionMean: average(colTransitions),
    rowWidthStdRatio: rowWidthMean ? standardDeviation(rowWidths) / rowWidthMean : 0,
    colWidthStdRatio: colWidthMean ? standardDeviation(colWidths) / colWidthMean : 0,
    rowCenterJitter: average(rowCenterDiffs),
    edgeTouchInkRatio: primary.area ? edgeTouchInk / primary.area : 0
  };
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
  const significantComponentCount = mainComponents.length || components.length;
  const projection = buildProjectionFeatures(mask, width, height, primary);

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
    strokeDensity: primary.area / Math.max(bboxArea, 1),
    significantComponentCount,
    rowTransitionMean: projection.rowTransitionMean,
    colTransitionMean: projection.colTransitionMean,
    rowWidthStdRatio: projection.rowWidthStdRatio,
    colWidthStdRatio: projection.colWidthStdRatio,
    meanStrokeWidthStdRatio: average([projection.rowWidthStdRatio, projection.colWidthStdRatio]),
    rowCenterJitter: projection.rowCenterJitter,
    edgeTouchInkRatio: projection.edgeTouchInkRatio
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

async function extractFeatures(cellImage, options = {}) {
  const baseConfig = resolveConfig(options.config || {});
  const config = withGuideGridType(baseConfig, options);
  const threshold = options.threshold || config.image.threshold;
  const buffer = await decodeCellImage(cellImage);
  const image = sharp(buffer).ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });

  const mask = buildForegroundMask(data, info, threshold, config);
  const blankMask = buildBlankAnalysisMask(mask, info.width, info.height, config, config.image.grid_type);

  return {
    ...summarizeMaskFeatures(mask, info.width, info.height, config),
    guideGridType: normalizeGridType(config.image.grid_type || 'square'),
    blankDetection: summarizeMaskFeatures(blankMask, info.width, info.height, config)
  };
}

async function extractCellLayers(cellImage, options = {}) {
  const baseConfig = resolveConfig(options.config || {});
  const config = withGuideGridType(baseConfig, options);
  const threshold = options.threshold || config.image.threshold;
  const buffer = await decodeCellImage(cellImage);
  const image = sharp(buffer).ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  const mask = buildForegroundMask(data, info, threshold, config);
  const blankMask = buildBlankAnalysisMask(mask, info.width, info.height, config, config.image.grid_type);
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

module.exports = {
  buildForegroundMask,
  decodeCellImage,
  extractFeatures,
  extractCellLayers
};
