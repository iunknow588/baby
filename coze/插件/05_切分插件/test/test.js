const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const hanziPlugin = require('../index');
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

async function testPlugin() {
  const fixturePath = path.join(__dirname, 'fixtures', 'test_a4.png');
  const shiftedFixturePath = path.join(__dirname, 'fixtures', 'test_a4_shifted.png');
  const outputDir = path.join(__dirname, 'output');
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
  for (const stageDir of stageDirs) {
    await fs.promises.rm(stageDir, { recursive: true, force: true });
  }

  const result = await hanziPlugin.execute({
    imagePath: fixturePath,
    returnBase64: false,
    outputDir,
    gridRows: 7,
    gridCols: 10
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

  console.log('测试通过：标准图和偏移图都成功提取70个保留空白的方格，并返回了内容框与网格区域元数据。');
}

if (require.main === module) {
  testPlugin().catch((error) => {
    console.error('测试失败：', error);
    process.exitCode = 1;
  });
}

module.exports = { testPlugin };
