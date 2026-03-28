const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const scoringPlugin = require('../index');
const segmentationPlugin = require('../../05_切分插件/index');
const cellLayerExtractPlugin = require('../../06_单格背景文字提取插件/index');
const { normalizeContentBox } = require('../application/cell_scoring_service');
const { buildOcrCells, resolveRecognizedCharsWithOcr } = require('../application/ocr_diagnostics_service');
const { scoreSegmentation: scoreSegmentationService } = require('../application/page_scoring_service');
const { extractFeatures } = require('../scoring');
const { detectBlank } = require('../domain/blank_detection');
const { resolveConfig } = require('../config');
const { generateTestA4Image } = require('../../05_切分插件/test/generate_test_image');

async function createCellImage({ width = 200, height = 200, rectX, rectY, rectWidth, rectHeight }) {
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';

  if (rectWidth && rectHeight) {
    svg += `<rect x="${rectX}" y="${rectY}" width="${rectWidth}" height="${rectHeight}" fill="black"/>`;
  }

  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createCharCellImage({ width = 200, height = 200, char, fontSize = 110 }) {
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';
  svg += `<text x="${width / 2}" y="${height / 2}" font-family="sans-serif" font-size="${fontSize}" text-anchor="middle" dominant-baseline="middle" fill="black">${char}</text>`;
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createGuideNoiseCellImage({ width = 200, height = 200 } = {}) {
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';
  svg += '<line x1="24" y1="40" x2="176" y2="40" stroke="black" stroke-width="6"/>';
  svg += '<line x1="150" y1="28" x2="150" y2="172" stroke="black" stroke-width="5" stroke-dasharray="10 8"/>';
  svg += '<line x1="22" y1="12" x2="198" y2="12" stroke="black" stroke-width="8"/>';
  svg += '<line x1="192" y1="8" x2="192" y2="120" stroke="black" stroke-width="7"/>';
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createInnerMiGuideResidualCellImage({ width = 220, height = 220, withOuterFrame = true, withCircleGuide = false } = {}) {
  const inset = 26;
  const centerX = width / 2;
  const centerY = height / 2;
  const left = inset;
  const right = width - inset;
  const top = inset;
  const bottom = height - inset;
  const radius = Math.min(right - left, bottom - top) / 2 - 6;
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';

  if (withOuterFrame) {
    svg += `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="none" stroke="#666" stroke-width="6" stroke-dasharray="16 12"/>`;
  }

  if (withCircleGuide) {
    svg += `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="none" stroke="#666" stroke-width="6" stroke-dasharray="16 12"/>`;
  }

  svg += `<line x1="${centerX}" y1="${top + 22}" x2="${centerX}" y2="${bottom - 22}" stroke="#555" stroke-width="6" stroke-dasharray="16 12"/>`;
  svg += `<line x1="${left + 22}" y1="${centerY}" x2="${right - 22}" y2="${centerY}" stroke="#555" stroke-width="6" stroke-dasharray="16 12"/>`;
  svg += `<line x1="${left + 18}" y1="${top + 18}" x2="${right - 18}" y2="${bottom - 18}" stroke="#555" stroke-width="6" stroke-dasharray="16 12"/>`;
  svg += `<line x1="${left + 18}" y1="${bottom - 18}" x2="${right - 18}" y2="${top + 18}" stroke="#555" stroke-width="6" stroke-dasharray="16 12"/>`;
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function testRuleScoring() {
  const centered = await createCellImage({
    rectX: 55,
    rectY: 45,
    rectWidth: 90,
    rectHeight: 110
  });
  const leftShifted = await createCellImage({
    rectX: 18,
    rectY: 45,
    rectWidth: 90,
    rectHeight: 110
  });
  const blank = await createCellImage({});

  const segmentation = {
    gridRows: 1,
    gridCols: 3,
    cells: [
      { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 55, top: 45, width: 90, height: 110 } },
      { row: 0, col: 1, pageBox: { left: 200, top: 0, width: 200, height: 200 }, contentBox: { left: 18, top: 45, width: 90, height: 110 } },
      { row: 0, col: 2, pageBox: { left: 400, top: 0, width: 200, height: 200 }, contentBox: { left: 0, top: 0, width: 200, height: 200 } }
    ],
    matrix: [[centered, leftShifted, blank]]
  };

  const result = await scoringPlugin.execute({
    task_id: 'test-task',
    image_id: 'page-1',
    target_chars: [['永', '永', '永']],
    segmentation
  });

  assert.strictEqual(result.summary.total_cells, 3);
  assert.strictEqual(result.summary.blank_cells, 1);
  assert.deepStrictEqual(result.summary.blank_cell_ids, ['0_2']);
  assert.deepStrictEqual(result.summary.scored_cell_ids, ['0_0', '0_1']);
  assert(result.summary.review_cell_ids.includes('0_2'), '空白格应进入复核/标记列表');
  assert.strictEqual(result.summary.expected_target_cells, 3);
  assert.strictEqual(result.summary.missing_char_count, 1);
  assert.deepStrictEqual(result.summary.missing_char_cell_ids, ['0_2']);
  assert(Array.isArray(result.summary.page_penalties), '应返回整页扣分项');
  assert(result.summary.page_penalties.some((item) => item.code === 'MISSING_CHAR'), '漏写应进入整页扣分项');
  assert.strictEqual(result.summary.avg_score, result.summary.base_avg_score, 'avg_score 应保持基础平均分语义');
  assert(result.summary.page_total_score <= result.summary.base_avg_score, '整页总分不应高于基础平均分');
  assert.strictEqual(result.page_stats.status_matrix[0][2], 'blank');
  assert.strictEqual(result.grid_results[0][2].action, 'mark_blank');
  assert.strictEqual(result.grid_results[0][2].label, '空白');
  assert.strictEqual(result.grid_results[0][0].status, 'scored');
  assert.strictEqual(result.results.length, 3);

  const centeredResult = result.results[0];
  const shiftedResult = result.results[1];
  const blankResult = result.results[2];

  assert.strictEqual(centeredResult.is_blank, false);
  assert.strictEqual(blankResult.is_blank, true);
  assert.strictEqual(centeredResult.status, 'scored');
  assert.strictEqual(blankResult.status, 'blank');
  assert(blankResult.blank_reason, '空白格应返回 blank_reason');
  assert(centeredResult.total_score > shiftedResult.total_score, '居中字符得分应高于明显偏左字符');
  assert(shiftedResult.penalties.some((item) => item.code === 'CENTER_LEFT'), '偏左字符应触发字心偏左解释');
  assert(centeredResult.sub_scores.layout > shiftedResult.sub_scores.layout, '偏左字符布局分应更低');
  assert(result.summary.avg_score > 0, '非空格平均分应大于0');

  console.log('测试通过：评分插件能够识别空白格，并对偏移字符给出更低布局分。');
}

async function testEndToEndWithSegmentationPlugin() {
  const fixtureDir = path.join(__dirname, 'fixtures');
  const pagePath = path.join(fixtureDir, 'integration_page.png');

  await fs.promises.mkdir(fixtureDir, { recursive: true });
  await generateTestA4Image(pagePath);

  const segmentation = await segmentationPlugin.execute({
    imagePath: pagePath,
    returnBase64: false,
    cropToGrid: true,
    trimContent: false
  });

  const targetChars = Array.from({ length: 7 }, () => ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']);
  const result = await scoringPlugin.execute({
    task_id: 'integration-task',
    image_id: 'integration-page',
    target_chars: targetChars,
    segmentation
  });

  const expectedTotalCells = segmentation.gridRows * segmentation.gridCols;
  assert.strictEqual(result.summary.total_cells, expectedTotalCells);
  assert.strictEqual(result.results.length, expectedTotalCells);
  assert(
    result.summary.scored_cells >= Math.floor(expectedTotalCells * 0.6),
    '整页联调中应有多数方格被识别为有效字'
  );
  assert(Array.isArray(result.summary.blank_cell_ids), '整页联调应返回空白格ID列表');
  assert(Array.isArray(result.summary.low_score_cell_ids), '整页联调应返回低分格ID列表');
  assert(Array.isArray(result.summary.review_cell_ids), '整页联调应返回复核格ID列表');
  assert(Array.isArray(result.summary.page_penalties), '整页联调应返回页级扣分信息');
  assert(Array.isArray(result.page_stats.status_matrix), '整页联调应返回状态矩阵');
  assert(Array.isArray(result.grid_results), '整页联调应返回二维网格结果');
  assert(
    result.grid_results.length === segmentation.gridRows && result.grid_results[0].length === segmentation.gridCols,
    '二维网格结果尺寸应与方格矩阵一致'
  );
  assert(result.summary.avg_score !== null, '整页联调中的平均分不应为空');
  assert(result.summary.page_total_score !== null, '整页联调应返回整页总分');
  assert.strictEqual(result.summary.avg_score, result.summary.base_avg_score, '整页联调中 avg_score 应保持基础平均分语义');

  const first = result.results[0];
  assert.strictEqual(first.is_blank, false);
  assert(first.total_score > 0, '联调首格得分应大于0');
  assert(first.features.primaryAreaRatio > 0.001, '联调首格应检测到有效主连通域');

  console.log('测试通过：切分插件输出可被评分插件直接消费，并完成整页70格评分。');
}

async function testTargetCharSimilarity() {
  const cellImage = await createCharCellImage({ char: '永' });

  const matched = await scoringPlugin.execute({
    task_id: 'similarity-match',
    image_id: 'page-match',
    target_chars: [['永']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }],
      matrix: [[cellImage]]
    }
  });

  const mismatched = await scoringPlugin.execute({
    task_id: 'similarity-mismatch',
    image_id: 'page-mismatch',
    target_chars: [['口']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }],
      matrix: [[cellImage]]
    }
  });

  const matchedResult = matched.results[0];
  const mismatchedResult = mismatched.results[0];

  assert(matchedResult.sub_scores.similarity !== null, '目标字存在时应输出相似度子分');
  assert(matchedResult.sub_scores.similarity > mismatchedResult.sub_scores.similarity, '匹配目标字的相似度应高于不匹配目标字');
  assert(matchedResult.total_score > mismatchedResult.total_score, '匹配目标字的总分应高于不匹配目标字');

  console.log('测试通过：目标字模板相似度能够参与评分，并区分匹配与不匹配目标字。');
}

