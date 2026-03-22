const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const scoringPlugin = require('../index');
const segmentationPlugin = require('../../05_切分插件/index');
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

  assert.strictEqual(result.summary.total_cells, 70);
  assert.strictEqual(result.results.length, 70);
  assert(result.summary.scored_cells >= 60, '整页联调中应有大部分方格被识别为有效字');
  assert(Array.isArray(result.summary.blank_cell_ids), '整页联调应返回空白格ID列表');
  assert(Array.isArray(result.summary.low_score_cell_ids), '整页联调应返回低分格ID列表');
  assert(Array.isArray(result.summary.review_cell_ids), '整页联调应返回复核格ID列表');
  assert(Array.isArray(result.page_stats.status_matrix), '整页联调应返回状态矩阵');
  assert(Array.isArray(result.grid_results), '整页联调应返回二维网格结果');
  assert(result.grid_results.length === 7 && result.grid_results[0].length === 10, '二维网格结果尺寸应与方格矩阵一致');
  assert(result.summary.avg_score !== null, '整页联调中的平均分不应为空');

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

if (require.main === module) {
  (async () => {
    await testRuleScoring();
    await testEndToEndWithSegmentationPlugin();
    await testTargetCharSimilarity();
    await testTargetCharStructure();
    await testGuideNoiseBlankDetection();
    await testConfigOverride();
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
  testConfigOverride
};
