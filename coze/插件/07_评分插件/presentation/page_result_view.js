function labelFromResult(result, config) {
  if (result.status === 'blank') {
    return '空白';
  }

  if (result.total_score >= config.display.excellent_min) {
    return '优秀';
  }
  if (result.total_score >= config.display.good_min) {
    return '良好';
  }
  if (result.total_score >= config.display.pass_min) {
    return '及格';
  }
  return '待提升';
}

function actionFromResult(result, config) {
  if (result.status === 'blank') {
    return 'mark_blank';
  }
  if (result.total_score < config.review.low_score_threshold) {
    return 'review';
  }
  return 'pass';
}

function colorFromResult(result, config) {
  if (result.status === 'blank') {
    return '#6b7280';
  }
  if (result.total_score >= config.display.excellent_min) {
    return '#15803d';
  }
  if (result.total_score >= config.display.good_min) {
    return '#2563eb';
  }
  if (result.total_score >= config.display.pass_min) {
    return '#d97706';
  }
  return '#dc2626';
}

function buildPageStats(results, config, gridRows, gridCols) {
  const blankCells = results.filter((item) => item.status === 'blank');
  const scoredCells = results.filter((item) => item.status === 'scored');
  const lowScoreCells = scoredCells.filter((item) => item.total_score !== null && item.total_score < config.review.low_score_threshold);
  const reviewCells = results.filter((item) => {
    if (item.status === 'blank') {
      return true;
    }
    if (item.total_score !== null && item.total_score < config.review.low_score_threshold) {
      return true;
    }
    return item.model_outputs && item.model_outputs.blank_prob >= config.review.blank_prob_review_threshold;
  });

  const statusMatrix = Array.from({ length: gridRows }, () => Array(gridCols).fill(null));
  for (const item of results) {
    statusMatrix[item.row][item.col] = item.status;
  }

  return {
    blank_cell_ids: blankCells.map((item) => item.cell_id),
    scored_cell_ids: scoredCells.map((item) => item.cell_id),
    low_score_cell_ids: lowScoreCells.map((item) => item.cell_id),
    review_cell_ids: reviewCells.map((item) => item.cell_id),
    status_matrix: statusMatrix
  };
}

function buildGridResults(results, config, gridRows, gridCols) {
  const grid = Array.from({ length: gridRows }, () => Array(gridCols).fill(null));

  for (const item of results) {
    grid[item.row][item.col] = {
      cell_id: item.cell_id,
      row: item.row,
      col: item.col,
      target_char: item.target_char,
      status: item.status,
      label: labelFromResult(item, config),
      action: actionFromResult(item, config),
      color: colorFromResult(item, config),
      total_score: item.total_score,
      score_level: item.score_level,
      blank_reason: item.blank_reason,
      penalty_count: item.penalties.length,
      top_penalty: item.penalties.length ? item.penalties[0].message : null
    };
  }

  return grid;
}

module.exports = {
  labelFromResult,
  actionFromResult,
  colorFromResult,
  buildPageStats,
  buildGridResults
};
