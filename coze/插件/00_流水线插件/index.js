const fs = require('fs');
const path = require('path');
const a4PaperExtractPlugin = require('../01_A4纸张提取插件/index');
const a4RectifyPlugin = require('../02_A4纸张矫正插件/index');
const gridOuterRectExtractPlugin = require('../03_总方格大矩形提取插件/index');
const segmentationPlugin = require('../05_切分插件/index');
const scoringPlugin = require('../07_评分插件/index');
const gridCountAnnotatePlugin = require('../04_方格数量计算标注插件/index');
const cellLayerExtractPlugin = require('../06_单格背景文字提取插件/index');
const { estimateGridSize } = require('../00_预处理插件/grid_size_estimator');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fitBoundaryGuidesToImage(boundaryGuides, imageWidth, imageHeight) {
  if (!boundaryGuides || !imageWidth || !imageHeight) {
    return null;
  }
  const sourceWidth = Math.max(1, (boundaryGuides.right ?? 0) - (boundaryGuides.left ?? 0));
  const sourceHeight = Math.max(1, (boundaryGuides.bottom ?? 0) - (boundaryGuides.top ?? 0));
  const scaleX = imageWidth / sourceWidth;
  const scaleY = imageHeight / sourceHeight;
  const mapX = (value) => Math.max(0, Math.min(imageWidth, Math.round(((value ?? 0) - (boundaryGuides.left ?? 0)) * scaleX)));
  const mapY = (value) => Math.max(0, Math.min(imageHeight, Math.round(((value ?? 0) - (boundaryGuides.top ?? 0)) * scaleY)));

  return {
    ...boundaryGuides,
    left: 0,
    top: 0,
    right: imageWidth,
    bottom: imageHeight,
    xPeaks: Array.isArray(boundaryGuides.xPeaks) ? boundaryGuides.xPeaks.map(mapX) : [],
    yPeaks: Array.isArray(boundaryGuides.yPeaks) ? boundaryGuides.yPeaks.map(mapY) : [],
    source: `${boundaryGuides.source || '边界引导'}_适配矫正图`
  };
}

function getSegmentationVariantLabel(source) {
  switch (source) {
    case 'grid_rectified':
      return '单格切分输入图';
    case 'binary':
      return '二值预处理图';
    case 'segmentation_ready':
      return '单格切分输入图';
    default:
      return source;
  }
}

function inferSegmentationSourceStep(imagePath, context = {}) {
  if (!imagePath) {
    return '03_总方格大矩形提取';
  }
  if (context.gridCountCarryForwardPath && imagePath === context.gridCountCarryForwardPath) {
    return '04_方格数量计算标注';
  }
  if (context.gridRectifiedPath && imagePath === context.gridRectifiedPath) {
    return '03_0_方格背景与边界检测';
  }
  if (context.textRectPreprocessedPath && imagePath === context.textRectPreprocessedPath) {
    return '03_3_总方格裁切标注';
  }
  if (context.gridSegmentationInputPath && imagePath === context.gridSegmentationInputPath) {
    return imagePath.includes('/03_0_') ? '03_0_方格背景与边界检测' : '03_3_总方格裁切标注';
  }
  return '03_总方格大矩形提取';
}

function getGridSourceLabel(source) {
  switch (source) {
    case 'estimated':
      return '自动估计';
    case 'provided':
      return '指定值';
    default:
      return source;
  }
}

async function writeStageInfo(stageDir, payload) {
  await fs.promises.mkdir(stageDir, { recursive: true });
  const chineseView = {
    阶段编号: payload.processNo || null,
    阶段名称: payload.processName || null,
    显示名称: payload.displayName || null,
    阶段目录: payload.stageDir || stageDir,
    原始图片: payload.imagePath || null,
    阶段输入图: payload.stageInputPath || null,
    关键输出: payload.keyOutputs || {},
    子步骤目录: payload.stepDirs || {},
    子步骤结果JSON: payload.stepMetaPaths || {}
  };
  if (payload.variants) {
    chineseView.候选方案 = payload.variants;
  }
  const infoPath = path.join(stageDir, 'stage_info.json');
  await fs.promises.writeFile(
    infoPath,
    `${JSON.stringify({
      ...payload,
      显示信息: chineseView
    }, null, 2)}\n`,
    'utf8'
  );
  return infoPath;
}

async function ensureDir(dirPath) {
  if (!dirPath) {
    return;
  }
  await fs.promises.mkdir(dirPath, { recursive: true });
}


