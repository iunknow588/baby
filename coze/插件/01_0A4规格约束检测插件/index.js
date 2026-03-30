const fs = require('fs');
const path = require('path');
const { clamp, buildPaperBorderOverlaySvg } = require('../utils/paper_edge_cleanup');
const { requireSharp } = require('../utils/require_sharp');
const sharp = requireSharp();

const DEFAULT_NEUTRAL_PAPER_COLOR = {
  r: 216,
  g: 216,
  b: 216,
  luma: 216
};

function buildEdgeCleanupHintFromImage(rawData, info, baseBounds) {
  if (!rawData || !info?.width || !info?.height || !baseBounds) {
    return null;
  }

  const imageWidth = Number(info.width || 0);
  const imageHeight = Number(info.height || 0);
  const channels = Number(info.channels || 0);
  if (imageWidth <= 0 || imageHeight <= 0 || channels < 3) {
    return null;
  }

  const left0 = clamp(Math.round(Number(baseBounds.left || 0)), 0, Math.max(0, imageWidth - 1));
  const top0 = clamp(Math.round(Number(baseBounds.top || 0)), 0, Math.max(0, imageHeight - 1));
  const width0 = clamp(Math.round(Number(baseBounds.width || 0)), 1, imageWidth - left0);
  const height0 = clamp(Math.round(Number(baseBounds.height || 0)), 1, imageHeight - top0);
  const right0 = left0 + width0;
  const bottom0 = top0 + height0;

  const coreLeft = clamp(left0 + Math.round(width0 * 0.22), left0, Math.max(left0, right0 - 1));
  const coreTop = clamp(top0 + Math.round(height0 * 0.22), top0, Math.max(top0, bottom0 - 1));
  const coreRight = clamp(right0 - Math.round(width0 * 0.22), coreLeft + 1, right0);
  const coreBottom = clamp(bottom0 - Math.round(height0 * 0.22), coreTop + 1, bottom0);
  const coreStepX = Math.max(1, Math.floor((coreRight - coreLeft) / 120));
  const coreStepY = Math.max(1, Math.floor((coreBottom - coreTop) / 120));
  const brightSamples = [];

  for (let y = coreTop; y < coreBottom; y += coreStepY) {
    for (let x = coreLeft; x < coreRight; x += coreStepX) {
      const offset = (y * imageWidth + x) * channels;
      const r = rawData[offset];
      const g = rawData[offset + 1];
      const b = rawData[offset + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      brightSamples.push({ r, g, b, luma });
    }
  }

  if (!brightSamples.length) {
    return null;
  }

  const sortedLumas = brightSamples.map((item) => item.luma).sort((a, b) => a - b);
  const lumaThreshold = sortedLumas[Math.max(0, Math.floor(sortedLumas.length * 0.7) - 1)] || sortedLumas[sortedLumas.length - 1];
  const paperLike = brightSamples.filter((item) => item.luma >= lumaThreshold);
  const paperSamples = paperLike.length ? paperLike : brightSamples;
  const paperColor = paperSamples.reduce((acc, item) => {
    acc.r += item.r;
    acc.g += item.g;
    acc.b += item.b;
    acc.luma += item.luma;
    return acc;
  }, { r: 0, g: 0, b: 0, luma: 0 });
  paperColor.r /= paperSamples.length;
  paperColor.g /= paperSamples.length;
  paperColor.b /= paperSamples.length;
  paperColor.luma /= paperSamples.length;

  const maxInsetX = Math.max(4, Math.min(120, Math.round(width0 * 0.08)));
  const maxInsetY = Math.max(4, Math.min(160, Math.round(height0 * 0.08)));
  const minSampleTop = clamp(top0 + Math.round(height0 * 0.1), top0, Math.max(top0, bottom0 - 1));
  const maxSampleBottom = clamp(bottom0 - Math.round(height0 * 0.1), minSampleTop + 1, bottom0);
  const minSampleLeft = clamp(left0 + Math.round(width0 * 0.1), left0, Math.max(left0, right0 - 1));
  const maxSampleRight = clamp(right0 - Math.round(width0 * 0.1), minSampleLeft + 1, right0);
  const bandDepth = 3;
  const nonPaperRatioLimit = 0.12;
  const paperLumaDropLimit = 18;
  const colorDistanceLimit = 26;
  const brightnessSampleStride = 2;

  const isPaperLikePixel = (x, y) => {
    const offset = (y * imageWidth + x) * channels;
    const r = rawData[offset];
    const g = rawData[offset + 1];
    const b = rawData[offset + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const colorDistance = Math.sqrt(
      ((r - paperColor.r) ** 2) +
      ((g - paperColor.g) ** 2) +
      ((b - paperColor.b) ** 2)
    );
    const lumaDiff = Math.abs(luma - paperColor.luma);
    return colorDistance <= colorDistanceLimit || (luma >= paperColor.luma - paperLumaDropLimit && lumaDiff <= 22);
  };

  const buildBrightnessProfile = (side, sampleCount) => {
    const profile = [];
    for (let inset = 0; inset <= sampleCount; inset += 1) {
      let lumaSum = 0;
      let count = 0;
      if (side === 'left' || side === 'right') {
        const x = side === 'left' ? clamp(left0 + inset, left0, right0 - 1) : clamp(right0 - 1 - inset, left0, right0 - 1);
        for (let y = minSampleTop; y < maxSampleBottom; y += brightnessSampleStride) {
          const offset = (y * imageWidth + x) * channels;
          lumaSum += 0.299 * rawData[offset] + 0.587 * rawData[offset + 1] + 0.114 * rawData[offset + 2];
          count += 1;
        }
      } else {
        const y = side === 'top' ? clamp(top0 + inset, top0, bottom0 - 1) : clamp(bottom0 - 1 - inset, top0, bottom0 - 1);
        for (let x = minSampleLeft; x < maxSampleRight; x += brightnessSampleStride) {
          const offset = (y * imageWidth + x) * channels;
          lumaSum += 0.299 * rawData[offset] + 0.587 * rawData[offset + 1] + 0.114 * rawData[offset + 2];
          count += 1;
        }
      }
      profile.push(count ? (lumaSum / count) : 0);
    }
    return profile;
  };

  const smoothProfile = (values, radius = 2) => values.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sample = values[index + offset];
      if (Number.isFinite(sample)) {
        sum += sample;
        count += 1;
      }
    }
    return count ? (sum / count) : values[index];
  });

  const scanSideByColor = (side) => {
    const maxInset = (side === 'left' || side === 'right') ? maxInsetX : maxInsetY;
    for (let inset = 0; inset <= maxInset; inset += 1) {
      let paperPixels = 0;
      let totalPixels = 0;
      for (let band = 0; band < bandDepth; band += 1) {
        if (side === 'left' || side === 'right') {
          const x = side === 'left' ? clamp(left0 + inset + band, left0, right0 - 1) : clamp(right0 - 1 - inset - band, left0, right0 - 1);
          for (let y = minSampleTop; y < maxSampleBottom; y += 2) {
            totalPixels += 1;
            if (isPaperLikePixel(x, y)) {
              paperPixels += 1;
            }
          }
        } else {
          const y = side === 'top' ? clamp(top0 + inset + band, top0, bottom0 - 1) : clamp(bottom0 - 1 - inset - band, top0, bottom0 - 1);
          for (let x = minSampleLeft; x < maxSampleRight; x += 2) {
            totalPixels += 1;
            if (isPaperLikePixel(x, y)) {
              paperPixels += 1;
            }
          }
        }
      }
      if (!totalPixels) {
        continue;
      }
      const nonPaperRatio = 1 - paperPixels / totalPixels;
      if (nonPaperRatio <= nonPaperRatioLimit) {
        return inset;
      }
    }
    return 0;
  };

  const scanSideByBrightness = (side) => {
    const maxInset = (side === 'left' || side === 'right') ? maxInsetX : maxInsetY;
    const profile = smoothProfile(buildBrightnessProfile(side, maxInset));
    if (!profile.length) {
      return 0;
    }
    const baselineStart = Math.max(4, Math.floor(profile.length * 0.35));
    const baselineValues = profile.slice(baselineStart).sort((a, b) => a - b);
    const baseline = baselineValues.length
      ? baselineValues[Math.floor(baselineValues.length / 2)]
      : profile[profile.length - 1];
    const edgeWindow = profile.slice(0, Math.min(16, profile.length));
    const edgeMinimum = edgeWindow.length ? Math.min(...edgeWindow) : profile[0];
    const edgeMaximum = edgeWindow.length ? Math.max(...edgeWindow) : profile[0];
    const edgeMinimumIndex = edgeWindow.findIndex((value) => value === edgeMinimum);
    const brightnessGap = baseline - edgeMinimum;
    if (brightnessGap < 10) {
      return 0;
    }
    const searchStart = edgeMaximum - edgeMinimum >= 18 && edgeMinimumIndex >= 0
      ? edgeMinimumIndex
      : 0;
    const stableThreshold = baseline - Math.max(6, brightnessGap * 0.22);
    for (let inset = searchStart; inset < profile.length; inset += 1) {
      const current = profile[inset];
      const next = profile[Math.min(profile.length - 1, inset + 1)];
      const next2 = profile[Math.min(profile.length - 1, inset + 2)];
      if (
        current >= stableThreshold &&
        next >= stableThreshold &&
        next2 >= stableThreshold
      ) {
        return inset;
      }
    }
    return 0;
  };

  const detectInsetHorizontalFrameLine = (side, maxInset) => {
    if (side !== 'top' && side !== 'bottom') {
      return null;
    }
    const sampleStrideX = 2;
    const sampleDepth = 3;
    const darkThreshold = paperColor.luma - Math.max(18, Math.min(42, paperLumaDropLimit + 8));
    const minRunCoverage = 0.62;
    const minInsetMargin = Math.max(12, Math.round(width0 * 0.018));
    const maxInsetToInspect = clamp(maxInset + Math.max(6, Math.round(height0 * 0.02)), 0, maxInsetY);

    for (let inset = 0; inset <= maxInsetToInspect; inset += 1) {
      let bestRunStart = null;
      let bestRunEnd = null;
      let currentRunStart = null;
      let strongRows = 0;

      for (let band = 0; band < sampleDepth; band += 1) {
        const y = side === 'top'
          ? clamp(top0 + inset + band, top0, bottom0 - 1)
          : clamp(bottom0 - 1 - inset - band, top0, bottom0 - 1);
        let rowBestStart = null;
        let rowBestEnd = null;
        let rowCurrentStart = null;
        for (let x = left0; x < right0; x += sampleStrideX) {
          const offset = (y * imageWidth + x) * channels;
          const luma = 0.299 * rawData[offset] + 0.587 * rawData[offset + 1] + 0.114 * rawData[offset + 2];
          const dark = luma <= darkThreshold;
          if (dark) {
            if (rowCurrentStart === null) {
              rowCurrentStart = x;
            }
          } else if (rowCurrentStart !== null) {
            const rowRunEnd = x - sampleStrideX;
            if (rowBestStart === null || (rowRunEnd - rowCurrentStart) > (rowBestEnd - rowBestStart)) {
              rowBestStart = rowCurrentStart;
              rowBestEnd = rowRunEnd;
            }
            rowCurrentStart = null;
          }
        }
        if (rowCurrentStart !== null) {
          const rowRunEnd = right0 - 1;
          if (rowBestStart === null || (rowRunEnd - rowCurrentStart) > (rowBestEnd - rowBestStart)) {
            rowBestStart = rowCurrentStart;
            rowBestEnd = rowRunEnd;
          }
        }
        if (Number.isFinite(rowBestStart) && Number.isFinite(rowBestEnd)) {
          const rowRunWidth = rowBestEnd - rowBestStart;
          if (rowRunWidth >= width0 * minRunCoverage) {
            strongRows += 1;
            if (bestRunStart === null || rowBestStart < bestRunStart) {
              bestRunStart = rowBestStart;
            }
            if (bestRunEnd === null || rowBestEnd > bestRunEnd) {
              bestRunEnd = rowBestEnd;
            }
          }
        }
      }

      if (strongRows >= 2 && Number.isFinite(bestRunStart) && Number.isFinite(bestRunEnd)) {
        const leftMargin = bestRunStart - left0;
        const rightMargin = right0 - 1 - bestRunEnd;
        const runWidth = bestRunEnd - bestRunStart;
        if (
          runWidth >= width0 * minRunCoverage
          && leftMargin >= minInsetMargin
          && rightMargin >= minInsetMargin
        ) {
          return {
            inset,
            runWidth,
            leftMargin,
            rightMargin,
            strongRows
          };
        }
      }
    }
    return null;
  };

  const detectInsetVerticalFrameLine = (side, maxInset) => {
    if (side !== 'left' && side !== 'right') {
      return null;
    }
    const sampleStrideY = 2;
    const sampleDepth = 3;
    const darkThreshold = paperColor.luma - Math.max(18, Math.min(42, paperLumaDropLimit + 8));
    const minRunCoverage = 0.62;
    const minInsetMargin = Math.max(12, Math.round(height0 * 0.018));
    const maxInsetToInspect = clamp(maxInset + Math.max(6, Math.round(width0 * 0.02)), 0, maxInsetX);

    for (let inset = 0; inset <= maxInsetToInspect; inset += 1) {
      let bestRunStart = null;
      let bestRunEnd = null;
      let strongCols = 0;
      for (let band = 0; band < sampleDepth; band += 1) {
        const x = side === 'left'
          ? clamp(left0 + inset + band, left0, right0 - 1)
          : clamp(right0 - 1 - inset - band, left0, right0 - 1);
        let colBestStart = null;
        let colBestEnd = null;
        let colCurrentStart = null;
        for (let y = top0; y < bottom0; y += sampleStrideY) {
          const offset = (y * imageWidth + x) * channels;
          const luma = 0.299 * rawData[offset] + 0.587 * rawData[offset + 1] + 0.114 * rawData[offset + 2];
          const dark = luma <= darkThreshold;
          if (dark) {
            if (colCurrentStart === null) {
              colCurrentStart = y;
            }
          } else if (colCurrentStart !== null) {
            const colRunEnd = y - sampleStrideY;
            if (colBestStart === null || (colRunEnd - colCurrentStart) > (colBestEnd - colBestStart)) {
              colBestStart = colCurrentStart;
              colBestEnd = colRunEnd;
            }
            colCurrentStart = null;
          }
        }
        if (colCurrentStart !== null) {
          const colRunEnd = bottom0 - 1;
          if (colBestStart === null || (colRunEnd - colCurrentStart) > (colBestEnd - colBestStart)) {
            colBestStart = colCurrentStart;
            colBestEnd = colRunEnd;
          }
        }
        if (Number.isFinite(colBestStart) && Number.isFinite(colBestEnd)) {
          const colRunHeight = colBestEnd - colBestStart;
          if (colRunHeight >= height0 * minRunCoverage) {
            strongCols += 1;
            if (bestRunStart === null || colBestStart < bestRunStart) {
              bestRunStart = colBestStart;
            }
            if (bestRunEnd === null || colBestEnd > bestRunEnd) {
              bestRunEnd = colBestEnd;
            }
          }
        }
      }

      if (strongCols >= 2 && Number.isFinite(bestRunStart) && Number.isFinite(bestRunEnd)) {
        const topMargin = bestRunStart - top0;
        const bottomMargin = bottom0 - 1 - bestRunEnd;
        const runHeight = bestRunEnd - bestRunStart;
        if (
          runHeight >= height0 * minRunCoverage
          && topMargin >= minInsetMargin
          && bottomMargin >= minInsetMargin
        ) {
          return {
            inset,
            runHeight,
            topMargin,
            bottomMargin,
            strongCols
          };
        }
      }
    }
    return null;
  };

  const baseInsetLeft = Math.max(scanSideByColor('left'), scanSideByBrightness('left'));
  const baseInsetRight = Math.max(scanSideByColor('right'), scanSideByBrightness('right'));
  const baseInsetTop = Math.max(scanSideByColor('top'), scanSideByBrightness('top'));
  const baseInsetBottom = Math.max(scanSideByColor('bottom'), scanSideByBrightness('bottom'));
  const protectedLeftFrameLine = baseInsetLeft > 0 ? detectInsetVerticalFrameLine('left', baseInsetLeft) : null;
  const protectedRightFrameLine = baseInsetRight > 0 ? detectInsetVerticalFrameLine('right', baseInsetRight) : null;
  const protectedTopFrameLine = baseInsetTop > 0 ? detectInsetHorizontalFrameLine('top', baseInsetTop) : null;
  const protectedBottomFrameLine = baseInsetBottom > 0 ? detectInsetHorizontalFrameLine('bottom', baseInsetBottom) : null;
  const safetyInsetX = Math.max(1, Math.min(6, Math.round(width0 * 0.0025)));
  const safetyInsetY = Math.max(1, Math.min(8, Math.round(height0 * 0.0025)));
  const insetLeft = protectedLeftFrameLine ? 0 : (baseInsetLeft > 0 ? baseInsetLeft + safetyInsetX : 0);
  const insetRight = protectedRightFrameLine ? 0 : (baseInsetRight > 0 ? baseInsetRight + safetyInsetX : 0);
  const insetTop = protectedTopFrameLine ? 0 : (baseInsetTop > 0 ? baseInsetTop + safetyInsetY : 0);
  const insetBottom = protectedBottomFrameLine ? 0 : (baseInsetBottom > 0 ? baseInsetBottom + safetyInsetY : 0);
  const cleanLeft = clamp(left0 + insetLeft, left0, right0 - 2);
  const cleanTop = clamp(top0 + insetTop, top0, bottom0 - 2);
  const cleanRight = clamp(right0 - insetRight, cleanLeft + 2, right0);
  const cleanBottom = clamp(bottom0 - insetBottom, cleanTop + 2, bottom0);
  const cleanWidth = cleanRight - cleanLeft;
  const cleanHeight = cleanBottom - cleanTop;
  const shrinkRatio = Math.min(cleanWidth / Math.max(width0, 1), cleanHeight / Math.max(height0, 1));

  return {
    paperColor: {
      ...DEFAULT_NEUTRAL_PAPER_COLOR
    },
    sampledPaperColor: {
      r: Number(paperColor.r.toFixed(1)),
      g: Number(paperColor.g.toFixed(1)),
      b: Number(paperColor.b.toFixed(1)),
      luma: Number(paperColor.luma.toFixed(1))
    },
    plannedInsets: {
      left: baseInsetLeft > 0 ? baseInsetLeft + safetyInsetX : 0,
      right: baseInsetRight > 0 ? baseInsetRight + safetyInsetX : 0,
      top: baseInsetTop > 0 ? baseInsetTop + safetyInsetY : 0,
      bottom: baseInsetBottom > 0 ? baseInsetBottom + safetyInsetY : 0
    },
    insets: {
      left: insetLeft,
      right: insetRight,
      top: insetTop,
      bottom: insetBottom
    },
    protectedFrameLines: {
      left: protectedLeftFrameLine,
      right: protectedRightFrameLine,
      top: protectedTopFrameLine,
      bottom: protectedBottomFrameLine
    },
    cleanBounds: {
      left: cleanLeft,
      top: cleanTop,
      width: cleanWidth,
      height: cleanHeight
    },
    shrinkRatio: Number(shrinkRatio.toFixed(4)),
    applied: (insetLeft + insetRight + insetTop + insetBottom) > 0
  };
}

