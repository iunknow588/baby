const { createCellLayerExportPlugin } = require('../06_单格背景文字提取插件/create_cell_layer_export_plugin');

module.exports = createCellLayerExportPlugin({
  name: '06_2_单格前景Mask',
  processNo: '06_2',
  processName: '06_2_单格前景Mask',
  bufferKey: 'foregroundMask',
  fileSuffix: '2_单格前景Mask图.png',
  defaultSourceStep: '06_1_单格原图导出'
});
