const fs = require('fs');
const path = require('path');
const { validateScoringPayload } = require('../contracts');
const { average, roundScore } = require('../shared/math');
const { mapWithConcurrency, normalizeConcurrency } = require('../shared/async');
const { buildPagePenaltySummary } = require('../domain/page_scoring');
const {
  buildPageStats,
  buildGridResults
} = require('../presentation/page_result_view');
const { buildChineseAggregatedView } = require('../presentation/chinese_scoring_view');
const cellScoringService = require('./cell_scoring_service');

function formatCellDirName(row, col) {
  return `row${String(row + 1).padStart(2, '0')}_col${String(col + 1).padStart(2, '0')}`;
}

function resolvePageScoringConcurrency(options, config) {
  const explicitConcurrency =
    options?.pageScoring?.concurrency ??
    options?.page_scoring?.concurrency ??
    config?.execution?.page_scoring_concurrency;

  return normalizeConcurrency(explicitConcurrency, 1);
}

async function aggregatePageScoring(params) {
  const {
    segmentation,
    cellLayerExtraction = null,
    target_chars = [],
    recognized_chars = null,
    options = {},
    config,
    outputDir = null
  } = params || {};

  validateScoringPayload({
    segmentation,
    target_chars,
    recognized_chars
  });

  const cellsRootDir = outputDir ? path.join(outputDir, '07_1_单格评分详情') : null;
  if (cellsRootDir) {
    await fs.promises.mkdir(cellsRootDir, { recursive: true });
  }

  const cellLayerMap = new Map(
    Array.isArray(cellLayerExtraction?.cells)
      ? cellLayerExtraction.cells.map((item) => [`${item.row}_${item.col}`, item])
      : []
  );
  const scoringJobs = [];
  for (let row = 0; row < segmentation.matrix.length; row++) {
    for (let col = 0; col < segmentation.matrix[row].length; col++) {
      const cellIndex = row * segmentation.gridCols + col;
      const cellMeta = segmentation.cells[cellIndex] || {};
      const cellLayerMeta = cellLayerMap.get(`${row}_${col}`) || null;
      const targetChar = target_chars[row] && target_chars[row][col] ? target_chars[row][col] : null;
      scoringJobs.push({
        row,
        col,
        cell: {
          cell_id: `${row}_${col}`,
          row,
          col,
          target_char: targetChar,
          cell_image: segmentation.matrix[row][col],
          cell_image_path: cellLayerMeta?.outputs?.textOnlyPath || null,
          page_box: cellMeta.pageBox || null,
          content_box: cellMeta.contentBox || null
        },
        textOnlyPath: cellLayerMeta?.outputs?.textOnlyPath || null,
        outputDir: cellsRootDir ? path.join(cellsRootDir, formatCellDirName(row, col)) : null
      });
    }
  }
  const pageScoringConcurrency = resolvePageScoringConcurrency(options, config);
  const results = await mapWithConcurrency(scoringJobs, pageScoringConcurrency, async (job) => {
    let cellImage = job.cell.cell_image;
    let cellImagePath = job.cell.cell_image_path;

    if (job.textOnlyPath) {
      try {
        cellImage = await fs.promises.readFile(job.textOnlyPath);
        cellImagePath = job.textOnlyPath;
      } catch (error) {
        cellImage = job.cell.cell_image;
        cellImagePath = job.cell.cell_image_path;
      }
    }

    return cellScoringService.scoreCell(
      {
        ...job.cell,
        cell_image: cellImage,
        cell_image_path: cellImagePath
      },
      { ...options, config },
      job.outputDir
    );
  });

  const scoredCells = results.filter((item) => !item.is_blank);
  const pageStats = buildPageStats(results, config, segmentation.gridRows, segmentation.gridCols);
  const gridResults = buildGridResults(results, config, segmentation.gridRows, segmentation.gridCols);

  const summary = {
    total_cells: results.length,
    expected_target_cells: 0,
    scored_cells: scoredCells.length,
    blank_cells: pageStats.blank_cell_ids.length,
    blank_cell_ids: pageStats.blank_cell_ids,
    scored_cell_ids: pageStats.scored_cell_ids,
    low_score_cell_ids: pageStats.low_score_cell_ids,
    review_cell_ids: pageStats.review_cell_ids,
    avg_score: scoredCells.length ? roundScore(average(scoredCells.map((item) => item.total_score))) : null
  };
  const pagePenaltySummary = buildPagePenaltySummary(results, summary, config, target_chars, recognized_chars);
  summary.expected_target_cells = pagePenaltySummary.expectedTargetCells;
  summary.base_avg_score = summary.avg_score;
  summary.page_total_score = pagePenaltySummary.pageTotalScore;
  summary.page_score_level = pagePenaltySummary.pageScoreLevel;
  summary.page_penalties = pagePenaltySummary.penalties;
  summary.text_audit = pagePenaltySummary.textAudit;
  summary.missing_char_count = pagePenaltySummary.missingCharCount;
  summary.missing_char_cell_ids = pagePenaltySummary.missingCharCellIds;
  summary.page_cleanliness = pagePenaltySummary.pageCleanliness;
  summary.page_total_deduction = pagePenaltySummary.totalDeduction;
  summary.ocr_supported = pagePenaltySummary.textAudit.supported;

  return {
    summary,
    outputDir,
    cellsRootDir,
    page_stats: pageStats,
    grid_results: gridResults,
    results,
    中文结果: buildChineseAggregatedView({
      summary,
      pageStats,
      gridResults,
      results,
      pagePenaltySummary
    })
  };
}

module.exports = {
  aggregatePageScoring
};