async function normalizeCleanedPaperBackground(imagePath, edgeCleanup) {
  if (!imagePath || !edgeCleanup?.paperColor) {
    return;
  }

  const { data, info } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  const targetR = Number(edgeCleanup.paperColor.r || 0);
  const targetG = Number(edgeCleanup.paperColor.g || 0);
  const targetB = Number(edgeCleanup.paperColor.b || 0);

  for (let i = 0; i < info.width * info.height; i += 1) {
    const offset = i * info.channels;
    const r = output[offset];
    const g = output[offset + 1];
    const b = output[offset + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const colorSpan = Math.max(r, g, b) - Math.min(r, g, b);
    if (luma < 168 || colorSpan > 36) {
      continue;
    }
    output[offset] = clamp(Math.round(r * 0.2 + targetR * 0.8), 0, 255);
    output[offset + 1] = clamp(Math.round(g * 0.2 + targetG * 0.8), 0, 255);
    output[offset + 2] = clamp(Math.round(b * 0.2 + targetB * 0.8), 0, 255);
  }

  await sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels
    }
  }).png().toFile(imagePath);
}

class A4ConstraintDetectPlugin {
  constructor() {
    this.name = '01_0_A4规格约束检测';
    this.version = '1.0.0';
    this.processNo = '01_0';
  }

