const { renderGridDebugImage } = require('../05_切分插件/presentation/debug_render');

class SegmentationDebugRenderPlugin {
  constructor() {
    this.name = '05_3_切分调试渲染';
    this.version = '1.0.0';
    this.processNo = '05_3';
  }

  async execute(params) {
    const { imageInput, debugOutputPath, debugData } = params || {};
    if (!imageInput || !debugOutputPath || !debugData) {
      throw new Error('imageInput/debugOutputPath/debugData参数是必需的');
    }

    await renderGridDebugImage(imageInput, debugOutputPath, debugData);
    return { processNo: this.processNo, processName: '05_3_切分调试渲染', debugOutputPath };
  }
}

module.exports = new SegmentationDebugRenderPlugin();
