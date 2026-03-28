const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveSingleImageInput } = require('../utils/stage_image_contract');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

const execFileAsync = promisify(execFile);
const DEFAULT_NEUTRAL_PAPER_GRAY = 216;

function normalizePaperCorners(corners) {
  const points = Array.isArray(corners) ? corners : [];
  if (points.length !== 4) {
    return null;
  }
  const normalized = points
    .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : null)
    .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  return normalized.length === 4 ? normalized : null;
}

function percentile(values, q) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

function sampleBrightBandScore(gray, width, height, side, inset, thickness, marginX, marginY) {
  const values = [];
  if (side === 'top' || side === 'bottom') {
    const y0 = side === 'top' ? inset : Math.max(0, height - inset - thickness);
    const y1 = Math.min(height, y0 + thickness);
    for (let y = y0; y < y1; y += 1) {
      const rowOffset = y * width;
      for (let x = marginX; x < Math.max(marginX + 1, width - marginX); x += 1) {
        values.push(gray[rowOffset + x]);
      }
    }
  } else {
    const x0 = side === 'left' ? inset : Math.max(0, width - inset - thickness);
    const x1 = Math.min(width, x0 + thickness);
    for (let y = marginY; y < Math.max(marginY + 1, height - marginY); y += 1) {
      const rowOffset = y * width;
      for (let x = x0; x < x1; x += 1) {
        values.push(gray[rowOffset + x]);
      }
    }
  }
  if (!values.length) {
    return { brightMean: 0, darkRatio: 1 };
  }
  const brightThreshold = percentile(values, 0.68);
  const brightValues = values.filter((value) => value >= brightThreshold);
  const brightMean = brightValues.length
    ? brightValues.reduce((sum, value) => sum + value, 0) / brightValues.length
    : brightThreshold;
  const darkLimit = brightMean - 34;
  const darkRatio = values.filter((value) => value < darkLimit).length / values.length;
  return {
    brightMean,
    darkRatio
  };
}

function buildBandPenalty(score, targetBright) {
  const allowedFloor = Math.max(DEFAULT_NEUTRAL_PAPER_GRAY - 2, targetBright - 18);
  const brightnessPenalty = Math.max(0, allowedFloor - score.brightMean);
  return brightnessPenalty + score.darkRatio * 80;
}

async function refinePaperCropByInteriorConsistency(imagePath) {
  if (!imagePath) {
    return null;
  }

  const { data, info } = await sharp(imagePath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  if (width <= 32 || height <= 32) {
    return null;
  }

  const marginX = Math.max(12, Math.round(width * 0.12));
  const marginY = Math.max(12, Math.round(height * 0.12));
  const coreValues = [];
  for (let y = marginY; y < Math.max(marginY + 1, height - marginY); y += 2) {
    const rowOffset = y * width;
    for (let x = marginX; x < Math.max(marginX + 1, width - marginX); x += 2) {
      coreValues.push(data[rowOffset + x]);
    }
  }
  if (!coreValues.length) {
    return null;
  }
  const targetBright = percentile(coreValues, 0.78);
  const thickness = Math.max(4, Math.min(8, Math.round(Math.min(width, height) * 0.0035)));
  const maxTrimX = Math.max(0, Math.min(28, Math.round(width * 0.018)));
  const maxTrimY = Math.max(0, Math.min(32, Math.round(height * 0.018)));
  const limits = {
    left: maxTrimX,
    right: maxTrimX,
    top: maxTrimY,
    bottom: maxTrimY
  };
  const insets = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0
  };

  for (const side of ['left', 'right', 'top', 'bottom']) {
    const limit = limits[side];
    const baseScore = sampleBrightBandScore(data, width, height, side, 0, thickness, marginX, marginY);
    const basePenalty = buildBandPenalty(baseScore, targetBright);
    let bestInset = 0;
    let bestPenalty = basePenalty;

    for (let inset = 0; inset <= limit; inset += 1) {
      const score = sampleBrightBandScore(data, width, height, side, inset, thickness, marginX, marginY);
      const penalty = buildBandPenalty(score, targetBright);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestInset = inset;
      }
      const consistent = (
        score.brightMean >= Math.max(DEFAULT_NEUTRAL_PAPER_GRAY - 2, targetBright - 18) &&
        score.darkRatio <= 0.12
      );
      if (consistent) {
        insets[side] = inset;
        break;
      }
      insets[side] = 0;
    }

    if (insets[side] === 0 && bestInset > 0) {
      const improvement = basePenalty - bestPenalty;
      if (improvement >= 8) {
        insets[side] = bestInset;
      }
    }
  }

  const cropLeft = insets.left;
  const cropTop = insets.top;
  const cropRight = width - insets.right;
  const cropBottom = height - insets.bottom;
  if (cropRight - cropLeft < width * 0.85 || cropBottom - cropTop < height * 0.85) {
    return {
      applied: false,
      reason: 'consistency-crop-too-aggressive',
      insets,
      targetBright: Number(targetBright.toFixed(2))
    };
  }
  if (cropLeft + cropTop + insets.right + insets.bottom <= 0) {
    return {
      applied: false,
      reason: 'consistency-crop-not-needed',
      insets,
      targetBright: Number(targetBright.toFixed(2))
    };
  }

  const buffer = await sharp(imagePath)
    .extract({
      left: cropLeft,
      top: cropTop,
      width: cropRight - cropLeft,
      height: cropBottom - cropTop
    })
    .png()
    .toBuffer();
  await fs.promises.writeFile(imagePath, buffer);
  return {
    applied: true,
    insets,
    targetBright: Number(targetBright.toFixed(2)),
    outputSize: {
      width: cropRight - cropLeft,
      height: cropBottom - cropTop
    }
  };
}

