const { roundScore } = require('../shared/math');
const {
  extractFeatures
} = require('../../utils/cell_image_analysis');
const {
  detectBlank,
  blankReasonFromFeatures
} = require('../domain/blank_detection');
const {
  calculateSimilarityScore,
  calculateStructureScore
} = require('../domain/template_scoring');
const {
  calculateStrokeQualityScore,
  calculateStructureAccuracyScore,
  calculateCleanlinessScore,
  buildPenalties,
  levelFromScore,
  buildAliasSemantics
} = require('../domain/rule_scoring');

async function executeCellFeatureExtractionStep(params) {
  const { cellImage, options = {} } = params || {};
  if (!cellImage) {
    throw new Error('cellImage参数是必需的');
  }

  const features = await extractFeatures(cellImage, options);
  return {
    processNo: '07_1',
    processName: '07_1_单格特征提取',
    features
  };
}

function executeBlankCellJudgeStep(params) {
  const { features, config } = params || {};
  if (!features || !config) {
    throw new Error('features 和 config 参数是必需的');
  }

  const blankResult = detectBlank(features, config);
  return {
    processNo: '07_2',
    processName: '07_2_空白格判定',
    blankResult,
    blankReason: blankReasonFromFeatures(features)
  };
}

async function executeCellStructureScoreStep(params) {
  const { cellImage, targetChar, options = {} } = params || {};
  const structure = await calculateStructureScore(cellImage, targetChar, options);
  return {
    processNo: '07_3',
    processName: '07_3_单格结构评分',
    structure
  };
}

async function executeCellSimilarityScoreStep(params) {
  const { cellImage, targetChar, options = {} } = params || {};
  const similarity = await calculateSimilarityScore(cellImage, targetChar, options);
  return {
    processNo: '07_4',
    processName: '07_4_单格相似度评分',
    similarity
  };
}

function executeCellFinalScoreStep(params) {
  const { features, structure, similarity, config } = params || {};
  if (!features || !config) {
    throw new Error('features 和 config 参数是必需的');
  }

  const strokeQuality = calculateStrokeQualityScore(features, config);
  const structureAccuracy = calculateStructureAccuracyScore(features, config, structure);
  const cleanliness = calculateCleanlinessScore(features, config);
  const morphologySimilarity = similarity ? similarity.score : cleanliness;
  const total = similarity
    ? roundScore(
        config.weights.with_target.stroke_quality * strokeQuality.score +
        config.weights.with_target.structure_accuracy * structureAccuracy.score +
        config.weights.with_target.morphology_similarity * morphologySimilarity
      )
    : roundScore(
        config.weights.rule_only.stroke_quality * strokeQuality.score +
        config.weights.rule_only.structure_accuracy * structureAccuracy.score +
        config.weights.rule_only.cleanliness * cleanliness
      );

  return {
    processNo: '07_5',
    processName: '07_5_单格总评分',
    total,
    scoreLevel: levelFromScore(total),
    subScores: {
      stroke_quality: strokeQuality.score,
      structure_accuracy: structureAccuracy.score,
      morphology_similarity: similarity ? similarity.score : null,
      cleanliness: similarity ? null : cleanliness,
      layout: structureAccuracy.details.center,
      size: structureAccuracy.details.proportion,
      stability: strokeQuality.details.stability,
      structure: structureAccuracy.score,
      similarity: morphologySimilarity
    },
    scoreBreakdown: {
      stroke_quality: strokeQuality.details,
      structure_accuracy: structureAccuracy.details,
      similarity: similarity || null,
      cleanliness: similarity ? null : cleanliness,
      alias_semantics: {
        aliases: buildAliasSemantics(Boolean(similarity)),
        note: similarity
          ? null
          : '兼容字段 sub_scores.similarity 在无目标字场景下回退表示 cleanliness'
      }
    },
    penalties: buildPenalties(
      features,
      config,
      structure,
      similarity,
      strokeQuality,
      structureAccuracy,
      cleanliness
    )
  };
}

module.exports = {
  executeCellFeatureExtractionStep,
  executeBlankCellJudgeStep,
  executeCellStructureScoreStep,
  executeCellSimilarityScoreStep,
  executeCellFinalScoreStep
};
