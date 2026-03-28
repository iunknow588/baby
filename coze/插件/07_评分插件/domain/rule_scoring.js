const { clamp, average, roundScore } = require('../shared/math');

function scoreCenterOffset(offset, scale) {
  return Math.max(0, 100 - scale * Math.abs(offset));
}

function expectedTransitionComplexity(features) {
  return (
    1.8 +
    Math.max(0, features.significantComponentCount - 1) * 0.65 +
    features.strokeDensity * 4.2 +
    features.bboxRatio * 3.2
  );
}

function transitionOverloadRatio(features) {
  const transitionMean = average([features.rowTransitionMean, features.colTransitionMean]);
  const expected = Math.max(1, expectedTransitionComplexity(features));
  return Math.max(0, transitionMean / expected - 1);
}

function expectedFragmentAllowance(features) {
  return (
    1 +
    Math.max(0, average([features.rowTransitionMean, features.colTransitionMean]) - 2.2) * 0.55 +
    features.strokeDensity * 2.5 +
    features.bboxRatio * 2.2
  );
}

function excessFragmentCount(features) {
  return Math.max(0, features.significantComponentCount - expectedFragmentAllowance(features));
}

function effectiveNoiseComponentCount(features) {
  const allowance = (
    Math.max(0, features.significantComponentCount - 1) * 1.8 +
    Math.max(0, average([features.rowTransitionMean, features.colTransitionMean]) - 2.5) * 1.35 +
    features.strokeDensity * 6 +
    features.bboxRatio * 6
  );
  return Math.max(0, features.noiseComponentCount - allowance);
}

function scoreRatioInRange(value, idealLow, idealHigh, penaltyScale) {
  if (value >= idealLow && value <= idealHigh) {
    return 100;
  }

  const distance = value < idealLow ? idealLow - value : value - idealHigh;
  return Math.max(0, 100 - penaltyScale * distance);
}

function resolveStructureAccuracyTargets(features, config) {
  const baseLow = config.structure_accuracy.ideal_bbox_ratio_low;
  const baseHigh = config.structure_accuracy.ideal_bbox_ratio_high;
  const guideGridType = String(features?.guideGridType || '').trim().toLowerCase();

  if (guideGridType === 'circle_mi') {
    return {
      idealBBoxRatioLow: baseLow * 0.82,
      idealBBoxRatioHigh: baseHigh * 0.92
    };
  }

  if (guideGridType === 'circle_tian') {
    return {
      idealBBoxRatioLow: baseLow * 0.85,
      idealBBoxRatioHigh: baseHigh * 0.94
    };
  }

  return {
    idealBBoxRatioLow: baseLow,
    idealBBoxRatioHigh: baseHigh
  };
}

function calculateStrokeQualityScore(features, config) {
  const transitionOverload = transitionOverloadRatio(features);
  const effectiveNoiseCount = effectiveNoiseComponentCount(features);
  const fragmentOverflow = excessFragmentCount(features);
  const start = clamp(
    100 - features.edgeTouchInkRatio * config.stroke_quality.edge_touch_ratio_penalty_scale,
    0,
    100
  );
  const stability = clamp(
    100 -
      transitionOverload * config.stroke_quality.transition_penalty_scale -
      features.rowCenterJitter * config.stroke_quality.jitter_penalty_scale,
    0,
    100
  );
  const ending = clamp(
    100 -
      effectiveNoiseCount * config.stroke_quality.fragment_penalty_scale -
      fragmentOverflow * config.stroke_quality.component_penalty_scale,
    0,
    100
  );
  const widthUniformity = clamp(
    100 - features.meanStrokeWidthStdRatio * config.stroke_quality.width_std_penalty_scale,
    0,
    100
  );
  const fluency = clamp(
    100 -
      Math.abs(features.strokeDensity - config.stroke_quality.ideal_stroke_density) * config.stroke_quality.stroke_density_penalty_scale -
      effectiveNoiseCount * 4,
    0,
    100
  );
  const weights = config.stroke_quality.weights;
  return {
    score: roundScore(
      weights.start * start +
      weights.stability * stability +
      weights.ending * ending +
      weights.width_uniformity * widthUniformity +
      weights.fluency * fluency
    ),
    details: {
      start: roundScore(start),
      stability: roundScore(stability),
      ending: roundScore(ending),
      width_uniformity: roundScore(widthUniformity),
      fluency: roundScore(fluency)
    }
  };
}

