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

  buildCornerDebugSvg(width, height, cornerPayload) {
    const toPolygon = (points, stroke, dashArray = '', label = '') => {
      if (!Array.isArray(points) || points.length !== 4) return '';
      const normalized = points
        .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : null)
        .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
      if (normalized.length !== 4) return '';
      const polygon = normalized.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ');
      const labelPoint = normalized[0];
      return `
        <polygon points="${polygon}" fill="none" stroke="${stroke}" stroke-width="6" ${dashArray ? `stroke-dasharray="${dashArray}"` : ''}/>
        ${label ? `<text x="${Math.round(labelPoint[0]) + 10}" y="${Math.max(24, Math.round(labelPoint[1]) - 10)}" font-size="22" fill="${stroke}">${label}</text>` : ''}
      `;
    };

    const selectedCorners = cornerPayload?.paperCorners || null;
    const roughCorners = cornerPayload?.roughPaperCorners || null;
    const refinedCorners = cornerPayload?.refinedPaperCorners || null;
    const selection = cornerPayload?.cornerSelection || null;

    return `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        ${toPolygon(roughCorners, '#22c55e', '16 10', 'rough')}
        ${toPolygon(refinedCorners, '#38bdf8', '12 8', 'refined')}
        ${toPolygon(selectedCorners, '#ef4444', '', 'selected')}
        <rect x="18" y="18" width="${Math.min(720, Math.max(340, width - 36))}" height="144" rx="12" ry="12" fill="rgba(17,24,39,0.84)"/>
        <text x="34" y="50" font-size="24" fill="#ffffff">02_1 纸张角点检测</text>
        <text x="34" y="82" font-size="18" fill="#fde68a">当前输入=02_0_2_A4规格约束检测图</text>
        <text x="34" y="110" font-size="18" fill="#d1fae5">输出=02_1_1_纸张角点调试图</text>
        <text x="34" y="138" font-size="18" fill="#93c5fd">角点选择=${selection?.selected || 'unknown'} ${selection?.reason ? `(${selection.reason})` : ''}</text>
      </svg>
    `;
  }

  async renderCornerDebugImage(baseImagePath, outputImagePath, cornerPayload) {
    if (!baseImagePath || !outputImagePath || !fs.existsSync(baseImagePath)) {
      return;
    }
    const baseMeta = await sharp(baseImagePath).metadata();
    const width = baseMeta.width || 0;
    const height = baseMeta.height || 0;
    if (width <= 0 || height <= 0) {
      return;
    }
    const svg = this.buildCornerDebugSvg(width, height, cornerPayload);
    await sharp(baseImagePath)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toFile(outputImagePath);
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
    const a4ConstraintImagePath = path.join(step02_0Dir, '02_0_2_A4规格约束检测图.png');
    const a4ConstraintMetaPath = path.join(step02_0Dir, '02_0_A4规格约束检测.json');
    const a4CleanedInputPath = path.join(step02_0Dir, '02_0_1_A4内切清边图.png');
    const outputDebugPath = path.join(step02_1Dir, '02_1_1_纸张角点调试图.png');
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
    await this.renderCornerDebugImage(
      fs.existsSync(a4ConstraintImagePath) ? a4ConstraintImagePath : effectiveImagePath,
      outputDebugPath,
      step02_1
    );
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
