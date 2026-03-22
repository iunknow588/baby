let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function renderBoundsAnnotation(imagePath, outputPath, bounds, title, subtitle = '') {
  if (!outputPath) {
    return null;
  }
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${bounds.left}" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="#f97316" stroke-width="6"/>
      <rect x="18" y="18" width="${Math.min(460, Math.max(220, width - 36))}" height="86" rx="12" ry="12" fill="rgba(17,24,39,0.84)"/>
      <text x="34" y="50" font-size="24" fill="#ffffff">${title}</text>
      <text x="34" y="80" font-size="18" fill="#d1fae5">${subtitle}</text>
    </svg>
  `;
  await sharp(imagePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputPath);
  return outputPath;
}

function computeGuidePadding(peaks, fallbackSpan, ratio, minPadding) {
  const gaps = peaks.length > 1
    ? peaks.slice(1).map((value, index) => value - peaks[index]).filter((gap) => gap > 0)
    : [];
  const averageGap = gaps.length ? average(gaps) : fallbackSpan;
  return Math.max(minPadding, Math.round(averageGap * ratio));
}

function buildProtectedGuideBounds(guides, imageInfo) {
  const left = clamp(Math.floor(guides.left), 0, imageInfo.width - 1);
  const top = clamp(Math.floor(guides.top), 0, imageInfo.height - 1);
  const right = clamp(Math.ceil(guides.right), left + 1, imageInfo.width);
  const bottom = clamp(Math.ceil(guides.bottom), top + 1, imageInfo.height);
  const hasA4GuideRepair = [guides.xSource, guides.ySource]
    .some((value) => typeof value === 'string' && value.includes('A4约束修正'));

  if (!hasA4GuideRepair) {
    return {
      bounds: { left, top, width: right - left, height: bottom - top, source: '真实边界检测引导' },
      protectionPadding: null
    };
  }

  const xPeaks = Array.isArray(guides.xPeaks) ? guides.xPeaks : [];
  const yPeaks = Array.isArray(guides.yPeaks) ? guides.yPeaks : [];
  const baseWidth = Math.max(1, right - left);
  const baseHeight = Math.max(1, bottom - top);
  const paddingX = Math.min(
    Math.max(left, imageInfo.width - right),
    computeGuidePadding(xPeaks, baseWidth / 10, 0.04, 6)
  );
  const paddingY = Math.min(
    Math.max(top, imageInfo.height - bottom),
    computeGuidePadding(yPeaks, baseHeight / 7, 0.08, 16)
  );
  const protectedLeft = clamp(left - paddingX, 0, imageInfo.width - 1);
  const protectedTop = clamp(top - paddingY, 0, imageInfo.height - 1);
  const protectedRight = clamp(right + paddingX, protectedLeft + 1, imageInfo.width);
  const protectedBottom = clamp(bottom + paddingY, protectedTop + 1, imageInfo.height);

  return {
    bounds: {
      left: protectedLeft,
      top: protectedTop,
      width: protectedRight - protectedLeft,
      height: protectedBottom - protectedTop,
      source: '真实边界检测引导_外扩保护'
    },
    protectionPadding: {
      paddingX,
      paddingY,
      reason: 'A4约束修正边界需要保留额外安全留白'
    }
  };
}

async function detectLargestMaskBounds(maskPath, options = {}) {
  const { paddingRatio = 0.008 } = options;
  const { data, info } = await sharp(maskPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] < 128) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < 0 || maxY < 0) {
    return { left: 0, top: 0, width: info.width, height: info.height, source: 'full_image' };
  }

  const padX = Math.max(2, Math.round(info.width * paddingRatio));
  const padY = Math.max(2, Math.round(info.height * paddingRatio));
  const left = clamp(minX - padX, 0, info.width - 1);
  const top = clamp(minY - padY, 0, info.height - 1);
  const right = clamp(maxX + padX + 1, left + 1, info.width);
  const bottom = clamp(maxY + padY + 1, top + 1, info.height);
  return { left, top, width: right - left, height: bottom - top, source: 'mask_bounds' };
}

class GridRectCandidatePlugin {
  constructor() {
    this.name = '03_1_总方格候选矩形';
    this.version = '1.0.0';
    this.processNo = '03_1';
  }

  async execute(params) {
    const {
      preprocessImagePath,
      maskPath,
      gridBoundaryDetection,
      gridRectification,
      outputImagePath = null,
      explicitBounds = null,
      explicitSourceMethod = null,
      explicitSourceStep = null
    } = params || {};
    const imageInfo = await sharp(preprocessImagePath).metadata();
    const boundaryGuides = gridBoundaryDetection && gridBoundaryDetection.guides;
    const rectificationGuides = gridRectification && gridRectification.guides;

    if (explicitBounds) {
      const annotatedPath = await renderBoundsAnnotation(
        preprocessImagePath,
        outputImagePath,
        explicitBounds,
        '03_1 总方格候选矩形',
        explicitSourceMethod || '上一步直通'
      );
      return {
        processNo: this.processNo,
        processName: '03_1_总方格候选矩形',
        inputPath: preprocessImagePath,
        inputMaskPath: maskPath || null,
        sourceStep: explicitSourceStep || '03_0_方格背景与边界检测',
        sourceMethod: explicitSourceMethod || '上一步直通',
        bounds: explicitBounds,
        outputImagePath: annotatedPath,
        imageInfo
      };
    }

    if (boundaryGuides) {
      const protectedBoundary = buildProtectedGuideBounds(boundaryGuides, imageInfo);
      const annotatedPath = await renderBoundsAnnotation(
        preprocessImagePath,
        outputImagePath,
        protectedBoundary.bounds,
        '03_1 总方格候选矩形',
        protectedBoundary.protectionPadding ? '真实边界引导 + 外扩保护' : '真实边界引导'
      );
      return {
        processNo: this.processNo,
        processName: '03_1_总方格候选矩形',
        inputPath: preprocessImagePath,
        inputMaskPath: maskPath || null,
        sourceStep: '02_A4纸张矫正',
        sourceMethod: protectedBoundary.protectionPadding
          ? '真实边界检测引导 + 外扩保护'
          : '真实边界检测引导',
        bounds: protectedBoundary.bounds,
        outputImagePath: annotatedPath,
        protectionPadding: protectedBoundary.protectionPadding,
        imageInfo
      };
    }

    if (rectificationGuides) {
      const left = clamp(Math.floor(rectificationGuides.left), 0, imageInfo.width - 1);
      const top = clamp(Math.floor(rectificationGuides.top), 0, imageInfo.height - 1);
      const right = clamp(Math.ceil(rectificationGuides.right), left + 1, imageInfo.width);
      const bottom = clamp(Math.ceil(rectificationGuides.bottom), top + 1, imageInfo.height);
      const bounds = { left, top, width: right - left, height: bottom - top, source: '方格边界矫正引导' };
      const annotatedPath = await renderBoundsAnnotation(
        preprocessImagePath,
        outputImagePath,
        bounds,
        '03_1 总方格候选矩形',
        '方格边界矫正引导'
      );
      return {
        processNo: this.processNo,
        processName: '03_1_总方格候选矩形',
        inputPath: preprocessImagePath,
        inputMaskPath: maskPath || null,
        sourceStep: '02_A4纸张矫正',
        sourceMethod: '方格边界矫正引导',
        bounds,
        outputImagePath: annotatedPath,
        imageInfo
      };
    }

    const fallback = await detectLargestMaskBounds(maskPath);
    const annotatedPath = await renderBoundsAnnotation(
      preprocessImagePath,
      outputImagePath,
      fallback,
      '03_1 总方格候选矩形',
      'Mask范围检测'
    );
    return {
      processNo: this.processNo,
      processName: '03_1_总方格候选矩形',
      inputPath: preprocessImagePath,
      inputMaskPath: maskPath || null,
      sourceStep: '03_0_方格背景与边界检测',
      sourceMethod: 'Mask范围检测',
      bounds: fallback,
      outputImagePath: annotatedPath,
      imageInfo
    };
  }
}

module.exports = new GridRectCandidatePlugin();
