const fs = require('fs');
const path = require('path');

function createCellLayerExportPlugin({
  name,
  version = '1.0.0',
  processNo,
  processName,
  bufferKey,
  fileSuffix,
  defaultSourceStep
}) {
  return new class CellLayerExportPlugin {
    constructor() {
      this.name = name;
      this.version = version;
      this.processNo = processNo;
    }

    async execute(params) {
      const {
        cellDir,
        baseName,
        layers,
        inputPath = null,
        sourceStep = defaultSourceStep,
        outputMetaPath = null
      } = params || {};
      const buffer = layers?.buffers?.[bufferKey];

      if (!cellDir || !baseName || !buffer) {
        throw new Error(`cellDir/baseName/layers.buffers.${bufferKey} 参数是必需的`);
      }

      const outputPath = path.join(cellDir, `${baseName}_${fileSuffix}`);
      await fs.promises.mkdir(cellDir, { recursive: true });
      await fs.promises.writeFile(outputPath, buffer);

      const payload = {
        processNo: this.processNo,
        processName,
        sourceStep,
        inputPath,
        outputPath
      };

      if (outputMetaPath) {
        await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      }

      return payload;
    }
  }();
}

module.exports = {
  createCellLayerExportPlugin
};
