const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../../05_切分插件/node_modules/sharp');
}

const cellLayerPlugin = require('../index');

async function createCellImage({ width = 200, height = 200, rectX = 52, rectY = 36, rectWidth = 96, rectHeight = 124 } = {}) {
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += '<rect width="100%" height="100%" fill="white"/>';
  svg += `<rect x="${rectX}" y="${rectY}" width="${rectWidth}" height="${rectHeight}" fill="black"/>`;
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

async function testArtifactLevels() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cell-layer-plugin-'));
  const debugDir = path.join(tmpRoot, 'debug');
  const standardDir = path.join(tmpRoot, 'standard');
  const minimalDir = path.join(tmpRoot, 'minimal');
  const cellImage = await createCellImage();
  const segmentation = {
    gridRows: 1,
    gridCols: 1,
    cells: [
      {
        row: 0,
        col: 0,
        pageBox: { left: 0, top: 0, width: 200, height: 200 },
        contentBox: { left: 52, top: 36, width: 96, height: 124 }
      }
    ],
    matrix: [[cellImage]]
  };

  try {
    const debugResult = await cellLayerPlugin.execute({
      segmentation,
      inputPath: '/tmp/source-cell.png',
      outputDir: debugDir
    });

    assert.strictEqual(debugResult.artifactLevel, 'debug', '默认应输出 debug 级别产物');
    assert(await pathExists(debugResult.summaryPath), 'debug 模式应输出汇总 JSON');
    assert(await pathExists(debugResult.cells[0].metaPath), 'debug 模式应输出单格汇总 JSON');
    assert(await pathExists(debugResult.cells[0].outputs.originalPath), 'debug 模式应输出 06_1 原图');
    assert(await pathExists(debugResult.cells[0].outputs.foregroundMaskPath), 'debug 模式应输出 06_2 前景 Mask');
    assert(await pathExists(debugResult.cells[0].outputs.cleanedForegroundMaskPath), 'debug 模式应输出 06_3 清洗文字 Mask');
    assert(await pathExists(debugResult.cells[0].outputs.textOnlyPath), 'debug 模式应输出 06_4 文字图');
    assert(await pathExists(debugResult.cells[0].outputs.backgroundOnlyPath), 'debug 模式应输出 06_5 背景图');

    const standardResult = await cellLayerPlugin.execute({
      segmentation,
      inputPath: '/tmp/source-cell.png',
      outputDir: standardDir,
      artifactLevel: 'standard'
    });

    assert.strictEqual(standardResult.artifactLevel, 'standard', 'standard 模式应回显 artifactLevel');
    assert.strictEqual(standardResult.outputs.artifactLevel, 'standard', 'standard 输出摘要应包含 artifactLevel');
    assert.strictEqual(standardResult.stepDirs.step06_1, null, 'standard 模式不应输出 06_1 目录');
    assert.strictEqual(standardResult.stepDirs.step06_2, null, 'standard 模式不应输出 06_2 目录');
    assert.strictEqual(standardResult.stepDirs.step06_3, null, 'standard 模式不应输出 06_3 目录');
    assert(await pathExists(standardResult.stepDirs.step06_4), 'standard 模式应输出 06_4 目录');
    assert(await pathExists(standardResult.stepDirs.step06_5), 'standard 模式应输出 06_5 目录');
    assert.strictEqual(standardResult.cells[0].metaPath, undefined, 'standard 模式不应输出单格汇总 JSON');
    assert.strictEqual(standardResult.cells[0].outputs.originalPath, null, 'standard 模式不应落盘 06_1 原图');
    assert.strictEqual(standardResult.cells[0].outputs.foregroundMaskPath, null, 'standard 模式不应落盘 06_2 前景 Mask');
    assert.strictEqual(standardResult.cells[0].outputs.cleanedForegroundMaskPath, null, 'standard 模式不应落盘 06_3 清洗文字 Mask');
    assert(await pathExists(standardResult.cells[0].outputs.textOnlyPath), 'standard 模式应输出 06_4 文字图');
    assert(await pathExists(standardResult.cells[0].outputs.backgroundOnlyPath), 'standard 模式应输出 06_5 背景图');
    assert.strictEqual(await pathExists(path.join(standardDir, 'row01_col01')), false, 'standard 模式不应创建单格汇总目录');
    assert(await pathExists(standardResult.summaryPath), 'standard 模式应输出汇总 JSON');

    const minimalResult = await cellLayerPlugin.execute({
      segmentation,
      inputPath: '/tmp/source-cell.png',
      outputDir: minimalDir,
      artifactLevel: 'minimal'
    });

    assert.strictEqual(minimalResult.artifactLevel, 'minimal', 'minimal 模式应回显 artifactLevel');
    assert.strictEqual(minimalResult.stepDirs.step06_1, null, 'minimal 模式不应输出 06_1 目录');
    assert.strictEqual(minimalResult.stepDirs.step06_2, null, 'minimal 模式不应输出 06_2 目录');
    assert.strictEqual(minimalResult.stepDirs.step06_3, null, 'minimal 模式不应输出 06_3 目录');
    assert(await pathExists(minimalResult.stepDirs.step06_4), 'minimal 模式应输出 06_4 目录');
    assert.strictEqual(minimalResult.stepDirs.step06_5, null, 'minimal 模式不应输出 06_5 目录');
    assert.strictEqual(minimalResult.cells[0].outputs.originalPath, null, 'minimal 模式不应落盘 06_1 原图');
    assert.strictEqual(minimalResult.cells[0].outputs.foregroundMaskPath, null, 'minimal 模式不应落盘 06_2 前景 Mask');
    assert.strictEqual(minimalResult.cells[0].outputs.cleanedForegroundMaskPath, null, 'minimal 模式不应落盘 06_3 清洗文字 Mask');
    assert(await pathExists(minimalResult.cells[0].outputs.textOnlyPath), 'minimal 模式应输出 06_4 文字图');
    assert.strictEqual(minimalResult.cells[0].outputs.backgroundOnlyPath, null, 'minimal 模式不应落盘 06_5 背景图');
    assert.strictEqual(await pathExists(path.join(minimalDir, 'row01_col01')), false, 'minimal 模式不应创建单格汇总目录');
    assert(await pathExists(minimalResult.summaryPath), 'minimal 模式应输出汇总 JSON');
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }

  console.log('测试通过：06 阶段支持 debug/standard/minimal 三档产物策略。');
}

if (require.main === module) {
  testArtifactLevels().catch((error) => {
    console.error('测试失败：', error);
    process.exitCode = 1;
  });
}

module.exports = {
  testArtifactLevels
};
