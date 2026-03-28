const fs = require('fs');
const path = require('path');
const {
  resolveSingleImageInput,
  buildStageImageHandoffContract
} = require('../utils/stage_image_contract');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

class GridRectCropAnnotatePlugin {
  constructor() {
    this.name = '03_3辅助_内框裁剪标注';
    this.version = '1.0.0';
    this.processNo = '03_i3';
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
        <text x="${bounds.left + 12}" y="${Math.max(22, bounds.top - 14)}" font-size="18" fill="#ffffff">03 inner-frame ${bounds.width}x${bounds.height}</text>
      </svg>
    `;
    await sharp(inputPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputPath);
  }

  async execute(params) {
    const {
      baseName,
      bounds,
      stageInputPath = null,
      imagePath = null,
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

    const resolvedStageInputPath = resolveSingleImageInput({
      stageName: '03_3辅助_内框裁剪标注',
      primaryInputPath: stageInputPath,
      imagePath,
      legacyInputPaths: [
        segmentationMode === 'passthrough' ? gridSegmentationInputPath : preprocessWarpedPath,
        preprocessPath,
        preprocessGuideRemovedPath,
        preprocessGridBackgroundMaskPath
      ]
    });

    await fs.promises.mkdir(path.dirname(annotatedPath), { recursive: true });
    let resolvedBounds = bounds;
    let sourceImageSize = null;
    if (segmentationMode === 'passthrough') {
      const passthroughMeta = await sharp(resolvedStageInputPath).metadata();
      const fullBounds = {
        left: 0,
        top: 0,
        width: passthroughMeta.width,
        height: passthroughMeta.height,
        source: `${bounds?.source || '03_4'}_passthrough`
      };
      if (bounds?.width && bounds?.height) {
        const left = Math.max(0, Math.min(passthroughMeta.width - 1, Math.round(bounds.left || 0)));
        const top = Math.max(0, Math.min(passthroughMeta.height - 1, Math.round(bounds.top || 0)));
        const right = Math.max(left + 1, Math.min(passthroughMeta.width, Math.round((bounds.left || 0) + bounds.width)));
        const bottom = Math.max(top + 1, Math.min(passthroughMeta.height, Math.round((bounds.top || 0) + bounds.height)));
        resolvedBounds = {
          left,
          top,
          width: right - left,
          height: bottom - top,
          source: `${bounds.source || '03_4'}_passthrough`
        };
      } else {
        resolvedBounds = fullBounds;
      }
      sourceImageSize = {
        width: passthroughMeta.width,
        height: passthroughMeta.height
      };
      if (
        resolvedBounds.left === 0
        && resolvedBounds.top === 0
        && resolvedBounds.width === passthroughMeta.width
        && resolvedBounds.height === passthroughMeta.height
      ) {
        await this.copyImage(resolvedStageInputPath, warpedCropPath);
      } else {
        await this.cropImageToBounds(resolvedStageInputPath, warpedCropPath, resolvedBounds);
      }
      await this.annotateRectBounds(annotationInputPath || resolvedStageInputPath, annotatedPath, resolvedBounds);
    } else {
      const warpedMeta = await sharp(resolvedStageInputPath).metadata();
      sourceImageSize = {
        width: warpedMeta.width,
        height: warpedMeta.height
      };
      await this.cropImageToBounds(resolvedStageInputPath, warpedCropPath, resolvedBounds);
      await this.annotateRectBounds(annotationInputPath || resolvedStageInputPath, annotatedPath, resolvedBounds);
    }

    return {
      processNo: this.processNo,
      processName: '03_3辅助_内框裁剪标注',
      sourceStep: '03_2辅助_内框范围纠偏',
      stageInputPath: resolvedStageInputPath,
      stageOutputImagePath: warpedCropPath,
      baseName,
      bounds: resolvedBounds,
      inputPaths: {
        stageInputPath: resolvedStageInputPath,
        annotationInputPath: annotationInputPath || null
      },
      legacyInputPaths: {
        preprocessWarpedPath: preprocessWarpedPath || null,
        preprocessPath: preprocessPath || null,
        gridSegmentationInputPath: gridSegmentationInputPath || null,
        preprocessGuideRemovedPath: preprocessGuideRemovedPath || null,
        preprocessGridBackgroundMaskPath: preprocessGridBackgroundMaskPath || null
      },
      segmentationMode,
      annotatedPath,
      warpedCropPath,
      gridSegmentationInputPath: warpedCropPath,
      gridSegmentationInputGenerated: false,
      sourceImageSize,
      handoffContract: buildStageImageHandoffContract({
        stageName: '03_3辅助_内框裁剪标注',
        stageInputPath: resolvedStageInputPath,
        stageOutputImagePath: warpedCropPath,
        nextStageInputPath: warpedCropPath
      })
    };
  }
}

module.exports = new GridRectCropAnnotatePlugin();
