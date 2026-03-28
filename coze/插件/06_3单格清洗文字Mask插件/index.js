const { createCellLayerExportPlugin } = require('../06_单格背景文字提取插件/create_cell_layer_export_plugin');

module.exports = createCellLayerExportPlugin({
  name: '06_3_单格清洗文字Mask',
  processNo: '06_3',
  processName: '06_3_单格清洗文字Mask',
  bufferKey: 'cleanedForegroundMask',
  fileSuffix: '3_单格清洗文字Mask图.png',
  defaultSourceStep: '06_2_单格前景Mask'
});
