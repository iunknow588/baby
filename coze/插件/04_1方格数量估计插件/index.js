const fs = require('fs');
const path = require('path');

let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

class GridCountEstimatePlugin {
  constructor() {
    this.name = '04_1_方格数量估计';
    this.version = '1.0.0';
    this.processNo = '04_1';
  }

  async execute(params) {
    const { imagePath, gridRows, gridCols, source = '指定值', outputMetaPath, outputImagePath = null } = params || {};
    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }

    const metadata = await sharp(imagePath).metadata();
    const payload = {
      processNo: this.processNo,
      processName: '04_1_方格数量估计',
      sourceStep: '03_3_总方格裁切标注',
      inputPath: imagePath,
      imagePath,
      outputImagePath,
      gridRows,
      gridCols,
      totalCells: gridRows * gridCols,
      source,
      imageSize: {
        width: metadata.width,
        height: metadata.height
      }
    };

    if (outputImagePath) {
      const svg = `
        <svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="${metadata.width}" height="${metadata.height}" fill="none" stroke="#f59e0b" stroke-width="8"/>
          <rect x="16" y="16" width="${Math.min(360, Math.max(220, metadata.width - 32))}" height="82" rx="10" ry="10" fill="rgba(17,24,39,0.82)"/>
          <text x="34" y="48" font-size="24" fill="#ffffff">04_1 方格数量估计</text>
          <text x="34" y="78" font-size="18" fill="#d1fae5">${gridRows} x ${gridCols} = ${gridRows * gridCols} (${source})</text>
        </svg>
      `;
      await fs.promises.mkdir(path.dirname(outputImagePath), { recursive: true });
      await sharp(imagePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputImagePath);
    }

    if (outputMetaPath) {
      await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
      await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    return payload;
  }
}

module.exports = new GridCountEstimatePlugin();
