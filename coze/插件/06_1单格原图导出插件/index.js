const { createCellLayerExportPlugin } = require('../06_单格背景文字提取插件/create_cell_layer_export_plugin');

module.exports = createCellLayerExportPlugin({
  name: '06_1_单格原图导出',
  processNo: '06_1',
  processName: '06_1_单格原图导出',
  bufferKey: 'original',
  fileSuffix: '1_单格原图.png',
  defaultSourceStep: '05_4_单格裁切'
});
