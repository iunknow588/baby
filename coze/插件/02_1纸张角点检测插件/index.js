const fs = require('fs');
const path = require('path');

function buildFullFrameCorners(preprocessResult) {
  const paperBounds = preprocessResult.paperBounds || null;
  if (!paperBounds) {
    return null;
  }
  const left = Number(paperBounds.left || 0);
  const top = Number(paperBounds.top || 0);
  const width = Number(paperBounds.width || 0);
  const height = Number(paperBounds.height || 0);
  if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) {
    return null;
  }
  const right = left + width;
  const bottom = top + height;
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom]
  ];
}

class PaperCornerDetectPlugin {
  constructor() {
    this.name = '02_1_纸张角点检测';
    this.version = '1.0.0';
    this.processNo = '02_1';
  }

  async execute(params) {
    const { imagePath, preprocessResult, outputMetaPath } = params || {};
    if (!imagePath || !preprocessResult || !outputMetaPath) {
      throw new Error('imagePath/preprocessResult/outputMetaPath 参数是必需的');
    }

    const resolvedPaperCorners = preprocessResult.paperCorners || buildFullFrameCorners(preprocessResult);
    const resolvedCornerSelection = preprocessResult.cornerSelection || (
      resolvedPaperCorners
        ? {
            selected: 'full_frame',
            reason: '透视展开后纸面已占满全图，使用全幅四角作为纸张角点'
          }
        : null
    );

    const payload = {
      processNo: this.processNo,
      processName: '02_1_纸张角点检测',
      imagePath,
      paperBounds: preprocessResult.paperBounds || null,
      paperCorners: resolvedPaperCorners || null,
      roughPaperCorners: preprocessResult.roughPaperCorners || null,
      refinedPaperCorners: preprocessResult.refinedPaperCorners || null,
      cornerSelection: resolvedCornerSelection,
      outputDebugPath: preprocessResult.outputDebugPath || null
    };

    await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
    await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }
}

module.exports = new PaperCornerDetectPlugin();
