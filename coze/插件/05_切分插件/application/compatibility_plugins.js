const { executeGridBoundsDetection } = require('../domain/grid_bounds');
const { executeBoundaryGuideSegmentation } = require('../domain/boundary_guides');
const { renderGridDebugImage } = require('../presentation/debug_render');
const { executeCellCrop } = require('../domain/cell_crop');
const { SEGMENTATION_STEP_DEFINITIONS } = require('../step_definitions');

function createCompatibilityPlugin({ stepDefinition, execute }) {
  return new class CompatibilityPlugin {
    constructor() {
      this.name = stepDefinition.processName;
      this.version = '1.0.0';
      this.processNo = stepDefinition.processNo;
    }

    execute(params) {
      return execute(params);
    }
  }();
}

const gridBoundsDetectPlugin = createCompatibilityPlugin({
  stepDefinition: SEGMENTATION_STEP_DEFINITIONS.step05_1,
  execute: (params = {}) => executeGridBoundsDetection({
    ...params,
    processNo: SEGMENTATION_STEP_DEFINITIONS.step05_1.processNo,
    processName: SEGMENTATION_STEP_DEFINITIONS.step05_1.processName
  })
});

const boundaryGuideSegmentationPlugin = createCompatibilityPlugin({
  stepDefinition: SEGMENTATION_STEP_DEFINITIONS.step05_2,
  execute: (params = {}) => executeBoundaryGuideSegmentation({
    ...params,
    processNo: SEGMENTATION_STEP_DEFINITIONS.step05_2.processNo,
    processName: SEGMENTATION_STEP_DEFINITIONS.step05_2.processName
  })
});

const segmentationDebugRenderPlugin = createCompatibilityPlugin({
  stepDefinition: SEGMENTATION_STEP_DEFINITIONS.step05_3,
  execute: async (params = {}) => {
    const { imageInput, debugOutputPath, debugData } = params;
    if (!imageInput || !debugOutputPath || !debugData) {
      throw new Error('imageInput/debugOutputPath/debugData参数是必需的');
    }

    await renderGridDebugImage(imageInput, debugOutputPath, debugData);
    return {
      processNo: SEGMENTATION_STEP_DEFINITIONS.step05_3.processNo,
      processName: SEGMENTATION_STEP_DEFINITIONS.step05_3.processName,
      debugOutputPath
    };
  }
});

const cellCropPlugin = createCompatibilityPlugin({
  stepDefinition: SEGMENTATION_STEP_DEFINITIONS.step05_4,
  execute: async (params = {}) => executeCellCrop({
    ...params,
    processNo: SEGMENTATION_STEP_DEFINITIONS.step05_4.processNo,
    processName: SEGMENTATION_STEP_DEFINITIONS.step05_4.processName
  })
});

module.exports = {
  gridBoundsDetectPlugin,
  boundaryGuideSegmentationPlugin,
  segmentationDebugRenderPlugin,
  cellCropPlugin
};
