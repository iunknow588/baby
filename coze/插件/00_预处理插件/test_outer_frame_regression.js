const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pipelinePlugin = require('../00_流水线插件/index');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

if (sharp && typeof sharp.cache === 'function') {
  sharp.cache({ memory: 64, items: 32, files: 0 });
}
if (sharp && typeof sharp.concurrency === 'function') {
  sharp.concurrency(2);
}

async function run() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'outer-frame-regression-'));
  try {
    const formatSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
    const resolveOuterFrameInfo = (stage03Meta) => {
      const extracted = stage03Meta.outerFrameExtraction || null;
      const inferred = stage03Meta.inferredOuterFrame || null;
      return {
        applied: Boolean(extracted?.applied || inferred?.applied),
        pattern: extracted?.pattern || inferred?.diagnostics?.outerFramePattern || null,
        refinedOuterFrame: extracted?.refinedOuterFrame || inferred?.refinedOuterFrame || extracted?.outerFrame || null
      };
    };

    const runStage03 = async (imageName) => {
      const startedAt = Date.now();
      console.log(`[outer-frame-regression] start ${imageName}`);
      const result = await pipelinePlugin.execute({
        imagePath: `/home/lc/luckee_dao/baby/coze/插件/test/obj/${imageName}`,
        outputRootDir: tmpRoot,
        gridType: 'square',
        trimContent: false,
        cropToGrid: true,
        maxStep: 3
      });
      const stage03MetaPath = path.join(
        result.outputs.fileRootDir,
        '03_字帖外框与内框定位裁剪',
        '03_字帖外框与内框定位裁剪结果.json'
      );
      return {
        result,
        stage03Meta: JSON.parse(await fs.promises.readFile(stage03MetaPath, 'utf8')),
        elapsedMs: Date.now() - startedAt
      };
    };

    const case2Run = await runStage03('2.jpg');
    const stage03MetaCase2 = case2Run.stage03Meta;
    const patternProfileCase2 = stage03MetaCase2.gridGuideDiagnostics?.patternProfile || null;
    const outerFrameInfoCase2 = resolveOuterFrameInfo(stage03MetaCase2);
    const innerCornersCase2 = stage03MetaCase2.innerCornerLocalization?.corners || null;
    const case2OuterFrame = outerFrameInfoCase2.refinedOuterFrame || null;
    const case2OuterCrop = stage03MetaCase2.outerFrameRectification?.details?.croppedOutput || null;
    const case2DisplayCorners = stage03MetaCase2.innerCornerLocalization?.displayCorners || null;
    const case2SourceMargins = stage03MetaCase2.outerFrameRectification?.details?.sourceMargins || null;
    const case2OuterMode = stage03MetaCase2.outerCornerLocalization?.outerFrameMode || null;
    const case2OuterCorners = stage03MetaCase2.outerCornerLocalization?.corners || null;
    const case2RealOuterFrameDetected = Boolean(stage03MetaCase2.outerCornerLocalization?.realOuterFrameDetected);

    assert(outerFrameInfoCase2.applied, '2.jpg 应识别出或推断出外框');
    assert.strictEqual(
      outerFrameInfoCase2.pattern,
      'full-margin-outer-frame',
      '2.jpg 的外框语义应为 full-margin-outer-frame'
    );
    assert.strictEqual(
      patternProfileCase2?.outerFrameLayout,
      'full-margin-outer-frame',
      'patternProfile 应保留外框布局语义'
    );
    assert.strictEqual(
      patternProfileCase2?.profileMode,
      'template-circle-mi-grid-full-margin-outer-frame',
      'circle-mi-grid 的 profileMode 应与外框布局一致'
    );
    const expectedCase2InnerCorners = [
      [237, 170],
      [2284, 170],
      [2284, 3217],
      [237, 3217]
    ];
    assert(
      Array.isArray(innerCornersCase2)
      && innerCornersCase2.length === expectedCase2InnerCorners.length
      && innerCornersCase2.every((point, index) => (
        Array.isArray(point)
        && point.length === 2
        && Math.abs(Number(point[0]) - expectedCase2InnerCorners[index][0]) <= 8
        && Math.abs(Number(point[1]) - expectedCase2InnerCorners[index][1]) <= 4
      )),
      `2.jpg 的内框四角点不应发生明显漂移，当前=${JSON.stringify(innerCornersCase2)}`
    );
    assert(Number.isFinite(Number(case2OuterFrame?.top)), '2.jpg 应输出稳定的外框顶边');
    assert(
      Number(case2OuterFrame?.top) >= 120 && Number(case2OuterFrame?.top) <= 190,
      `2.jpg 外框顶边应贴近真实外框上边，当前 top=${case2OuterFrame?.top}`
    );
    assert(
      Number(case2OuterFrame?.bottom) >= 3218 && Number(case2OuterFrame?.bottom) <= 3240,
      `2.jpg 外框底边应贴近真实外框下边，当前 bottom=${case2OuterFrame?.bottom}`
    );
    assert(
      Array.isArray(case2OuterCorners)
      && Number(case2OuterCorners[0]?.[1]) >= 110
      && Number(case2OuterCorners[0]?.[1]) <= 134,
      `2.jpg 左上外框角点不应再明显偏低或被过度上提，当前 corners=${JSON.stringify(case2OuterCorners)}`
    );
    assert.strictEqual(
      case2OuterMode,
      'standard_outer_frame',
      `2.jpg 当前属于标准外框，不应再被误判为非标准外框，当前 mode=${case2OuterMode}`
    );
    assert.strictEqual(
      case2RealOuterFrameDetected,
      true,
      '2.jpg 当前应通过真实边界确认提升为 realOuterFrameDetected=true'
    );
    assert.strictEqual(
      case2OuterCrop?.method,
      'rectified-outer-frame-raw',
      `2.jpg 的外框矫正图不应再被过度内裁，当前 crop=${JSON.stringify(case2OuterCrop)}`
    );
    assert(
      Array.isArray(case2OuterCorners)
      && case2OuterCorners.length === 4
      && Math.abs(Number(case2OuterCorners[1][1]) - Number(case2OuterCorners[0][1])) >= 10,
      `2.jpg 的外框顶边不应再被压平成水平矩形，当前 corners=${JSON.stringify(case2OuterCorners)}`
    );
    assert(
      Number(case2SourceMargins?.right) <= 20,
      `2.jpg 的右侧外框不应再被外扩到页边噪声，当前 margins=${JSON.stringify(case2SourceMargins)}`
    );
    assert(
      Number(case2SourceMargins?.bottom) <= 12,
      `2.jpg 的下边外框不应再被页脚区域拖到过低位置，当前 margins=${JSON.stringify(case2SourceMargins)}`
    );
    assert(
      Array.isArray(case2DisplayCorners)
      && case2DisplayCorners.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)),
      '2.jpg 应输出可投影的内框显示四角点'
    );
    console.log(`[outer-frame-regression] done 2.jpg (${formatSeconds(case2Run.elapsedMs)})`);

    const case1Run = await runStage03('1.jpg');
    const stage03MetaCase1 = case1Run.stage03Meta;
    const case1HeaderSuppression = case1Run.result.preprocessing?.headerSuppressionDiagnostics || null;
    const case1OuterFrameInfo = resolveOuterFrameInfo(stage03MetaCase1);
    const case1FinalQuad = stage03MetaCase1.gridGuideDiagnostics?.cornerRefinement?.finalAppliedQuad || null;
    const case1LocalCornerRefinement = stage03MetaCase1.gridGuideDiagnostics?.cornerRefinement?.corners || null;
    const case1GuideTop = Number(stage03MetaCase1.gridGuideDiagnostics?.normalizedGuides?.top);
    const case1OuterLocalization = stage03MetaCase1.outerCornerLocalization || null;
    const case1FinalTop = Array.isArray(case1FinalQuad)
      ? (Number(case1FinalQuad[0]?.[1]) + Number(case1FinalQuad[1]?.[1])) / 2
      : NaN;
    const case1LocalTop = (
      case1LocalCornerRefinement?.leftTop?.refined
      && case1LocalCornerRefinement?.rightTop?.refined
    )
      ? (
          Number(case1LocalCornerRefinement.leftTop.refined[1])
          + Number(case1LocalCornerRefinement.rightTop.refined[1])
        ) / 2
      : NaN;

    assert.strictEqual(
      Boolean(case1HeaderSuppression?.applied),
      false,
      `1.jpg 无页眉样本不应触发页眉抑制，当前 diagnostics=${JSON.stringify(case1HeaderSuppression)}`
    );
    assert(case1OuterFrameInfo.applied, '1.jpg 即便没有真实外框，也应进入虚外框回退');
    assert.strictEqual(
      case1OuterLocalization?.virtualOuterFrameApplied,
      true,
      `1.jpg 不应再把首行/页脚误判成真实外框，当前 outer=${JSON.stringify(case1OuterLocalization)}`
    );
    assert.strictEqual(
      stage03MetaCase1.inferredOuterFrame?.reason,
      'virtual-outer-frame-from-image-border',
      `1.jpg 应回退为虚外框，当前 inferred=${JSON.stringify(stage03MetaCase1.inferredOuterFrame)}`
    );
    assert(Number.isFinite(case1GuideTop), '1.jpg 应输出稳定的顶部 guide');
    assert(case1GuideTop <= 120, `1.jpg 顶边不应再下压到外框内部较深位置，当前 top=${case1GuideTop}`);
    assert(Number.isFinite(case1FinalTop), '1.jpg 应输出最终内框顶边');
    assert(case1FinalTop <= 120, `1.jpg 最终内框顶边过低，当前 top=${case1FinalTop}`);
    assert(Number.isFinite(case1LocalTop), '1.jpg 应保留局部顶边诊断');
    console.log(`[outer-frame-regression] done 1.jpg (${formatSeconds(case1Run.elapsedMs)})`);

    const case3Run = await runStage03('3.jpg');
    const stage03MetaCase3 = case3Run.stage03Meta;
    const case3OuterFrameInfo = resolveOuterFrameInfo(stage03MetaCase3);
    const case3OuterFrame = case3OuterFrameInfo.refinedOuterFrame || null;
    const case3PatternProfile = stage03MetaCase3.gridGuideDiagnostics?.patternProfile || null;
    const case3OuterCrop = stage03MetaCase3.outerFrameRectification?.details?.croppedOutput || null;
    const case3DisplayCorners = stage03MetaCase3.innerCornerLocalization?.displayCorners || null;
    const case3LocalizedBoundaryGuides = stage03MetaCase3.localizedBoundaryGuides || null;
    const case3RectifiedOuter = stage03MetaCase3.outerFrameRectification?.details?.rectifiedOuterFrame || null;

    assert(case3OuterFrameInfo.applied, '3.jpg 应识别出或推断出页眉/页脚之间的真实外框');
    assert.strictEqual(
      case3OuterFrameInfo.pattern,
      'full-margin-outer-frame',
      '3.jpg 的外框语义应保持为 full-margin-outer-frame'
    );
    assert.strictEqual(
      case3PatternProfile?.outerFrameLayout,
      'full-margin-outer-frame',
      '3.jpg 的 patternProfile 应回写真实外框布局语义'
    );
    assert(Number.isFinite(Number(case3OuterFrame?.top)), '3.jpg 应输出稳定的外框顶边');
    assert(Number.isFinite(Number(case3OuterFrame?.bottom)), '3.jpg 应输出稳定的外框底边');
    assert(
      Number(case3OuterFrame?.top) >= 300 && Number(case3OuterFrame?.top) <= 380,
      `3.jpg 外框顶边应落在页眉下方黑色外框上，当前 top=${case3OuterFrame?.top}`
    );
    assert(
      Number(case3OuterFrame?.bottom) >= 2180 && Number(case3OuterFrame?.bottom) <= 2285,
      `3.jpg 外框底边应落在页脚上方黑色外框上，当前 bottom=${case3OuterFrame?.bottom}`
    );
    assert(
      case3OuterCrop?.method === 'rectified-outer-frame-raw'
      || case3OuterCrop?.method === 'rectified-edge-dense-band-crop',
      `3.jpg 的 03_2 外框矫正图不应再把外框裁掉，当前 crop=${JSON.stringify(case3OuterCrop)}`
    );
    assert(
      Array.isArray(case3DisplayCorners)
      && case3DisplayCorners[0][0] >= 0
      && case3DisplayCorners[0][1] >= 0
      && case3DisplayCorners[2][0] > case3DisplayCorners[0][0]
      && case3DisplayCorners[2][1] > case3DisplayCorners[0][1],
      `3.jpg 的内框显示四角应落在 03_2 图内，当前 display=${JSON.stringify(case3DisplayCorners)}`
    );
    assert(
      Array.isArray(case3DisplayCorners)
      && Number.isFinite(Number(case3RectifiedOuter?.targetWidth))
      && Number.isFinite(Number(case3RectifiedOuter?.targetHeight))
      && case3DisplayCorners[0][0] >= Math.max(24, Math.round(Number(case3RectifiedOuter.targetWidth) * 0.05))
      && case3DisplayCorners[0][1] >= Math.max(24, Math.round(Number(case3RectifiedOuter.targetHeight) * 0.04))
      && (Number(case3RectifiedOuter.targetWidth) - case3DisplayCorners[1][0]) >= Math.max(24, Math.round(Number(case3RectifiedOuter.targetWidth) * 0.05))
      && (Number(case3RectifiedOuter.targetHeight) - case3DisplayCorners[2][1]) >= Math.max(24, Math.round(Number(case3RectifiedOuter.targetHeight) * 0.04)),
      `3.jpg 的内框显示四角不应再贴住外框残留边线，当前 display=${JSON.stringify(case3DisplayCorners)}, rectified=${JSON.stringify(case3RectifiedOuter)}`
    );
    assert(
      Array.isArray(case3LocalizedBoundaryGuides?.xPeaks)
      && case3LocalizedBoundaryGuides.xPeaks.every((value, index, array) => index === 0 || value > array[index - 1]),
      `3.jpg 的 localizedBoundaryGuides.xPeaks 不应再含重复峰值，当前=${JSON.stringify(case3LocalizedBoundaryGuides?.xPeaks)}`
    );
    assert(
      Array.isArray(case3LocalizedBoundaryGuides?.yPeaks)
      && case3LocalizedBoundaryGuides.yPeaks.every((value, index, array) => index === 0 || value > array[index - 1]),
      `3.jpg 的 localizedBoundaryGuides.yPeaks 不应再含重复峰值，当前=${JSON.stringify(case3LocalizedBoundaryGuides?.yPeaks)}`
    );
    console.log(`[outer-frame-regression] done 3.jpg (${formatSeconds(case3Run.elapsedMs)})`);

    const case4Run = await runStage03('4.jpg');
    const stage03MetaCase4 = case4Run.stage03Meta;
    const case4HeaderSuppression = case4Run.result.preprocessing?.headerSuppressionDiagnostics || null;
    const case4Guides = stage03MetaCase4.gridGuideDiagnostics?.normalizedGuides || null;
    const case4FinalQuad = stage03MetaCase4.gridGuideDiagnostics?.cornerRefinement?.finalAppliedQuad || null;
    const case4DisplayCorners = stage03MetaCase4.innerCornerLocalization?.displayCorners || null;
    const case4FinalTop = Array.isArray(case4FinalQuad)
      ? (Number(case4FinalQuad[0]?.[1]) + Number(case4FinalQuad[1]?.[1])) / 2
      : NaN;

    assert.strictEqual(
      Boolean(case4HeaderSuppression?.applied),
      false,
      `4.jpg 无页眉样本不应触发页眉抑制，当前 diagnostics=${JSON.stringify(case4HeaderSuppression)}`
    );
    assert(Number.isFinite(Number(case4Guides?.top)), '4.jpg 应输出修正后的顶部 guide');
    assert(Number(case4Guides?.top) <= 100, `4.jpg 顶边应回收到接近页顶，当前 top=${case4Guides?.top}`);
    assert(Number.isFinite(case4FinalTop) && case4FinalTop <= 100, `4.jpg 最终内框顶边仍过低，当前 top=${case4FinalTop}`);
    assert(
      Array.isArray(case4DisplayCorners)
      && Math.abs(Number(case4DisplayCorners[0][0]) - Number(case4DisplayCorners[3][0])) <= 1
      && Math.abs(Number(case4DisplayCorners[1][0]) - Number(case4DisplayCorners[2][0])) <= 1,
      `4.jpg 内框底角不应再相对顶角横向漂移，当前 display=${JSON.stringify(case4DisplayCorners)}`
    );
    console.log(`[outer-frame-regression] done 4.jpg (${formatSeconds(case4Run.elapsedMs)})`);

    console.log('outer frame regression passed');
  } finally {
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
