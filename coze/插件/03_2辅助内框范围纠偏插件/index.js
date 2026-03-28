let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildTextRectDiagnostics(bounds, imageInfo) {
  const rightMargin = Math.max(0, imageInfo.width - (bounds.left + bounds.width));
  const bottomMargin = Math.max(0, imageInfo.height - (bounds.top + bounds.height));
  const margins = { left: bounds.left, right: rightMargin, top: bounds.top, bottom: bottomMargin };
  const cropRatios = {
    left: Number((margins.left / Math.max(1, imageInfo.width)).toFixed(4)),
    right: Number((margins.right / Math.max(1, imageInfo.width)).toFixed(4)),
    top: Number((margins.top / Math.max(1, imageInfo.height)).toFixed(4)),
    bottom: Number((margins.bottom / Math.max(1, imageInfo.height)).toFixed(4))
  };
  const warnings = [];
  if (cropRatios.left <= 0.01 || cropRatios.right <= 0.01) warnings.push('左右边缘过近');
  if (cropRatios.top <= 0.01 || cropRatios.bottom <= 0.01) warnings.push('上下边缘过近');
  if (bounds.width / Math.max(1, imageInfo.width) >= 0.96) warnings.push('宽度接近整页');
  if (bounds.height / Math.max(1, imageInfo.height) >= 0.96) warnings.push('高度接近整页');
  return { margins, cropRatios, warnings };
}

class GridRectAdjustPlugin {
  constructor() {
    this.name = '03_2辅助_内框范围纠偏';
    this.version = '1.0.0';
    this.processNo = '03_i2';
  }

  async execute(params) {
    const { bounds, imageInfo, gridRectification = null, inputPath = null, outputImagePath = null } = params || {};
    const diagnostics = buildTextRectDiagnostics(bounds, imageInfo);
    const warnings = diagnostics.warnings || [];
    const isRealBoundarySource = typeof bounds.source === 'string' && bounds.source.includes('真实边界检测引导');
    const isMaskSource = bounds.source === 'Mask范围检测';
    const isRectifiedSource = typeof bounds.source === 'string' && bounds.source.includes('方格边界矫正引导');
    const isDirectSegmentationInput = typeof bounds.source === 'string'
      && (
        bounds.source.includes('03_4_字帖内框裁剪与矫正直通')
        || bounds.source.includes('03_4_单格切分输入直通')
        || bounds.source.includes('03_0_6_单格切分输入直通')
        || bounds.source.includes('03_0_6_总方格大矩形提取直通')
      );
    const margins = diagnostics.margins || {};
    const cropRatios = diagnostics.cropRatios || {};
    const edgeTooClose =
      cropRatios.left <= 0.004 ||
      cropRatios.right <= 0.004 ||
      cropRatios.top <= 0.004 ||
      cropRatios.bottom <= 0.004;
    const shouldAdjust =
      (!isDirectSegmentationInput && (
      isMaskSource ||
      isRectifiedSource ||
      (!isRealBoundarySource && (warnings.includes('宽度接近整页') || warnings.includes('高度接近整页'))) ||
      (isRealBoundarySource && edgeTooClose)
      ));

    if (!shouldAdjust) {
      const payload = {
        processNo: this.processNo,
        processName: '03_2辅助_内框范围纠偏',
        sourceStep: '03_1辅助_内框候选范围',
        bounds,
        adjusted: false,
        diagnostics,
        adjustment: {
          skipped: true,
          reason: isDirectSegmentationInput
            ? '03_4 已是内框裁剪后的可直接切分输入图，禁止再次做矩形内缩纠偏'
            : isRealBoundarySource
            ? '真实边界引导结果已保留外层边界，不执行内缩纠偏'
            : '当前内框范围无需纠偏',
          originalBounds: bounds
        }
      };
      if (inputPath && outputImagePath) {
        await this.renderAdjustmentAnnotation(inputPath, outputImagePath, bounds, payload.adjusted);
        payload.outputImagePath = outputImagePath;
      }
      return payload;
    }

    const xPeaks = gridRectification?.guides?.xPeaks || [];
    const yPeaks = gridRectification?.guides?.yPeaks || [];
    const avgXGap = xPeaks.length > 1 ? average(xPeaks.slice(1).map((value, index) => value - xPeaks[index])) : imageInfo.width * 0.08;
    const avgYGap = yPeaks.length > 1 ? average(yPeaks.slice(1).map((value, index) => value - yPeaks[index])) : imageInfo.height * 0.08;
    const insetX = isRealBoundarySource
      ? Math.max(1, Math.min(margins.left, margins.right, Math.round(avgXGap * 0.02)))
      : Math.max(4, Math.round(avgXGap * 0.08));
    const insetY = isRealBoundarySource
      ? Math.max(1, Math.min(margins.top, margins.bottom, Math.round(avgYGap * 0.02)))
      : Math.max(4, Math.round(avgYGap * 0.08));
    const left = clamp(bounds.left + insetX, 0, imageInfo.width - 2);
    const top = clamp(bounds.top + insetY, 0, imageInfo.height - 2);
    const right = clamp(bounds.left + bounds.width - insetX, left + 1, imageInfo.width);
    const bottom = clamp(bounds.top + bounds.height - insetY, top + 1, imageInfo.height);
    const adjustedBounds = { left, top, width: right - left, height: bottom - top, source: `${bounds.source || 'Mask范围检测'}_纠偏后` };

    const payload = {
      processNo: this.processNo,
      processName: '03_2辅助_内框范围纠偏',
      sourceStep: '03_1辅助_内框候选范围',
      bounds: adjustedBounds,
      adjusted: true,
      diagnostics: buildTextRectDiagnostics(adjustedBounds, imageInfo),
      adjustment: { insetX, insetY, originalBounds: bounds }
    };
    if (inputPath && outputImagePath) {
      await this.renderAdjustmentAnnotation(inputPath, outputImagePath, adjustedBounds, payload.adjusted);
      payload.outputImagePath = outputImagePath;
    }
    return payload;
  }

  async renderAdjustmentAnnotation(inputPath, outputPath, bounds, adjusted) {
    const metadata = await sharp(inputPath).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${bounds.left}" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="#22c55e" stroke-width="6"/>
        <rect x="18" y="18" width="${Math.min(460, Math.max(220, width - 36))}" height="86" rx="12" ry="12" fill="rgba(17,24,39,0.84)"/>
        <text x="34" y="50" font-size="24" fill="#ffffff">03_2辅助 内框范围纠偏</text>
        <text x="34" y="80" font-size="18" fill="#d1fae5">${adjusted ? '已根据边缘距离做纠偏' : '当前候选框无需纠偏'}</text>
      </svg>
    `;
    await sharp(inputPath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputPath);
  }
}

module.exports = new GridRectAdjustPlugin();