async function applyNeutralPaperEdgeBorder(imagePath) {
  if (!imagePath) {
    return;
  }

  const metadata = await sharp(imagePath).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (width <= 0 || height <= 0) {
    return;
  }

  const borderX = Math.max(12, Math.min(18, Math.round(width * 0.01)));
  const borderY = Math.max(10, Math.min(20, Math.round(height * 0.01)));
  const color = `rgb(${DEFAULT_NEUTRAL_PAPER_GRAY},${DEFAULT_NEUTRAL_PAPER_GRAY},${DEFAULT_NEUTRAL_PAPER_GRAY})`;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${borderY}" fill="${color}"/>
      <rect x="0" y="${Math.max(0, height - borderY)}" width="${width}" height="${borderY}" fill="${color}"/>
      <rect x="0" y="0" width="${borderX}" height="${height}" fill="${color}"/>
      <rect x="${Math.max(0, width - borderX)}" y="0" width="${borderX}" height="${height}" fill="${color}"/>
    </svg>
  `;

  const buffer = await sharp(imagePath)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
  await fs.promises.writeFile(imagePath, buffer);
}

class PaperCropExportPlugin {
  constructor() {
    this.name = '01_2_纸张裁切导出';
    this.version = '1.0.0';
    this.processNo = '01_2';
  }

  async execute(params) {
    const {
      stageInputPath = null,
      imagePath,
      preprocessResult,
      paperBounds = null,
      paperCorners = null,
      paperCropOutputPath,
      outputMetaPath
    } = params || {};

    const resolvedImagePath = resolveSingleImageInput({
      stageName: '01_2_纸张裁切导出',
      primaryInputPath: stageInputPath,
      imagePath
    });

    let effectivePaperBounds = paperBounds || preprocessResult?.paperBounds || null;
    const effectivePaperCorners = paperCorners || preprocessResult?.paperCorners || null;
    if (!paperCropOutputPath) {
      throw new Error('paperCropOutputPath参数是必需的');
    }
    if (!effectivePaperBounds && !normalizePaperCorners(effectivePaperCorners)) {
      const inputMeta = await sharp(resolvedImagePath).metadata();
      effectivePaperBounds = {
        left: 0,
        top: 0,
        width: inputMeta.width || 0,
        height: inputMeta.height || 0,
        source: '01_2_full_frame_fallback'
      };
    }
    const normalizedPaperCorners = normalizePaperCorners(effectivePaperCorners);

    let rectifyMeta = null;
    if (normalizedPaperCorners) {
      await fs.promises.mkdir(path.dirname(paperCropOutputPath), { recursive: true });
      const rectifyMetaPath = outputMetaPath
        ? outputMetaPath.replace(/\.json$/i, '.rectify.json')
        : null;
      const scriptPath = path.join(__dirname, '../00_预处理插件/paper_quad_rectify.py');
      const args = [
        scriptPath,
        '--image', resolvedImagePath,
        '--corners-json', JSON.stringify(normalizedPaperCorners),
        '--output', paperCropOutputPath
      ];
      if (rectifyMetaPath) {
        args.push('--meta-output', rectifyMetaPath);
      }
      const { stdout } = await execFileAsync('python3', args, {
        cwd: path.join(__dirname, '../00_预处理插件'),
        maxBuffer: 10 * 1024 * 1024
      });
      try {
        rectifyMeta = JSON.parse((stdout || '').trim() || '{}');
      } catch (error) {
        rectifyMeta = null;
      }
    } else if (effectivePaperBounds) {
      await fs.promises.mkdir(path.dirname(paperCropOutputPath), { recursive: true });
      const cropBox = {
        left: Math.round(effectivePaperBounds.left || 0),
        top: Math.round(effectivePaperBounds.top || 0),
        width: Math.max(1, Math.round(effectivePaperBounds.width || 0)),
        height: Math.max(1, Math.round(effectivePaperBounds.height || 0))
      };
      await sharp(imagePath)
        .extract(cropBox)
        .png()
        .toFile(paperCropOutputPath);
    }
    const consistencyAdjustment = await refinePaperCropByInteriorConsistency(paperCropOutputPath);
    await applyNeutralPaperEdgeBorder(paperCropOutputPath);

    const payload = {
      processNo: this.processNo,
      processName: '01_2_纸张裁切导出',
      imagePath: resolvedImagePath,
      stageInputPath: resolvedImagePath,
      paperCropOutputPath,
      paperBounds: effectivePaperBounds,
      paperCorners: normalizedPaperCorners || effectivePaperCorners,
      rectifyMeta,
      consistencyAdjustment,
      sourceMethod: normalizedPaperCorners ? '01_1_纸张范围检测四点透视拉正' : '01_1_纸张范围检测边界矩形回退裁切',
      note: normalizedPaperCorners
        ? '01_2 使用 01_1 输出的稿纸四角点，将倾斜稿纸四边形直接拉正为矩形，不再通过包围框补白裁切。'
        : '01_2 在缺少四角点时，回退为边界矩形裁切。'
    };

    if (outputMetaPath) {
      await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
      await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    return payload;
  }
}

module.exports = new PaperCropExportPlugin();
