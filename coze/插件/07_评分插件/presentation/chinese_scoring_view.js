function buildChineseSummary(summary) {
  return {
    总格数: summary.total_cells,
    应评分目标格数: summary.expected_target_cells ?? null,
    已评分格数: summary.scored_cells,
    空白格数: summary.blank_cells,
    空白格列表: summary.blank_cell_ids,
    已评分格列表: summary.scored_cell_ids,
    低分格列表: summary.low_score_cell_ids,
    复核格列表: summary.review_cell_ids,
    平均分: summary.avg_score,
    基础平均分: summary.base_avg_score ?? summary.avg_score,
    整页总分: summary.page_total_score ?? summary.avg_score,
    整页等级: summary.page_score_level ?? null,
    页级扣分项: summary.page_penalties || [],
    文本校验: summary.text_audit || null
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

function buildChineseOcrNote(textAudit) {
  if (textAudit.supported) {
    return '已接入外部 recognized_chars 结果进行页级文本校验';
  }
  if (textAudit.skipped_reason === 'target_chars_unavailable') {
    return '未提供 target_chars，OCR 结果仅作诊断，不参与文本扣分';
  }
  return '当前版本未启用错别字/添字 OCR 识别';
}

function buildChineseAggregatedView({ summary, pageStats, gridResults, results, pagePenaltySummary }) {
  return {
    汇总信息: buildChineseSummary(summary),
    页面统计: buildChinesePageStats(pageStats),
    网格结果: buildChineseGridResults(gridResults),
    单格结果: results.map(buildChineseCellResult),
    整页扣分信息: {
      页级扣分项: pagePenaltySummary.penalties,
      漏写格数: pagePenaltySummary.missingCharCount,
      漏写格列表: pagePenaltySummary.missingCharCellIds,
      整页整洁度: pagePenaltySummary.pageCleanliness,
      文本校验: pagePenaltySummary.textAudit,
      OCR状态: {
        supported: pagePenaltySummary.textAudit.supported,
        note: buildChineseOcrNote(pagePenaltySummary.textAudit)
      }
    }
  };
}

function buildChineseScoringView(result) {
  return {
    任务ID: result.task_id,
    图片ID: result.image_id,
    汇总信息: result.中文结果?.汇总信息 || null,
    页面统计: result.中文结果?.页面统计 || null,
    网格结果: result.中文结果?.网格结果 || null,
    单格结果: result.中文结果?.单格结果 || null,
    OCR结果: result.ocr || null,
    输出目录: result.outputDir || null,
    单格评分目录: result.cellsRootDir || null
  };
}

module.exports = {
  buildChineseSummary,
  buildChinesePageStats,
  buildChineseGridResults,
  buildChineseCellResult,
  buildChineseAggregatedView,
  buildChineseScoringView
};
