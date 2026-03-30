const { resolveConfig } = require('../config');
const { roundScore } = require('../shared/math');
const { prepareCellStepArtifacts } = require('../adapters/cell_step_outputs');
const {
  CELL_STEP_DEFINITIONS,
  CELL_SCORING_SOURCE_STEPS
} = require('../step_definitions');
const {
  executeCellFeatureExtractionStep,
  executeBlankCellJudgeStep,
  executeCellStructureScoreStep,
  executeCellSimilarityScoreStep,
  executeCellFinalScoreStep
} = require('./cell_scoring_steps');

function normalizeContentBox(cell) {
  if (!cell) {
    return null;
  }
  if (cell.content_box) {
    return cell.content_box;
  }
  if (cell.page_box) {
    return {
      left: 0,
      top: 0,
      width: cell.page_box.width,
      height: cell.page_box.height
    };
  }
  return null;
}

async function scoreCell(cell, options = {}, outputDir = null) {
  const config = resolveConfig(options.config);
  const { stepDirs, stepMetaPaths, writeStepMeta } = await prepareCellStepArtifacts(outputDir);

  const step07_1 = await executeCellFeatureExtractionStep({
    cellImage: cell.cell_image,
    options: { ...options, config }
  });
  step07_1.sourceStep = CELL_SCORING_SOURCE_STEPS.inputTextOnly;
  step07_1.inputPath = cell.cell_image_path || null;
  const features = step07_1.features;

  const step07_2 = executeBlankCellJudgeStep({ features, config });
  step07_2.sourceStep = CELL_SCORING_SOURCE_STEPS.blankJudgeFromFeature;
  step07_2.inputPath = cell.cell_image_path || null;
  const { blankResult, blankReason } = step07_2;

  await writeStepMeta('step07_1', step07_1);
  await writeStepMeta('step07_2', step07_2);

  if (blankResult.isBlank) {
    const step07_5 = {
      processNo: CELL_STEP_DEFINITIONS.step07_5.processNo,
      processName: CELL_STEP_DEFINITIONS.step07_5.processName,
      sourceStep: CELL_SCORING_SOURCE_STEPS.finalFromBlankJudge,
      inputPath: cell.cell_image_path || null,
      status: 'blank',
      blankResult,
      blankReason
    };
    await writeStepMeta('step07_5', step07_5);
    return {
      cell_id: cell.cell_id,
      row: cell.row,
      col: cell.col,
      target_char: cell.target_char || null,
      page_box: cell.page_box || null,
      content_box: normalizeContentBox(cell),
      status: 'blank',
      is_blank: true,
      blank_reason: blankReason,
      total_score: null,
      score_level: null,
      sub_scores: {},
      penalties: [],
      features,
      model_outputs: {
        blank_prob: roundScore(blankResult.blankProb)
      },
      stepDirs,
      stepMetaPaths
    };
  }

  const step07_3 = await executeCellStructureScoreStep({
    cellImage: cell.cell_image,
    targetChar: cell.target_char,
    options: { ...options, config }
  });
  step07_3.sourceStep = CELL_SCORING_SOURCE_STEPS.structureFromBlankJudge;
  step07_3.inputPath = cell.cell_image_path || null;
  const structure = step07_3.structure;

  const step07_4 = await executeCellSimilarityScoreStep({
    cellImage: cell.cell_image,
    targetChar: cell.target_char,
    options: { ...options, config }
  });
  step07_4.sourceStep = CELL_SCORING_SOURCE_STEPS.similarityFromBlankJudge;
  step07_4.inputPath = cell.cell_image_path || null;
  const similarity = step07_4.similarity;

  const step07_5 = executeCellFinalScoreStep({
    features,
    structure,
    similarity,
    config
  });
  step07_5.sourceStep = CELL_SCORING_SOURCE_STEPS.finalFromStructureSimilarity;
  step07_5.inputPath = cell.cell_image_path || null;

  await writeStepMeta('step07_3', step07_3);
  await writeStepMeta('step07_4', step07_4);
  await writeStepMeta('step07_5', step07_5);

  return {
    cell_id: cell.cell_id,
    row: cell.row,
    col: cell.col,
    target_char: cell.target_char || null,
    page_box: cell.page_box || null,
    content_box: normalizeContentBox(cell),
    status: 'scored',
    is_blank: false,
    blank_reason: null,
    total_score: step07_5.total,
    score_level: step07_5.scoreLevel,
    sub_scores: step07_5.subScores,
    score_breakdown: step07_5.scoreBreakdown || null,
    penalties: step07_5.penalties,
    features,
    model_outputs: {
      blank_prob: roundScore(blankResult.blankProb),
      structure_regions: structure ? structure.region_diffs : null,
      similarity_iou: similarity ? similarity.iou : null,
      similarity_hu: similarity ? similarity.hu_similarity : null,
      similarity_edge_direction: similarity ? similarity.edge_direction_similarity : null
    },
    stepDirs,
    stepMetaPaths
  };
}

module.exports = {
  normalizeContentBox,
  scoreCell
};
