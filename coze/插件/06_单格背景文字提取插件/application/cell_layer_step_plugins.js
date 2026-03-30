const { createCellLayerExportPlugin } = require('../create_cell_layer_export_plugin');

const cellOriginalExportPlugin = createCellLayerExportPlugin({
  name: '06_1_单格原图导出',
  processNo: '06_1',
  processName: '06_1_单格原图导出',
  bufferKey: 'original',
  fileSuffix: '1_单格原图.png',
  defaultSourceStep: '05_4_单格裁切'
});

const cellForegroundMaskPlugin = createCellLayerExportPlugin({
  name: '06_2_单格前景Mask',
  processNo: '06_2',
  processName: '06_2_单格前景Mask',
  bufferKey: 'foregroundMask',
  fileSuffix: '2_单格前景Mask图.png',
  defaultSourceStep: '06_1_单格原图导出'
});

const cellCleanedTextMaskPlugin = createCellLayerExportPlugin({
  name: '06_3_单格清洗文字Mask',
  processNo: '06_3',
  processName: '06_3_单格清洗文字Mask',
  bufferKey: 'cleanedForegroundMask',
  fileSuffix: '3_单格清洗文字Mask图.png',
  defaultSourceStep: '06_2_单格前景Mask'
});

const cellTextOnlyPlugin = createCellLayerExportPlugin({
  name: '06_4_单格文字图',
  processNo: '06_4',
  processName: '06_4_单格文字图',
  bufferKey: 'textOnly',
  fileSuffix: '4_单格文字图.png',
  defaultSourceStep: '06_3_单格清洗文字Mask'
});

const cellBackgroundOnlyPlugin = createCellLayerExportPlugin({
  name: '06_5_单格背景图',
  processNo: '06_5',
  processName: '06_5_单格背景图',
  bufferKey: 'backgroundOnly',
  fileSuffix: '5_单格背景图.png',
  defaultSourceStep: '06_1_单格原图导出'
});

module.exports = {
  cellOriginalExportPlugin,
  cellForegroundMaskPlugin,
  cellCleanedTextMaskPlugin,
  cellTextOnlyPlugin,
  cellBackgroundOnlyPlugin
};