async function testTargetCharStructure() {
  const cellImage = await createCharCellImage({ char: '明' });

  const matched = await scoringPlugin.execute({
    task_id: 'structure-match',
    image_id: 'page-structure-match',
    target_chars: [['明']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 35, top: 35, width: 130, height: 130 } }],
      matrix: [[cellImage]]
    }
  });

  const mismatched = await scoringPlugin.execute({
    task_id: 'structure-mismatch',
    image_id: 'page-structure-mismatch',
    target_chars: [['口']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 35, top: 35, width: 130, height: 130 } }],
      matrix: [[cellImage]]
    }
  });

  const matchedResult = matched.results[0];
  const mismatchedResult = mismatched.results[0];

  assert(matchedResult.sub_scores.structure !== null, '目标字存在时应输出结构子分');
  assert(matchedResult.sub_scores.structure > mismatchedResult.sub_scores.structure, '匹配目标字的结构分应高于不匹配目标字');
  assert(
    mismatchedResult.penalties.some((item) => item.code.startsWith('STRUCTURE_')),
    '结构不匹配时应输出结构类解释'
  );

  console.log('测试通过：目标字结构评分能够参与评分，并输出结构失衡解释。');
}

async function testGuideNoiseBlankDetection() {
  const guideNoiseBlank = await createGuideNoiseCellImage();
  const singleStrokeChar = await createCharCellImage({ char: '一', fontSize: 128 });

  const blankResult = await scoringPlugin.execute({
    task_id: 'guide-noise-blank',
    image_id: 'guide-noise-page',
    target_chars: [[null]],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 0, top: 0, width: 200, height: 200 } }],
      matrix: [[guideNoiseBlank]]
    }
  });

  const strokeResult = await scoringPlugin.execute({
    task_id: 'guide-noise-stroke',
    image_id: 'guide-noise-stroke-page',
    target_chars: [['一']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 0, top: 0, width: 200, height: 200 } }],
      matrix: [[singleStrokeChar]]
    }
  });

  assert.strictEqual(blankResult.results[0].status, 'blank', '仅包含练字纸辅助线残留的方格应识别为空白');
  assert.strictEqual(strokeResult.results[0].status, 'scored', '真实笔画不应被辅助线清理误判为空白');

  console.log('测试通过：辅助线/边框残留可被空白检测清理，真实单横笔画仍可保留为有效字。');
}

