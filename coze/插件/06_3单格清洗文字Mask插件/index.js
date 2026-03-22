const fs = require('fs');
const path = require('path');

class CellCleanedTextMaskPlugin {
  constructor() {
    this.name = '06_3_单格清洗文字Mask';
    this.version = '1.0.0';
    this.processNo = '06_3';
  }

  async execute(params) {
    const {
      cellDir,
      baseName,
      layers,
      inputPath = null,
      sourceStep = '06_2_单格前景Mask',
      outputMetaPath = null
    } = params || {};
    if (!cellDir || !baseName || !layers?.buffers?.cleanedForegroundMask) {
      throw new Error('cellDir/baseName/layers.buffers.cleanedForegroundMask 参数是必需的');
    }
    const outputPath = path.join(cellDir, `${baseName}_3_单格清洗文字Mask图.png`);
    await fs.promises.mkdir(cellDir, { recursive: true });
    await fs.promises.writeFile(outputPath, layers.buffers.cleanedForegroundMask);
    const payload = {
      processNo: this.processNo,
      processName: '06_3_单格清洗文字Mask',
      sourceStep,
      inputPath,
      outputPath
    };
    if (outputMetaPath) {
      await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    return payload;
  }
}

module.exports = new CellCleanedTextMaskPlugin();
