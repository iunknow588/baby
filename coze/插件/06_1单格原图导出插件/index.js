const fs = require('fs');
const path = require('path');

class CellOriginalExportPlugin {
  constructor() {
    this.name = '06_1_单格原图导出';
    this.version = '1.0.0';
    this.processNo = '06_1';
  }

  async execute(params) {
    const {
      cellDir,
      baseName,
      layers,
      inputPath = null,
      sourceStep = '05_4_单格裁切',
      outputMetaPath = null
    } = params || {};
    if (!cellDir || !baseName || !layers?.buffers?.original) {
      throw new Error('cellDir/baseName/layers.buffers.original 参数是必需的');
    }
    const outputPath = path.join(cellDir, `${baseName}_1_单格原图.png`);
    await fs.promises.mkdir(cellDir, { recursive: true });
    await fs.promises.writeFile(outputPath, layers.buffers.original);
    const payload = {
      processNo: this.processNo,
      processName: '06_1_单格原图导出',
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

module.exports = new CellOriginalExportPlugin();