async function testConfigOverride() {
  const shifted = await createCellImage({
    rectX: 20,
    rectY: 45,
    rectWidth: 90,
    rectHeight: 110
  });

  const baseResult = await scoringPlugin.execute({
    task_id: 'config-base',
    image_id: 'config-page',
    target_chars: [[null]],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 20, top: 45, width: 90, height: 110 } }],
      matrix: [[shifted]]
    }
  });

  const relaxedResult = await scoringPlugin.execute({
    task_id: 'config-relaxed',
    image_id: 'config-page',
    target_chars: [[null]],
    options: {
      config: {
        layout: {
          center_penalty_scale: 300
        }
      }
    },
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 20, top: 45, width: 90, height: 110 } }],
      matrix: [[shifted]]
    }
  });

  assert(
    relaxedResult.results[0].sub_scores.layout > baseResult.results[0].sub_scores.layout,
    '覆盖配置后，较低的中心偏移惩罚应提高布局分'
  );

  console.log('测试通过：评分插件支持通过 options.config 覆盖默认评分配置。');
}

async function testComplexCharacterRuleNormalization() {
  const {
    calculateStrokeQualityScore,
    calculateCleanlinessScore
  } = require('../domain/rule_scoring');

  const config = resolveConfig();
  const complexButCleanFeatures = {
    edgeTouchInkRatio: 0.03,
    rowTransitionMean: 6.2,
    colTransitionMean: 6.0,
    rowCenterJitter: 0.03,
    noiseComponentCount: 11,
    significantComponentCount: 4,
    meanStrokeWidthStdRatio: 0.32,
    strokeDensity: 0.34,
    bboxRatio: 0.28
  };

  const strokeQuality = calculateStrokeQualityScore(complexButCleanFeatures, config);
  const cleanliness = calculateCleanlinessScore(complexButCleanFeatures, config);

  assert(
    strokeQuality.details.stability > 50,
    '复杂字不应因转折较多而被一律压成极低稳定性'
  );
  assert(
    cleanliness > 40,
    '复杂字不应因原始连通域计数较高而被一律压成接近0分的整洁度'
  );

  console.log('测试通过：复杂字会先做复杂度归一化，再计算稳定性与整洁度。');
}

async function testCircleGuidePatternRelaxesBboxExpectation() {
  const {
    calculateStructureAccuracyScore,
    buildPenalties
  } = require('../domain/rule_scoring');

  const config = resolveConfig();
  const baseFeatures = {
    centerDx: 0,
    centerDy: 0,
    marginBalanceX: 0.92,
    marginBalanceY: 0.92,
    bboxRatio: 0.255,
    aspectRatio: 0.9,
    rowWidthStdRatio: 0.08,
    colWidthStdRatio: 0.08,
    rowCenterJitter: 0.03,
    significantComponentCount: 1,
    rowTransitionMean: 2.2,
    colTransitionMean: 2.3,
    edgeTouchInkRatio: 0.03,
    strokeDensity: 0.44,
    noiseComponentCount: 0,
    meanStrokeWidthStdRatio: 0.1
  };

  const squareFeatures = { ...baseFeatures, guideGridType: 'square' };
  const circleFeatures = { ...baseFeatures, guideGridType: 'circle_mi' };

  const squareScore = calculateStructureAccuracyScore(squareFeatures, config);
  const circleScore = calculateStructureAccuracyScore(circleFeatures, config);
  const squarePenalties = buildPenalties(squareFeatures, config);
  const circlePenalties = buildPenalties(circleFeatures, config);

  assert(
    circleScore.score > squareScore.score,
    '圆形米字格在相同 bboxRatio 下应比普通方格获得更合理的布局分'
  );
  assert(
    squarePenalties.some((item) => item.code === 'LOW_BBOX_RATIO'),
    '普通方格样本应保留整体偏小处罚'
  );
  assert(
    !circlePenalties.some((item) => item.code === 'LOW_BBOX_RATIO'),
    '圆形米字格样本应放宽整体偏小处罚'
  );

  console.log('测试通过：circle pattern 会放宽圆形字格的占格比例要求。');
}

async function testInnerGuideResidueBlankCleanup() {
  const guideResidual = await createInnerMiGuideResidualCellImage({ withOuterFrame: false });
  const config = resolveConfig({ image: { grid_type: 'mi' } });
  const features = await extractFeatures(guideResidual, {
    config,
    patternProfile: {
      family: 'diagonal-mi-grid',
      signals: {
        diagonalSignal: 0.28,
        crossSignal: 0.27,
        centerSignal: 0.3
      }
    }
  });
  const blankResult = detectBlank(features, config);

  assert.strictEqual(blankResult.isBlank, true, '单格内部米字虚线残留应在清理后判为空白');
  assert(
    features.blankDetection.componentCount <= 2,
    '米字虚线残留清理后不应保留大量内部碎片连通域'
  );

  console.log('测试通过：单格内部米字虚线残留可被清理，并恢复为空白格。');
}

