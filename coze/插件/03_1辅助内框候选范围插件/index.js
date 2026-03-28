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

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function smoothProfile(values, windowSize) {
  if (!Array.isArray(values) || !values.length) {
    return [];
  }
  const size = Math.max(3, windowSize | 1);
  const radius = Math.floor(size / 2);
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const clampedIndex = clamp(index + offset, 0, values.length - 1);
      const value = values[clampedIndex];
      if (Number.isFinite(value)) {
        sum += value;
        count += 1;
      }
    }
    return count ? (sum / count) : 0;
  });
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

function analyzeEdgeResidualBounds(grayData, imageInfo) {
  const width = imageInfo.width || 0;
  const height = imageInfo.height || 0;
  if (!width || !height) {
    return null;
  }
  const rowDarkness = new Array(height).fill(0);
  const colDarkness = new Array(width).fill(0);

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      const darkness = 255 - grayData[offset + x];
      rowSum += darkness;
      colDarkness[x] += darkness;
    }
    rowDarkness[y] = rowSum / Math.max(1, width);
  }
  for (let x = 0; x < width; x += 1) {
    colDarkness[x] /= Math.max(1, height);
  }

  const detectInteriorEnvelopeBounds = () => {
    const detectAxisBounds = (profile, size) => {
      const smoothed = smoothProfile(profile, Math.max(9, Math.round(size * 0.025)));
      const low = percentile(smoothed, 0.15);
      const high = percentile(smoothed, 0.85);
      const threshold = low + ((high - low) * 0.35);
      const indices = [];
      for (let index = 0; index < smoothed.length; index += 1) {
        if (smoothed[index] > threshold) {
          indices.push(index);
        }
      }
      if (!indices.length) {
        return null;
      }
      return {
        start: indices[0],
        end: indices[indices.length - 1],
        marginStart: indices[0],
        marginEnd: Math.max(0, size - 1 - indices[indices.length - 1]),
        low: Number(low.toFixed(3)),
        high: Number(high.toFixed(3)),
        threshold: Number(threshold.toFixed(3))
      };
    };

    const xBounds = detectAxisBounds(colDarkness, width);
    const yBounds = detectAxisBounds(rowDarkness, height);
    if (!xBounds || !yBounds) {
      return null;
    }
    const minMarginX = Math.max(12, Math.round(width * 0.05));
    const minMarginY = Math.max(12, Math.round(height * 0.05));
    const xValid = xBounds.marginStart >= minMarginX && xBounds.marginEnd >= minMarginX;
    const yValid = yBounds.marginStart >= minMarginY && yBounds.marginEnd >= minMarginY;
    if (!xValid || !yValid) {
      return {
        bounds: null,
        diagnostics: {
          applied: false,
          reason: 'interior-envelope-not-symmetric-enough',
          xBounds,
          yBounds,
          minMarginX,
          minMarginY
        }
      };
    }

    const left = clamp(Math.max(0, xBounds.start - 2), 0, width - 2);
    const top = clamp(Math.max(0, yBounds.start - 2), 0, height - 2);
    const right = clamp(Math.min(width, xBounds.end + 3), left + 1, width);
    const bottom = clamp(Math.min(height, yBounds.end + 3), top + 1, height);
    const croppedWidth = right - left;
    const croppedHeight = bottom - top;
    const minWidth = Math.max(200, Math.round(width * 0.7));
    const minHeight = Math.max(200, Math.round(height * 0.7));
    if (croppedWidth < minWidth || croppedHeight < minHeight) {
      return {
        bounds: null,
        diagnostics: {
          applied: false,
          reason: 'interior-envelope-too-small',
          xBounds,
          yBounds,
          minWidth,
          minHeight
        }
      };
    }
    return {
      bounds: {
        left,
        top,
        width: croppedWidth,
        height: croppedHeight,
        source: '03_4_字帖内框裁剪与矫正直通_图内包络裁剪'
      },
      diagnostics: {
        applied: true,
        reason: 'interior-frame-envelope-detected',
        xBounds,
        yBounds
      }
    };
  };

  const envelopeResult = detectInteriorEnvelopeBounds();

  const buildTrim = (profile, side, size) => {
    const maxTrim = Math.min(24, Math.max(6, Math.round(size * 0.022)));
    const interiorFrom = Math.min(size - 1, Math.max(maxTrim + 2, Math.round(size * 0.02)));
    const interiorTo = Math.min(size, Math.max(interiorFrom + 4, Math.round(size * 0.08)));
    const interior = profile.slice(interiorFrom, interiorTo).filter(Number.isFinite);
    const baseline = median(interior);
    const threshold = Math.max(8, baseline * 0.18);
    const edgeValue = side === 'start' ? profile[0] : profile[size - 1];
    if (!Number.isFinite(edgeValue) || edgeValue <= baseline + threshold) {
      return {
        trim: 0,
        baseline: Number(baseline.toFixed(3)),
        threshold: Number(threshold.toFixed(3)),
        edgeValue: Number((edgeValue || 0).toFixed(3))
      };
    }
    let trim = 0;
    for (let index = 0; index < maxTrim; index += 1) {
      const profileIndex = side === 'start' ? index : size - 1 - index;
      const value = profile[profileIndex];
      if (!Number.isFinite(value) || value <= baseline + threshold) {
        break;
      }
      trim = index + 1;
    }
    return {
      trim,
      baseline: Number(baseline.toFixed(3)),
      threshold: Number(threshold.toFixed(3)),
      edgeValue: Number((edgeValue || 0).toFixed(3))
    };
  };

  const top = buildTrim(rowDarkness, 'start', height);
  const bottom = buildTrim(rowDarkness, 'end', height);
  const left = buildTrim(colDarkness, 'start', width);
  const right = buildTrim(colDarkness, 'end', width);
  const totalTrim = top.trim + bottom.trim + left.trim + right.trim;
  if (!totalTrim) {
    if (envelopeResult?.bounds) {
      return {
        bounds: envelopeResult.bounds,
        cleanupDiagnostics: {
          applied: true,
          reason: envelopeResult.diagnostics.reason,
          trims: {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0
          },
          profiles: { top, bottom, left, right },
          envelopeDiagnostics: envelopeResult.diagnostics
        }
      };
    }
    return {
      bounds: {
        left: 0,
        top: 0,
        width,
        height,
        source: '03_4_字帖内框裁剪与矫正直通'
      },
      cleanupDiagnostics: {
        applied: false,
        reason: envelopeResult?.diagnostics?.reason || 'no-strong-edge-residue',
        trims: {
          top: top.trim,
          bottom: bottom.trim,
          left: left.trim,
          right: right.trim
        },
        profiles: { top, bottom, left, right },
        envelopeDiagnostics: envelopeResult?.diagnostics || null
      }
    };
  }

  const cropLeft = clamp(left.trim, 0, Math.max(0, width - 2));
  const cropTop = clamp(top.trim, 0, Math.max(0, height - 2));
  const cropRight = clamp(width - right.trim, cropLeft + 1, width);
  const cropBottom = clamp(height - bottom.trim, cropTop + 1, height);
  const croppedWidth = cropRight - cropLeft;
  const croppedHeight = cropBottom - cropTop;
  const minWidth = Math.max(200, Math.round(width * 0.9));
  const minHeight = Math.max(200, Math.round(height * 0.9));
  if (croppedWidth < minWidth || croppedHeight < minHeight) {
    if (envelopeResult?.bounds) {
      return {
        bounds: envelopeResult.bounds,
        cleanupDiagnostics: {
          applied: true,
          reason: envelopeResult.diagnostics.reason,
          trims: {
            top: top.trim,
            bottom: bottom.trim,
            left: left.trim,
            right: right.trim
          },
          profiles: { top, bottom, left, right },
          envelopeDiagnostics: envelopeResult.diagnostics
        }
      };
    }
    return {
      bounds: {
        left: 0,
        top: 0,
        width,
        height,
        source: '03_4_字帖内框裁剪与矫正直通'
      },
      cleanupDiagnostics: {
        applied: false,
        reason: envelopeResult?.diagnostics?.reason || 'edge-residue-trim-too-large',
        trims: {
          top: top.trim,
          bottom: bottom.trim,
          left: left.trim,
          right: right.trim
        },
        profiles: { top, bottom, left, right },
        envelopeDiagnostics: envelopeResult?.diagnostics || null
      }
    };
  }

  if (envelopeResult?.bounds) {
    const edgeArea = croppedWidth * croppedHeight;
    const envelopeArea = envelopeResult.bounds.width * envelopeResult.bounds.height;
    const edgeMargin = (cropLeft + cropTop) + (width - cropRight) + (height - cropBottom);
    const envelopeMargin = (envelopeResult.bounds.left + envelopeResult.bounds.top)
      + (width - (envelopeResult.bounds.left + envelopeResult.bounds.width))
      + (height - (envelopeResult.bounds.top + envelopeResult.bounds.height));
    if (envelopeArea < edgeArea * 0.92 && envelopeMargin > edgeMargin + Math.round((width + height) * 0.04)) {
      return {
        bounds: envelopeResult.bounds,
        cleanupDiagnostics: {
          applied: true,
          reason: envelopeResult.diagnostics.reason,
          trims: {
            top: top.trim,
            bottom: bottom.trim,
            left: left.trim,
            right: right.trim
          },
          profiles: { top, bottom, left, right },
          envelopeDiagnostics: envelopeResult.diagnostics
        }
      };
    }
  }

  return {
    bounds: {
      left: cropLeft,
      top: cropTop,
      width: croppedWidth,
      height: croppedHeight,
      source: '03_4_字帖内框裁剪与矫正直通_残留边线清理'
    },
    cleanupDiagnostics: {
      applied: true,
      reason: 'strong-edge-residue-trimmed',
      trims: {
        top: top.trim,
        bottom: bottom.trim,
        left: left.trim,
        right: right.trim
      },
      profiles: { top, bottom, left, right },
      envelopeDiagnostics: envelopeResult?.diagnostics || null
    }
  };
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || !values.length) {
    return 0;
  }
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return 0;
  }
  const index = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1);
  return sorted[index];
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
    this.name = '03_1辅助_内框候选范围';
    this.version = '1.0.0';
    this.processNo = '03_i1';
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
      let resolvedBounds = explicitBounds;
      let cleanupDiagnostics = null;
      if (
        explicitSourceStep === '03_4_字帖内框裁剪与矫正'
        || explicitSourceStep === '03_0_6_总方格大矩形提取'
      ) {
        const { data, info } = await sharp(preprocessImagePath).greyscale().raw().toBuffer({ resolveWithObject: true });
        const cleanupResult = analyzeEdgeResidualBounds(data, info) || null;
        if (cleanupResult?.bounds) {
          resolvedBounds = cleanupResult.bounds;
          cleanupDiagnostics = cleanupResult.cleanupDiagnostics || null;
        }
      }
      const annotatedPath = await renderBoundsAnnotation(
        preprocessImagePath,
        outputImagePath,
        resolvedBounds,
        '03_1辅助 内框候选范围',
        cleanupDiagnostics?.applied
          ? '03_4直通 + 残留边线清理'
          : (explicitSourceMethod || '上一步直通')
      );
      return {
        processNo: this.processNo,
        processName: '03_1辅助_内框候选范围',
        inputPath: preprocessImagePath,
        inputMaskPath: maskPath || null,
        sourceStep: explicitSourceStep || '03_3_内框四角定位',
        sourceMethod: cleanupDiagnostics?.applied
          ? '03_4直通 + 残留边线清理'
          : (explicitSourceMethod || '上一步直通'),
        bounds: resolvedBounds,
        outputImagePath: annotatedPath,
        cleanupDiagnostics,
        imageInfo
      };
    }

    if (boundaryGuides) {
      const protectedBoundary = buildProtectedGuideBounds(boundaryGuides, imageInfo);
      const annotatedPath = await renderBoundsAnnotation(
        preprocessImagePath,
        outputImagePath,
        protectedBoundary.bounds,
        '03_1辅助 内框候选范围',
        protectedBoundary.protectionPadding ? '真实边界引导 + 外扩保护' : '真实边界引导'
      );
      return {
        processNo: this.processNo,
        processName: '03_1辅助_内框候选范围',
        inputPath: preprocessImagePath,
        inputMaskPath: maskPath || null,
        sourceStep: '03_3_内框四角定位',
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
        '03_1辅助 内框候选范围',
        '方格边界矫正引导'
      );
      return {
        processNo: this.processNo,
        processName: '03_1辅助_内框候选范围',
        inputPath: preprocessImagePath,
        inputMaskPath: maskPath || null,
        sourceStep: '03_3_内框四角定位',
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
      '03_1辅助 内框候选范围',
      'Mask范围检测'
    );
    return {
      processNo: this.processNo,
      processName: '03_1辅助_内框候选范围',
      inputPath: preprocessImagePath,
      inputMaskPath: maskPath || null,
      sourceStep: '03_3_内框四角定位',
      sourceMethod: 'Mask范围检测',
      bounds: fallback,
      outputImagePath: annotatedPath,
      imageInfo
    };
  }
}

module.exports = new GridRectCandidatePlugin();
