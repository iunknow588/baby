const fs = require('fs');
const path = require('path');
const { detectPaperRegion } = require('../00_预处理插件/paper_preprocess');
const { resolveSingleImageInput } = require('../utils/stage_image_contract');
const { requireSharp } = require('../utils/require_sharp');
const sharp = requireSharp();

class PaperBoundsDetectPlugin {
  constructor() {
    this.name = '01_1_纸张范围检测';
    this.version = '1.0.0';
    this.processNo = '01_1';
  }

  async execute(params) {
    const {
      stageInputPath = null,
      imagePath,
      outputMetaPath,
      outputImagePath = null
    } = params || {};
    const resolvedImagePath = resolveSingleImageInput({
      stageName: '01_1_纸张范围检测',
      primaryInputPath: stageInputPath,
      imagePath
    });

    const payload = {
      processNo: this.processNo,
      processName: '01_1_纸张范围检测',
      imagePath: resolvedImagePath,
      stageInputPath: resolvedImagePath,
      outputImagePath,
      method: 'white-paper connected-region',
      paperBounds: null,
      paperCorners: null,
      note: '01_1 仅基于白纸区域连通性检测纸张范围，不使用任何内部方格角点或内容框角点。'
    };

    const { data: colorData, info } = await sharp(resolvedImagePath)
      .ensureAlpha()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const detectedPaperRegion = detectPaperRegion(colorData, info, {
      paddingTop: 8,
      paddingRight: 18,
      paddingBottom: 18,
      paddingLeft: 18,
      inwardCropRatio: 0,
      maskDilateRadius: 1,
      scale: 640,
      blockSize: 6,
      brightnessThreshold: 108,
      saturationThreshold: 102,
      minAreaRatio: 0.34,
      strongWhiteRatioThreshold: 0.6,
      softWhiteRatioThreshold: 0.38,
      maybeWhiteRatioThreshold: 0.14,
      minRefineRectSize: 1,
      leafWhiteRatioThreshold: 0.16,
      paperCornerImageRefineBlend: 0,
      paperCornerStabilizeBlend: 0,
      paperCornerRadialRefineBlend: 0.3,
      paperCornerRadialRefineMaxShift: 16,
      cornerExpandScale: 1.01,
      cornerExpandPadX: 4,
      cornerExpandPadY: 4
    });
    const detectedPaperBounds = detectedPaperRegion.bounds;
    const detectedPaperCorners = detectedPaperRegion.paperCorners || null;
    payload.paperBounds = detectedPaperBounds;
    payload.paperCorners = detectedPaperCorners;

    if (outputImagePath) {
      const width = info.width || 0;
      const height = info.height || 0;
      const paperBounds = detectedPaperBounds || null;
      const paperCorners = Array.isArray(detectedPaperCorners) ? detectedPaperCorners : [];
      const previewMask = Buffer.alloc(width * height * 4, 0);
      const componentMask = detectedPaperRegion.componentMask || null;
      const scaledWidth = detectedPaperRegion.scaledWidth || 0;
      const scaledHeight = detectedPaperRegion.scaledHeight || 0;
      if (componentMask && scaledWidth > 0 && scaledHeight > 0) {
        for (let y = 0; y < height; y++) {
          const sy = Math.min(scaledHeight - 1, Math.max(0, Math.round((y / Math.max(1, height - 1)) * Math.max(0, scaledHeight - 1))));
          for (let x = 0; x < width; x++) {
            const sx = Math.min(scaledWidth - 1, Math.max(0, Math.round((x / Math.max(1, width - 1)) * Math.max(0, scaledWidth - 1))));
            if (!componentMask[sy * scaledWidth + sx]) {
              continue;
            }
            const offset = (y * width + x) * 4;
            previewMask[offset] = 34;
            previewMask[offset + 1] = 197;
            previewMask[offset + 2] = 94;
            previewMask[offset + 3] = 62;
          }
        }
      }
      const boundsRect = paperBounds
        ? `<rect x="${Math.round(paperBounds.left || 0)}" y="${Math.round(paperBounds.top || 0)}" width="${Math.max(1, Math.round(paperBounds.width || 0))}" height="${Math.max(1, Math.round(paperBounds.height || 0))}" fill="none" stroke="#22c55e" stroke-width="3" stroke-dasharray="12 10"/>`
        : '';
      const paperPolygon = paperCorners.length === 4
        ? `<polygon points="${paperCorners.map((point) => `${Math.round(point[0])},${Math.round(point[1])}`).join(' ')}" fill="none" stroke="#16a34a" stroke-width="6"/>`
        : '';
      const paperCornerMarks = paperCorners.map((point, index) => `
        <circle cx="${Math.round(point[0])}" cy="${Math.round(point[1])}" r="8" fill="#f97316"/>
        <text x="${Math.round(point[0]) + 10}" y="${Math.round(point[1]) - 10}" font-size="18" fill="#111827">P${index}</text>
      `).join('\n');
      const svg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          ${paperPolygon}
          ${paperCornerMarks}
          ${boundsRect}
          <rect x="18" y="18" width="${Math.min(460, Math.max(220, width - 36))}" height="84" rx="12" ry="12" fill="rgba(17,24,39,0.84)"/>
          <text x="34" y="50" font-size="24" fill="#ffffff">01_1 纸张范围检测</text>
          <text x="34" y="80" font-size="18" fill="#d1fae5">基于白纸连通区域输出四角点，矩形框仅作辅助包围框</text>
        </svg>
      `;
      await fs.promises.mkdir(path.dirname(outputImagePath), { recursive: true });
      await sharp(resolvedImagePath)
        .composite([
          {
            input: previewMask,
            raw: {
              width,
              height,
              channels: 4
            },
            top: 0,
            left: 0
          },
          { input: Buffer.from(svg), top: 0, left: 0 }
        ])
        .png()
        .toFile(outputImagePath);
    }

    if (outputMetaPath) {
      await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
      await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    return payload;
  }
}

module.exports = new PaperBoundsDetectPlugin();
