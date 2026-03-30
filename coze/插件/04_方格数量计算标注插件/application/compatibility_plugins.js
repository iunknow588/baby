const { estimateGridCount } = require('../domain/grid_count');
const { renderGridCountAnnotation } = require('../presentation/grid_count_annotation');
const { GRID_COUNT_STEP_DEFINITIONS } = require('../step_definitions');

function createCompatibilityPlugin({ stepDefinition, execute }) {
  return new class CompatibilityPlugin {
    constructor() {
      this.name = stepDefinition.processName;
      this.version = '1.0.0';
      this.processNo = stepDefinition.processNo;
    }

    execute(params) {
      return execute(params);
    }
  }();
}

const gridCountEstimatePlugin = createCompatibilityPlugin({
  stepDefinition: GRID_COUNT_STEP_DEFINITIONS.step04_1,
  execute: async (params = {}) => estimateGridCount({
    ...params,
    processNo: GRID_COUNT_STEP_DEFINITIONS.step04_1.processNo,
    processName: GRID_COUNT_STEP_DEFINITIONS.step04_1.processName
  })
});

const gridCountRenderPlugin = createCompatibilityPlugin({
  stepDefinition: GRID_COUNT_STEP_DEFINITIONS.step04_2,
  execute: async (params = {}) => renderGridCountAnnotation({
    ...params,
    processNo: GRID_COUNT_STEP_DEFINITIONS.step04_2.processNo,
    processName: GRID_COUNT_STEP_DEFINITIONS.step04_2.processName
  })
});

module.exports = {
  gridCountEstimatePlugin,
  gridCountRenderPlugin
};
