const fs = require('fs');
const path = require('path');
const gridRectCandidatePlugin = require('../03_1总方格候选矩形插件/index');
const gridRectAdjustPlugin = require('../03_2总方格矩形纠偏插件/index');
const gridRectCropAnnotatePlugin = require('../03_3总方格裁切标注插件/index');
const gridBoundaryLocalizePlugin = require('../03_0方格边界局部化插件/index');
const { extractGridArtifactsFromWarpedImages } = require('../00_预处理插件/paper_preprocess');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

function chooseSegmentationInputPath(gridStage) {
  return gridStage.gridRectifiedOutputPath || null;
}

function buildCornerLocalizationResult(gridStage) {
  const detection = gridStage?.gridBoundaryDetection || null;
  return {
    source: detection?.source || '四角点定位',
    annotationPath: detection?.annotationPath || null,
    corners: detection?.corners || null,
    cornerAnchors: detection?.cornerAnchors || null
  };
}

function buildGridGuideDiagnostics(gridStage) {
  const detection = gridStage?.gridBoundaryDetection || null;
  return {
    note: '内部均分线/切分参考线仅用于角点质量诊断与后续步骤，不属于 03_0 四角点定位主结果。',
    rawGuides: detection?.rawGuides || null,
    normalizedGuides: detection?.guides || null,
    gridRectificationGuides: gridStage?.gridRectification?.guides || null,
    guideConstraintRepair: gridStage?.guideConstraintRepair || null,
    topGuideConfirmation: gridStage?.topGuideConfirmation || null,
    cornerRefinement: gridStage?.cornerRefinement || null,
    realBoundaryRefinement: gridStage?.realBoundaryRefinement || null
  };
}

class GridOuterRectExtractPlugin {
  constructor() {
    this.name = '03_总方格大矩形提取';
    this.version = '1.0.0';
  }