async function estimateSegmentationQuality(scoringImagePath, segmentation) {
  const image = sharp(scoringImagePath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const metrics = [];

  for (const cell of segmentation.cells || []) {
    const { left, top, width, height } = cell.pageBox;
    let darkPixels = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let y = top; y < top + height; y++) {
      for (let x = left; x < left + width; x++) {
        const offset = (y * info.width + x) * info.channels;
        let intensity = 255;
        for (let channel = 0; channel < Math.min(info.channels, 3); channel++) {
          intensity = Math.min(intensity, data[offset + channel]);
        }

        const darkness = 255 - intensity;
        if (darkness < 48) {
          continue;
        }

        darkPixels += 1;
        weightedX += x - left;
        weightedY += y - top;
      }
    }

    const area = width * height;
    const darkRatio = area > 0 ? darkPixels / area : 0;
    const centerX = darkPixels ? weightedX / darkPixels / width : 0.5;
    const centerY = darkPixels ? weightedY / darkPixels / height : 0.5;
    const centerOffset = Math.abs(centerX - 0.5) + Math.abs(centerY - 0.5);

    metrics.push({
      darkRatio,
      blank: darkRatio < 0.012,
      centerOffset
    });
  }

  const blankCount = metrics.filter((item) => item.blank).length;
  const nonBlank = metrics.filter((item) => !item.blank);
  const averageDarkRatio = average(nonBlank.map((item) => item.darkRatio));
  const averageCenterOffset = average(nonBlank.map((item) => item.centerOffset));
  const lineCount = (segmentation.debug.verticalLines || []).length + (segmentation.debug.horizontalLines || []).length;
  const profileLineCount =
    (segmentation.debug.profileVerticalLines || []).length + (segmentation.debug.profileHorizontalLines || []).length;
  const fallbackPenalty = segmentation.debug.fallbackUsed ? 6 : 0;
  const score =
    lineCount * 3 +
    profileLineCount -
    blankCount * 2.2 +
    averageDarkRatio * 900 -
    averageCenterOffset * 120 -
    fallbackPenalty;

  return {
    blankCount,
    averageDarkRatio: Math.round(averageDarkRatio * 10000) / 10000,
    averageCenterOffset: Math.round(averageCenterOffset * 10000) / 10000,
    lineCount,
    profileLineCount,
    fallbackUsed: Boolean(segmentation.debug.fallbackUsed),
    score: Math.round(score * 100) / 100
  };
}

class HanziPipelinePlugin {
  constructor() {
    this.name = '00_hanzi_pipeline';
    this.version = '1.0.0';
  }

  async execute(params) {
    const hasProvidedGridRows = Object.prototype.hasOwnProperty.call(params || {}, 'gridRows');
    const hasProvidedGridCols = Object.prototype.hasOwnProperty.call(params || {}, 'gridCols');
    const {
      imagePath,
      outputRootDir,
      gridRows = 11,
      gridCols = 7,
      gridType = 'square',
      target_chars = [],
      task_id = null,
      image_id = null,
      trimContent = false,
      cropToGrid = true,
      pageBounds = null,
      scoringOptions = {},
      preprocessOptions = {},
      segmentationOptions = {},
      autoUseEstimatedGrid = true,
      maxStep = 7
    } = params || {};

    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }
    if (!outputRootDir) {
      throw new Error('outputRootDir参数是必需的');
    }

    const baseName = path.basename(imagePath, path.extname(imagePath));
    const fileRootDir = path.join(outputRootDir, baseName);
    const locateDir = path.join(fileRootDir, '01_稿纸提取');
    const rectifyDir = path.join(fileRootDir, '02_A4纸张矫正');
    const textRectDir = path.join(fileRootDir, '03_总方格大矩形提取');
    const gridCountDir = path.join(fileRootDir, '04_方格数量计算标注');
    const segmentationDir = path.join(fileRootDir, '05_单格切分');
    const cellLayerDir = path.join(fileRootDir, '06_单格背景文字提取');
    const scoringDir = path.join(fileRootDir, '07_单格评分');
    const scoringCellDir = path.join(scoringDir, '07_1至07_5_单格评分步骤');
    const scoringPageRenderDir = path.join(scoringDir, '07_6_页面评分渲染');
    const scoringResultDir = path.join(scoringDir, '07_7_页面评分结果');

    await ensureDir(fileRootDir);
    await ensureDir(locateDir);
    await ensureDir(rectifyDir);
    await ensureDir(textRectDir);

    const locatePaperCropPath = path.join(locateDir, '01_2_纸张裁切导出', '01_2_稿纸裁切图.png');
    const locateMetaPath = path.join(locateDir, '01_稿纸提取结果.json');
    const rectifyA4ConstraintMetaPath = path.join(rectifyDir, '02_0_A4规格约束检测', '02_0_A4规格约束检测.json');
    const quadDebugPath = path.join(rectifyDir, '02_1_纸张角点检测', '02_1_1_纸张角点调试图.png');
    const quadMetaPath = path.join(rectifyDir, '02_1_纸张角点检测', '02_1_纸张角点检测.json');
    const preprocessPath = path.join(rectifyDir, '02_3_去底纹', '02_3_2_矫正预处理输出', '02_3_2_1_矫正预处理图.png');
    const preprocessWarpedPath = path.join(rectifyDir, '02_2_透视矫正', '02_2_1_透视矫正图.png');
    const preprocessNeutralGuideRemovedPath = path.join(rectifyDir, '02_3_去底纹', '02_3_1_去底纹输出', '02_3_1_1_检测去底纹图.png');
    const preprocessGuideRemovedPath = preprocessNeutralGuideRemovedPath;
    const preprocessMetaPath = path.join(rectifyDir, '02_A4纸张矫正结果.json');
    const textRectGridStageDir = path.join(textRectDir, '03_0_方格背景与边界检测');
    const preprocessGridStageReferencePath = path.join(textRectGridStageDir, '03_0_1_粗裁剪去外框输入', '03_0_1_粗裁剪去外框输入图.png');
    const preprocessGridCornerAnnotatedPath = path.join(textRectGridStageDir, '03_0_2_四角点定位标注', '03_0_2_四角点定位标注图.png');
    const preprocessGridBackgroundMaskPath = path.join(textRectGridStageDir, '03_0_4_方格背景Mask', '03_0_4_方格背景Mask图.png');
    const preprocessGridRectifiedPath = path.join(textRectGridStageDir, '03_0_6_单格切分输入', '03_0_6_单格切分输入图.png');
    const preprocessGridRectifiedMetaPath = path.join(textRectGridStageDir, '03_0_6_单格切分输入', '03_0_6_单格切分输入信息.json');
    const preprocessGridStageMetaPath = path.join(textRectGridStageDir, '03_0_方格背景与边界检测.json');
    const textRectBoundsMetaPath = path.join(textRectDir, '03_总方格大矩形提取结果.json');
    const textRectAnnotatedPath = path.join(textRectDir, '03_3_总方格裁切标注', '03_3_1_总方格定位标注', '03_3_1_总方格定位标注图.png');
    const textRectWarpedPath = path.join(textRectDir, '03_3_总方格裁切标注', '03_3_2_总方格计数参考', '03_3_2_总方格计数参考图.png');
    const gridCountAnnotatedPath = path.join(gridCountDir, '04_2_方格数量标注图.png');
    const gridCountMetaPath = path.join(gridCountDir, '04_方格数量计算标注结果.json');
    const gridCountCarryForwardPath = path.join(gridCountDir, '04_3_单格切分输入', '04_3_单格切分输入图.png');
    const segmentationCellsDir = path.join(segmentationDir, '05_4_单格图');
    const segmentationDebugPath = path.join(segmentationDir, '05_3_切分调试图.png');
    const segmentationDebugMetaPath = path.join(segmentationDir, '05_3_切分调试信息.json');
    const cellLayerOutputDir = path.join(cellLayerDir, '06_0_单格分层总览');
    const scoringAnnotatedPath = path.join(scoringPageRenderDir, '07_6_页面评分标注图.png');
    const scoringSummaryPath = path.join(scoringPageRenderDir, '07_6_页面评分摘要.txt');
    const scoringJsonPath = path.join(scoringResultDir, '07_7_页面评分结果.json');

