const { average, roundScore } = require('../shared/math');
const { levelFromScore } = require('./rule_scoring');

function normalizeAuditChar(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
}

function getRecognizedChar(recognizedChars, row, col) {
  if (!recognizedChars) {
    return null;
  }

  if (Array.isArray(recognizedChars)) {
    return normalizeAuditChar(recognizedChars[row]?.[col] ?? null);
  }

  if (typeof recognizedChars === 'object') {
    return normalizeAuditChar(recognizedChars[`${row}_${col}`] ?? null);
  }

  return null;
}

function buildTextAudit(results, targetChars, recognizedChars) {
  const hasRecognizedChars = Boolean(recognizedChars);
  const expectedTargetCount = results.reduce((sum, item) => {
    const expected = normalizeAuditChar(targetChars?.[item.row]?.[item.col] ?? item.target_char ?? null);
    return sum + (expected ? 1 : 0);
  }, 0);
  const mismatchedCells = [];
  const extraCharCells = [];
  const missingExpectedCells = [];

  if (!hasRecognizedChars) {
    return {
      supported: false,
      enabled: false,
      skipped_reason: 'recognized_chars_unavailable',
      recognized_source: null,
      wrong_char_count: 0,
      wrong_char_cells: [],
      missing_char_count_by_recognition: 0,
      missing_char_cells_by_recognition: [],
      extra_char_count: 0,
      extra_char_cells: [],
      deductions: {
        wrong_char: 0,
        missing_char: 0,
        extra_char: 0
      },
      total_deduction: 0
    };
  }

  if (expectedTargetCount === 0) {
    return {
      supported: false,
      enabled: false,
      skipped_reason: 'target_chars_unavailable',
      recognized_source: 'external-recognized_chars',
      wrong_char_count: 0,
      wrong_char_cells: [],
      missing_char_count_by_recognition: 0,
      missing_char_cells_by_recognition: [],
      extra_char_count: 0,
      extra_char_cells: [],
      deductions: {
        wrong_char: 0,
        missing_char: 0,
        extra_char: 0
      },
      total_deduction: 0
    };
  }

  for (const item of results) {
    const expected = normalizeAuditChar(targetChars?.[item.row]?.[item.col] ?? item.target_char ?? null);
    const recognized = getRecognizedChar(recognizedChars, item.row, item.col);
    if (!expected && !recognized) {
      continue;
    }
    if (expected && !recognized) {
      missingExpectedCells.push(item.cell_id);
      continue;
    }
    if (!expected && recognized) {
      extraCharCells.push({
        cell_id: item.cell_id,
        recognized_char: recognized
      });
      continue;
    }
    if (expected !== recognized) {
      mismatchedCells.push({
        cell_id: item.cell_id,
        expected_char: expected,
        recognized_char: recognized
      });
    }
  }

  const wrongCharDeduction = roundScore(mismatchedCells.length * 5);
  const missingDeduction = roundScore(missingExpectedCells.length * 2);
  const extraDeduction = roundScore(extraCharCells.length * 2);
  return {
    supported: true,
    enabled: true,
    skipped_reason: null,
    recognized_source: 'external-recognized_chars',
    wrong_char_count: mismatchedCells.length,
    wrong_char_cells: mismatchedCells,
    missing_char_count_by_recognition: missingExpectedCells.length,
    missing_char_cells_by_recognition: missingExpectedCells,
    extra_char_count: extraCharCells.length,
    extra_char_cells: extraCharCells,
    deductions: {
      wrong_char: wrongCharDeduction,
      missing_char: missingDeduction,
      extra_char: extraDeduction
    },
    total_deduction: roundScore(wrongCharDeduction + missingDeduction + extraDeduction)
  };
}

function calculateMissingCharStats(results) {
  const expectedCells = results.filter((item) => item.target_char);
  const missingCells = expectedCells.filter((item) => item.is_blank);
  return {
    expectedTargetCells: expectedCells.length,
    missingCharCells: missingCells.map((item) => item.cell_id),
    missingCharCount: missingCells.length
  };
}

