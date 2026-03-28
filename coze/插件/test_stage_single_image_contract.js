const assert = require('assert');
const os = require('os');
const path = require('path');

const paperExtractPlugin = require('./01_A4纸张提取插件/index');
const a4RectifyPlugin = require('./02_A4纸张矫正插件/index');
const paperCornerDetectPlugin = require('./02_1纸张角点检测插件/index');
const perspectiveRectifyPlugin = require('./02_2透视矫正插件/index');
const guideRemovePlugin = require('./02_3去底纹插件/index');
const gridOuterRectExtractPlugin = require('./03_字帖外框与内框定位裁剪插件/index');
const gridRectCropAnnotatePlugin = require('./03_3辅助内框裁剪标注插件/index');
const {
  resolveSingleImageInput,
  buildStageImageHandoffContract
} = require('./utils/stage_image_contract');

async function assertRejectsWith(promiseFactory, messageFragment) {
  let rejected = false;
  try {
    await promiseFactory();
  } catch (error) {
    rejected = true;
    assert(
      String(error.message || '').includes(messageFragment),
      `预期错误信息包含 "${messageFragment}"，实际收到: ${error.message}`
    );
  }
  assert(rejected, `预期抛出错误: ${messageFragment}`);
}

async function main() {
  const tmpRoot = path.join(os.tmpdir(), 'coze-stage-single-image-contract');
  const imageA = path.join(tmpRoot, 'a.png');
  const imageB = path.join(tmpRoot, 'b.png');

  const resolved = resolveSingleImageInput({
    stageName: '合同测试',
    primaryInputPath: imageA,
    imagePath: imageA
  });
  assert.strictEqual(resolved, path.resolve(imageA));

  const handoffContract = buildStageImageHandoffContract({
    stageName: '合同测试',
    stageInputPath: imageA,
    stageOutputImagePath: imageB
  });
  assert.deepStrictEqual(handoffContract.allowedStageInputs, [path.resolve(imageA)]);
  assert.deepStrictEqual(handoffContract.allowedStageOutputs, [path.resolve(imageB)]);
  assert.deepStrictEqual(handoffContract.allowedNextStageInputs, [path.resolve(imageB)]);

  assert.throws(() => {
    resolveSingleImageInput({
      stageName: '合同测试',
      primaryInputPath: imageA,
      imagePath: imageB
    });
  }, /只允许传递一张输入图/);

  await assertRejectsWith(() => paperExtractPlugin.execute({
    stageInputPath: imageA,
    imagePath: imageB,
    outputDir: path.join(tmpRoot, 'stage01')
  }), '只允许传递一张输入图');

  await assertRejectsWith(() => a4RectifyPlugin.execute({
    stageInputPath: imageA,
    imagePath: imageB,
    outputDir: path.join(tmpRoot, 'stage02')
  }), '只允许传递一张输入图');

  const preprocessResult = {
    paperBounds: {
      left: 0,
      top: 0,
      width: 100,
      height: 200
    },
    warpedOutputPath: imageA,
    outputPath: imageA,
    guideRemovedOutputPath: imageA
  };

  await assertRejectsWith(() => paperCornerDetectPlugin.execute({
    stageInputPath: imageA,
    imagePath: imageB,
    preprocessResult,
    outputMetaPath: path.join(tmpRoot, '02_1.json')
  }), '只允许传递一张输入图');

  await assertRejectsWith(() => perspectiveRectifyPlugin.execute({
    stageInputPath: imageA,
    imagePath: imageB,
    preprocessResult,
    outputMetaPath: path.join(tmpRoot, '02_2.json')
  }), '只允许传递一张输入图');

  await assertRejectsWith(() => guideRemovePlugin.execute({
    stageInputPath: imageA,
    imagePath: imageB,
    preprocessResult,
    outputMetaPath: path.join(tmpRoot, '02_3.json')
  }), '只允许传递一张输入图');

  await assertRejectsWith(() => gridOuterRectExtractPlugin.execute({
    stageInputPath: imageA,
    preprocessPath: imageB,
    outputDir: path.join(tmpRoot, 'stage03')
  }), '只允许传递一张输入图');

  await assertRejectsWith(() => gridRectCropAnnotatePlugin.execute({
    baseName: 'contract-check',
    bounds: { left: 0, top: 0, width: 1, height: 1, source: 'unit-test' },
    stageInputPath: imageA,
    gridSegmentationInputPath: imageB,
    segmentationMode: 'passthrough',
    annotatedPath: path.join(tmpRoot, '03_3_annotated.png'),
    warpedCropPath: path.join(tmpRoot, '03_3_warped.png')
  }), '只允许传递一张输入图');

  console.log('stage single-image contract checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