  async execute(params) {
    const { imagePath, preprocessResult, outputMetaPath, outputImagePath = null, cleanedImagePath = null } = params || {};
    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }
    if (!preprocessResult) {
      throw new Error('preprocessResult参数是必需的');
    }

    const metadata = await sharp(imagePath).metadata();
    const rawPaperBounds = preprocessResult.paperBounds || {
      left: 0,
      top: 0,
      width: metadata.width || 0,
      height: metadata.height || 0
    };
    const { data: rawData, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const edgeCleanup = buildEdgeCleanupHintFromImage(rawData, info, rawPaperBounds);
    const paperBounds = edgeCleanup?.applied ? edgeCleanup.cleanBounds : rawPaperBounds;
    const width = paperBounds ? Number(paperBounds.width || 0) : 0;
    const height = paperBounds ? Number(paperBounds.height || 0) : 0;
    const longEdge = Math.max(width, height);
    const shortEdge = Math.max(1, Math.min(width, height));
    const detectedRatio = Number((longEdge / shortEdge).toFixed(4));
    const a4Ratio = Number(Math.sqrt(2).toFixed(4));
    const ratioError = Number(Math.abs(detectedRatio - a4Ratio).toFixed(4));
    const ratioErrorPercent = Number(((ratioError / a4Ratio) * 100).toFixed(2));
    const isLikelyA4 = width > 0 && height > 0 && ratioErrorPercent <= 12;
    const confidence = width > 0 && height > 0
      ? Number(Math.max(0, Math.min(1, 1 - ratioErrorPercent / 12)).toFixed(4))
      : 0;

    const payload = {
      processNo: this.processNo,
      processName: '01_0_A4规格约束检测',
      imagePath,
      outputImagePath,
      cleanedImagePath,
      rawPaperBounds,
      paperBounds,
      edgeCleanup,
      a4Constraint: {
        enabled: true,
        standardRatio: a4Ratio,
        detectedRatio,
        ratioError,
        ratioErrorPercent,
        isLikelyA4,
        confidence,
        recommendedPerspectiveTarget: width > 0 && height > 0
          ? {
              longEdge,
              shortEdge,
              standardRatio: a4Ratio
            }
          : null
      }
    };

    if (cleanedImagePath && edgeCleanup?.applied) {
      await fs.promises.mkdir(path.dirname(cleanedImagePath), { recursive: true });
      const cleanedWidth = metadata.width || Math.max(1, Math.round(paperBounds.width || 0));
      const cleanedHeight = metadata.height || Math.max(1, Math.round(paperBounds.height || 0));
      let cleanedImage = sharp(imagePath)
        .extract({
          left: Math.round(paperBounds.left || 0),
          top: Math.round(paperBounds.top || 0),
          width: Math.max(1, Math.round(paperBounds.width || 0)),
          height: Math.max(1, Math.round(paperBounds.height || 0))
        })
        .resize({
          width: cleanedWidth || undefined,
          height: cleanedHeight || undefined,
          fit: 'fill'
        });
      const svg = buildPaperBorderOverlaySvg(cleanedWidth, cleanedHeight, edgeCleanup);
      if (svg) {
        cleanedImage = cleanedImage.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
      }
      await cleanedImage.png().toFile(cleanedImagePath);
      await normalizeCleanedPaperBackground(cleanedImagePath, edgeCleanup);
    }

    if (outputImagePath) {
      const useCleanedBase = Boolean(cleanedImagePath && edgeCleanup?.applied && fs.existsSync(cleanedImagePath));
      const renderBasePath = useCleanedBase ? cleanedImagePath : imagePath;
      const renderMeta = await sharp(renderBasePath).metadata();
      const width = renderMeta.width || metadata.width || 0;
      const height = renderMeta.height || metadata.height || 0;
      const rawBoundsRect = useCleanedBase
        ? ''
        : rawPaperBounds
          ? `<rect x="${Math.round(rawPaperBounds.left || 0)}" y="${Math.round(rawPaperBounds.top || 0)}" width="${Math.max(1, Math.round(rawPaperBounds.width || 0))}" height="${Math.max(1, Math.round(rawPaperBounds.height || 0))}" fill="none" stroke="#16a34a" stroke-width="4" stroke-dasharray="14 10"/>`
          : '';
      const cleanBoundsRect = useCleanedBase
        ? `<rect x="2" y="2" width="${Math.max(1, width - 4)}" height="${Math.max(1, height - 4)}" fill="none" stroke="#f59e0b" stroke-width="6"/>`
        : paperBounds
          ? `<rect x="${Math.round(paperBounds.left || 0)}" y="${Math.round(paperBounds.top || 0)}" width="${Math.max(1, Math.round(paperBounds.width || 0))}" height="${Math.max(1, Math.round(paperBounds.height || 0))}" fill="none" stroke="#f59e0b" stroke-width="6"/>`
          : '';
      const protectedSides = ['left', 'right', 'top', 'bottom']
        .filter((side) => edgeCleanup?.protectedFrameLines?.[side]);
      const protectText = protectedSides.length ? protectedSides.join(',') : 'none';
      const protectMarks = [];
      const protectedLineOverlays = [];
      if (edgeCleanup?.protectedFrameLines?.top) {
        const detail = edgeCleanup.protectedFrameLines.top;
        const x1 = clamp(Math.round(detail.leftMargin || 0), 0, Math.max(0, width - 1));
        const x2 = clamp(Math.round(width - (detail.rightMargin || 0)), x1 + 1, Math.max(x1 + 1, width));
        const y = clamp(Math.round(detail.inset || 0), 0, Math.max(0, height - 1));
        protectedLineOverlays.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#f97316" stroke-width="4" stroke-opacity="0.95"/>`);
        protectMarks.push(`<text x="${Math.max(26, Math.round(width * 0.3))}" y="34" font-size="18" fill="#f97316">protect-top i=${detail.inset} run=${Math.round(detail.runWidth || 0)} rows=${detail.strongRows || 0} plan=${edgeCleanup?.plannedInsets?.top || 0} keep=${edgeCleanup?.insets?.top || 0}</text>`);
      }
      if (edgeCleanup?.protectedFrameLines?.bottom) {
        const detail = edgeCleanup.protectedFrameLines.bottom;
        const x1 = clamp(Math.round(detail.leftMargin || 0), 0, Math.max(0, width - 1));
        const x2 = clamp(Math.round(width - (detail.rightMargin || 0)), x1 + 1, Math.max(x1 + 1, width));
        const y = clamp(Math.round(height - 1 - (detail.inset || 0)), 0, Math.max(0, height - 1));
        protectedLineOverlays.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#f97316" stroke-width="4" stroke-opacity="0.95"/>`);
        protectMarks.push(`<text x="${Math.max(26, Math.round(width * 0.12))}" y="${Math.max(24, height - 18)}" font-size="18" fill="#f97316">protect-bottom i=${detail.inset} run=${Math.round(detail.runWidth || 0)} rows=${detail.strongRows || 0} plan=${edgeCleanup?.plannedInsets?.bottom || 0} keep=${edgeCleanup?.insets?.bottom || 0}</text>`);
      }
      if (edgeCleanup?.protectedFrameLines?.left) {
        const detail = edgeCleanup.protectedFrameLines.left;
        const x = clamp(Math.round(detail.inset || 0), 0, Math.max(0, width - 1));
        const y1 = clamp(Math.round(detail.topMargin || 0), 0, Math.max(0, height - 1));
        const y2 = clamp(Math.round(height - (detail.bottomMargin || 0)), y1 + 1, Math.max(y1 + 1, height));
        protectedLineOverlays.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#f97316" stroke-width="4" stroke-opacity="0.95"/>`);
        protectMarks.push(`<text x="18" y="${Math.max(64, Math.round(height * 0.5))}" font-size="18" fill="#f97316">protect-left i=${detail.inset} run=${Math.round(detail.runHeight || 0)} cols=${detail.strongCols || 0} plan=${edgeCleanup?.plannedInsets?.left || 0} keep=${edgeCleanup?.insets?.left || 0}</text>`);
      }
      if (edgeCleanup?.protectedFrameLines?.right) {
        const detail = edgeCleanup.protectedFrameLines.right;
        const x = clamp(Math.round(width - 1 - (detail.inset || 0)), 0, Math.max(0, width - 1));
        const y1 = clamp(Math.round(detail.topMargin || 0), 0, Math.max(0, height - 1));
        const y2 = clamp(Math.round(height - (detail.bottomMargin || 0)), y1 + 1, Math.max(y1 + 1, height));
        protectedLineOverlays.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#f97316" stroke-width="4" stroke-opacity="0.95"/>`);
        protectMarks.push(`<text x="${Math.max(24, width - 520)}" y="${Math.max(64, Math.round(height * 0.5))}" font-size="18" fill="#f97316">protect-right i=${detail.inset} run=${Math.round(detail.runHeight || 0)} cols=${detail.strongCols || 0} plan=${edgeCleanup?.plannedInsets?.right || 0} keep=${edgeCleanup?.insets?.right || 0}</text>`);
      }
      const statusColor = isLikelyA4 ? '#22c55e' : '#ef4444';
      const svg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          ${rawBoundsRect}
          ${cleanBoundsRect}
          ${protectedLineOverlays.join('\n')}
          ${protectMarks.join('\n')}
          <rect x="18" y="18" width="${Math.min(680, Math.max(320, width - 36))}" height="170" rx="12" ry="12" fill="rgba(17,24,39,0.84)"/>
          <text x="34" y="50" font-size="24" fill="#ffffff">01_0 A4规格约束检测</text>
          <text x="34" y="82" font-size="18" fill="${statusColor}">A4匹配=${isLikelyA4 ? '是' : '否'}  置信度=${confidence}</text>
          <text x="34" y="110" font-size="18" fill="#d1fae5">检测比例=${detectedRatio}  标准比例=${a4Ratio}</text>
          <text x="34" y="138" font-size="18" fill="#fde68a">清边内切=${edgeCleanup?.applied ? `L${edgeCleanup.insets.left}/R${edgeCleanup.insets.right}/T${edgeCleanup.insets.top}/B${edgeCleanup.insets.bottom}` : '未触发'}</text>
          <text x="34" y="166" font-size="18" fill="#93c5fd">当前输入=${useCleanedBase ? '02_0_1_A4内切清边图' : '01_2_稿纸裁切图'}  protect=${protectText}</text>
        </svg>
      `;
      await fs.promises.mkdir(path.dirname(outputImagePath), { recursive: true });
      await sharp(renderBasePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputImagePath);
    }

    if (outputMetaPath) {
      await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
      await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    return payload;
  }
}

module.exports = new A4ConstraintDetectPlugin();
