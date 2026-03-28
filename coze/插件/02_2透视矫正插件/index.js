const fs = require('fs');
const path = require('path');
const { resolveSingleImageInput } = require('../utils/stage_image_contract');

class PerspectiveRectifyPlugin {
  constructor() {
    this.name = '02_2_透视矫正';
    this.version = '1.0.0';
    this.processNo = '02_2';
  }

  async execute(params) {
    const {
      stageInputPath = null,
      imagePath = null,
      preprocessResult,
      outputMetaPath
    } = params || {};
    if (!preprocessResult || !outputMetaPath) {
      throw new Error('preprocessResult/outputMetaPath 参数是必需的');
    }
    const resolvedImagePath = resolveSingleImageInput({
      stageName: '02_2_透视矫正',
      primaryInputPath: stageInputPath,
      imagePath
    });

    const payload = {
      processNo: this.processNo,
      processName: '02_2_透视矫正',
      imagePath: resolvedImagePath,
      stageInputPath: resolvedImagePath,
      stageOutputImagePath: preprocessResult.warpedOutputPath || null,
      method: preprocessResult.method || null,
      warpedOutputPath: preprocessResult.warpedOutputPath || null,
      outputPath: preprocessResult.outputPath || null,
      segmentationOutputPath: preprocessResult.segmentationOutputPath || null,
      warp: preprocessResult.warp || null,
      outputInfo: preprocessResult.outputInfo || null
    };

    await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
    await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }
}

module.exports = new PerspectiveRectifyPlugin();
