const { roundScore } = require('./shared/math');
const {
  extractFeatures,
  extractCellLayers
} = require('../utils/cell_image_analysis');
const {
  detectBlank,
  blankReasonFromFeatures
} = require('./domain/blank_detection');
const {
  calculateSimilarityScore,
  calculateStructureScore
} = require('./domain/template_scoring');
const {
  calculateStrokeQualityScore,
  calculateStructureAccuracyScore,
  calculateCleanlinessScore,
  buildPenalties,
  levelFromScore
} = require('./domain/rule_scoring');
const {
  buildPageStats,
  buildGridResults
} = require('./presentation/page_result_view');
const { renderAnnotatedPage } = require('./adapters/page_annotation');
const { scoreCell } = require('./application/cell_scoring_service');
const { scoreSegmentation } = require('./application/page_scoring_service');

module.exports = {
  extractFeatures,
  extractCellLayers,
  detectBlank,
  calculateSimilarityScore,
  calculateStructureScore,
  calculateStrokeQualityScore,
  calculateStructureAccuracyScore,
  calculateCleanlinessScore,
  buildPenalties,
  levelFromScore,
  blankReasonFromFeatures,
  roundScore,
  scoreCell,
  buildPageStats,
  buildGridResults,
  scoreSegmentation,
  renderAnnotatedPage
};
