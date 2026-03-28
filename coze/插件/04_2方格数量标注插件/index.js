const { renderGridCountAnnotation } = require('../04_方格数量计算标注插件/presentation/grid_count_annotation');

class GridCountRenderPlugin {
  constructor() {
    this.name = '04_2_方格数量标注';
    this.version = '1.0.0';
    this.processNo = '04_2';
  }

  async execute(params) {
    return renderGridCountAnnotation({
      ...params,
      processNo: this.processNo,
      processName: this.name
    });
  }
}

module.exports = new GridCountRenderPlugin();