    const finish = async (payload = {}) => {
      const result = {
        imagePath,
        baseName,
        completedStep: payload.completedStep || 0,
        stoppedAtStep: payload.stoppedAtStep || null,
        outputs: {
          rootDir: outputRootDir,
          fileRootDir,
          ...(payload.outputs || {})
        },
        preprocessing: payload.preprocessing || null,
        estimatedGrid: payload.estimatedGrid || null,
        effectiveGrid: payload.effectiveGrid || null,
        gridCount: payload.gridCount || null,
        segmentation: payload.segmentation || null,
        cellLayerExtraction: payload.cellLayerExtraction || null,
        segmentationSelection: payload.segmentationSelection || null,
        scoring: payload.scoring || null
      };
      await fs.promises.writeFile(
        path.join(fileRootDir, 'pipeline_result.json'),
        `${JSON.stringify(result, null, 2)}\n`,
        'utf8'
      );
      return result;
    };

    const a4Extract = await a4PaperExtractPlugin.execute({
      imagePath,
      outputDir: locateDir,
      paperCropOutputPath: locatePaperCropPath
    });
    const locateStageInfoPath = await writeStageInfo(locateDir, {
      processNo: '01',
      processName: '01_稿纸提取',
      displayName: '01 稿纸提取',
      stageDir: locateDir,
      imagePath,
      keyOutputs: {
        paperBoundsImagePath: path.join(locateDir, '01_1_纸张范围检测', '01_1_纸张范围检测图.png'),
        paperCropImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
        metaPath: locateMetaPath
      },
      processChain: [
        '原始待处理图片 -> 01_1_纸张范围检测图',
        '01_1_纸张范围检测图 -> 01_2_稿纸裁切图'
      ],
      stepDirs: a4Extract.stepDirs || {},
      stepMetaPaths: a4Extract.stepMetaPaths || {}
    });
    if (maxStep <= 1) {
      return finish({
        completedStep: 1,
        stoppedAtStep: 1,
        preprocessing: null,
        outputs: {
          preprocess: {
            locateDir,
            locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            locateMetaPath,
            locateStepMetaPaths: a4Extract.stepMetaPaths || {},
            locateStepDirs: a4Extract.stepDirs || {},
            locateStageInfoPath
          }
        }
      });
    }

    const locatePerspectiveInputPath = a4Extract.paperCropOutputPath || locatePaperCropPath;
    const a4Rectify = await a4RectifyPlugin.execute({
      imagePath: locatePerspectiveInputPath,
      outputDir: rectifyDir,
      gridRows,
      gridCols,
      gridType,
      preprocessOptions: {
        outputPath: preprocessPath,
        warpedOutputPath: preprocessWarpedPath,
        guideRemovedOutputPath: preprocessGuideRemovedPath,
        neutralGuideRemovedOutputPath: preprocessNeutralGuideRemovedPath,
        outputMetaPath: preprocessMetaPath,
        outputDebugPath: quadDebugPath,
        cropToPaper: false,
        ...preprocessOptions
      }
    });
    const preprocessing = a4Rectify.result;

