const singleCellScoringPlugin = require('../07_0单格评分插件/index');

function formatCellDirName(row, col) {
  return `row${String(row + 1).padStart(2, '0')}_col${String(col + 1).padStart(2, '0')}`;
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value) {
  return Math.round(value * 100) / 100;
}

function buildChineseSummary(summary) {
  return {
    总格数: summary.total_cells,
    已评分格数: summary.scored_cells,
    空白格数: summary.blank_cells,
    空白格列表: summary.blank_cell_ids,
    已评分格列表: summary.scored_cell_ids,
    低分格列表: summary.low_score_cell_ids,
    复核格列表: summary.review_cell_ids,
    平均分: summary.avg_score
  };
}

function buildChinesePageStats(pageStats) {
  return {
    空白格列表: pageStats.blank_cell_ids,
    已评分格列表: pageStats.scored_cell_ids,
    低分格列表: pageStats.low_score_cell_ids,
    复核格列表: pageStats.review_cell_ids,
    状态矩阵: pageStats.status_matrix
  };
}

function buildChineseGridResults(gridResults) {
  return gridResults.map((row) => row.map((item) => {
    if (!item) {
      return null;
    }
    return {
      单格编号: item.cell_id,
      行号: item.row,
      列号: item.col,
      目标字: item.target_char,
      状态: item.status,
      标签: item.label,
      建议动作: item.action,
      标注颜色: item.color,
      总分: item.total_score,
      等级: item.score_level,
      空白原因: item.blank_reason,
      扣分项数量: item.penalty_count,
      主要扣分项: item.top_penalty
    };
  }));
}

function buildChineseCellResult(result) {
  return {
    单格编号: result.cell_id,
    行号: result.row,
    列号: result.col,
    目标字: result.target_char,
    状态: result.status,
    是否空白格: result.is_blank,
    空白原因: result.blank_reason,
    总分: result.total_score,
    等级: result.score_level,
    页面定位框: result.page_box,
    内容定位框: result.content_box,
    扣分项: result.penalties,
    步骤目录: result.stepDirs || {},
    步骤JSON: result.stepMetaPaths || {}
  };
}

class PageScoringAggregatePlugin {
  constructor() {
    this.name = '07_0_页面评分汇总';
    this.version = '1.0.0';
  }

  async execute(params) {
    const {
      segmentation,
      cellLayerExtraction = null,
      target_chars = [],
      options = {},
      buildPageStats,
      buildGridResults,
      config,
      outputDir = null
    } = params || {};

    if (!segmentation || !Array.isArray(segmentation.matrix) || !Array.isArray(segmentation.cells)) {
      throw new Error('segmentation.matrix 和 segmentation.cells 是必需的');
    }
    if (typeof buildPageStats !== 'function' || typeof buildGridResults !== 'function') {
      throw new Error('buildPageStats 和 buildGridResults 参数是必需的');
    }

    const path = require('path');
    const fs = require('fs');
    const cellsRootDir = outputDir ? path.join(outputDir, '07_1_单格评分详情') : null;
    if (cellsRootDir) {
      await fs.promises.mkdir(cellsRootDir, { recursive: true });
    }

    const results = [];
    const cellLayerMap = new Map(
      Array.isArray(cellLayerExtraction?.cells)
        ? cellLayerExtraction.cells.map((item) => [`${item.row}_${item.col}`, item])
        : []
    );
    for (let row = 0; row < segmentation.matrix.length; row++) {
      for (let col = 0; col < segmentation.matrix[row].length; col++) {
        const cellIndex = row * segmentation.gridCols + col;
        const cellMeta = segmentation.cells[cellIndex] || {};
        const cellLayerMeta = cellLayerMap.get(`${row}_${col}`) || null;
        const targetChar = target_chars[row] && target_chars[row][col] ? target_chars[row][col] : null;
        const scored = await singleCellScoringPlugin.execute({
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
          options: { ...options, config },
          outputDir: cellsRootDir ? path.join(cellsRootDir, formatCellDirName(row, col)) : null
        });
        results.push(scored);
      }
    }

    const scoredCells = results.filter((item) => !item.is_blank);
    const pageStats = buildPageStats(results, config, segmentation.gridRows, segmentation.gridCols);
    const gridResults = buildGridResults(results, config, segmentation.gridRows, segmentation.gridCols);

    const summary = {
      total_cells: results.length,
      scored_cells: scoredCells.length,
      blank_cells: pageStats.blank_cell_ids.length,
      blank_cell_ids: pageStats.blank_cell_ids,
      scored_cell_ids: pageStats.scored_cell_ids,
      low_score_cell_ids: pageStats.low_score_cell_ids,
      review_cell_ids: pageStats.review_cell_ids,
      avg_score: scoredCells.length ? roundScore(average(scoredCells.map((item) => item.total_score))) : null
    };

    return {
      summary,
      outputDir,
      cellsRootDir,
      page_stats: pageStats,
      grid_results: gridResults,
      results,
      中文结果: {
        汇总信息: buildChineseSummary(summary),
        页面统计: buildChinesePageStats(pageStats),
        网格结果: buildChineseGridResults(gridResults),
        单格结果: results.map(buildChineseCellResult)
      }
    };
  }
}

module.exports = new PageScoringAggregatePlugin();