function calculatePageCleanliness(results) {
  const scored = results.filter((item) => item.status === 'scored' && item.features);
  if (!scored.length) {
    return {
      score: null,
      penalty: 0,
      approxNoiseRatio: null
    };
  }

  const approxNoiseRatio = average(scored.map((item) => {
    const features = item.features || {};
    const edgeNoise = Number(features.edgeTouchInkRatio) || 0;
    const componentNoise = Math.min(0.12, (Number(features.noiseComponentCount) || 0) * 0.01);
    const fragmentNoise = Math.min(0.12, Math.max(0, (Number(features.significantComponentCount) || 1) - 1) * 0.015);
    return edgeNoise * 0.45 + componentNoise * 0.3 + fragmentNoise * 0.25;
  }));
  const pageNoisePercent = approxNoiseRatio * 100;

  return {
    score: roundScore(Math.max(0, 100 - pageNoisePercent * 5)),
    penalty: roundScore(Math.min(10, pageNoisePercent)),
    approxNoiseRatio: roundScore(approxNoiseRatio)
  };
}

function buildPagePenaltySummary(results, summary, config, targetChars, recognizedChars) {
  const missingStats = calculateMissingCharStats(results);
  const pageCleanliness = calculatePageCleanliness(results);
  const textAudit = buildTextAudit(results, targetChars, recognizedChars);
  const penalties = [];
  const useRecognitionMissingAsPrimary = Boolean(textAudit.supported);

  if (!useRecognitionMissingAsPrimary && missingStats.missingCharCount > 0) {
    penalties.push({
      code: 'MISSING_CHAR',
      message: `疑似漏写 ${missingStats.missingCharCount} 格`,
      count: missingStats.missingCharCount,
      deduction: roundScore(missingStats.missingCharCount * 2),
      cell_ids: missingStats.missingCharCells
    });
  }

  if (pageCleanliness.penalty > 0) {
    penalties.push({
      code: 'PAGE_CLEANLINESS',
      message: '整页存在一定残墨/边缘噪声',
      deduction: pageCleanliness.penalty,
      approx_noise_ratio: pageCleanliness.approxNoiseRatio,
      derived_score: pageCleanliness.score
    });
  }

  if (textAudit.supported) {
    if (textAudit.wrong_char_count > 0) {
      penalties.push({
        code: 'WRONG_CHAR',
        message: `识别到疑似错字 ${textAudit.wrong_char_count} 格`,
        deduction: textAudit.deductions.wrong_char,
        cells: textAudit.wrong_char_cells
      });
    }
    if (textAudit.missing_char_count_by_recognition > 0) {
      penalties.push({
        code: 'RECOGNITION_MISSING_CHAR',
        message: `识别到疑似漏字 ${textAudit.missing_char_count_by_recognition} 格`,
        deduction: textAudit.deductions.missing_char,
        cell_ids: textAudit.missing_char_cells_by_recognition
      });
    }
    if (textAudit.extra_char_count > 0) {
      penalties.push({
        code: 'EXTRA_CHAR',
        message: `识别到疑似添字 ${textAudit.extra_char_count} 格`,
        deduction: textAudit.deductions.extra_char,
        cells: textAudit.extra_char_cells
      });
    }
  } else {
    penalties.push({
      code: 'OCR_UNAVAILABLE',
      message: textAudit.skipped_reason === 'target_chars_unavailable'
        ? '未提供 target_chars，OCR 结果仅作诊断展示，未参与整页文本扣分'
        : '错别字/添字 OCR 规则尚未启用，当前未参与整页扣分',
      deduction: 0,
      supported: false,
      skipped_reason: textAudit.skipped_reason || 'recognized_chars_unavailable'
    });
  }

  const totalDeduction = roundScore(penalties.reduce((sum, item) => sum + (Number(item.deduction) || 0), 0));
  const pageTotalScore = summary.avg_score === null
    ? null
    : roundScore(Math.max(0, summary.avg_score - totalDeduction));

  return {
    expectedTargetCells: missingStats.expectedTargetCells,
    missingCharCount: useRecognitionMissingAsPrimary
      ? textAudit.missing_char_count_by_recognition
      : missingStats.missingCharCount,
    missingCharCellIds: useRecognitionMissingAsPrimary
      ? textAudit.missing_char_cells_by_recognition
      : missingStats.missingCharCells,
    pageCleanliness,
    textAudit,
    penalties,
    totalDeduction,
    pageTotalScore,
    pageScoreLevel: levelFromScore(pageTotalScore, config)
  };
}

module.exports = {
  buildTextAudit,
  calculateMissingCharStats,
  calculatePageCleanliness,
  buildPagePenaltySummary
};
