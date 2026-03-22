const fs = require('fs');
const path = require('path');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

class GridRectCropAnnotatePlugin {
  constructor() {
    this.name = '03_3_总方格裁切标注';
    this.version = '1.0.0';
    this.processNo = '03_3';
  }

  async cropImageToBounds(inputPath, outputPath, bounds) {
    const { left, top, width, height } = bounds;
    await sharp(inputPath).extract({ left, top, width, height }).png().toFile(outputPath);
  }

  async copyImage(inputPath, outputPath) {
    await sharp(inputPath).png().toFile(outputPath);
  }

  async removeFileIfExists(filePath) {
    if (!filePath) {
      return;
    }
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async annotateRectBounds(inputPath, outputPath, bounds) {
    const metadata = await sharp(inputPath).metadata();
    const svg = `
      <svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${bounds.left}" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="#16a34a" stroke-width="6"/>
        <rect x="${Math.max(0, bounds.left)}" y="${Math.max(0, bounds.top - 36)}" width="320" height="30" fill="rgba(17,24,39,0.82)"/>
        <text x="${bounds.left + 12}" y="${Math.max(22, bounds.top - 14)}" font-size="18" fill="#ffffff">03 grid-rect ${bounds.width}x${bounds.height}</text>
      </svg>
    `;
    await sharp(inputPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputPath);
  }

  async execute(params) {
    const {
      baseName,
      bounds,
      preprocessWarpedPath,
      preprocessPath,
      gridSegmentationInputPath,
      preprocessGuideRemovedPath,
      preprocessGridBackgroundMaskPath,
      segmentationMode = 'crop',
      annotationInputPath = null,
      annotatedPath,
      warpedCropPath
    } = params || {};

    await fs.promises.mkdir(path.dirname(annotatedPath), { recursive: true });
    let resolvedBounds = bounds;
    let sourceImageSize = null;
    if (segmentationMode === 'passthrough') {
      const passthroughMeta = await sharp(gridSegmentationInputPath).metadata();
      resolvedBounds = {
        left: 0,
        top: 0,
        width: passthroughMeta.width,
        height: passthroughMeta.height,
        source: `${bounds?.source || '03_0_6'}_passthrough`
      };
      sourceImageSize = {
        width: passthroughMeta.width,
        height: passthroughMeta.height
      };
      await this.copyImage(gridSegmentationInputPath, warpedCropPath);
      await this.annotateRectBounds(annotationInputPath || gridSegmentationInputPath, annotatedPath, resolvedBounds);
    } else {
      const warpedMeta = await sharp(preprocessWarpedPath).metadata();
      sourceImageSize = {
        width: warpedMeta.width,
        height: warpedMeta.height
      };
      await this.cropImageToBounds(preprocessWarpedPath, warpedCropPath, resolvedBounds);
      await this.annotateRectBounds(annotationInputPath || preprocessWarpedPath, annotatedPath, resolvedBounds);
    }

    return {
      processNo: this.processNo,
      processName: '03_3_总方格裁切标注',
      sourceStep: '03_2_总方格矩形纠偏',
      stageInputPath: gridSegmentationInputPath,
      baseName,
      bounds: resolvedBounds,
      inputPaths: {
        warpedInputPath: preprocessWarpedPath,
        preprocessedInputPath: preprocessPath,
        gridSegmentationInputPath,
        guideRemovedInputPath: preprocessGuideRemovedPath,
        maskInputPath: preprocessGridBackgroundMaskPath
      },
      segmentationMode,
      annotatedPath,
      warpedCropPath,
      gridSegmentationInputPath,
      gridSegmentationInputGenerated: false,
      sourceImageSize
    };
  }
}

module.exports = new GridRectCropAnnotatePlugin();
