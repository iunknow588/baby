const fs = require('fs');
const path = require('path');

class CellTextOnlyPlugin {
  constructor() {
    this.name = '06_4_单格文字图';
    this.version = '1.0.0';
    this.processNo = '06_4';
  }

  async execute(params) {
    const {
      cellDir,
      baseName,
      layers,
      inputPath = null,
      sourceStep = '06_3_单格清洗文字Mask',
      outputMetaPath = null
    } = params || {};
    if (!cellDir || !baseName || !layers?.buffers?.textOnly) {
      throw new Error('cellDir/baseName/layers.buffers.textOnly 参数是必需的');
    }
    const outputPath = path.join(cellDir, `${baseName}_4_单格文字图.png`);
    await fs.promises.mkdir(cellDir, { recursive: true });
    await fs.promises.writeFile(outputPath, layers.buffers.textOnly);
    const payload = {
      processNo: this.processNo,
      processName: '06_4_单格文字图',
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

module.exports = new CellTextOnlyPlugin();