  async execute(params) {
    const {
      baseName,
      preprocessPath,
      preprocessWarpedPath,
      preprocessGuideRemovedPath,
      gridRows = 11,
      gridCols = 7,
      a4Constraint = null,
      outputDir,
      gridStageMetaPath,
      gridStagePreprocessPath,
      gridStageMaskPath,
      gridStageRectifiedPath,
      gridStageRectifiedMetaPath,
      textRectMetaPath,
      textRectAnnotatedPath,
      textRectWarpedPath
    } = params || {};

    if (!preprocessPath || !preprocessWarpedPath || !preprocessGuideRemovedPath) {
      throw new Error('03阶段输入图参数不完整');
    }
    await fs.promises.mkdir(outputDir, { recursive: true });
    const step03_0Dir = path.join(outputDir, '03_0_方格背景与边界检测');
    const step03_0_1Dir = path.join(step03_0Dir, '03_0_1_粗裁剪去外框输入');
    const step03_0_2Dir = path.join(step03_0Dir, '03_0_2_四角点定位标注');
    const step03_0_4Dir = path.join(step03_0Dir, '03_0_4_方格背景Mask');
    const step03_0_6Dir = path.join(step03_0Dir, '03_0_6_单格切分输入');
    const step03_1Dir = path.join(outputDir, '03_1_总方格候选矩形');
    const step03_2Dir = path.join(outputDir, '03_2_总方格矩形纠偏');
    const step03_3Dir = path.join(outputDir, '03_3_总方格裁切标注');
    const step03_3_1Dir = path.join(step03_3Dir, '03_3_1_总方格定位标注');
    const step03_3_2Dir = path.join(step03_3Dir, '03_3_2_总方格计数参考');
    await fs.promises.mkdir(step03_0Dir, { recursive: true });
    await fs.promises.mkdir(step03_0_1Dir, { recursive: true });
    await fs.promises.mkdir(step03_0_2Dir, { recursive: true });
    await fs.promises.mkdir(step03_0_4Dir, { recursive: true });
    await fs.promises.mkdir(step03_0_6Dir, { recursive: true });
    await fs.promises.mkdir(step03_1Dir, { recursive: true });
    await fs.promises.mkdir(step03_2Dir, { recursive: true });
    await fs.promises.mkdir(step03_3Dir, { recursive: true });
    await fs.promises.mkdir(step03_3_1Dir, { recursive: true });
    await fs.promises.mkdir(step03_3_2Dir, { recursive: true });
    const step03_0MetaPath = gridStageMetaPath || path.join(step03_0Dir, '03_0_方格背景与边界检测.json');
    const step03_1MetaPath = path.join(step03_1Dir, '03_1_总方格候选矩形.json');
    const step03_2MetaPath = path.join(step03_2Dir, '03_2_总方格矩形纠偏.json');
    const step03_3MetaPath = path.join(step03_3Dir, '03_3_总方格裁切标注.json');
    const step03_0AnnotatedPath = path.join(step03_0_2Dir, '03_0_2_四角点定位标注图.png');
    const step03_1ImagePath = path.join(step03_1Dir, '03_1_总方格候选矩形图.png');
    const step03_2ImagePath = path.join(step03_2Dir, '03_2_总方格矩形纠偏图.png');

    const gridStage = await extractGridArtifactsFromWarpedImages({
      preprocessInputPath: preprocessPath,
      warpedImagePath: preprocessWarpedPath,
      guideRemovedInputPath: preprocessGuideRemovedPath,
      outputPath: gridStagePreprocessPath || path.join(step03_0_1Dir, '03_0_1_粗裁剪去外框输入图.png'),
      gridAnnotatedOutputPath: step03_0AnnotatedPath,
      gridBackgroundMaskOutputPath: gridStageMaskPath || path.join(step03_0_4Dir, '03_0_4_方格背景Mask图.png'),
      gridRectifiedOutputPath: gridStageRectifiedPath || path.join(step03_0_6Dir, '03_0_6_单格切分输入图.png'),
      gridRectifiedMetaPath: gridStageRectifiedMetaPath || path.join(step03_0_6Dir, '03_0_6_单格切分输入信息.json'),
      gridRows,
      gridCols,
      a4Constraint,
      enableA4GuideConstraint: false,
      processNo: '03'
    });
    const gridStagePayload = {
      processNo: '03_0',
      processName: '03_0_方格背景与边界检测',
      inputPaths: {
        preprocessInputPath: preprocessPath,
        warpedInputPath: preprocessWarpedPath,
        guideRemovedInputPath: preprocessGuideRemovedPath
      },
      outputPaths: {
        preprocessPath: gridStage.outputPath,
        annotatedPath: gridStage.gridBoundaryDetection?.annotationPath || null,
        guideRemovedInputPath: preprocessGuideRemovedPath,
        maskPath: gridStage.gridBackgroundMaskOutputPath,
        gridRectifiedPath: gridStage.gridRectifiedOutputPath || null,
        gridRectifiedSourceStep: gridStage.gridRectifiedSourceStep || null,
        gridRectifiedMetaPath: gridStageRectifiedMetaPath || path.join(step03_0_6Dir, '03_0_6_单格切分输入信息.json')
      },
      diagnosticsNote: '03_0_1 为粗裁剪去外框输入图，只负责把外层黑框裁掉并作为后续唯一输入；03_0_2 仅负责四角点定位。03阶段已禁用A4约束，03_0_6 透视矫正以已确认四角点为主，内部均分线仅作诊断辅助。',
      outerFrameCleanup: gridStage.outerFrameCleanup || null,
      cornerLocalization: buildCornerLocalizationResult(gridStage),
      gridGuideDiagnostics: buildGridGuideDiagnostics(gridStage),
      gridRectification: gridStage.gridRectification || null,
      correctedGridRectified: gridStage.correctedGridRectified || null,
      gridBoundaryDetection: {
        note: '兼容旧字段，后续分析请优先使用 cornerLocalization 与 gridGuideDiagnostics。',
        source: gridStage.gridBoundaryDetection?.source || null,
        annotationPath: gridStage.gridBoundaryDetection?.annotationPath || null,
        corners: gridStage.gridBoundaryDetection?.corners || null,
        cornerAnchors: gridStage.gridBoundaryDetection?.cornerAnchors || null
      }
    };
    const step03_0PreprocessPath = gridStage.outputPath;
    const step03_0MaskPath = gridStage.gridBackgroundMaskOutputPath;
    const segmentationInputPath = chooseSegmentationInputPath(gridStage);
    if (!step03_0PreprocessPath || !step03_0MaskPath || !segmentationInputPath) {
      throw new Error('03_0 必须先产出四角点矫正后的单格切分输入图，03_1/03_2/03_3 禁止回退到未矫正图');
    }
    const segmentationMode = 'passthrough';
    const candidateInputPath = segmentationInputPath;
    const candidateMaskPath = null;
    const passthroughImageInfo = await sharp(segmentationInputPath).metadata();
    const passthroughBounds = {
      left: 0,
      top: 0,
      width: passthroughImageInfo.width || 0,
      height: passthroughImageInfo.height || 0,
      source: '03_0_6_单格切分输入直通'
    };

    const candidate = await gridRectCandidatePlugin.execute({
      preprocessImagePath: candidateInputPath,
      maskPath: candidateMaskPath,
      gridBoundaryDetection: null,
      gridRectification: null,
      explicitBounds: passthroughBounds,
      explicitSourceMethod: '03_0_6_单格切分输入图直通',
      explicitSourceStep: '03_0_6_单格切分输入',
      outputImagePath: step03_1ImagePath
    });
    const adjusted = await gridRectAdjustPlugin.execute({
      bounds: candidate.bounds,
      imageInfo: candidate.imageInfo,
      gridRectification: gridStage.gridRectification || null,
      inputPath: step03_1ImagePath,
      outputImagePath: step03_2ImagePath
    });
    const cropResult = await gridRectCropAnnotatePlugin.execute({
      baseName,
      bounds: adjusted.bounds,
      preprocessWarpedPath,
      preprocessPath: step03_0PreprocessPath,
      gridSegmentationInputPath: segmentationInputPath,
      preprocessGridBackgroundMaskPath: step03_0MaskPath,
      segmentationMode,
      annotationInputPath: step03_2ImagePath,
      annotatedPath: path.join(step03_3_1Dir, path.basename(textRectAnnotatedPath)),
      warpedCropPath: path.join(step03_3_2Dir, path.basename(textRectWarpedPath))
    });
    const localizedBoundaryGuides = gridStage.gridBoundaryDetection?.guides
      ? gridBoundaryLocalizePlugin.execute({ guides: gridStage.gridBoundaryDetection.guides, bounds: adjusted.bounds })
      : null;
    const finalBounds = cropResult.bounds || adjusted.bounds;
    const finalSourceImageSize = cropResult.sourceImageSize || {
      width: candidate.imageInfo.width,
      height: candidate.imageInfo.height
    };

    const payload = {
      processNo: '03',
      processName: '03_总方格大矩形提取',
      baseName,
      cornerAnchors: gridStage.gridBoundaryDetection?.cornerAnchors || null,
      cornerLocalization: buildCornerLocalizationResult(gridStage),
      gridGuideDiagnostics: buildGridGuideDiagnostics(gridStage),
      inputPaths: {
        step03_0PreprocessInputPath: preprocessPath,
        step03_0WarpedInputPath: preprocessWarpedPath,
        step03_0GuideRemovedInputPath: preprocessGuideRemovedPath,
        step03_1InputPath: candidateInputPath,
        step03_1MaskPath: candidateMaskPath,
        step03_2InputPath: step03_1ImagePath,
        step03_3WarpedInputPath: preprocessWarpedPath,
        step03_3PreprocessedInputPath: step03_1ImagePath,
        step03_3SegmentationInputPath: segmentationInputPath,
        step03_3MaskInputPath: step03_0MaskPath
      },
      sourceMethod: candidate.sourceMethod,
      adjusted: adjusted.adjusted,
      bounds: finalBounds,
      sourceImageSize: finalSourceImageSize,
      areaRatio: Number(((finalBounds.width * finalBounds.height) / Math.max(1, finalSourceImageSize.width * finalSourceImageSize.height)).toFixed(4)),
      diagnostics: adjusted.diagnostics,
      adjustment: adjusted.adjustment || null,
      gridRectificationGuides: gridStage.gridRectification?.guides || null,
      gridRectifiedSourceStep: gridStage.gridRectifiedSourceStep || null,
      gridBoundaryDetection: {
        note: '兼容旧字段，后续分析请优先使用 cornerLocalization 与 gridGuideDiagnostics。',
        source: gridStage.gridBoundaryDetection?.source || null,
        annotationPath: gridStage.gridBoundaryDetection?.annotationPath || null,
        corners: gridStage.gridBoundaryDetection?.corners || null,
        cornerAnchors: gridStage.gridBoundaryDetection?.cornerAnchors || null
      },
      localizedBoundaryGuides,
      steps: {
        step03_0: gridStagePayload,
        step03_1: candidate,
        step03_2: adjusted,
        step03_3: cropResult
      },
      stepDirs: {
        step03_0: step03_0Dir,
        step03_0_1: step03_0_1Dir,
        step03_0_2: step03_0_2Dir,
        step03_0_4: step03_0_4Dir,
        step03_0_6: step03_0_6Dir,
        step03_1: step03_1Dir,
        step03_2: step03_2Dir,
        step03_3: step03_3Dir,
        step03_3_1: step03_3_1Dir,
        step03_3_2: step03_3_2Dir
      },
      stepMetaPaths: {
        step03_0: step03_0MetaPath,
        step03_1: step03_1MetaPath,
        step03_2: step03_2MetaPath,
        step03_3: step03_3MetaPath
      },
      annotatedImagePath: cropResult.annotatedPath,
      warpedCropPath: cropResult.warpedCropPath,
      gridSegmentationInputPath: cropResult.gridSegmentationInputPath,
      gridSegmentationInputGenerated: cropResult.gridSegmentationInputGenerated,
      segmentationInputPath,
      segmentationMode,
      显示信息: {
        阶段编号: '03',
        阶段名称: '03_总方格大矩形提取',
        输入文件: {
          矫正预处理图: preprocessPath,
          透视矫正图: preprocessWarpedPath,
          检测去底纹图: preprocessGuideRemovedPath
        },
        输出文件: {
          '03_0_1_粗裁剪去外框输入图': gridStage.outputPath,
          '03_0_2_四角点定位标注图': gridStage.gridBoundaryDetection?.annotationPath || null,
          '03_0_4_方格背景Mask图': gridStage.gridBackgroundMaskOutputPath,
          '03_0_6_单格切分输入图': gridStage.gridRectifiedOutputPath || null,
          '03_3_1_总方格定位标注图': cropResult.annotatedPath,
          '03_3_2_总方格计数参考图': cropResult.warpedCropPath
        },
        边界来源: candidate.sourceMethod,
        是否纠偏: adjusted.adjusted
      }
    };

    await fs.promises.writeFile(step03_0MetaPath, `${JSON.stringify(gridStagePayload, null, 2)}\n`, 'utf8');
    await fs.promises.writeFile(step03_1MetaPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    await fs.promises.writeFile(step03_2MetaPath, `${JSON.stringify(adjusted, null, 2)}\n`, 'utf8');
    await fs.promises.writeFile(step03_3MetaPath, `${JSON.stringify(cropResult, null, 2)}\n`, 'utf8');
    await fs.promises.writeFile(textRectMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }
}

module.exports = new GridOuterRectExtractPlugin();
