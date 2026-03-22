const fs = require('fs');
const path = require('path');

class CellBackgroundOnlyPlugin {
  constructor() {
    this.name = '06_5_单格背景图';
    this.version = '1.0.0';
    this.processNo = '06_5';
  }

  async execute(params) {
    const {
      cellDir,
      baseName,
      layers,
      inputPath = null,
      sourceStep = '06_1_单格原图导出',
      outputMetaPath = null
    } = params || {};
    if (!cellDir || !baseName || !layers?.buffers?.backgroundOnly) {
      throw new Error('cellDir/baseName/layers.buffers.backgroundOnly 参数是必需的');
    }
    const outputPath = path.join(cellDir, `${baseName}_5_单格背景图.png`);
    await fs.promises.mkdir(cellDir, { recursive: true });
    await fs.promises.writeFile(outputPath, layers.buffers.backgroundOnly);
    const payload = {
      processNo: this.processNo,
      processName: '06_5_单格背景图',
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

module.exports = new CellBackgroundOnlyPlugin();
