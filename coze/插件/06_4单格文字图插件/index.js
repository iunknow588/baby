const { createCellLayerExportPlugin } = require('../06_单格背景文字提取插件/create_cell_layer_export_plugin');

module.exports = createCellLayerExportPlugin({
  name: '06_4_单格文字图',
  processNo: '06_4',
  processName: '06_4_单格文字图',
  bufferKey: 'textOnly',
  fileSuffix: '4_单格文字图.png',
  defaultSourceStep: '06_3_单格清洗文字Mask'
});