    const rectifyStageInfoPath = await writeStageInfo(rectifyDir, {
      processNo: '02',
      processName: '02_A4纸张矫正',
      displayName: '02 A4纸张矫正',
      stageDir: rectifyDir,
      imagePath,
      stageInputPath: locatePerspectiveInputPath,
      keyOutputs: {
        inputPath: locatePerspectiveInputPath,
        a4ConstraintMetaPath: rectifyA4ConstraintMetaPath,
        a4ConstraintImagePath: path.join(rectifyDir, '02_0_A4规格约束检测', '02_0_2_A4规格约束检测图.png'),
        preprocessPath,
        warpedPath: preprocessWarpedPath,
        guideRemovedPath: preprocessGuideRemovedPath,
        neutralGuideRemovedPath: preprocessNeutralGuideRemovedPath,
        metaPath: preprocessMetaPath,
        quadMetaPath,
        quadDebugPath
      },
      stepDirs: {
        step02_0: a4Rectify.outputs.step02_0Dir,
        step02_1: a4Rectify.outputs.step02_1Dir,
        step02_2: a4Rectify.outputs.step02_2Dir,
        step02_3: a4Rectify.outputs.step02_3Dir,
        step02_3_1: a4Rectify.outputs.step02_3_1Dir,
        step02_3_2: a4Rectify.outputs.step02_3_2Dir
      },
      stepMetaPaths: {
        step02_0: a4Rectify.outputs.step02_0MetaPath,
        step02_1: a4Rectify.outputs.step02_1MetaPath,
        step02_2: a4Rectify.outputs.step02_2MetaPath,
        step02_3: a4Rectify.outputs.step02_3MetaPath,
        step02_3_1: a4Rectify.outputs.step02_3_1MetaPath,
        step02_3_2: a4Rectify.outputs.step02_3_2MetaPath
      },
      processChain: [
        '01_2_稿纸裁切图 -> 02_0_1_A4内切清边图',
        '02_0_1_A4内切清边图 -> 02_0_2_A4规格约束检测图',
        '02_0_2_A4规格约束检测图 -> 02_1_1_纸张角点调试图',
        '02_1_1_纸张角点调试图 -> 02_2_1_透视矫正图',
        '02_2_1_透视矫正图 -> 02_3_1_1_检测去底纹图',
        '02_3_1_1_检测去底纹图 -> 02_3_2_1_矫正预处理图'
      ]
    });
    if (maxStep <= 2) {
      return finish({
        completedStep: 2,
        stoppedAtStep: 2,
        preprocessing,
        outputs: {
          preprocess: {
            locateDir,
            locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            locateMetaPath,
            locateStepMetaPaths: a4Extract.stepMetaPaths || {},
            locateStepDirs: a4Extract.stepDirs || {},
            locateStageInfoPath,
            quadDebugImagePath: quadDebugPath,
            quadMetaPath,
            rectifyDir,
            imagePath: preprocessPath,
            paperCropImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            rectifyA4ConstraintMetaPath,
            warpedImagePath: preprocessWarpedPath,
            guideRemovedImagePath: preprocessGuideRemovedPath,
            neutralGuideRemovedImagePath: preprocessNeutralGuideRemovedPath,
            metaPath: preprocessMetaPath,
            debugImagePath: quadDebugPath,
            rectifyStageInfoPath,
            step02MetaPaths: {
              step02_0: a4Rectify.outputs.step02_0MetaPath,
              step02_1: a4Rectify.outputs.step02_1MetaPath,
              step02_2: a4Rectify.outputs.step02_2MetaPath,
              step02_3: a4Rectify.outputs.step02_3MetaPath,
              step02_3_1: a4Rectify.outputs.step02_3_1MetaPath,
              step02_3_2: a4Rectify.outputs.step02_3_2MetaPath
            },
            step02Dirs: {
              step02_0: a4Rectify.outputs.step02_0Dir,
              step02_1: a4Rectify.outputs.step02_1Dir,
              step02_2: a4Rectify.outputs.step02_2Dir,
              step02_3: a4Rectify.outputs.step02_3Dir,
              step02_3_1: a4Rectify.outputs.step02_3_1Dir,
              step02_3_2: a4Rectify.outputs.step02_3_2Dir
            }
          }
        }
      });
    }