function calculateStructureAccuracyScore(features, config, structure = null) {
  const structureTargets = resolveStructureAccuracyTargets(features, config);
  const centerX = scoreCenterOffset(features.centerDx, config.structure_accuracy.center_penalty_scale);
  const centerY = scoreCenterOffset(features.centerDy, config.structure_accuracy.center_penalty_scale);
  const marginScore = 50 * features.marginBalanceX + 50 * features.marginBalanceY;
  const center = average([centerX, centerY]) * (1 - config.structure_accuracy.margin_weight) + marginScore * config.structure_accuracy.margin_weight;
  const bboxScore = scoreRatioInRange(
    features.bboxRatio,
    structureTargets.idealBBoxRatioLow,
    structureTargets.idealBBoxRatioHigh,
    config.structure_accuracy.bbox_penalty_scale
  );
  const aspectScore = scoreRatioInRange(
    features.aspectRatio,
    config.structure_accuracy.ideal_aspect_ratio_low,
    config.structure_accuracy.ideal_aspect_ratio_high,
    config.structure_accuracy.aspect_penalty_scale
  );
  const proportion = config.structure_accuracy.bbox_weight * bboxScore + config.structure_accuracy.aspect_weight * aspectScore;
  const spacing = clamp(
    100 -
      average([features.rowWidthStdRatio, features.colWidthStdRatio, features.rowCenterJitter]) * config.structure_accuracy.spacing_penalty_scale,
    0,
    100
  );
  const crossing = clamp(
    100 -
      Math.max(0, features.significantComponentCount - 1) * config.structure_accuracy.crossing_penalty_scale * 0.08 -
      Math.max(0, average([features.rowTransitionMean, features.colTransitionMean]) - 2) * config.structure_accuracy.crossing_penalty_scale * 0.18,
    0,
    100
  );
  const contour = clamp(
    100 -
      features.edgeTouchInkRatio * config.structure_accuracy.edge_touch_ratio_penalty_scale -
      Math.abs(features.strokeDensity - 0.45) * 110,
    0,
    100
  );
  const weights = config.structure_accuracy.weights;
  const ruleScore = (
    weights.center * center +
    weights.proportion * proportion +
    weights.spacing * spacing +
    weights.crossing * crossing +
    weights.contour * contour
  );
  const score = structure
    ? (1 - config.structure_accuracy.template_blend_weight) * ruleScore + config.structure_accuracy.template_blend_weight * structure.score
    : ruleScore;
  return {
    score: roundScore(score),
    details: {
      center: roundScore(center),
      proportion: roundScore(proportion),
      spacing: roundScore(spacing),
      crossing: roundScore(crossing),
      contour: roundScore(contour),
      template_structure: structure ? roundScore(structure.score) : null
    }
  };
}

function calculateCleanlinessScore(features, config) {
  const effectiveNoiseCount = effectiveNoiseComponentCount(features);
  const fragmentOverflow = excessFragmentCount(features);
  return roundScore(clamp(
    100 -
      features.edgeTouchInkRatio * config.cleanliness.edge_noise_penalty_scale -
      effectiveNoiseCount * config.cleanliness.noise_component_penalty_scale -
      fragmentOverflow * config.cleanliness.fragment_penalty_scale,
    0,
    100
  ));
}