async function testCircleMiGuideResidueBlankCleanup() {
  const guideResidual = await createInnerMiGuideResidualCellImage({ withOuterFrame: false, withCircleGuide: true });
  const config = resolveConfig({ image: { grid_type: 'square' } });
  const baselineFeatures = await extractFeatures(guideResidual, {
    config,
    patternProfile: null
  });
  const features = await extractFeatures(guideResidual, {
    config,
    patternProfile: {
      family: 'template-circle-mi-grid',
      profileMode: 'circle-mi-grid',
      signals: {
        diagonalSignal: 0.28,
        crossSignal: 0.27,
        centerSignal: 0.3
      }
    }
  });
  const blankResult = detectBlank(features, config);

  assert.strictEqual(blankResult.isBlank, true, '单格内部圆形米字格残留应在清理后判为空白');
  assert(
    features.blankDetection.componentCount < baselineFeatures.blankDetection.componentCount,
    '启用 circle patternProfile 后，圆形米字格残留连通域数量应明显下降'
  );

  console.log('测试通过：单格内部圆形米字格残留可被清理，并恢复为空白格。');
}

async function testBlankLikeGuideResidueDetection() {
  const config = resolveConfig();
  const features = {
    inkRatio: 0.02,
    primaryAreaRatio: 0.0016,
    bboxRatio: 0.004,
    centralInkRatio: 0.06,
    componentCount: 28,
    significantComponentCount: 3,
    noiseComponentCount: 24,
    strokeDensity: 0.21,
    marginBalanceX: 0.95,
    marginBalanceY: 0.96,
    blankDetection: {
      inkRatio: 0.02,
      primaryAreaRatio: 0.0016,
      bboxRatio: 0.004,
      centralInkRatio: 0.06,
      componentCount: 28,
      significantComponentCount: 3,
      noiseComponentCount: 24,
      strokeDensity: 0.21,
      marginBalanceX: 0.95,
      marginBalanceY: 0.96
    }
  };

  const blankResult = detectBlank(features, config);
  assert.strictEqual(blankResult.isBlank, true, 'blank-like 底纹碎片残留应判为空白');

  console.log('测试通过：blank-like 底纹碎片残留可被空白判定拦截。');
}

async function testPageScoringUsesCellLayerTextOnlyImage() {
  const original = await createCharCellImage({ char: '永' });
  const blank = await createCellImage({});
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hanzi-scoring-cell-layer-'));
  const blankTextOnlyPath = path.join(tmpDir, 'text_only.png');
  await fs.promises.writeFile(blankTextOnlyPath, blank);

  const result = await scoreSegmentationService({
    task_id: 'cell-layer-text-only',
    image_id: 'cell-layer-text-only-page',
    target_chars: [['永']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 } }],
      matrix: [[original]]
    },
    cellLayerExtraction: {
      cells: [
        {
          row: 0,
          col: 0,
          outputs: {
            textOnlyPath: blankTextOnlyPath
          }
        }
      ]
    },
    options: {
      config: resolveConfig()
    }
  });

  assert.strictEqual(result.results[0].status, 'blank', '评分阶段应优先读取 06_4_单格文字图，而不是回退原始单格图');

  console.log('测试通过：页面评分会优先消费 06_4_单格文字图。');
}

async function testCellScoringServiceHelpers() {
  assert.strictEqual(normalizeContentBox(null), null, '空单元格应返回 null');
  assert.deepStrictEqual(
    normalizeContentBox({ content_box: { left: 1, top: 2, width: 3, height: 4 } }),
    { left: 1, top: 2, width: 3, height: 4 },
    '已有 content_box 时应直接复用'
  );
  assert.deepStrictEqual(
    normalizeContentBox({ page_box: { width: 120, height: 90 } }),
    { left: 0, top: 0, width: 120, height: 90 },
    '缺少 content_box 时应回退为 page_box 尺寸'
  );

  console.log('测试通过：单格评分应用服务辅助函数可正确规范化内容框。');
}

async function testOcrDiagnosticsServiceHelpers() {
  const matrixCell = await createCharCellImage({ char: '永' });
  const segmentation = {
    gridRows: 1,
    gridCols: 2,
    cells: [
      { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 } },
      { row: 0, col: 1, pageBox: { left: 200, top: 0, width: 200, height: 200 } }
    ],
    matrix: [[matrixCell, matrixCell]]
  };

  const ocrCells = buildOcrCells({
    segmentation,
    targetChars: [['永', null]],
    cellLayerExtraction: {
      cells: [
        { row: 0, col: 0, outputs: { textOnlyPath: '/tmp/cell-0.png' } }
      ]
    }
  });

  assert.strictEqual(ocrCells.length, 2, '应为每个格子构建 OCR 任务');
  assert.deepStrictEqual(ocrCells[0], {
    cell_id: '0_0',
    row: 0,
    col: 0,
    target_char: '永',
    image_path: '/tmp/cell-0.png'
  });
  assert.strictEqual(ocrCells[1].image_path, null, '缺少分层输出时应回退为 null');

  const recognizedChars = [['永']];
  const resolved = await resolveRecognizedCharsWithOcr({
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 } }],
      matrix: [[matrixCell]]
    },
    recognizedChars,
    ocrOptions: { enabled: true }
  });

  assert.strictEqual(resolved.recognizedChars, recognizedChars, '已提供 recognized_chars 时应直接复用');
  assert.strictEqual(resolved.ocrDiagnostics, null, '已提供 recognized_chars 时不应触发 OCR');

  console.log('测试通过：OCR 应用服务可正确构建 OCR 任务，并在已有 recognized_chars 时跳过 OCR。');
}