    const textRectMeta = await gridOuterRectExtractPlugin.execute({
      baseName,
      preprocessPath,
      preprocessWarpedPath,
      preprocessGuideRemovedPath: preprocessNeutralGuideRemovedPath,
      gridRows,
      gridCols,
      a4Constraint: preprocessing.a4Constraint || null,
      outputDir: textRectDir,
      gridStageMetaPath: preprocessGridStageMetaPath,
      gridStagePreprocessPath: preprocessGridStageReferencePath,
      gridStageMaskPath: preprocessGridBackgroundMaskPath,
      gridStageRectifiedPath: preprocessGridRectifiedPath,
      gridStageRectifiedMetaPath: preprocessGridRectifiedMetaPath,
      textRectMetaPath: textRectBoundsMetaPath,
      textRectAnnotatedPath,
      textRectWarpedPath
    });
    const localizedBoundaryGuides = textRectMeta.localizedBoundaryGuides || null;
    let rectifiedBoundaryGuides = null;
    if (preprocessGridRectifiedPath) {
      const rectifiedMeta = await sharp(preprocessGridRectifiedPath).metadata();
      rectifiedBoundaryGuides = fitBoundaryGuidesToImage(
        localizedBoundaryGuides,
        rectifiedMeta.width || 0,
        rectifiedMeta.height || 0
      );
    }
    const textRectAnnotatedOutputPath = textRectMeta.annotatedImagePath;
    const textRectWarpedOutputPath = textRectMeta.warpedCropPath;
    const gridSegmentationInputOutputPath = textRectMeta.gridSegmentationInputPath;
    if (
      !textRectAnnotatedOutputPath ||
      !textRectWarpedOutputPath ||
      !gridSegmentationInputOutputPath
    ) {
      throw new Error('03阶段未完整产出后续所需文件，禁止回退到预设默认路径');
    }
    const textRectStageInfoPath = await writeStageInfo(textRectDir, {
      processNo: '03',
      processName: '03_总方格大矩形提取',
      displayName: '03 总方格大矩形提取',
      stageDir: textRectDir,
      imagePath,
      stageInputPath: preprocessPath,
      keyOutputs: {
          '02_3_2_1_矫正预处理图': preprocessPath,
          '03_0_方格背景与边界检测.json': preprocessGridStageMetaPath,
          '03_0_1_粗裁剪去外框输入图': preprocessGridStageReferencePath,
          '03_0_2_四角点定位标注图': preprocessGridCornerAnnotatedPath,
          '03_0_4_方格背景Mask图': preprocessGridBackgroundMaskPath,
          '03_0_6_单格切分输入图': preprocessGridRectifiedPath,
          '03_1_总方格候选矩形图': path.join(textRectDir, '03_1_总方格候选矩形', '03_1_总方格候选矩形图.png'),
          '03_2_总方格矩形纠偏图': path.join(textRectDir, '03_2_总方格矩形纠偏', '03_2_总方格矩形纠偏图.png'),
          '03_总方格大矩形提取结果.json': textRectBoundsMetaPath,
          '03_3_1_总方格定位标注图': textRectAnnotatedOutputPath,
          '03_3_2_总方格计数参考图': textRectWarpedOutputPath
      },
      processChain: [
        '02_3_2_1_矫正预处理图 -> 03_0_1_粗裁剪去外框输入图',
        '03_0_1_粗裁剪去外框输入图 -> 03_0_2_四角点定位标注图',
        '03_0_1_粗裁剪去外框输入图 + 02_3_1_1_检测去底纹图(内部输入) -> 03_0_方格背景与边界检测.json',
        '03_0_方格背景与边界检测.json -> 03_0_4_方格背景Mask图',
        '03_0_方格背景与边界检测.json -> 03_0_6_单格切分输入图(四角点透视矫正后)',
        '03_0_6_单格切分输入图 -> 03_1_总方格候选矩形图',
        '03_1_总方格候选矩形图 -> 03_2_总方格矩形纠偏图',
        '03_2_总方格矩形纠偏图 -> 03_3_1_总方格定位标注图',
        '03_0_6_单格切分输入图 + 03_2_总方格矩形纠偏图 -> 03_3_2_总方格计数参考图'
      ],
      stepDirs: textRectMeta.stepDirs || {},
      stepMetaPaths: textRectMeta.stepMetaPaths || {}
    });
    if (maxStep <= 3) {
      return finish({
        completedStep: 3,
        stoppedAtStep: 3,
        preprocessing,
        outputs: {
          preprocess: {
            locateDir,
            locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            locateMetaPath,
            locateStepMetaPaths: a4Extract.stepMetaPaths || {},
            locateStepDirs: a4Extract.stepDirs || {},
            locateStageInfoPath,
            quadDebugImagePath: quadDebugPath,
            quadMetaPath,
            rectifyDir,
            textRectDir,
            textRectMetaPath: textRectBoundsMetaPath,
            textRectStepMetaPaths: textRectMeta.stepMetaPaths || {},
            textRectStepDirs: textRectMeta.stepDirs || {},
            textRectStageInfoPath,
            textRectAnnotatedPath: textRectAnnotatedOutputPath,
            textRectWarpedPath: textRectWarpedOutputPath,
            gridSegmentationInputPath: gridSegmentationInputOutputPath,
            imagePath: preprocessPath,
            paperCropImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            rectifyA4ConstraintMetaPath,
            warpedImagePath: preprocessWarpedPath,
            guideRemovedImagePath: preprocessNeutralGuideRemovedPath,
            guideRemovedDisplayImagePath: preprocessGuideRemovedPath,
            gridBackgroundMaskImagePath: preprocessGridBackgroundMaskPath,
            gridRectifiedImagePath: preprocessGridRectifiedPath,
            gridRectifiedMetaPath: preprocessGridRectifiedMetaPath,
            gridStageMetaPath: preprocessGridStageMetaPath,
            metaPath: preprocessMetaPath,
            debugImagePath: quadDebugPath,
            rectifyStageInfoPath
          }
        }
      });
    }

    let estimatedGrid = null;
    try {
      estimatedGrid = await estimateGridSize(textRectWarpedOutputPath);
    } catch (error) {
      estimatedGrid = preprocessing.gridEstimation || {
        error: error.message
      };
    }

    const useEstimatedGrid = Boolean(
      autoUseEstimatedGrid &&
      (!hasProvidedGridRows || !hasProvidedGridCols) &&
      estimatedGrid &&
      !estimatedGrid.error &&
      estimatedGrid.confidence >= 0.35 &&
      estimatedGrid.estimatedGridRows &&
      estimatedGrid.estimatedGridCols
    );
    const effectiveGridRows = useEstimatedGrid ? estimatedGrid.estimatedGridRows : gridRows;
    const effectiveGridCols = useEstimatedGrid ? estimatedGrid.estimatedGridCols : gridCols;

