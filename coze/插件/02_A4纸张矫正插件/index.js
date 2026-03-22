const fs = require('fs');
const path = require('path');
const { applySolidPaperBorder } = require('../utils/paper_edge_cleanup');
const preprocessPlugin = require('../00_预处理插件/index');
const a4ConstraintDetectPlugin = require('../01_0A4规格约束检测插件/index');
const paperCornerDetectPlugin = require('../02_1纸张角点检测插件/index');
const perspectiveRectifyPlugin = require('../02_2透视矫正插件/index');
const guideRemovePlugin = require('../02_3去底纹插件/index');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

class A4RectifyPlugin {
  constructor() {
    this.name = '02_a4_rectify';
    this.version = '1.0.0';
  }

  async execute(params) {
    const { imagePath, outputDir, gridRows = 11, gridCols = 7, gridType = 'square', preprocessOptions = {} } = params || {};
    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }
    if (!outputDir) {
      throw new Error('outputDir参数是必需的');
    }

    const baseName = path.basename(imagePath, path.extname(imagePath));
    await fs.promises.mkdir(outputDir, { recursive: true });
    const step02_0Dir = path.join(outputDir, '02_0_A4规格约束检测');
    const step02_1Dir = path.join(outputDir, '02_1_纸张角点检测');
    const step02_2Dir = path.join(outputDir, '02_2_透视矫正');
    const step02_3Dir = path.join(outputDir, '02_3_去底纹');
    const step02_3_1Dir = path.join(step02_3Dir, '02_3_1_去底纹输出');
    const step02_3_2Dir = path.join(step02_3Dir, '02_3_2_矫正预处理输出');
    await fs.promises.mkdir(step02_0Dir, { recursive: true });
    await fs.promises.mkdir(step02_1Dir, { recursive: true });
    await fs.promises.mkdir(step02_2Dir, { recursive: true });
    await fs.promises.mkdir(step02_3Dir, { recursive: true });
    await fs.promises.mkdir(step02_3_1Dir, { recursive: true });
    await fs.promises.mkdir(step02_3_2Dir, { recursive: true });

    const outputPath = path.join(step02_3_2Dir, '02_3_2_矫正预处理图.png');
    const warpedOutputPath = path.join(step02_2Dir, '02_2_透视矫正图.png');
    const neutralGuideRemovedOutputPath = path.join(step02_3_1Dir, '02_3_1_检测去底纹图.png');
    const outputMetaPath = path.join(outputDir, '02_A4纸张矫正结果.json');
    const a4ConstraintImagePath = path.join(step02_0Dir, '02_0_A4规格约束检测图.png');
    const a4ConstraintMetaPath = path.join(step02_0Dir, '02_0_A4规格约束检测.json');
    const a4CleanedInputPath = path.join(step02_0Dir, '02_0_1_A4内切清边图.png');
    const outputDebugPath = path.join(step02_1Dir, '02_1_纸张角点调试图.png');
    const cornerMetaPath = path.join(step02_1Dir, '02_1_纸张角点检测.json');
    const perspectiveMetaPath = path.join(step02_2Dir, '02_2_透视矫正.json');
    const guideRemoveMetaPath = path.join(step02_3Dir, '02_3_去底纹.json');
    const guideRemoveStep01MetaPath = path.join(step02_3_1Dir, '02_3_1_去底纹.json');
    const guideRemoveStep02MetaPath = path.join(step02_3_2Dir, '02_3_2_矫正预处理.json');
    const inputMeta = await sharp(imagePath).metadata();
    const step02_0 = await a4ConstraintDetectPlugin.execute({
      imagePath,
      preprocessResult: {
        paperBounds: {
          left: 0,
          top: 0,
          width: inputMeta.width || 0,
          height: inputMeta.height || 0
        }
      },
      outputMetaPath: a4ConstraintMetaPath,
      outputImagePath: a4ConstraintImagePath,
      cleanedImagePath: a4CleanedInputPath
    });
    const effectiveImagePath = step02_0?.edgeCleanup?.applied && fs.existsSync(a4CleanedInputPath)
      ? a4CleanedInputPath
      : imagePath;

    const result = await preprocessPlugin.execute({
      imagePath: effectiveImagePath,
      outputPath,
      warpedOutputPath,
      guideRemovedOutputPath: neutralGuideRemovedOutputPath,
      neutralGuideRemovedOutputPath,
      outputMetaPath,
      outputDebugPath,
      gridRows,
      gridCols,
      gridType,
      a4Constraint: step02_0?.a4Constraint || null,
      ...preprocessOptions
    });

    const step02_1 = await paperCornerDetectPlugin.execute({
      imagePath: effectiveImagePath,
      preprocessResult: result,
      outputMetaPath: cornerMetaPath
    });
    const step02_2 = await perspectiveRectifyPlugin.execute({
      imagePath: effectiveImagePath,
      preprocessResult: result,
      outputMetaPath: perspectiveMetaPath
    });
    const step02_3 = await guideRemovePlugin.execute({
      imagePath: effectiveImagePath,
      preprocessResult: result,
      outputMetaPath: guideRemoveMetaPath,
      step02_3_1MetaPath: guideRemoveStep01MetaPath,
      step02_3_2MetaPath: guideRemoveStep02MetaPath
    });

    const stabilizedBorderTargets = [
      warpedOutputPath,
      neutralGuideRemovedOutputPath,
      outputPath
    ].filter(Boolean);
    for (const targetPath of stabilizedBorderTargets) {
      if (fs.existsSync(targetPath)) {
        await applySolidPaperBorder(targetPath, step02_0?.edgeCleanup || null);
      }
    }

    return {
      processNo: '02',
      processName: '02_A4纸张矫正',
      imagePath,
      outputMetaPath,
      outputs: {
        a4ConstraintImagePath,
        a4CleanedInputPath,
        outputPath,
        warpedOutputPath,
        guideRemovedOutputPath: neutralGuideRemovedOutputPath,
        neutralGuideRemovedOutputPath,
        outputDebugPath,
        step02_0Dir,
        step02_1Dir,
        step02_2Dir,
        step02_3Dir,
        step02_3_1Dir,
        step02_3_2Dir,
        step02_0MetaPath: a4ConstraintMetaPath,
        step02_1MetaPath: cornerMetaPath,
        step02_2MetaPath: perspectiveMetaPath,
        step02_3MetaPath: guideRemoveMetaPath,
        step02_3_1MetaPath: guideRemoveStep01MetaPath,
        step02_3_2MetaPath: guideRemoveStep02MetaPath
      },
      steps: {
        step02_0,
        step02_1,
        step02_2,
        step02_3
      },
      result
    };
  }
}

module.exports = new A4RectifyPlugin();