async function testPageScoringServiceAssembly() {
  const matrixCell = await createCharCellImage({ char: '永' });
  const pageScoringAggregationService = require('../application/page_scoring_aggregation_service');
  const originalAggregatePageScoring = pageScoringAggregationService.aggregatePageScoring;
  let capturedParams = null;

  pageScoringAggregationService.aggregatePageScoring = async function patchedAggregatePageScoring(params) {
    capturedParams = params;
    return {
      summary: { total_cells: 1, avg_score: 95, base_avg_score: 95, page_total_score: 95 },
      outputDir: '/tmp/page-output',
      cellsRootDir: '/tmp/page-output/cells',
      page_stats: { status_matrix: [['scored']] },
      grid_results: [[{ cell_id: '0_0', status: 'scored' }]],
      results: [{ cell_id: '0_0', status: 'scored', penalties: [] }],
      中文结果: {
        汇总信息: { 总格数: 1 },
        页面统计: { 状态矩阵: [['scored']] },
        网格结果: [[{ 单格编号: '0_0' }]],
        单格结果: [{ 单格编号: '0_0' }]
      }
    };
  };

  try {
    const result = await scoreSegmentationService({
      task_id: 'service-task',
      image_id: 'service-image',
      target_chars: [['永']],
      recognized_chars: [['永']],
      segmentation: {
        gridRows: 1,
        gridCols: 1,
        cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 } }],
        matrix: [[matrixCell]]
      }
    });

    assert(capturedParams, '整页评分应用服务应调用页面聚合服务');
    assert.deepStrictEqual(capturedParams.target_chars, [['永']], '应将 target_chars 透传给页面聚合服务');
    assert.deepStrictEqual(capturedParams.recognized_chars, [['永']], '应将 recognized_chars 透传给页面聚合服务');
    assert.strictEqual(result.summary.total_cells, 1, '应返回页面聚合服务生成的 summary');
    assert.strictEqual(result.中文结果.任务ID, 'service-task', '应组装顶层中文结果');
    assert.strictEqual(result.中文结果.图片ID, 'service-image', '应组装顶层中文结果中的图片ID');
    assert.strictEqual(result.ocr, null, '未触发 OCR 时应返回 null');
  } finally {
    pageScoringAggregationService.aggregatePageScoring = originalAggregatePageScoring;
  }

  console.log('测试通过：整页评分应用服务可正确组装顶层结果并编排页面聚合服务。');
}

async function testPageTextAudit() {
  const matched = await createCharCellImage({ char: '永' });
  const mismatched = await createCharCellImage({ char: '口' });
  const blank = await createCellImage({});

  const result = await scoringPlugin.execute({
    task_id: 'text-audit',
    image_id: 'text-audit-page',
    target_chars: [['永', '永', null]],
    recognized_chars: [['永', '口', '山']],
    segmentation: {
      gridRows: 1,
      gridCols: 3,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } },
        { row: 0, col: 1, pageBox: { left: 200, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } },
        { row: 0, col: 2, pageBox: { left: 400, top: 0, width: 200, height: 200 }, contentBox: { left: 0, top: 0, width: 200, height: 200 } }
      ],
      matrix: [[matched, mismatched, blank]]
    }
  });

  assert.strictEqual(result.summary.ocr_supported, true, '传入 recognized_chars 后应启用文本校验');
  assert.strictEqual(result.summary.text_audit.wrong_char_count, 1, '应识别出 1 个错字');
  assert.strictEqual(result.summary.text_audit.extra_char_count, 1, '应识别出 1 个添字');
  assert.strictEqual(result.summary.text_audit.missing_char_count_by_recognition, 0, '本例不应识别出漏字');
  assert(result.summary.page_penalties.some((item) => item.code === 'WRONG_CHAR'), '页级扣分应包含错字');
  assert(result.summary.page_penalties.some((item) => item.code === 'EXTRA_CHAR'), '页级扣分应包含添字');
  assert(!result.summary.page_penalties.some((item) => item.code === 'MISSING_CHAR'), '接入 recognized_chars 后不应再叠加启发式漏写扣分');
  assert(result.summary.page_total_score < result.summary.base_avg_score, '文本校验扣分后整页总分应下降');

  console.log('测试通过：整页评分支持接入 recognized_chars 执行错字/添字校验。');
}

async function testPageTextAuditWithObjectRecognizedChars() {
  const matched = await createCharCellImage({ char: '永' });
  const blank = await createCellImage({});

  const result = await scoringPlugin.execute({
    task_id: 'text-audit-object',
    image_id: 'text-audit-object-page',
    target_chars: [['永', '永']],
    recognized_chars: {
      '0_0': '永',
      '0_1': ''
    },
    segmentation: {
      gridRows: 1,
      gridCols: 2,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } },
        { row: 0, col: 1, pageBox: { left: 200, top: 0, width: 200, height: 200 }, contentBox: { left: 0, top: 0, width: 200, height: 200 } }
      ],
      matrix: [[matched, blank]]
    }
  });

  assert.strictEqual(result.summary.ocr_supported, true, '对象映射 recognized_chars 也应启用文本校验');
  assert.strictEqual(result.summary.text_audit.wrong_char_count, 0, '对象映射场景下不应误报错字');
  assert.strictEqual(result.summary.text_audit.extra_char_count, 0, '对象映射场景下不应误报添字');
  assert.strictEqual(result.summary.text_audit.missing_char_count_by_recognition, 1, '空字符串应按未识别处理并计入漏字');
  assert(result.summary.page_penalties.some((item) => item.code === 'RECOGNITION_MISSING_CHAR'), '对象映射场景下应产生识别漏字扣分');
  assert.deepStrictEqual(result.summary.missing_char_cell_ids, ['0_1'], '应返回识别到的漏字单元格');

  console.log('测试通过：recognized_chars 支持 row_col 对象映射并参与页级文本校验。');
}

async function testAnnotatedPageOutput() {
  const fixtureDir = path.join(__dirname, 'fixtures', 'annotation_output');
  const pagePath = path.join(fixtureDir, 'page.png');
  const annotatedPath = path.join(fixtureDir, 'page_annotated.png');
  const summaryPath = path.join(fixtureDir, 'page_summary.txt');
  const cellImage = await createCharCellImage({ char: '永' });

  await fs.promises.mkdir(fixtureDir, { recursive: true });
  await fs.promises.writeFile(pagePath, cellImage);

  const result = await scoringPlugin.execute({
    task_id: 'annotation-output',
    image_id: 'annotation-output-page',
    imagePath: pagePath,
    outputAnnotatedPath: annotatedPath,
    outputSummaryPath: summaryPath,
    target_chars: [['永']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }
      ],
      matrix: [[cellImage]]
    }
  });

  const annotationMeta = await fs.promises.stat(annotatedPath);
  const summaryText = await fs.promises.readFile(summaryPath, 'utf8');

  assert(result.annotation, '请求输出标注图时应返回 annotation 信息');
  assert(annotationMeta.size > 0, '标注图文件应成功生成');
  assert(summaryText.includes('page_total_score:'), '标注摘要应包含整页总分');
  assert(summaryText.includes('0_0\tscored'), '标注摘要应包含单格状态行');

  console.log('测试通过：评分插件可输出标注图与摘要文件。');
}