function buildPenalties(features, config, structure = null, similarity = null, strokeQuality = null, structureAccuracy = null, cleanliness = null) {
  const penalties = [];
  const effectiveNoiseCount = effectiveNoiseComponentCount(features);
  const structureTargets = resolveStructureAccuracyTargets(features, config);

  if (features.centerDx < -config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_LEFT', message: '重心偏左', severity: roundScore(Math.abs(features.centerDx)) });
  }
  if (features.centerDx > config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_RIGHT', message: '重心偏右', severity: roundScore(Math.abs(features.centerDx)) });
  }
  if (features.centerDy < -config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_UP', message: '重心偏上', severity: roundScore(Math.abs(features.centerDy)) });
  }
  if (features.centerDy > config.penalties.center_offset_threshold) {
    penalties.push({ code: 'CENTER_DOWN', message: '重心偏下', severity: roundScore(Math.abs(features.centerDy)) });
  }
  if (features.bboxRatio < structureTargets.idealBBoxRatioLow) {
    penalties.push({ code: 'LOW_BBOX_RATIO', message: '整体偏小', severity: roundScore(structureTargets.idealBBoxRatioLow - features.bboxRatio) });
  }
  if (features.bboxRatio > structureTargets.idealBBoxRatioHigh) {
    penalties.push({ code: 'HIGH_BBOX_RATIO', message: '整体偏大', severity: roundScore(features.bboxRatio - structureTargets.idealBBoxRatioHigh) });
  }
  if (features.marginBalanceX < config.penalties.margin_balance_threshold) {
    penalties.push({ code: 'MARGIN_X_UNBALANCED', message: '左右留白不均', severity: roundScore(1 - features.marginBalanceX) });
  }
  if (features.marginBalanceY < config.penalties.margin_balance_threshold) {
    penalties.push({ code: 'MARGIN_Y_UNBALANCED', message: '上下留白不均', severity: roundScore(1 - features.marginBalanceY) });
  }
  if (effectiveNoiseCount >= config.penalties.noise_component_threshold) {
    penalties.push({ code: 'NOISE_COMPONENTS', message: '噪点较多', severity: roundScore(effectiveNoiseCount / 10) });
  }
  if (features.rowCenterJitter > config.penalties.stroke_jitter_threshold) {
    penalties.push({ code: 'STROKE_JITTER', message: '行笔抖动', severity: roundScore(features.rowCenterJitter) });
  }
  if (features.meanStrokeWidthStdRatio > config.penalties.width_std_threshold) {
    penalties.push({ code: 'STROKE_WIDTH_VARIANCE', message: '粗细不均', severity: roundScore(features.meanStrokeWidthStdRatio) });
  }
  if (features.edgeTouchInkRatio > config.penalties.edge_touch_ratio_threshold) {
    penalties.push({ code: 'START_END_ROUGH', message: '起收笔边缘毛糙', severity: roundScore(features.edgeTouchInkRatio) });
  }

  if (structure) {
    if (structure.score < config.structure_accuracy.template_mismatch_score_threshold) {
      penalties.push({
        code: 'STRUCTURE_TEMPLATE_MISMATCH',
        message: '整体结构与目标字存在差异',
        severity: roundScore(
          (config.structure_accuracy.template_mismatch_score_threshold - structure.score) /
            config.structure_accuracy.template_mismatch_score_threshold
        )
      });
    }
    if (
      structure.region_diffs.left > config.structure_accuracy.left_right_diff_threshold &&
      structure.region_diffs.right > config.structure_accuracy.left_right_diff_threshold
    ) {
      penalties.push({ code: 'STRUCTURE_LR_IMBALANCE', message: '左右结构分布失衡', severity: roundScore(Math.max(structure.region_diffs.left, structure.region_diffs.right)) });
    }
    if (
      structure.region_diffs.top > config.structure_accuracy.up_down_diff_threshold &&
      structure.region_diffs.bottom > config.structure_accuracy.up_down_diff_threshold
    ) {
      penalties.push({ code: 'STRUCTURE_UD_IMBALANCE', message: '上下结构分布失衡', severity: roundScore(Math.max(structure.region_diffs.top, structure.region_diffs.bottom)) });
    }
    if (
      structure.region_diffs.topLeft > config.structure_accuracy.diagonal_diff_threshold ||
      structure.region_diffs.bottomRight > config.structure_accuracy.diagonal_diff_threshold
    ) {
      penalties.push({ code: 'STRUCTURE_DIAGONAL_MISMATCH', message: '对角结构与标准字差异较大', severity: roundScore(Math.max(structure.region_diffs.topLeft, structure.region_diffs.bottomRight)) });
    }
  }
  if (similarity && similarity.score < config.penalties.template_similarity_threshold) {
    penalties.push({ code: 'SIMILARITY_LOW', message: '字形偏差过大', severity: roundScore((100 - similarity.score) / 100) });
  }
  if (cleanliness !== null && cleanliness < config.penalties.cleanliness_threshold) {
    penalties.push({ code: 'CLEANLINESS_LOW', message: '卷面涂改或残墨较多', severity: roundScore((100 - cleanliness) / 100) });
  }
  if (strokeQuality && strokeQuality.details.stability < 70) {
    penalties.push({ code: 'STROKE_STABILITY_LOW', message: '行笔稳定性不足', severity: roundScore((100 - strokeQuality.details.stability) / 100) });
  }
  if (structureAccuracy && structureAccuracy.details.proportion < 72) {
    penalties.push({ code: 'PROPORTION_IMBALANCED', message: '比例失调', severity: roundScore((100 - structureAccuracy.details.proportion) / 100) });
  }

  return penalties;
}

function levelFromScore(score) {
  if (score >= 90) {
    return 'excellent';
  }
  if (score >= 75) {
    return 'good';
  }
  if (score >= 60) {
    return 'pass';
  }
  return 'poor';
}

function buildAliasSemantics(hasMorphologySimilarity) {
  return {
    layout: 'structure_accuracy.center',
    size: 'structure_accuracy.proportion',
    stability: 'stroke_quality.stability',
    structure: 'structure_accuracy',
    similarity: hasMorphologySimilarity ? 'morphology_similarity' : 'cleanliness'
  };
}

module.exports = {
  calculateStrokeQualityScore,
  calculateStructureAccuracyScore,
  calculateCleanlinessScore,
  buildPenalties,
  levelFromScore,
  buildAliasSemantics
};
