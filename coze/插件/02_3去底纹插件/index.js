const fs = require('fs');
const path = require('path');
const {
  resolveSingleImageInput,
  buildStageImageHandoffContract
} = require('../utils/stage_image_contract');

class GuideRemovePlugin {
  constructor() {
    this.name = '02_3_去底纹';
    this.version = '1.0.0';
    this.processNo = '02_3';
  }

  async execute(params) {
    const {
      stageInputPath = null,
      imagePath = null,
      preprocessResult,
      outputMetaPath,
      step02_3_1MetaPath = null,
      step02_3_2MetaPath = null
    } = params || {};
    if (!preprocessResult || !outputMetaPath) {
      throw new Error('preprocessResult/outputMetaPath 参数是必需的');
    }
    const resolvedImagePath = resolveSingleImageInput({
      stageName: '02_3_去底纹',
      primaryInputPath: stageInputPath,
      imagePath
    });

    const step02_3_1 = {
      processNo: '02_3_1',
      processName: '02_3_1_检测去底纹输出',
      imagePath: resolvedImagePath,
      stageInputPath: resolvedImagePath,
      stageOutputImagePath: preprocessResult.guideRemovedOutputPath || null,
      outputPath: preprocessResult.guideRemovedOutputPath || null,
      neutralOutputPath: preprocessResult.neutralGuideRemovedOutputPath || null,
      boundaryDetection: preprocessResult.guideRemovalBoundaryDetection || null,
      handoffContract: buildStageImageHandoffContract({
        stageName: '02_3_1',
        stageInputPath: resolvedImagePath,
        stageOutputImagePath: preprocessResult.guideRemovedOutputPath || null,
        nextStageInputPath: preprocessResult.guideRemovedOutputPath || null
      })
    };

    const step02_3_2 = {
      processNo: '02_3_2',
      processName: '02_3_2_矫正预处理',
      imagePath: resolvedImagePath,
      stageInputPath: resolvedImagePath,
      stageOutputImagePath: preprocessResult.outputPath || null,
      outputPath: preprocessResult.outputPath || null,
      segmentationOutputPath: preprocessResult.segmentationOutputPath || null,
      segmentationBoundaryDetection: preprocessResult.gridBoundaryDetection || null,
      handoffContract: buildStageImageHandoffContract({
        stageName: '02_3_2',
        stageInputPath: resolvedImagePath,
        stageOutputImagePath: preprocessResult.outputPath || null,
        nextStageInputPath: preprocessResult.outputPath || null
      })
    };

    const payload = {
      processNo: this.processNo,
      processName: '02_3_去底纹',
      imagePath: resolvedImagePath,
      stageInputPath: resolvedImagePath,
      stageOutputImagePath: preprocessResult.outputPath || null,
      nextStageInputPath: preprocessResult.outputPath || null,
      handoffContract: buildStageImageHandoffContract({
        stageName: '02_3',
        stageInputPath: resolvedImagePath,
        stageOutputImagePath: preprocessResult.outputPath || null,
        nextStageInputPath: preprocessResult.outputPath || null
      }),
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
