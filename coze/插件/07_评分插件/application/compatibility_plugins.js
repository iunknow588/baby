const { scoreCell } = require('./cell_scoring_service');
const { aggregatePageScoring } = require('./page_scoring_aggregation_service');
const {
  CELL_STEP_DEFINITIONS,
  COMPATIBILITY_PLUGIN_DEFINITIONS
} = require('../step_definitions');
const {
  executeCellFeatureExtractionStep,
  executeBlankCellJudgeStep,
  executeCellStructureScoreStep,
  executeCellSimilarityScoreStep,
  executeCellFinalScoreStep
} = require('./cell_scoring_steps');

function createCompatibilityPlugin({ name, version = '1.0.0', processNo = null, execute }) {
  return new class CompatibilityPlugin {
    constructor() {
      this.name = name;
      this.version = version;
      if (processNo) {
        this.processNo = processNo;
      }
    }

    async execute(params) {
      return execute(params);
    }
  }();
}

const singleCellScoringPlugin = createCompatibilityPlugin({
  name: COMPATIBILITY_PLUGIN_DEFINITIONS.singleCellScoring.name,
  execute: async (params = {}) => {
    const { cell, options = {}, outputDir = null } = params;
    if (!cell) {
      throw new Error('cell参数是必需的');
    }
    return scoreCell(cell, options, outputDir);
  }
});

const pageScoringAggregatePlugin = createCompatibilityPlugin({
  name: COMPATIBILITY_PLUGIN_DEFINITIONS.pageScoringAggregate.name,
  execute: async (params = {}) => aggregatePageScoring(params)
});

const cellFeatureExtractPlugin = createCompatibilityPlugin({
  name: CELL_STEP_DEFINITIONS.step07_1.processName,
  processNo: CELL_STEP_DEFINITIONS.step07_1.processNo,
  execute: async (params = {}) => executeCellFeatureExtractionStep(params)
});

const blankCellJudgePlugin = createCompatibilityPlugin({
  name: CELL_STEP_DEFINITIONS.step07_2.processName,
  processNo: CELL_STEP_DEFINITIONS.step07_2.processNo,
  execute: async (params = {}) => executeBlankCellJudgeStep(params)
});

const cellStructureScorePlugin = createCompatibilityPlugin({
  name: CELL_STEP_DEFINITIONS.step07_3.processName,
  processNo: CELL_STEP_DEFINITIONS.step07_3.processNo,
  execute: async (params = {}) => executeCellStructureScoreStep(params)
});

const cellSimilarityScorePlugin = createCompatibilityPlugin({
  name: CELL_STEP_DEFINITIONS.step07_4.processName,
  processNo: CELL_STEP_DEFINITIONS.step07_4.processNo,
  execute: async (params = {}) => executeCellSimilarityScoreStep(params)
});

const cellFinalScorePlugin = createCompatibilityPlugin({
  name: CELL_STEP_DEFINITIONS.step07_5.processName,
  processNo: CELL_STEP_DEFINITIONS.step07_5.processNo,
  execute: async (params = {}) => executeCellFinalScoreStep(params)
});

module.exports = {
  singleCellScoringPlugin,
  pageScoringAggregatePlugin,
  cellFeatureExtractPlugin,
  blankCellJudgePlugin,
  cellStructureScorePlugin,
  cellSimilarityScorePlugin,
  cellFinalScorePlugin
};
