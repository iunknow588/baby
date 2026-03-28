const fs = require('fs');
const path = require('path');
const paperBoundsDetectPlugin = require('../01_1纸张范围检测插件/index');
const paperCropExportPlugin = require('../01_2纸张裁切导出插件/index');
const {
  resolveSingleImageInput,
  buildStageImageHandoffContract
} = require('../utils/stage_image_contract');

class PaperExtractPlugin {
  constructor() {
    this.name = '01_paper_extract';
    this.version = '1.0.0';
    this.processNo = '01';
  }

  async execute(params) {
    const {
      stageInputPath = null,
      imagePath = null,
      outputDir,
      preprocessResult = null,
      paperCropOutputPath = null
    } = params || {};
    if (!outputDir) {
      throw new Error('outputDir参数是必需的');
    }
    const resolvedStageInputPath = resolveSingleImageInput({
      stageName: '01阶段',
      primaryInputPath: stageInputPath,
      imagePath
    });

    const baseName = path.basename(resolvedStageInputPath, path.extname(resolvedStageInputPath));
    await fs.promises.mkdir(outputDir, { recursive: true });
    const step01_1Dir = path.join(outputDir, '01_1_纸张范围检测');
    const step01_2Dir = path.join(outputDir, '01_2_纸张裁切导出');
    await fs.promises.mkdir(step01_1Dir, { recursive: true });
    await fs.promises.mkdir(step01_2Dir, { recursive: true });

    const resolvedPaperCropOutputPath = paperCropOutputPath || path.join(step01_2Dir, '01_2_稿纸裁切图.png');
    const outputMetaPath = path.join(outputDir, '01_稿纸提取结果.json');
    const step01_1MetaPath = path.join(step01_1Dir, '01_1_纸张范围检测.json');
    const step01_2MetaPath = path.join(step01_2Dir, '01_2_纸张裁切导出.json');
    const step01_1ImagePath = path.join(step01_1Dir, '01_1_纸张范围检测图.png');

    const step01_1 = await paperBoundsDetectPlugin.execute({
      stageInputPath: resolvedStageInputPath,
      outputMetaPath: step01_1MetaPath,
      outputImagePath: step01_1ImagePath
    });
    const step01_2 = await paperCropExportPlugin.execute({
      stageInputPath: resolvedStageInputPath,
      paperBounds: step01_1.paperBounds || preprocessResult?.paperBounds || null,
      paperCorners: step01_1.paperCorners || preprocessResult?.paperCorners || null,
      paperCropOutputPath: resolvedPaperCropOutputPath,
      outputMetaPath: step01_2MetaPath
    });

    const payload = {
      processNo: this.processNo,
      processName: '01_稿纸提取',
      imagePath: resolvedStageInputPath,
      stageInputPath: resolvedStageInputPath,
      paperCropOutputPath: resolvedPaperCropOutputPath,
      stageOutputImagePath: resolvedPaperCropOutputPath,
      nextStageInputPath: resolvedPaperCropOutputPath,
      outputMetaPath,
      paperBounds: step01_1.paperBounds || preprocessResult?.paperBounds || null,
      paperCorners: step01_1.paperCorners || preprocessResult?.paperCorners || null,
      method: 'white-paper connected-region',
      note: '01 仅负责稿纸白色连通域提取与裁切，不负责A4比例或透视矫正。',
      handoffContract: buildStageImageHandoffContract({
        stageName: '01阶段',
        stageInputPath: resolvedStageInputPath,
        stageOutputImagePath: resolvedPaperCropOutputPath,
        nextStageInputPath: resolvedPaperCropOutputPath
      }),
      steps: {
        step01_1,
        step01_2
      },
      stepDirs: {
        step01_1: step01_1Dir,
        step01_2: step01_2Dir
      },
      stepMetaPaths: {
        step01_1: step01_1MetaPath,
        step01_2: step01_2MetaPath
      }
    };

    await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }
}

module.exports = new PaperExtractPlugin();
