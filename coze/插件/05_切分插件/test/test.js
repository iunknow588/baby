const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const hanziPlugin = require('../index');
const boundaryGuideSegmentationPlugin = require('../../05_2边界引导切分插件/index');
const guideLocalizePlugin = require('../../03_0方格边界局部化插件/index');
const guideNormalizePlugin = require('../../05_0方格边界规范化插件/index');
const { generateTestA4Image } = require('./generate_test_image');

async function countDarkPixels(imageBuffer, threshold = 220) {
  const { data, info } = await sharp(imageBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let count = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i] < threshold) {
      count++;
    }
  }
  return count;
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function testPlugin() {
  const fixturePath = path.join(__dirname, 'fixtures', 'test_a4.png');
  const shiftedFixturePath = path.join(__dirname, 'fixtures', 'test_a4_shifted.png');
  const outputDir = path.join(__dirname, 'output');
  const minimalRootDir = path.join(__dirname, 'artifact_minimal');
  const minimalOutputDir = path.join(minimalRootDir, '05_4_单格图');
  const standardRootDir = path.join(__dirname, 'artifact_standard');
  const standardOutputDir = path.join(standardRootDir, '05_4_单格图');
  const stageDirs = [
    path.join(__dirname, '05_1_网格范围检测'),
    path.join(__dirname, '05_2_边界引导切分'),
    path.join(__dirname, '05_3_切分调试渲染'),
    path.join(__dirname, '05_4_单格裁切')
  ];

  await fs.promises.mkdir(path.join(__dirname, 'fixtures'), { recursive: true });
  await generateTestA4Image(fixturePath);
  await generateTestA4Image(shiftedFixturePath, {
    canvasWidth: 1600,
    canvasHeight: 2150,
    offsetX: 140,
    offsetY: 180
  });
  await fs.promises.rm(outputDir, { recursive: true, force: true });
  await fs.promises.rm(minimalRootDir, { recursive: true, force: true });
  await fs.promises.rm(standardRootDir, { recursive: true, force: true });
  for (const stageDir of stageDirs) {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
  }

  const result = await hanziPlugin.execute({
    imagePath: fixturePath,
    returnBase64: false,
    outputDir
  });

  assert.strictEqual(result.gridRows, 7);
  assert.strictEqual(result.gridCols, 10);
  assert.strictEqual(result.totalCells, 70);
  assert.strictEqual(result.matrix.length, 7);
  assert.strictEqual(result.matrix[0].length, 10);
  assert.strictEqual(result.cells.length, 70);

  const files = await fs.promises.readdir(result.outputs.cellsDir);
  assert.strictEqual(files.length, 70);

  const darkPixels = await countDarkPixels(result.matrix[0][0]);
  assert(darkPixels > 100, '切分结果中未检测到足够的汉字像素');
  assert(result.cells[0].contentBox.width > 0, '未返回有效的内容框宽度');
  assert(result.cells[0].contentBox.height > 0, '未返回有效的内容框高度');
  assert(
    result.matrix[0][0].length > 250,
    '保留方格空白后的输出体积异常，可能仍然发生了内容裁剪'
  );
  assert(result.gridBounds.width > 0, '未返回有效的整页网格宽度');
  assert(result.gridBounds.height > 0, '未返回有效的整页网格高度');
  assert.strictEqual(result.artifactLevel, 'debug', '默认应产出 debug 级别产物');

  const shifted = await hanziPlugin.execute({
    imagePath: shiftedFixturePath,
    returnBase64: false,
    cropToGrid: true,
    gridRows: 7,
    gridCols: 10
  });

  assert.strictEqual(shifted.totalCells, 70);
  assert.strictEqual(shifted.cells.length, 70);
  assert(shifted.gridBounds.left > 0, '偏移测试中未检测出网格左边界');
  assert(shifted.gridBounds.top > 0, '偏移测试中未检测出网格上边界');
  const shiftedDarkPixels = await countDarkPixels(shifted.matrix[0][0]);
  assert(shiftedDarkPixels > 100, '偏移测试切分结果中未检测到足够的汉字像素');

  const minimalResult = await hanziPlugin.execute({
    imagePath: fixturePath,
    returnBase64: false,
    outputDir: minimalOutputDir,
    artifactLevel: 'minimal'
  });

  assert.strictEqual(minimalResult.artifactLevel, 'minimal', '最小产物模式应回显 artifactLevel');
  assert.strictEqual(minimalResult.outputs.artifactLevel, 'minimal', '输出摘要应包含 artifactLevel');
  assert.strictEqual(minimalResult.debugOutputPath, null, 'minimal 模式不应落盘调试图');
  assert.strictEqual(minimalResult.debugMetaPath, null, 'minimal 模式不应落盘调试元数据');
  assert.strictEqual(minimalResult.outputs.stepDirs.step05_1, null, 'minimal 模式不应创建 05_1 目录');
  assert.strictEqual(minimalResult.outputs.stepDirs.step05_2, null, 'minimal 模式不应创建 05_2 目录');
  assert.strictEqual(minimalResult.outputs.stepDirs.step05_3, null, 'minimal 模式不应创建 05_3 目录');
  assert.strictEqual(minimalResult.outputs.stepDirs.step05_4, null, 'minimal 模式不应创建 05_4 步骤目录');
  assert.strictEqual(minimalResult.outputs.stepMetaPaths.step05_1, null, 'minimal 模式不应输出 05_1 元数据');
  assert.strictEqual(minimalResult.outputs.stepMetaPaths.step05_2, null, 'minimal 模式不应输出 05_2 元数据');
  assert.strictEqual(minimalResult.outputs.stepMetaPaths.step05_3, null, 'minimal 模式不应输出 05_3 元数据');
  assert.strictEqual(minimalResult.outputs.stepMetaPaths.step05_4, null, 'minimal 模式不应输出 05_4 元数据');
  assert(await pathExists(minimalResult.outputs.cellsDir), 'minimal 模式仍应输出单格图');
  assert(await pathExists(minimalResult.outputs.summaryPath), 'minimal 模式仍应输出汇总 JSON');
  assert.strictEqual(await pathExists(path.join(minimalRootDir, '05_1_网格范围检测')), false, 'minimal 模式不应创建 05_1 目录');
  assert.strictEqual(await pathExists(path.join(minimalRootDir, '05_3_切分调试渲染')), false, 'minimal 模式不应创建 05_3 目录');

  const standardResult = await hanziPlugin.execute({
    imagePath: fixturePath,
    returnBase64: false,
    outputDir: standardOutputDir,
    artifactLevel: 'standard'
  });

  assert.strictEqual(standardResult.artifactLevel, 'standard', '标准产物模式应回显 artifactLevel');
  assert.strictEqual(standardResult.outputs.artifactLevel, 'standard', '标准产物输出摘要应包含 artifactLevel');
  assert.strictEqual(standardResult.debugOutputPath, null, 'standard 模式不应落盘调试图');
  assert.strictEqual(standardResult.debugMetaPath, null, 'standard 模式不应落盘调试元数据');
  assert(await pathExists(standardResult.outputs.cellsDir), 'standard 模式应输出单格图');
  assert(await pathExists(standardResult.outputs.summaryPath), 'standard 模式应输出汇总 JSON');
  assert(await pathExists(standardResult.outputs.stepMetaPaths.step05_1), 'standard 模式应输出 05_1 元数据');
  assert(await pathExists(standardResult.outputs.stepMetaPaths.step05_2), 'standard 模式应输出 05_2 元数据');
  assert(await pathExists(standardResult.outputs.stepMetaPaths.step05_4), 'standard 模式应输出 05_4 元数据');
  assert.strictEqual(standardResult.outputs.stepDirs.step05_3, null, 'standard 模式不应创建 05_3 目录');
  assert.strictEqual(standardResult.outputs.stepMetaPaths.step05_3, null, 'standard 模式不应输出 05_3 元数据');
  assert.strictEqual(await pathExists(path.join(standardRootDir, '05_3_切分调试渲染')), false, 'standard 模式不应落盘 05_3 调试目录');

  const guidedSegmentation = boundaryGuideSegmentationPlugin.execute({
    boundaryGuides: {
      left: 0,
      top: 0,
      right: 1419,
      bottom: 1885,
      xPeaks: [138, 343, 546, 748, 952, 1153, 1354],
      yPeaks: [439, 650, 857, 1064, 1271, 1478, 1687, 1793],
      patternProfile: {
        family: 'diagonal-mi-grid',
        profileMode: 'template-diagonal-mi-grid-no-explicit-outer-frame'
      }
    },
    segmentationProfile: {
      family: 'diagonal-mi-grid',
      profileMode: 'template-diagonal-mi-grid-no-explicit-outer-frame',
      preferUniform: false,
      preferBoundaryGuides: true,
      preferPeakEnvelope: true
    },
    gridRows: 9,
    gridCols: 7,
    width: 1419,
    height: 1885
  });

  assert(guidedSegmentation, '边界引导切分应返回结果');
  assert.strictEqual(guidedSegmentation.yBoundaries[0][0], 0, '显式顶部边界应保留为 0');
  assert.strictEqual(guidedSegmentation.yBoundaries[guidedSegmentation.yBoundaries.length - 1][1], 1885, '显式底部边界应保留为整图高度');
  assert.strictEqual(guidedSegmentation.xBoundaries[0][0], 0, '显式左边界应保留为 0');
  assert.strictEqual(guidedSegmentation.xBoundaries[guidedSegmentation.xBoundaries.length - 1][1], 1419, '显式右边界应保留为整图宽度');
  const guidedRowHeights = guidedSegmentation.yBoundaries.map(([top, bottom]) => bottom - top);
  assert(Math.min(...guidedRowHeights) >= 90, '显式外边界修正后，不应再出现极薄的首末行');

  const localizedGuides = guideLocalizePlugin.execute({
    guides: {
      left: 138,
      right: 1557,
      top: 439,
      bottom: 2324,
      xPeaks: [
        138,
        343.1445698166432,
        546.2877291960508,
        748.4301833568406,
        951.5733427362483,
        1152.7150916784203,
        1353.8568406205925,
        1557
      ],
      yPeaks: [
        439,
        649.6764705882354,
        857.3288770053475,
        1063.9732620320856,
        1270.6176470588234,
        1478.2700534759358,
        1686.9304812834223,
        1792.7727272727273,
        1991.3529411764705,
        2110.2994652406414,
        2324
      ],
      patternProfile: {
        family: 'diagonal-mi-grid',
        profileMode: 'template-diagonal-mi-grid-no-explicit-outer-frame'
      }
    },
    bounds: {
      left: 0,
      top: 0,
      width: 1419,
      height: 1885
    }
  });

  assert.strictEqual(localizedGuides.xPeaks[0], 0, '局部化后应保留左边界 0');
  assert.strictEqual(localizedGuides.xPeaks[localizedGuides.xPeaks.length - 1], 1419, '局部化后应保留右边界');
  assert.strictEqual(localizedGuides.yPeaks[0], 0, '局部化后应保留上边界 0');
  assert.strictEqual(localizedGuides.yPeaks[localizedGuides.yPeaks.length - 1], 1885, '局部化后应保留下边界');

  const dedupedLocalizedGuides = guideLocalizePlugin.execute({
    guides: {
      left: 247,
      right: 1627,
      top: 340,
      bottom: 2223,
      xPeaks: [495, 691, 887, 1083, 1278, 1474, 1627, 1627],
      yPeaks: [685, 873, 1061, 1248, 1436, 1624, 1812, 2000, 2187, 2223, 2223]
    },
    bounds: {
      left: 0,
      top: 0,
      width: 1352,
      height: 1870
    }
  });

  assert.strictEqual(dedupedLocalizedGuides.xPeaks.length, 7, '局部化后重复的末尾竖向峰值应被去重');
  assert.strictEqual(dedupedLocalizedGuides.yPeaks.length, 10, '局部化后重复的末尾横向峰值应被去重');
  assert.strictEqual(dedupedLocalizedGuides.xPeaks[dedupedLocalizedGuides.xPeaks.length - 1], 1352, '局部化后应保留唯一的右边界峰值');
  assert.strictEqual(dedupedLocalizedGuides.yPeaks[dedupedLocalizedGuides.yPeaks.length - 1], 1870, '局部化后应保留唯一的下边界峰值');

  const normalizedGuides = guideNormalizePlugin.execute({
    gridRectification: {
      guides: {
        left: 0,
        right: 1352,
        top: 0,
        bottom: 1870,
        xPeaks: [243, 439, 635, 831, 1026, 1222, 1352, 1352],
        yPeaks: [341, 529, 717, 904, 1092, 1280, 1468, 1656, 1843, 1870, 1870]
      }
    },
    gridRows: 10,
    gridCols: 7
  });

  assert.strictEqual(normalizedGuides.xPeaks.length, 8, '规范化后应回退到完整的 7 列边界');
  assert.strictEqual(normalizedGuides.yPeaks.length, 11, '规范化后应回退到完整的 10 行边界');
  assert.strictEqual(normalizedGuides.xPeaks[0], 0, '规范化回退后应补上左边界');
  assert.strictEqual(normalizedGuides.xPeaks[normalizedGuides.xPeaks.length - 1], 1352, '规范化回退后应保留右边界');
  assert.strictEqual(normalizedGuides.yPeaks[0], 0, '规范化回退后应补上上边界');
  assert.strictEqual(normalizedGuides.yPeaks[normalizedGuides.yPeaks.length - 1], 1870, '规范化回退后应保留下边界');

  const irregularUniformSegmentation = boundaryGuideSegmentationPlugin.execute({
    boundaryGuides: {
      left: 0,
      top: 0,
      right: 1352,
      bottom: 1870,
      xPeaks: [243, 439, 635, 831, 1026, 1222, 1352],
      yPeaks: [341, 529, 717, 904, 1092, 1280, 1468, 1656, 1843, 1870],
      xPattern: 'uniform-boundary-grid',
      yPattern: 'uniform-boundary-grid',
      patternProfile: {
        family: 'inner-dashed-box-grid',
        profileMode: 'template-inner-dashed-box-grid-full-margin-outer-frame'
      }
    },
    segmentationProfile: {
      family: 'inner-dashed-box-grid',
      profileMode: 'template-inner-dashed-box-grid-full-margin-outer-frame',
      preferUniform: false,
      preferBoundaryGuides: true,
      preferPeakEnvelope: true
    },
    gridRows: 10,
    gridCols: 7,
    width: 1352,
    height: 1870
  });

  const irregularXWidths = irregularUniformSegmentation.xBoundaries.map(([left, right]) => right - left);
  assert(Math.max(...irregularXWidths) - Math.min(...irregularXWidths) <= 2, '均匀方格模式下，异常列宽应回退到稳定均分');
  assert.strictEqual(irregularUniformSegmentation.debug.guideResolvedPeakFallback.x, true, '异常列宽应触发竖向峰值回退');

  const explicitBoundaryCenterMismatchSegmentation = boundaryGuideSegmentationPlugin.execute({
    boundaryGuides: {
      left: 0,
      top: 0,
      right: 1405,
      bottom: 2277,
      xPeaks: [0, 201, 402, 602, 803, 1004, 1204, 1405],
      yPeaks: [0, 138, 354, 568, 911, 1139, 1366, 1735, 1842, 2059, 2277],
      yPattern: 'mixed',
      patternProfile: {
        family: 'diagonal-mi-grid',
        profileMode: 'template-diagonal-mi-grid-no-explicit-outer-frame'
      }
    },
    segmentationProfile: {
      family: 'diagonal-mi-grid',
      profileMode: 'template-diagonal-mi-grid-no-explicit-outer-frame',
      preferUniform: false,
      preferBoundaryGuides: true,
      preferPeakEnvelope: true
    },
    gridRows: 11,
    gridCols: 7,
    width: 1405,
    height: 2277
  });

  const explicitBoundaryCenterMismatchRowHeights = explicitBoundaryCenterMismatchSegmentation.yBoundaries
    .map(([top, bottom]) => bottom - top);
  assert(Math.min(...explicitBoundaryCenterMismatchRowHeights) >= 200, '显式外边界被误判为中心峰值时，不应再产生超薄首行');
  assert(Math.max(...explicitBoundaryCenterMismatchRowHeights) - Math.min(...explicitBoundaryCenterMismatchRowHeights) <= 2, '显式外边界异常回退后，行高应恢复稳定');
  assert.strictEqual(explicitBoundaryCenterMismatchSegmentation.debug.guideExplicitCenterFallback.y, true, '图1型异常应触发显式外边界中心峰值回退');
  assert.strictEqual(explicitBoundaryCenterMismatchSegmentation.debug.guideAxisModes.y, '显式外边界异常回退均分', '图1型异常应回退到稳定均分边界');

  const localizedSegmentation = boundaryGuideSegmentationPlugin.execute({
    boundaryGuides: localizedGuides,
    segmentationProfile: {
      family: 'diagonal-mi-grid',
      profileMode: 'template-diagonal-mi-grid-no-explicit-outer-frame',
      preferUniform: false,
      preferBoundaryGuides: true,
      preferPeakEnvelope: true
    },
    gridRows: 9,
    gridCols: 7,
    width: 1419,
    height: 1885
  });

  const localizedRowHeights = localizedSegmentation.yBoundaries.map(([top, bottom]) => bottom - top);
  const localizedColWidths = localizedSegmentation.xBoundaries.map(([left, right]) => right - left);
  assert(Math.max(...localizedRowHeights) - Math.min(...localizedRowHeights) <= 24, '完整边界局部化后，行高不应再出现首尾巨幅畸变');
  assert(Math.max(...localizedColWidths) - Math.min(...localizedColWidths) <= 12, '完整边界局部化后，列宽应保持稳定');

  console.log('测试通过：标准图和偏移图都成功提取70个保留空白的方格，并返回了内容框与网格区域元数据。');
}

if (require.main === module) {
  testPlugin().catch((error) => {
    console.error('测试失败：', error);
    process.exitCode = 1;
  });
}

module.exports = { testPlugin };
