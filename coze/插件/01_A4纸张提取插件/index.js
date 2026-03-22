const fs = require('fs');
const path = require('path');
const preprocessPlugin = require('../00_预处理插件/index');
const paperBoundsDetectPlugin = require('../01_1纸张范围检测插件/index');
const paperCropExportPlugin = require('../01_2纸张裁切导出插件/index');

async function removeFileIfExists(filePath) {
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

class PaperExtractPlugin {
  constructor() {
    this.name = '01_paper_extract';
    this.version = '1.0.0';
    this.processNo = '01';
  }

  async execute(params) {
    const { imagePath, outputDir, preprocessOptions = {}, preprocessResult = null, paperCropOutputPath = null } = params || {};
    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }
    if (!outputDir) {
      throw new Error('outputDir参数是必需的');
    }

    const baseName = path.basename(imagePath, path.extname(imagePath));
    await fs.promises.mkdir(outputDir, { recursive: true });
    const step01_1Dir = path.join(outputDir, '01_1_纸张范围检测');
    const step01_2Dir = path.join(outputDir, '01_2_纸张裁切导出');
    await fs.promises.mkdir(step01_1Dir, { recursive: true });
    await fs.promises.mkdir(step01_2Dir, { recursive: true });

    const resolvedPaperCropOutputPath = paperCropOutputPath || path.join(step01_2Dir, '01_2_稿纸裁切图.png');
    const outputPath = path.join(outputDir, `01_${baseName}_预处理图.png`);
    const outputMetaPath = path.join(outputDir, '01_稿纸提取结果.json');
    const step01_1MetaPath = path.join(step01_1Dir, '01_1_纸张范围检测.json');
    const step01_2MetaPath = path.join(step01_2Dir, '01_2_纸张裁切导出.json');
    const step01_1ImagePath = path.join(step01_1Dir, '01_1_纸张范围检测图.png');

    const resolvedPreprocessResult = preprocessResult || await preprocessPlugin.execute({
      imagePath,
      outputPath,
      paperCropOutputPath: resolvedPaperCropOutputPath,
      outputMetaPath,
      ...preprocessOptions
    });

    const step01_1 = await paperBoundsDetectPlugin.execute({
      imagePath,
      preprocessResult: resolvedPreprocessResult,
      outputMetaPath: step01_1MetaPath,
      outputImagePath: step01_1ImagePath
    });
    const step01_2 = await paperCropExportPlugin.execute({
      imagePath,
      preprocessResult: resolvedPreprocessResult,
      paperBounds: step01_1.paperBounds || null,
      paperCorners: step01_1.paperCorners || null,
      paperCropOutputPath: resolvedPaperCropOutputPath,
      outputMetaPath: step01_2MetaPath
    });

    const payload = {
      processNo: this.processNo,
      processName: '01_稿纸提取',
      imagePath,
      paperCropOutputPath: resolvedPaperCropOutputPath,
      outputMetaPath,
      paperBounds: step01_1.paperBounds || resolvedPreprocessResult.paperBounds || null,
      paperCorners: step01_1.paperCorners || resolvedPreprocessResult.paperCorners || null,
      method: 'white-paper connected-region',
      note: '01 仅负责稿纸白色连通域提取与裁切，不负责A4比例或透视矫正。',
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

    if (!preprocessResult) {
      await removeFileIfExists(outputPath);
    }

    await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }
}

module.exports = new PaperExtractPlugin();