async function testCellStepArtifactsOutput() {
  const fixtureDir = path.join(__dirname, 'fixtures', 'cell_step_output');
  const outputDir = path.join(fixtureDir, 'result');
  const cellImage = await createCharCellImage({ char: '永' });

  await fs.promises.mkdir(fixtureDir, { recursive: true });

  const result = await scoringPlugin.execute({
    task_id: 'cell-step-output',
    image_id: 'cell-step-output-page',
    outputDir,
    target_chars: [['永']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }
      ],
      matrix: [[cellImage]]
    }
  });

  const first = result.results[0];
  assert(first.stepDirs.step07_1, '应返回步骤目录');
  assert(first.stepMetaPaths.step07_1, '应返回步骤 JSON 路径');
  assert(first.stepMetaPaths.step07_5, '应返回总评分步骤 JSON 路径');
  assert((await fs.promises.stat(first.stepMetaPaths.step07_1)).isFile(), '特征提取步骤 JSON 应存在');
  assert((await fs.promises.stat(first.stepMetaPaths.step07_5)).isFile(), '总评分步骤 JSON 应存在');

  console.log('测试通过：评分插件可输出单格步骤目录与步骤 JSON。');
}

async function testScoringArtifactLevelStandardSuppressesCellStepArtifacts() {
  const fixtureDir = path.join(__dirname, 'fixtures', 'cell_step_policy');
  const outputDir = path.join(fixtureDir, 'standard');
  const cellImage = await createCharCellImage({ char: '永' });

  await fs.promises.mkdir(fixtureDir, { recursive: true });
  await fs.promises.rm(outputDir, { recursive: true, force: true });

  const result = await scoringPlugin.execute({
    task_id: 'cell-step-policy-standard',
    image_id: 'cell-step-policy-standard-page',
    outputDir,
    artifactLevel: 'standard',
    target_chars: [['永']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }
      ],
      matrix: [[cellImage]]
    }
  });

  const first = result.results[0];
  assert.strictEqual(result.artifactLevel, 'standard', '应回显 standard artifactLevel');
  assert.strictEqual(result.outputDir, null, 'standard 模式不应保留单格步骤输出根目录');
  assert.strictEqual(result.cellsRootDir, null, 'standard 模式不应保留单格评分详情目录');
  assert.strictEqual(result.ocrOutputDir, null, '未启用 OCR 时不应返回 OCR 输出目录');
  assert.deepStrictEqual(first.stepDirs, {}, 'standard 模式不应返回步骤目录');
  assert.strictEqual(first.stepMetaPaths.step07_1, null, 'standard 模式不应输出步骤 JSON');
  assert.strictEqual(first.stepMetaPaths.step07_5, null, 'standard 模式不应输出总评分步骤 JSON');
  assert.strictEqual(await pathExists(outputDir), false, 'standard 模式不应在磁盘落盘单格步骤目录');

  console.log('测试通过：评分插件在 standard 模式下可抑制单格步骤产物。');
}

async function testPageScoringConcurrencyPreservesOrder() {
  const cellScoringService = require('../application/cell_scoring_service');
  const originalScoreCell = cellScoringService.scoreCell;
  let active = 0;
  let maxActive = 0;

  cellScoringService.scoreCell = async function patchedScoreCell(...args) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      return await originalScoreCell(...args);
    } finally {
      active -= 1;
    }
  };

  try {
    const centered = await createCellImage({
      rectX: 55,
      rectY: 45,
      rectWidth: 90,
      rectHeight: 110
    });
    const shifted = await createCellImage({
      rectX: 18,
      rectY: 45,
      rectWidth: 90,
      rectHeight: 110
    });
    const blank = await createCellImage({});

    const result = await scoringPlugin.execute({
      task_id: 'page-scoring-concurrency',
      image_id: 'page-scoring-concurrency-page',
      target_chars: [['永', '永', '永']],
      options: {
        config: {
          execution: {
            page_scoring_concurrency: 2
          }
        }
      },
      segmentation: {
        gridRows: 1,
        gridCols: 3,
        cells: [
          { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 55, top: 45, width: 90, height: 110 } },
          { row: 0, col: 1, pageBox: { left: 200, top: 0, width: 200, height: 200 }, contentBox: { left: 18, top: 45, width: 90, height: 110 } },
          { row: 0, col: 2, pageBox: { left: 400, top: 0, width: 200, height: 200 }, contentBox: { left: 0, top: 0, width: 200, height: 200 } }
        ],
        matrix: [[centered, shifted, blank]]
      }
    });

    assert(maxActive >= 2, '配置并发度后应实际发生并发评分');
    assert.deepStrictEqual(result.results.map((item) => item.cell_id), ['0_0', '0_1', '0_2'], '并发评分后结果顺序应保持稳定');
    assert.strictEqual(result.grid_results[0][0].cell_id, '0_0');
    assert.strictEqual(result.grid_results[0][1].cell_id, '0_1');
    assert.strictEqual(result.grid_results[0][2].cell_id, '0_2');

    console.log('测试通过：页级评分支持可控并发，且结果顺序保持稳定。');
  } finally {
    cellScoringService.scoreCell = originalScoreCell;
  }
}