    await ensureDir(gridCountDir);
    const gridCount = await gridCountAnnotatePlugin.execute({
      imagePath: textRectWarpedOutputPath,
      outputAnnotatedPath: gridCountAnnotatedPath,
      outputMetaPath: gridCountMetaPath,
      outputCarryForwardPath: gridCountCarryForwardPath,
      gridRows: effectiveGridRows,
      gridCols: effectiveGridCols,
      source: useEstimatedGrid ? '自动估计' : '指定值',
      processNo: '04'
    });
    const gridCountStageInfoPath = await writeStageInfo(gridCountDir, {
      processNo: '04',
      processName: '04_方格数量计算标注',
      displayName: '04 总方格数量计算与标注',
      stageDir: gridCountDir,
      imagePath,
      stageInputPath: textRectWarpedOutputPath,
      keyOutputs: {
        inputPath: textRectWarpedOutputPath,
        estimatedImagePath: path.join(gridCountDir, '04_1_方格数量估计', '04_1_方格数量估计图.png'),
        metaPath: gridCountMetaPath,
        annotatedPath: gridCount.outputAnnotatedPath || gridCountAnnotatedPath,
        carryForwardInputPath: gridCount.carryForwardInputPath || gridCountCarryForwardPath
      },
      processChain: [
        '03_3_2_总方格计数参考图 -> 04_1_方格数量估计图',
        '04_1_方格数量估计图 -> 04_2_方格数量标注图',
        '03_3_2_总方格计数参考图 -> 04_3_单格切分输入图'
      ],
      stepDirs: gridCount.stepDirs || {},
      stepMetaPaths: gridCount.stepMetaPaths || {}
    });
    if (maxStep <= 4) {
      return finish({
        completedStep: 4,
        stoppedAtStep: 4,
        preprocessing,
        estimatedGrid,
        effectiveGrid: {
          rows: effectiveGridRows,
          cols: effectiveGridCols,
          source: useEstimatedGrid ? '自动估计' : '指定值'
        },
        gridCount,
        outputs: {
          preprocess: {
            locateDir,
            locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            locateMetaPath,
            locateStageInfoPath,
            rectifyDir,
            textRectDir,
            textRectMetaPath: textRectBoundsMetaPath,
            textRectStageInfoPath,
            imagePath: preprocessPath,
            rectifyA4ConstraintMetaPath,
            guideRemovedImagePath: preprocessNeutralGuideRemovedPath,
            guideRemovedDisplayImagePath: preprocessGuideRemovedPath,
            gridBackgroundMaskImagePath: preprocessGridBackgroundMaskPath,
            gridRectifiedImagePath: preprocessGridRectifiedPath,
            gridRectifiedMetaPath: preprocessGridRectifiedMetaPath,
            gridStageMetaPath: preprocessGridStageMetaPath,
            metaPath: preprocessMetaPath
          },
          gridCount: {
            dir: gridCountDir,
            annotatedPath: gridCount.outputAnnotatedPath || gridCountAnnotatedPath,
            metaPath: gridCountMetaPath,
            stageInfoPath: gridCountStageInfoPath,
            stepMetaPaths: gridCount.stepMetaPaths || {},
            stepDirs: gridCount.stepDirs || {}
          }
        }
      });
    }

    const segmentationInputImagePath = gridCount.carryForwardInputPath || gridCountCarryForwardPath;
    await ensureDir(segmentationDir);
    const primarySegmentation = await segmentationPlugin.execute({
      imagePath: segmentationInputImagePath,
      sourceStep: inferSegmentationSourceStep(
        segmentationInputImagePath,
        {
          gridCountCarryForwardPath,
          gridRectifiedPath: preprocessGridRectifiedPath,
          gridSegmentationInputPath: gridSegmentationInputOutputPath
        }
      ),
      returnBase64: false,
      outputDir: segmentationCellsDir,
      gridRows: effectiveGridRows,
      gridCols: effectiveGridCols,
      trimContent,
      cropToGrid: false,
      pageBounds,
      boundaryGuides: localizedBoundaryGuides,
      gridGuideMaskPath: null,
      outputPrefix: '05',
      ...segmentationOptions
    });

    const primarySegmentationSource = 'grid_rectified';
    let segmentation = primarySegmentation;
    let segmentationSelection = {
      selectedSource: getSegmentationVariantLabel(primarySegmentationSource),
      selectedImagePath: segmentationInputImagePath,
      quality: await estimateSegmentationQuality(
        segmentationInputImagePath,
        primarySegmentation
      ),
      candidates: []
    };

    const segmentationStageInfoPath = await writeStageInfo(segmentationDir, {
      processNo: '05',
      processName: '05_单格切分',
      displayName: '05 单个方格切分',
      stageDir: segmentationDir,
      imagePath,
      stageInputPath: segmentationSelection.selectedImagePath,
      keyOutputs: {
        inputPath: segmentationSelection.selectedImagePath,
        cellsDir: segmentation.outputs.cellsDir,
        summaryPath: segmentation.outputs.summaryPath,
        debugImagePath: segmentation.debugOutputPath || segmentationDebugPath,
        debugMetaPath: segmentation.debugMetaPath || segmentationDebugMetaPath
      },
      stepDirs: segmentation.outputs.stepDirs || {},
      stepMetaPaths: segmentation.outputs.stepMetaPaths || {}
    });
    if (maxStep <= 5) {
      return finish({
        completedStep: 5,
        stoppedAtStep: 5,
        preprocessing,
        estimatedGrid,
        effectiveGrid: {
          rows: effectiveGridRows,
          cols: effectiveGridCols,
          source: useEstimatedGrid ? '自动估计' : '指定值'
        },
        gridCount,
        segmentation,
        segmentationSelection,
        outputs: {
          preprocess: {
            locateDir,
            locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            locateMetaPath,
            locateStageInfoPath,
            rectifyDir,
            textRectDir,
            textRectMetaPath: textRectBoundsMetaPath,
            textRectStageInfoPath,
            imagePath: preprocessPath,
            rectifyA4ConstraintMetaPath,
            guideRemovedImagePath: preprocessNeutralGuideRemovedPath,
            guideRemovedDisplayImagePath: preprocessGuideRemovedPath,
            gridBackgroundMaskImagePath: preprocessGridBackgroundMaskPath,
            metaPath: preprocessMetaPath
          },
          gridCount: {
            dir: gridCountDir,
            annotatedPath: gridCount.outputAnnotatedPath || gridCountAnnotatedPath,
            carryForwardInputPath: gridCount.carryForwardInputPath || gridCountCarryForwardPath,
            metaPath: gridCountMetaPath,
            stageInfoPath: gridCountStageInfoPath,
            stepMetaPaths: gridCount.stepMetaPaths || {},
            stepDirs: gridCount.stepDirs || {}
          },
          segmentation: {
            cellsDir: segmentation.outputs.cellsDir,
            summaryPath: segmentation.outputs.summaryPath,
            debugImagePath: segmentation.debugOutputPath || segmentationDebugPath,
            debugMetaPath: segmentation.debugMetaPath || segmentationDebugMetaPath,
            stageInfoPath: segmentationStageInfoPath,
            stepDirs: segmentation.outputs.stepDirs || {},
            stepMetaPaths: segmentation.outputs.stepMetaPaths || {}
          }
        }
      });
    }

