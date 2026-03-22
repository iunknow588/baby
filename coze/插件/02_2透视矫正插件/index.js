const fs = require('fs');
const path = require('path');

class PerspectiveRectifyPlugin {
  constructor() {
    this.name = '02_2_透视矫正';
    this.version = '1.0.0';
    this.processNo = '02_2';
  }

  async execute(params) {
    const { imagePath, preprocessResult, outputMetaPath } = params || {};
    if (!imagePath || !preprocessResult || !outputMetaPath) {
      throw new Error('imagePath/preprocessResult/outputMetaPath 参数是必需的');
    }

    const payload = {
      processNo: this.processNo,
      processName: '02_2_透视矫正',
      imagePath,
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