async function testAutoOcrIntegration() {
  const tmpDir = path.join(__dirname, 'fixtures', 'mock_ocr');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const fakeImagePath = path.join(tmpDir, 'cell.png');
  const fakeScriptPath = path.join(tmpDir, 'mock_ocr.py');
  await fs.promises.writeFile(fakeImagePath, await createCellImage({}));
  await fs.promises.writeFile(fakeScriptPath, `
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    manifest = json.load(f)
results = []
for item in manifest.get('cells', []):
    cell_id = item.get('cell_id')
    if cell_id == '0_0':
        text = '永'
    else:
        text = '口'
    results.append({
        'cell_id': cell_id,
        'row': item.get('row'),
        'col': item.get('col'),
        'target_char': item.get('target_char'),
        'recognized_char': text,
        'raw_text': text,
        'confidence': 0.99,
        'status': 'recognized'
    })
print(json.dumps({'supported': True, 'engine': 'MockOCR', 'results': results}, ensure_ascii=False))
`, 'utf8');

  const matched = await createCharCellImage({ char: '永' });
  const mismatched = await createCharCellImage({ char: '口' });
  const result = await scoringPlugin.execute({
    task_id: 'auto-ocr',
    image_id: 'auto-ocr-page',
    target_chars: [['永', '永']],
    segmentation: {
      gridRows: 1,
      gridCols: 2,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } },
        { row: 0, col: 1, pageBox: { left: 200, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }
      ],
      matrix: [[matched, mismatched]]
    },
    cellLayerExtraction: {
      cells: [
        { row: 0, col: 0, outputs: { textOnlyPath: fakeImagePath } },
        { row: 0, col: 1, outputs: { textOnlyPath: fakeImagePath } }
      ]
    },
    options: {
      ocr: {
        enabled: true,
        pythonPath: '/home/lc/miniconda3/bin/python3',
        scriptPath: fakeScriptPath
      }
    }
  });

  assert(result.ocr && result.ocr.supported, '启用自动 OCR 后应返回 OCR 结果');
  assert.strictEqual(result.summary.ocr_supported, true, '自动 OCR 成功时应启用文本校验');
  assert.strictEqual(result.summary.text_audit.wrong_char_count, 1, '自动 OCR 应驱动错字校验');
  assert(result.summary.page_penalties.some((item) => item.code === 'WRONG_CHAR'), '自动 OCR 后页级扣分应包含错字');

  console.log('测试通过：评分插件可自动调用 OCR 生成 recognized_chars 并参与页级校验。');
}

async function testAutoOcrIsolationAndPreprocessConfig() {
  const tmpDir = path.join(__dirname, 'fixtures', 'mock_ocr_env');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const fakeImagePath = path.join(tmpDir, 'cell.png');
  const fakeScriptPath = path.join(tmpDir, 'mock_ocr_env.py');
  await fs.promises.writeFile(fakeImagePath, await createCellImage({}));
  await fs.promises.writeFile(fakeScriptPath, `
import json, os, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    manifest = json.load(f)
results = []
for item in manifest.get('cells', []):
    results.append({
        'cell_id': item.get('cell_id'),
        'row': item.get('row'),
        'col': item.get('col'),
        'target_char': item.get('target_char'),
        'recognized_char': item.get('target_char'),
        'raw_text': item.get('target_char'),
        'confidence': 0.99,
        'status': 'recognized'
    })
print(json.dumps({
    'supported': True,
    'engine': 'MockOCR',
    'config': manifest.get('config'),
    'runtime': {
        'python_no_user_site': os.environ.get('PYTHONNOUSERSITE') == '1'
    },
    'results': results
}, ensure_ascii=False))
`, 'utf8');

  const matched = await createCharCellImage({ char: '永' });
  const result = await scoringPlugin.execute({
    task_id: 'auto-ocr-env',
    image_id: 'auto-ocr-env-page',
    target_chars: [['永']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }
      ],
      matrix: [[matched]]
    },
    cellLayerExtraction: {
      cells: [
        { row: 0, col: 0, outputs: { textOnlyPath: fakeImagePath } }
      ]
    },
    options: {
      ocr: {
        enabled: true,
        pythonPath: '/home/lc/miniconda3/bin/python3',
        scriptPath: fakeScriptPath,
        preprocess: {
          targetSize: 112
        }
      }
    }
  });

  assert(result.ocr && result.ocr.supported, '应返回 OCR 结果');
  assert.strictEqual(result.ocr.isolatedUserSite, true, 'OCR 插件应声明已隔离 usersite');
  assert.strictEqual(result.ocr.runtime.python_no_user_site, true, 'OCR 子进程应启用 PYTHONNOUSERSITE=1');
  assert.strictEqual(result.ocr.config.preprocess.target_size, 112, '应透传 OCR 预处理配置');

  console.log('测试通过：OCR 插件会隔离 usersite，并透传预处理配置。');
}

async function testRecognizedCharsWithoutTargetsDoesNotPenaltyTextAudit() {
  const matched = await createCharCellImage({ char: '天' });
  const result = await scoringPlugin.execute({
    task_id: 'recognized-no-targets',
    image_id: 'recognized-no-targets-page',
    target_chars: [[null]],
    recognized_chars: [['天']],
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [
        { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 }, contentBox: { left: 40, top: 40, width: 120, height: 120 } }
      ],
      matrix: [[matched]]
    }
  });

  assert.strictEqual(result.summary.ocr_supported, false, '无 target_chars 时不应启用文本扣分');
  assert.strictEqual(result.summary.text_audit.skipped_reason, 'target_chars_unavailable', '应明确说明跳过原因');
  assert(!result.summary.page_penalties.some((item) => item.code === 'EXTRA_CHAR'), '无 target_chars 时不应产生添字扣分');
  assert.strictEqual(
    result.results[0].score_breakdown.alias_semantics.aliases.similarity,
    'cleanliness',
    '无目标字场景下应显式标注 similarity 兼容字段映射到 cleanliness'
  );

  console.log('测试通过：未提供 target_chars 时，recognized_chars 仅作诊断，不参与文本扣分。');
}