    await ensureDir(cellLayerDir);
    const cellLayerExtraction = await cellLayerExtractPlugin.execute({
      segmentation,
      inputPath: segmentationSelection.selectedImagePath,
      outputDir: cellLayerOutputDir,
      outputPrefix: '06',
      options: scoringOptions
    });
    const cellLayerStageInfoPath = await writeStageInfo(cellLayerDir, {
      processNo: '06',
      processName: '06_单格背景文字提取',
      displayName: '06 单个方格背景与文字提取',
      stageDir: cellLayerDir,
      imagePath,
      stageInputPath: segmentationSelection.selectedImagePath,
      keyOutputs: {
        inputPath: segmentationSelection.selectedImagePath,
        cellsDir: cellLayerOutputDir,
        summaryPath: cellLayerExtraction.summaryPath || null
      },
      stepDirs: cellLayerExtraction.stepDirs || {}
    });
    if (maxStep <= 6) {
      return finish({
        completedStep: 6,
        stoppedAtStep: 6,
        preprocessing,
        estimatedGrid,
        effectiveGrid: {
          rows: effectiveGridRows,
          cols: effectiveGridCols,
          source: useEstimatedGrid ? '自动估计' : '指定值'
        },
        gridCount,
        segmentation,
        cellLayerExtraction,
        segmentationSelection,
        outputs: {
          preprocess: {
            locateDir,
            locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
            locateMetaPath,
            locateStageInfoPath,
            rectifyDir,
            textRectDir,
            textRectMetaPath: textRectBoundsMetaPath,
            textRectStageInfoPath,
            imagePath: preprocessPath,
            rectifyA4ConstraintMetaPath,
            guideRemovedImagePath: preprocessNeutralGuideRemovedPath,
            guideRemovedDisplayImagePath: preprocessGuideRemovedPath,
            gridBackgroundMaskImagePath: preprocessGridBackgroundMaskPath,
            gridRectifiedImagePath: preprocessGridRectifiedPath,
            gridRectifiedMetaPath: preprocessGridRectifiedMetaPath,
            gridStageMetaPath: preprocessGridStageMetaPath,
            metaPath: preprocessMetaPath
          },
          segmentation: {
            dir: segmentationDir,
            cellsDir: segmentation.outputs.cellsDir,
            summaryPath: segmentation.outputs.summaryPath,
            debugImagePath: segmentation.debugOutputPath || segmentationDebugPath,
            debugMetaPath: segmentation.debugMetaPath || segmentationDebugMetaPath,
            stageInfoPath: segmentationStageInfoPath,
            stepDirs: segmentation.outputs.stepDirs || {},
            stepMetaPaths: segmentation.outputs.stepMetaPaths || {}
          },
          gridCount: {
            dir: gridCountDir,
            annotatedPath: gridCount.outputAnnotatedPath || gridCountAnnotatedPath,
            carryForwardInputPath: gridCount.carryForwardInputPath || gridCountCarryForwardPath,
            metaPath: gridCountMetaPath,
            stageInfoPath: gridCountStageInfoPath,
            stepMetaPaths: gridCount.stepMetaPaths || {},
            stepDirs: gridCount.stepDirs || {}
          },
          cellLayerExtraction: {
            dir: cellLayerDir,
            cellsDir: cellLayerOutputDir,
            stageInfoPath: cellLayerStageInfoPath,
            stepDirs: cellLayerExtraction.stepDirs || {}
          }
        }
      });
    }

    await ensureDir(scoringCellDir);
    await ensureDir(scoringPageRenderDir);
    await ensureDir(scoringResultDir);
    const scoring = await scoringPlugin.execute({
      task_id: task_id || `pipeline-${baseName}`,
      image_id: image_id || baseName,
      imagePath: segmentationSelection.selectedImagePath,
      outputDir: scoringCellDir,
      outputAnnotatedPath: scoringAnnotatedPath,
      outputSummaryPath: scoringSummaryPath,
      target_chars,
      segmentation,
      cellLayerExtraction,
      options: scoringOptions
        ? {
            ...scoringOptions,
            config: {
              ...(scoringOptions.config || {}),
              image: {
                ...((scoringOptions.config && scoringOptions.config.image) || {}),
                grid_type: gridType
              }
            }
          }
        : {
            config: {
              image: {
                grid_type: gridType
              }
            }
          }
    });

