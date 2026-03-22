const fs = require('fs');
const path = require('path');

class CellForegroundMaskPlugin {
  constructor() {
    this.name = '06_2_单格前景Mask';
    this.version = '1.0.0';
    this.processNo = '06_2';
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
    if (!cellDir || !baseName || !layers?.buffers?.foregroundMask) {
      throw new Error('cellDir/baseName/layers.buffers.foregroundMask 参数是必需的');
    }
    const outputPath = path.join(cellDir, `${baseName}_2_单格前景Mask图.png`);
    await fs.promises.mkdir(cellDir, { recursive: true });
    await fs.promises.writeFile(outputPath, layers.buffers.foregroundMask);
    const payload = {
      processNo: this.processNo,
      processName: '06_2_单格前景Mask',
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

module.exports = new CellForegroundMaskPlugin();