async function testCellLayerExtractionUsesPatternProfileGuideInference() {
  const guideResidual = await createInnerMiGuideResidualCellImage();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hanzi-layer-pattern-'));
  const cellLayer = await cellLayerExtractPlugin.execute({
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 220, height: 220 } }],
      matrix: [[guideResidual]]
    },
    outputDir: tmpDir,
    patternProfile: {
      family: 'diagonal-mi-grid',
      signals: {
        diagonalSignal: 0.29,
        crossSignal: 0.27,
        centerSignal: 0.31
      }
    },
    options: {
      config: resolveConfig()
    }
  });

  const cleanedTextOnly = await fs.promises.readFile(cellLayer.cells[0].outputs.textOnlyPath);
  const cleanedFeatures = await extractFeatures(cleanedTextOnly, {
    config: resolveConfig({ image: { grid_type: 'mi' } })
  });

  assert(
    cleanedFeatures.blankDetection.componentCount <= 2,
    '06 阶段应能依据 patternProfile 推断米字格并清理内部虚线残留'
  );

  console.log('测试通过：06 阶段会依据 patternProfile 推断导线类型并清理内部虚线。');
}

async function testCellLayerExtractionUsesCirclePatternProfileGuideInference() {
  const guideResidual = await createInnerMiGuideResidualCellImage({ withCircleGuide: true });
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hanzi-layer-circle-pattern-'));
  const cellLayer = await cellLayerExtractPlugin.execute({
    segmentation: {
      gridRows: 1,
      gridCols: 1,
      cells: [{ row: 0, col: 0, pageBox: { left: 0, top: 0, width: 220, height: 220 } }],
      matrix: [[guideResidual]]
    },
    outputDir: tmpDir,
    patternProfile: {
      family: 'template-circle-mi-grid',
      profileMode: 'circle-mi-grid',
      signals: {
        diagonalSignal: 0.29,
        crossSignal: 0.27,
        centerSignal: 0.31
      }
    },
    options: {
      config: resolveConfig()
    }
  });

  const cleanedTextOnly = await fs.promises.readFile(cellLayer.cells[0].outputs.textOnlyPath);
  const baselineFeatures = await extractFeatures(guideResidual, {
    config: resolveConfig({ image: { grid_type: 'square' } })
  });
  const cleanedFeatures = await extractFeatures(cleanedTextOnly, {
    config: resolveConfig({ image: { grid_type: 'circle_mi' } })
  });

  assert(
    cleanedFeatures.blankDetection.componentCount < baselineFeatures.blankDetection.componentCount,
    '06 阶段应能依据 circle patternProfile 推断圆形米字格并减少圆圈残留连通域'
  );

  console.log('测试通过：06 阶段会依据 circle patternProfile 推断圆形米字格并清理圆圈残留。');
}

async function testContractValidation() {
  const matched = await createCharCellImage({ char: '永' });

  await assert.rejects(
    () => scoringPlugin.execute({
      task_id: 'invalid-contract',
      image_id: 'invalid-contract-page',
      target_chars: [['永', '和']],
      segmentation: {
        gridRows: 1,
        gridCols: 2,
        cells: [
          { row: 0, col: 0, pageBox: { left: 0, top: 0, width: 200, height: 200 } },
          { row: 0, col: 1, pageBox: { left: 200, top: 0, width: 200, height: 200 } }
        ],
        matrix: [[matched]]
      }
    }),
    /segmentation\.matrix\[0\] 列数必须与 segmentation\.gridCols 一致/
  );

  console.log('测试通过：评分插件会对 segmentation 输入契约进行严格校验。');
}

if (require.main === module) {
  (async () => {
    await testRuleScoring();
    await testEndToEndWithSegmentationPlugin();
    await testTargetCharSimilarity();
    await testTargetCharStructure();
    await testGuideNoiseBlankDetection();
    await testConfigOverride();
    await testComplexCharacterRuleNormalization();
    await testCircleGuidePatternRelaxesBboxExpectation();
    await testInnerGuideResidueBlankCleanup();
    await testCircleMiGuideResidueBlankCleanup();
    await testBlankLikeGuideResidueDetection();
    await testPageScoringUsesCellLayerTextOnlyImage();
    await testCellScoringServiceHelpers();
    await testOcrDiagnosticsServiceHelpers();
    await testPageScoringServiceAssembly();
    await testPageTextAudit();
    await testPageTextAuditWithObjectRecognizedChars();
    await testAnnotatedPageOutput();
    await testCellStepArtifactsOutput();
    await testScoringArtifactLevelStandardSuppressesCellStepArtifacts();
    await testPageScoringConcurrencyPreservesOrder();
    await testAutoOcrIntegration();
    await testAutoOcrIsolationAndPreprocessConfig();
    await testRecognizedCharsWithoutTargetsDoesNotPenaltyTextAudit();
    await testCellLayerExtractionUsesPatternProfileGuideInference();
    await testCellLayerExtractionUsesCirclePatternProfileGuideInference();
    await testContractValidation();
  })().catch((error) => {
    console.error('测试失败：', error);
    process.exitCode = 1;
  });
}

module.exports = {
  testRuleScoring,
  testEndToEndWithSegmentationPlugin,
  testTargetCharSimilarity,
  testTargetCharStructure,
  testGuideNoiseBlankDetection,
  testConfigOverride,
  testComplexCharacterRuleNormalization,
  testCircleGuidePatternRelaxesBboxExpectation,
  testInnerGuideResidueBlankCleanup,
  testCircleMiGuideResidueBlankCleanup,
  testBlankLikeGuideResidueDetection,
  testPageScoringUsesCellLayerTextOnlyImage,
  testCellScoringServiceHelpers,
  testOcrDiagnosticsServiceHelpers,
  testPageScoringServiceAssembly,
  testPageTextAudit,
  testPageTextAuditWithObjectRecognizedChars,
  testAnnotatedPageOutput,
  testCellStepArtifactsOutput,
  testScoringArtifactLevelStandardSuppressesCellStepArtifacts,
  testPageScoringConcurrencyPreservesOrder,
  testAutoOcrIntegration,
  testAutoOcrIsolationAndPreprocessConfig,
  testRecognizedCharsWithoutTargetsDoesNotPenaltyTextAudit,
  testCellLayerExtractionUsesPatternProfileGuideInference,
  testCellLayerExtractionUsesCirclePatternProfileGuideInference,
  testContractValidation
};