    await fs.promises.writeFile(scoringJsonPath, JSON.stringify(scoring, null, 2), 'utf8');
    const scoringStageInfoPath = await writeStageInfo(scoringDir, {
      processNo: '07',
      processName: '07_单格评分',
      displayName: '07 单个方格文字评分',
      stageDir: scoringDir,
      imagePath,
      stageInputPath: segmentationSelection.selectedImagePath,
      keyOutputs: {
        inputPath: segmentationSelection.selectedImagePath,
        cellStepsDir: scoringCellDir,
        cellsRootDir: scoring.cellsRootDir || null,
        pageRenderDir: scoringPageRenderDir,
        pageResultDir: scoringResultDir,
        annotatedImagePath: scoringAnnotatedPath,
        summaryPath: scoringSummaryPath,
        jsonPath: scoringJsonPath
      }
    });

    return finish({
      completedStep: 7,
      outputs: {
        rootDir: outputRootDir,
        fileRootDir,
        preprocess: {
          locateDir,
          locateImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
          locateMetaPath,
          locateStepMetaPaths: a4Extract.stepMetaPaths || {},
          locateStepDirs: a4Extract.stepDirs || {},
          locateStageInfoPath,
          quadDebugImagePath: quadDebugPath,
          quadMetaPath,
          rectifyDir,
          textRectDir,
          textRectMetaPath: textRectBoundsMetaPath,
          textRectStepMetaPaths: textRectMeta.stepMetaPaths || {},
          textRectStepDirs: textRectMeta.stepDirs || {},
          textRectStageInfoPath,
          textRectAnnotatedPath: textRectAnnotatedOutputPath,
          textRectWarpedPath: textRectWarpedOutputPath,
          gridSegmentationInputPath: gridSegmentationInputOutputPath,
          imagePath: preprocessPath,
          paperCropImagePath: a4Extract.paperCropOutputPath || locatePaperCropPath,
          rectifyA4ConstraintMetaPath,
          warpedImagePath: preprocessWarpedPath,
          guideRemovedImagePath: preprocessNeutralGuideRemovedPath,
          guideRemovedDisplayImagePath: preprocessGuideRemovedPath,
          gridBackgroundMaskImagePath: preprocessGridBackgroundMaskPath,
          gridRectifiedImagePath: preprocessGridRectifiedPath,
          gridRectifiedMetaPath: preprocessGridRectifiedMetaPath,
          gridStageMetaPath: preprocessGridStageMetaPath,
          metaPath: preprocessMetaPath,
          debugImagePath: quadDebugPath,
          rectifyStageInfoPath,
          step02MetaPaths: {
            step02_0: a4Rectify.outputs.step02_0MetaPath,
            step02_1: a4Rectify.outputs.step02_1MetaPath,
            step02_2: a4Rectify.outputs.step02_2MetaPath,
            step02_3: a4Rectify.outputs.step02_3MetaPath,
            step02_3_1: a4Rectify.outputs.step02_3_1MetaPath,
            step02_3_2: a4Rectify.outputs.step02_3_2MetaPath
          },
          step02Dirs: {
            step02_0: a4Rectify.outputs.step02_0Dir,
            step02_1: a4Rectify.outputs.step02_1Dir,
            step02_2: a4Rectify.outputs.step02_2Dir,
            step02_3: a4Rectify.outputs.step02_3Dir,
            step02_3_1: a4Rectify.outputs.step02_3_1Dir,
            step02_3_2: a4Rectify.outputs.step02_3_2Dir
          }
        },
        segmentation: {
          cellsDir: segmentation.outputs.cellsDir,
          summaryPath: segmentation.outputs.summaryPath,
          debugImagePath: segmentation.debugOutputPath || segmentationDebugPath,
          debugMetaPath: segmentation.debugMetaPath || segmentationDebugMetaPath,
          stageInfoPath: segmentationStageInfoPath,
          stepDirs: segmentation.outputs.stepDirs || {},
          stepMetaPaths: segmentation.outputs.stepMetaPaths || {}
        },
        gridCount: {
          dir: gridCountDir,
          annotatedPath: gridCount.outputAnnotatedPath || gridCountAnnotatedPath,
          carryForwardInputPath: gridCount.carryForwardInputPath || gridCountCarryForwardPath,
          metaPath: gridCountMetaPath,
          stageInfoPath: gridCountStageInfoPath,
          stepMetaPaths: gridCount.stepMetaPaths || {},
          stepDirs: gridCount.stepDirs || {}
        },
        cellLayerExtraction: {
          dir: cellLayerDir,
          cellsDir: cellLayerOutputDir,
          stageInfoPath: cellLayerStageInfoPath,
          stepDirs: cellLayerExtraction.stepDirs || {}
        },
        scoring: {
          dir: scoringDir,
          cellStepsDir: scoringCellDir,
          pageRenderDir: scoringPageRenderDir,
          pageResultDir: scoringResultDir,
          annotatedImagePath: scoringAnnotatedPath,
          summaryPath: scoringSummaryPath,
          jsonPath: scoringJsonPath,
          stageInfoPath: scoringStageInfoPath,
          cellsRootDir: scoring.cellsRootDir || null
        }
      },
      preprocessing,
      estimatedGrid,
      effectiveGrid: {
        rows: effectiveGridRows,
        cols: effectiveGridCols,
        source: useEstimatedGrid ? '自动估计' : '指定值'
      },
      gridCount,
      segmentation,
      cellLayerExtraction,
      segmentationSelection,
      scoring
    });
  }
}

module.exports = new HanziPipelinePlugin();
