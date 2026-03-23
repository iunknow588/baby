const fs = require('fs');
const path = require('path');
const { preprocessPaperImage } = require('./paper_preprocess');
const { estimateGridSize } = require('./grid_size_estimator');

class PaperPreprocessPlugin {
  constructor() {
    this.name = 'paper_preprocess';
    this.version = '1.0.0';
  }

  async execute(params) {
    const {
      imagePath,
      outputPath,
      segmentationOutputPath = null,
      paperCropOutputPath = null,
      warpedOutputPath = null,
      guideRemovedOutputPath = null,
      neutralGuideRemovedOutputPath = null,
      gridBackgroundMaskOutputPath = null,
      gridAnnotatedOutputPath = null,
      gridRectifiedOutputPath = null,
      gridRectifiedMetaPath = null,
      gridRectifiedDebugPath = null,
      gridEstimateMetaPath = null,
      outputMetaPath = null,
      outputDebugPath = null,
      returnBase64 = false,
      cropToPaper = true,
      gridRows = null,
      gridCols = null,
      threshold,
      blurSigma,
      ignoreRedGrid = true,
      gridType = 'square',
      a4Constraint = null,
      disableInternalGridGuideCleanup = false
    } = params || {};

    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }
    if (!outputPath) {
      throw new Error('outputPath参数是必需的');
    }

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    const result = await preprocessPaperImage(imagePath, {
      outputPath,
      segmentationOutputPath,
      paperCropOutputPath,
      warpedOutputPath,
      guideRemovedOutputPath,
      neutralGuideRemovedOutputPath,
      gridBackgroundMaskOutputPath,
      gridAnnotatedOutputPath,
      gridRectifiedOutputPath,
      gridRectifiedMetaPath,
      gridRectifiedDebugPath,
      debugPath: outputDebugPath,
      cropToPaper,
      gridRows,
      gridCols,
      threshold,
      blurSigma,
      ignoreRedGrid,
      gridType,
      a4Constraint,
      disableInternalGridGuideCleanup
    });

    let gridEstimation = null;
    const gridEstimateInputPath =
      result.gridBackgroundMaskOutputPath ||
      gridBackgroundMaskOutputPath ||
      result.segmentationOutputPath ||
      outputPath;

    if (gridEstimateInputPath) {
      try {
        gridEstimation = await estimateGridSize(gridEstimateInputPath);
      } catch (error) {
        gridEstimation = {
          error: error.message
        };
      }
    }

    const payload = {
      method: result.method,
      imagePath,
      outputPath,
      segmentationOutputPath: result.segmentationOutputPath || segmentationOutputPath || outputPath,
      paperCropOutputPath: result.paperCropOutputPath || paperCropOutputPath || null,
      warpedOutputPath: result.warpedOutputPath || warpedOutputPath || null,
      guideRemovedOutputPath: result.guideRemovedOutputPath || guideRemovedOutputPath || null,
      neutralGuideRemovedOutputPath: result.neutralGuideRemovedOutputPath || neutralGuideRemovedOutputPath || null,
      gridBackgroundMaskOutputPath: result.gridBackgroundMaskOutputPath || gridBackgroundMaskOutputPath || null,
      gridAnnotatedOutputPath: result.gridAnnotatedOutputPath || gridAnnotatedOutputPath || null,
      gridRectifiedOutputPath: result.gridRectifiedOutputPath || gridRectifiedOutputPath || null,
      gridRectifiedMetaPath: gridRectifiedMetaPath || null,
      gridRectifiedDebugPath: gridRectifiedDebugPath || null,
      gridRectification: result.gridRectification || null,
      correctedGridRectified: result.correctedGridRectified || null,
      guideRemovalBoundaryDetection: result.guideRemovalBoundaryDetection || null,
      gridBoundaryDetection: result.gridBoundaryDetection || null,
      a4Constraint: result.a4Constraint || a4Constraint || null,
      guideConstraintRepair: result.guideConstraintRepair || null,
      realBoundaryRefinement: result.realBoundaryRefinement || null,
      gridDetectionInputPath: result.realBoundaryRefinement?.gridDetectionInputPath || outputPath,
      gridEstimation,
      gridEstimationInputPath: gridEstimateInputPath || null,
      outputDebugPath,
      gridType,
      paperBounds: result.paperBounds,
      paperCorners: result.paperCorners || null,
      roughPaperCorners: result.roughPaperCorners || null,
      refinedPaperCorners: result.refinedPaperCorners || null,
      cornerSelection: result.cornerSelection || null,
      warp: result.warp || null,
      outputInfo: result.outputInfo
    };

    if (outputMetaPath) {
      await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
      await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    if (gridEstimateMetaPath && gridEstimation) {
      await fs.promises.mkdir(path.dirname(gridEstimateMetaPath), { recursive: true });
      await fs.promises.writeFile(gridEstimateMetaPath, `${JSON.stringify(gridEstimation, null, 2)}\n`, 'utf8');
    }

    return {
      ...payload,
      imageBase64: returnBase64 ? result.buffer.toString('base64') : null
    };
  }
}

module.exports = new PaperPreprocessPlugin();
