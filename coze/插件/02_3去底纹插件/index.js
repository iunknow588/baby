const fs = require('fs');
const path = require('path');

class GuideRemovePlugin {
  constructor() {
    this.name = '02_3_去底纹';
    this.version = '1.0.0';
    this.processNo = '02_3';
  }

  async execute(params) {
    const {
      imagePath,
      preprocessResult,
      outputMetaPath,
      step02_3_1MetaPath = null,
      step02_3_2MetaPath = null
    } = params || {};
    if (!imagePath || !preprocessResult || !outputMetaPath) {
      throw new Error('imagePath/preprocessResult/outputMetaPath 参数是必需的');
    }

    const step02_3_1 = {
      processNo: '02_3_1',
      processName: '02_3_1_检测去底纹输出',
      imagePath,
      outputPath: preprocessResult.guideRemovedOutputPath || null,
      neutralOutputPath: preprocessResult.neutralGuideRemovedOutputPath || null,
      boundaryDetection: preprocessResult.guideRemovalBoundaryDetection || null
    };

    const step02_3_2 = {
      processNo: '02_3_2',
      processName: '02_3_2_矫正预处理',
      imagePath,
      outputPath: preprocessResult.outputPath || null,
      segmentationOutputPath: preprocessResult.segmentationOutputPath || null,
      segmentationBoundaryDetection: preprocessResult.gridBoundaryDetection || null
    };

    const payload = {
      processNo: this.processNo,
      processName: '02_3_去底纹',
      imagePath,
      step02_3_1,
      step02_3_2
    };

    await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
    if (step02_3_1MetaPath) {
      await fs.promises.mkdir(path.dirname(step02_3_1MetaPath), { recursive: true });
      await fs.promises.writeFile(step02_3_1MetaPath, `${JSON.stringify(step02_3_1, null, 2)}\n`, 'utf8');
    }
    if (step02_3_2MetaPath) {
      await fs.promises.mkdir(path.dirname(step02_3_2MetaPath), { recursive: true });
      await fs.promises.writeFile(step02_3_2MetaPath, `${JSON.stringify(step02_3_2, null, 2)}\n`, 'utf8');
    }
    await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }
}

module.exports = new GuideRemovePlugin();
