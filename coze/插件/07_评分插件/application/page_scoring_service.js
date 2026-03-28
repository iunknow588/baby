const path = require('path');
const { resolveConfig } = require('../config');
const { validateScoringPayload } = require('../contracts');
const { buildChineseScoringView } = require('../presentation/chinese_scoring_view');
const { resolveRecognizedCharsWithOcr } = require('./ocr_diagnostics_service');
const pageScoringAggregationService = require('./page_scoring_aggregation_service');
const { resolveScoringArtifactPolicy } = require('../../utils/artifact_policy');

async function scoreSegmentation(payload) {
  const {
    task_id = null,
    image_id = null,
    target_chars = [],
    recognized_chars = null,
    segmentation,
    cellLayerExtraction = null,
    options = {},
    outputDir = null,
    artifactLevel = null,
    artifact_level = null
  } = payload || {};

  validateScoringPayload(payload);

  const config = resolveConfig(options.config);
  const artifactPolicy = resolveScoringArtifactPolicy({
    artifactLevel,
    artifact_level,
    options
  });
  const scoringOutputDir = artifactPolicy.emitCellStepArtifacts ? outputDir : null;
  const { recognizedChars: resolvedRecognizedChars, ocrDiagnostics } = await resolveRecognizedCharsWithOcr({
    segmentation,
    targetChars: target_chars,
    recognizedChars: recognized_chars,
    cellLayerExtraction,
    outputDir: artifactPolicy.emitOcrDiagnostics ? outputDir : null,
    ocrOptions: options.ocr || {}
  });
  const aggregated = await pageScoringAggregationService.aggregatePageScoring({
    segmentation,
    cellLayerExtraction,
    target_chars,
    recognized_chars: resolvedRecognizedChars,
    options,
    outputDir: scoringOutputDir,
    config
  });
  const ocrOutputDir = ocrDiagnostics && artifactPolicy.emitOcrDiagnostics && outputDir
    ? path.join(outputDir, '07_0_OCR识别')
    : null;

  return {
    task_id,
    image_id,
    artifactLevel: artifactPolicy.artifactLevel,
    summary: aggregated.summary,
    outputDir: aggregated.outputDir || null,
    cellsRootDir: aggregated.cellsRootDir || null,
    ocrOutputDir,
    page_stats: aggregated.page_stats,
    grid_results: aggregated.grid_results,
    results: aggregated.results,
    ocr: ocrDiagnostics,
    中文结果: buildChineseScoringView({
      task_id,
      image_id,
      artifactLevel: artifactPolicy.artifactLevel,
      outputDir: aggregated.outputDir || null,
      cellsRootDir: aggregated.cellsRootDir || null,
      中文结果: aggregated.中文结果,
      ocr: ocrDiagnostics
    })
  };
}

module.exports = {
  scoreSegmentation
};
