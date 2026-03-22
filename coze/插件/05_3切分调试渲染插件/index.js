let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

class SegmentationDebugRenderPlugin {
  constructor() {
    this.name = '05_3_切分调试渲染';
    this.version = '1.0.0';
    this.processNo = '05_3';
  }

  async execute(params) {
    const { imageInput, debugOutputPath, debugData } = params || {};
    if (!imageInput || !debugOutputPath || !debugData) {
      throw new Error('imageInput/debugOutputPath/debugData参数是必需的');
    }

    const image = sharp(imageInput).ensureAlpha();
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;
    const overlays = [];

    const addLine = (x1, y1, x2, y2, color, strokeWidth = 3, dashArray = null) => {
      const dash = dashArray ? `stroke-dasharray="${dashArray}"` : '';
      overlays.push({
        input: Buffer.from(`
          <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${strokeWidth}" ${dash}/>
          </svg>
        `),
        top: 0,
        left: 0
      });
    };

    const addRect = (box, color, strokeWidth = 4) => {
      overlays.push({
        input: Buffer.from(`
          <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>
          </svg>
        `),
        top: 0,
        left: 0
      });
    };

    const addLabel = (x, y, text, color) => {
      const safeText = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      overlays.push({
        input: Buffer.from(`
          <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect x="${x}" y="${y}" width="220" height="24" rx="4" ry="4" fill="${color}" fill-opacity="0.85"/>
            <text x="${x + 8}" y="${y + 17}" font-family="sans-serif" font-size="14" fill="white">${safeText}</text>
          </svg>
        `),
        top: 0,
        left: 0
      });
    };

    const isBoundaryGuideMode = debugData.selectedBoundaryMode === '边界引导';
    const primaryVerticalColor = isBoundaryGuideMode ? '#0f766e' : '#2563eb';
    const primaryHorizontalColor = isBoundaryGuideMode ? '#7c3aed' : '#dc2626';
    const primaryStrokeWidth = isBoundaryGuideMode ? 5 : 4;

    if (debugData.gridBounds) addRect(debugData.gridBounds, '#22c55e', 5);
    for (const center of debugData.verticalCandidates || []) addLine(center, 0, center, height, '#f59e0b', 2, '8 8');
    for (const center of debugData.verticalLines || []) addLine(center, 0, center, height, primaryVerticalColor, primaryStrokeWidth);
    for (const center of debugData.outerRectVerticalLines || []) addLine(center, 0, center, height, '#059669', 2, '10 6');
    for (const center of debugData.profileVerticalLines || []) addLine(center, 0, center, height, '#14b8a6', 2, '4 6');
    for (const center of debugData.horizontalLines || []) addLine(0, center, width, center, primaryHorizontalColor, primaryStrokeWidth);
    for (const center of debugData.outerRectHorizontalLines || []) addLine(0, center, width, center, '#16a34a', 2, '10 6');
    for (const center of debugData.horizontalLinesBeforeCorrection || []) addLine(0, center, width, center, '#fb7185', 2, '12 8');
    for (const center of debugData.leftHorizontalLines || []) addLine(0, center, Math.round(width * 0.18), center, '#0f766e', 3, '6 6');
    for (const center of debugData.rightHorizontalLines || []) addLine(Math.round(width * 0.82), center, width, center, '#7c3aed', 3, '6 6');
    for (const center of debugData.sideConsensusHorizontalLines || []) addLine(0, center, width, center, '#0891b2', 2, '10 8');
    for (const center of debugData.profileHorizontalLines || []) addLine(0, center, width, center, '#8b5cf6', 2, '4 6');
    for (const correction of debugData.horizontalCorrections || []) {
      addLabel(Math.max(16, Math.round(width * 0.74)), clamp(correction.to - 12, 40, Math.max(40, height - 40)), `纠偏${correction.boundaryIndex}: ${correction.from}->${correction.to}`, '#0f766e');
    }
    for (const box of debugData.pageBoxes || []) addRect(box, '#111827', 2);

    addLabel(16, 16, `回退切分: ${debugData.fallbackUsed ? '是' : '否'}`, debugData.fallbackUsed ? '#dc2626' : '#15803d');
    addLabel(16, 48, `纠偏次数: ${(debugData.horizontalCorrections || []).length}`, (debugData.horizontalCorrections || []).length ? '#0f766e' : '#475569');
    addLabel(16, 80, `切分模式: ${debugData.selectedBoundaryMode || '未知'}`, isBoundaryGuideMode ? '#0f766e' : '#1d4ed8');
    addLabel(16, 112, '图例: 橙色=候选线', '#92400e');
    addLabel(16, 144, isBoundaryGuideMode ? '引导竖横线=深青/紫' : '选中竖横线=蓝/红', isBoundaryGuideMode ? '#0f766e' : '#1d4ed8');
    addLabel(16, 176, '绿色虚线=外框锚线', '#166534');
    addLabel(16, 208, '青/粉=轮廓或纠偏前', '#475569');

    await image.composite(overlays).png().toFile(debugOutputPath);
    return { processNo: this.processNo, processName: '05_3_切分调试渲染', debugOutputPath };
  }
}

module.exports = new SegmentationDebugRenderPlugin();
