const assert = require('assert');
const fs = require('fs');
const path = require('path');
const gridCountPlugin = require('../index');
const gridCountEstimatePlugin = require('../../04_1方格数量估计插件/index');
const gridCountRenderPlugin = require('../../04_2方格数量标注插件/index');
const { requireSharp } = require('../../utils/require_sharp');

const sharp = requireSharp([path.join(__dirname, '..')]);

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function createFixtureImage(imagePath) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600">
      <rect width="1200" height="1600" fill="#ffffff"/>
      <rect x="40" y="40" width="1120" height="1520" fill="none" stroke="#111827" stroke-width="8"/>
      <line x1="40" y1="800" x2="1160" y2="800" stroke="#d1d5db" stroke-width="4"/>
      <line x1="600" y1="40" x2="600" y2="1560" stroke="#d1d5db" stroke-width="4"/>
    </svg>
  `;
  await fs.promises.mkdir(path.dirname(imagePath), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(imagePath);
}

async function testPlugin() {
  const fixtureDir = path.join(__dirname, 'fixtures');
  const outputDir = path.join(__dirname, 'output');
  const fixturePath = path.join(fixtureDir, 'grid_count_fixture.png');
  const estimateOutputPath = path.join(outputDir, '04_1_wrapper', 'estimate.png');
  const estimateMetaPath = path.join(outputDir, '04_1_wrapper', 'estimate.json');
  const annotateOutputPath = path.join(outputDir, '04_2_wrapper', 'annotated.png');
  const annotateMetaPath = path.join(outputDir, '04_2_wrapper', 'annotated.json');
  const stageAnnotatedPath = path.join(outputDir, '04_方格数量计算标注', '04_2_方格数量标注图.png');
  const stageMetaPath = path.join(outputDir, '04_方格数量计算标注', '04_方格数量计算标注结果.json');
  const carryForwardPath = path.join(outputDir, '04_方格数量计算标注', '04_3_单格切分输入', '04_3_单格切分输入图.png');

  await fs.promises.rm(outputDir, { recursive: true, force: true });
  await createFixtureImage(fixturePath);

  const step04_1 = await gridCountEstimatePlugin.execute({
    imagePath: fixturePath,
    gridRows: 7,
    gridCols: 10,
    source: '指定值',
    outputMetaPath: estimateMetaPath,
    outputImagePath: estimateOutputPath
  });

  assert.strictEqual(step04_1.processNo, '04_1', '04_1 wrapper 应保留 processNo');
  assert.strictEqual(step04_1.processName, '04_1_方格数量估计', '04_1 wrapper 应保留 processName');
  assert.strictEqual(step04_1.totalCells, 70, '04_1 wrapper 应正确计算总格数');
  assert(await pathExists(estimateOutputPath), '04_1 wrapper 应输出估计图');
  assert(await pathExists(estimateMetaPath), '04_1 wrapper 应输出估计元数据');

  const step04_2 = await gridCountRenderPlugin.execute({
    imagePath: fixturePath,
    outputAnnotatedPath: annotateOutputPath,
    outputMetaPath: annotateMetaPath,
    gridRows: 7,
    gridCols: 10,
    totalCells: 70,
    source: '指定值'
  });

  assert.strictEqual(step04_2.processNo, '04_2', '04_2 wrapper 应保留 processNo');
  assert.strictEqual(step04_2.processName, '04_2_方格数量标注', '04_2 wrapper 应保留 processName');
  assert(await pathExists(annotateOutputPath), '04_2 wrapper 应输出标注图');
  assert(await pathExists(annotateMetaPath), '04_2 wrapper 应输出标注元数据');

  const stageResult = await gridCountPlugin.execute({
    imagePath: fixturePath,
    outputAnnotatedPath: stageAnnotatedPath,
    outputMetaPath: stageMetaPath,
    outputCarryForwardPath: carryForwardPath,
    gridRows: 7,
    gridCols: 10,
    source: '指定值'
  });

  assert.strictEqual(stageResult.processNo, '04', '04 主阶段应保留 processNo');
  assert.strictEqual(stageResult.processName, '04_方格数量计算标注', '04 主阶段应保留 processName');
  assert.strictEqual(stageResult.totalCells, 70, '04 主阶段应正确计算总格数');
  assert.strictEqual(stageResult.carryForwardInputPath, carryForwardPath, '04 主阶段应回传唯一切分输入图路径');
  assert(await pathExists(stageResult.outputAnnotatedPath), '04 主阶段应输出标注图');
  assert(await pathExists(stageResult.carryForwardInputPath), '04 主阶段应输出切分输入图');
  assert(await pathExists(stageMetaPath), '04 主阶段应输出阶段元数据');
  assert(await pathExists(stageResult.stepMetaPaths.step04_1), '04 主阶段应输出 04_1 元数据');
  assert(await pathExists(stageResult.stepMetaPaths.step04_2), '04 主阶段应输出 04_2 元数据');
  assert(await pathExists(stageResult.stepMetaPaths.step04_3), '04 主阶段应输出 04_3 元数据');

  const step04_3Meta = JSON.parse(await fs.promises.readFile(stageResult.stepMetaPaths.step04_3, 'utf8'));
  assert.strictEqual(step04_3Meta.processNo, '04_3', '04_3 元数据应保留步骤编号');
  assert.strictEqual(step04_3Meta.sourceStep, '04_2_方格数量标注', '04_3 元数据应声明来源步骤');
  assert.strictEqual(step04_3Meta.carryForwardImagePath, carryForwardPath, '04_3 元数据应指向唯一切分输入图');

  console.log('测试通过：04 阶段与 04_1/04_2 wrapper 已统一通过兼容冒烟校验。');
}

if (require.main === module) {
  testPlugin().catch((error) => {
    console.error('测试失败：', error);
    process.exitCode = 1;
  });
}

module.exports = { testPlugin };
