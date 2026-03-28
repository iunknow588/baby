const { executeCellCrop } = require('../05_切分插件/domain/cell_crop');

class CellCropPlugin {
  constructor() {
    this.name = '05_4_单格裁切';
    this.version = '1.0.0';
    this.processNo = '05_4';
  }

  async execute(params) {
    return executeCellCrop({
      ...params,
      processNo: this.processNo,
      processName: this.name
    });
  }
}

module.exports = new CellCropPlugin();
