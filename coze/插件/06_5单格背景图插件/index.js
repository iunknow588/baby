const { createCellLayerExportPlugin } = require('../06_单格背景文字提取插件/create_cell_layer_export_plugin');

module.exports = createCellLayerExportPlugin({
  name: '06_5_单格背景图',
  processNo: '06_5',
  processName: '06_5_单格背景图',
  bufferKey: 'backgroundOnly',
  fileSuffix: '5_单格背景图.png',
  defaultSourceStep: '06_1_单格原图导出'
});
