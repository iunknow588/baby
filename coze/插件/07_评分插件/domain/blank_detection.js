const { clamp } = require('../shared/math');

function detectBlank(features, config) {
  const blankFeatures = features.blankDetection || features;
  const isStrongBlank = (candidateFeatures, requireCentralLow = false) =>
    candidateFeatures.inkRatio < config.blank.strong_ink_ratio_max &&
    candidateFeatures.primaryAreaRatio < config.blank.strong_primary_area_ratio_max &&
    candidateFeatures.bboxRatio < config.blank.strong_bbox_ratio_max &&
    (!requireCentralLow || candidateFeatures.centralInkRatio < config.blank.strong_center_ink_ratio_max);
  const edgeFragmentLikelyCharacter = (candidateFeatures) =>
    candidateFeatures.inkRatio >= 0.0018 &&
    candidateFeatures.componentCount >= 40 &&
    candidateFeatures.noiseComponentCount >= 35 &&
    candidateFeatures.strokeDensity >= 0.35 &&
    (
      candidateFeatures.marginBalanceX < 0.28 ||
      candidateFeatures.marginBalanceY < 0.28
    );
  const blankProbFromFeatures = (candidateFeatures) => clamp(
    1 -
      candidateFeatures.inkRatio * config.blank.ink_ratio_weight -
      candidateFeatures.primaryAreaRatio * config.blank.primary_area_ratio_weight -
      candidateFeatures.bboxRatio * config.blank.bbox_ratio_weight -
      candidateFeatures.componentCount * config.blank.component_count_weight,
    0,
    1
  );
  const strongBlank = isStrongBlank(features, false) || isStrongBlank(blankFeatures, true);
  const shouldRescueEdgeFragment =
    edgeFragmentLikelyCharacter(features) ||
    edgeFragmentLikelyCharacter(blankFeatures);
  const isBlank =
    (strongBlank && !shouldRescueEdgeFragment) ||
    (
      blankFeatures.inkRatio < config.blank.ink_ratio_max &&
      blankFeatures.primaryAreaRatio < config.blank.primary_area_ratio_max &&
      blankFeatures.bboxRatio < config.blank.bbox_ratio_max &&
      blankFeatures.centralInkRatio < config.blank.center_ink_ratio_max &&
      blankFeatures.componentCount <= config.blank.component_count_max
    );
  const residualFragmentBlank =
    blankFeatures.inkRatio < 0.012 &&
    blankFeatures.primaryAreaRatio < 0.0022 &&
    blankFeatures.bboxRatio < 0.003 &&
    blankFeatures.centralInkRatio < 0.05 &&
    blankFeatures.componentCount <= 8;
  const blankLikeGuideResidue =
    blankFeatures.inkRatio < config.blank.residual_ink_ratio_max &&
    blankFeatures.primaryAreaRatio < config.blank.residual_primary_area_ratio_max &&
    blankFeatures.bboxRatio < config.blank.residual_bbox_ratio_max &&
    blankFeatures.centralInkRatio < config.blank.residual_center_ink_ratio_max &&
    blankFeatures.componentCount >= config.blank.residual_component_count_min &&
    (blankFeatures.significantComponentCount || blankFeatures.componentCount) <= config.blank.residual_significant_component_count_max;
  const blankProb = Math.max(blankProbFromFeatures(features), blankProbFromFeatures(blankFeatures));
  const shouldMarkBlank =
    (isBlank || residualFragmentBlank || blankLikeGuideResidue) &&
    !shouldRescueEdgeFragment;

  return {
    isBlank: shouldMarkBlank,
    blankProb: shouldMarkBlank && (residualFragmentBlank || blankLikeGuideResidue)
      ? Math.max(blankProb, 0.92)
      : blankProb
  };
}

function blankReasonFromFeatures(features) {
  const blankFeatures = features.blankDetection || features;

  if (blankFeatures.componentCount === 0 || blankFeatures.primaryAreaRatio === 0) {
    return 'NO_FOREGROUND';
  }
  if (blankFeatures.inkRatio < 0.003) {
    return 'LOW_INK_RATIO';
  }
  if (blankFeatures.bboxRatio < 0.01) {
    return 'LOW_BBOX_RATIO';
  }
  return 'LIKELY_EMPTY_CELL';
}

module.exports = {
  detectBlank,
  blankReasonFromFeatures
};
