const fs = require('fs');
const path = require('path');
const pipelinePlugin = require('../../00_流水线插件/index');

const DEFAULT_INPUT_DIR = '/home/lc/luckee_dao/baby/coze/插件/test/obj';
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp']);
const MAX_STEP = Number(process.env.PIPELINE_MAX_STEP || '7');

function buildChineseStageManifestView(stageManifest) {
  return {
    运行时间目录: stageManifest.runTimestamp,
    根目录: stageManifest.rootDir,
    最大执行阶段: stageManifest.maxStep,
    目录结构: {
      一级目录: stageManifest.layout.level1,
      二级目录: stageManifest.layout.level2,
      三级目录: stageManifest.layout.level3
    },
    阶段说明: {
      '01_稿纸提取': stageManifest.stages.a4Locate,
      '02_A4纸张矫正': stageManifest.stages.a4Rectify,
      '03_总方格大矩形提取': stageManifest.stages.gridRectExtract,
      '04_方格数量计算标注': stageManifest.stages.gridCount,
      '05_单格切分': stageManifest.stages.segmentation,
      '06_单格背景文字提取': stageManifest.stages.cellTextExtract,
      '07_单格评分': stageManifest.stages.scoring
    },
    文件清单: stageManifest.files.map((item) => ({
      文件编号: item.baseName,
      原始图片: item.imagePath,
      输出根目录: item.fileRootDir
    }))
  };
}

function pushIfPresent(lines, label, value) {
  if (value === null || value === undefined || value === '') {
    return;
  }
  lines.push(`- ${label}: ${value}`);
}

function pushStageHeader(lines, stageNo, stageName, order, input, outputDir, stageInfoPath, stepDirs = []) {
  lines.push(`### ${stageNo} ${stageName}`);
  pushIfPresent(lines, '顺序关系', order);
  pushIfPresent(lines, '阶段输入', input);
  pushIfPresent(lines, '输出目录', outputDir);
  pushIfPresent(lines, '阶段说明', stageInfoPath);
  pushIfPresent(lines, '子步骤目录', stepDirs.filter(Boolean).join(' ; ') || '无');
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

async function processCase(item, outputDir) {
  const baseName = path.basename(item.imagePath, path.extname(item.imagePath));
  const pipeline = await pipelinePlugin.execute({
    imagePath: item.imagePath,
    outputRootDir: outputDir,
    gridType: item.gridType || 'square',
    trimContent: false,
    cropToGrid: true,
    pageBounds: item.pageBounds,
    maxStep: MAX_STEP
  });
  const preprocessMeta = pipeline.outputs.preprocess?.metaPath
    ? JSON.parse(await fs.promises.readFile(pipeline.outputs.preprocess.metaPath, 'utf8'))
    : null;
  const a4ConstraintMeta = pipeline.outputs.preprocess?.rectifyA4ConstraintMetaPath
    ? JSON.parse(await fs.promises.readFile(pipeline.outputs.preprocess.rectifyA4ConstraintMetaPath, 'utf8'))
    : null;
  const textRectMeta = pipeline.outputs.preprocess?.textRectMetaPath
    ? JSON.parse(await fs.promises.readFile(pipeline.outputs.preprocess.textRectMetaPath, 'utf8'))
    : null;
  const segmentationMeta = pipeline.outputs.segmentation?.summaryPath
    ? JSON.parse(await fs.promises.readFile(pipeline.outputs.segmentation.summaryPath, 'utf8'))
    : null;
  const scoring = pipeline.scoring || null;

  console.log(`${baseName}:`);
  console.log(`  completed_step: ${pipeline.completedStep}`);
  if (pipeline.outputs.preprocess?.imagePath) console.log(`  preprocess: ${pipeline.outputs.preprocess.imagePath}`);
  if (pipeline.outputs.preprocess?.debugImagePath) console.log(`  preprocess debug: ${pipeline.outputs.preprocess.debugImagePath}`);
  if (pipeline.outputs.segmentation?.cellsDir) console.log(`  segmentation cells: ${pipeline.outputs.segmentation.cellsDir}`);
  if (pipeline.outputs.segmentation?.debugImagePath) console.log(`  seg-debug: ${pipeline.outputs.segmentation.debugImagePath}`);
  if (pipeline.outputs.scoring?.annotatedImagePath) console.log(`  annotated: ${pipeline.outputs.scoring.annotatedImagePath}`);
  if (pipeline.outputs.scoring?.summaryPath) console.log(`  summary:   ${pipeline.outputs.scoring.summaryPath}`);
  if (pipeline.outputs.scoring?.jsonPath) console.log(`  json:      ${pipeline.outputs.scoring.jsonPath}`);
  if (scoring) {
    console.log(`  blanks:    ${scoring.summary.blank_cells}`);
    console.log(`  avg_score: ${scoring.summary.avg_score}`);
  }

  return {
    baseName,
    completedStep: pipeline.completedStep,
    fileRootDir: pipeline.outputs.fileRootDir,
    preprocessMeta,
    a4ConstraintMeta,
    textRectMeta,
    segmentationMeta,
    segmentationSelection: pipeline.segmentationSelection,
    scoring,
    annotatedImagePath: pipeline.outputs.scoring?.annotatedImagePath || null,
    summaryPath: pipeline.outputs.scoring?.summaryPath || null,
    jsonPath: pipeline.outputs.scoring?.jsonPath || null,
    locateDir: pipeline.outputs.preprocess.locateDir,
    locateImagePath: pipeline.outputs.preprocess.locateImagePath,
    locateMetaPath: pipeline.outputs.preprocess.locateMetaPath,
    rectifyA4ConstraintMetaPath: pipeline.outputs.preprocess.rectifyA4ConstraintMetaPath || null,
    locateStepDirs: pipeline.outputs.preprocess.locateStepDirs || {},
    quadDebugPath: pipeline.outputs.preprocess.quadDebugImagePath,
    quadMetaPath: pipeline.outputs.preprocess.quadMetaPath,
    rectifyDir: pipeline.outputs.preprocess.rectifyDir,
    textRectDir: pipeline.outputs.preprocess.textRectDir,
    textRectMetaPath: pipeline.outputs.preprocess.textRectMetaPath,
    textRectStepDirs: pipeline.outputs.preprocess.textRectStepDirs || {},
    textRectAnnotatedPath: pipeline.outputs.preprocess.textRectAnnotatedPath,
    textRectWarpedPath: pipeline.outputs.preprocess.textRectWarpedPath,
    textRectPreprocessedPath: pipeline.outputs.preprocess.textRectPreprocessedPath,
    gridSegmentationInputPath: pipeline.outputs.preprocess.gridSegmentationInputPath,
    textRectGuideRemovedPath: pipeline.outputs.preprocess.textRectGuideRemovedPath,
    textRectMaskPath: pipeline.outputs.preprocess.textRectMaskPath,
    preprocessPath: pipeline.outputs.preprocess.imagePath,
    preprocessWarpedPath: pipeline.outputs.preprocess.warpedImagePath,
    preprocessGuideRemovedPath: pipeline.outputs.preprocess.guideRemovedImagePath,
    preprocessGridBackgroundMaskPath: pipeline.outputs.preprocess.gridBackgroundMaskImagePath,
    preprocessMetaPath: pipeline.outputs.preprocess.metaPath,
    preprocessDebugPath: pipeline.outputs.preprocess.debugImagePath,
    preprocessGridRectifiedPath: pipeline.outputs.preprocess.gridRectifiedImagePath,
    preprocessGridRectifiedMetaPath: pipeline.outputs.preprocess.gridRectifiedMetaPath,
    preprocessGridEstimateMetaPath: pipeline.outputs.preprocess.gridEstimateMetaPath,
    estimatedGrid: pipeline.estimatedGrid,
    effectiveGrid: pipeline.effectiveGrid,
    gridCountDir: pipeline.outputs.gridCount?.dir || null,
    gridCountAnnotatedPath: pipeline.outputs.gridCount?.annotatedPath || null,
    gridCountMetaPath: pipeline.outputs.gridCount?.metaPath || null,
    gridCountStepDirs: pipeline.outputs.gridCount?.stepDirs || {},
    segmentationCellsDir: pipeline.outputs.segmentation?.cellsDir || null,
    segmentationSummaryPath: pipeline.outputs.segmentation?.summaryPath || null,
    segmentationDebugPath: pipeline.outputs.segmentation?.debugImagePath || null,
    segmentationDebugMetaPath: pipeline.outputs.segmentation?.debugMetaPath || null,
    segmentationStepDirs: pipeline.outputs.segmentation?.stepDirs || {},
    cellLayerDir: pipeline.outputs.cellLayerExtraction?.dir || null,
    cellLayerCellsDir: pipeline.outputs.cellLayerExtraction?.cellsDir || null,
    cellLayerStepDirs: pipeline.outputs.cellLayerExtraction?.stepDirs || {},
    scoringDir: pipeline.outputs.scoring?.dir || null,
    scoringCellStepsDir: pipeline.outputs.scoring?.cellStepsDir || null,
    scoringPageRenderDir: pipeline.outputs.scoring?.pageRenderDir || null,
    scoringPageResultDir: pipeline.outputs.scoring?.pageResultDir || null
  };
}

async function discoverCases(inputDir = DEFAULT_INPUT_DIR) {
  const dirEntries = await fs.promises.readdir(inputDir, { withFileTypes: true });
  const files = dirEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-CN-u-kn-true'));

  return files.map((name) => ({
    imagePath: path.join(inputDir, name),
    gridType: 'square'
  }));
}

async function main() {
  const outputRootDir = '/home/lc/luckee_dao/baby/coze/插件/test/out';
  const inputDir = DEFAULT_INPUT_DIR;
  const cases = await discoverCases(inputDir);
  if (!cases.length) {
    throw new Error(`默认目录中没有可处理图片: ${inputDir}`);
  }
  const runTimestamp = formatTimestamp();
  const outputDir = path.join(outputRootDir, runTimestamp);
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(outputRootDir, 'LATEST'),
    `${runTimestamp}\n`,
    'utf8'
  );
  await fs.promises.writeFile(
    path.join(outputDir, '07_RUN_INFO.json'),
    `${JSON.stringify({
      runTimestamp,
      outputDir,
      inputDir,
      maxStep: MAX_STEP,
      cases: cases.map((item) => ({
        imagePath: item.imagePath,
        gridType: item.gridType || 'square'
      })),
      显示信息: {
        运行时间目录: runTimestamp,
        输出目录: outputDir,
        输入目录: inputDir,
        最大执行阶段: MAX_STEP,
        待处理文件: cases.map((item) => ({
          原始图片: item.imagePath,
          方格类型: item.gridType || 'square'
        }))
      }
    }, null, 2)}\n`,
    'utf8'
  );
  const stageManifest = {
    runTimestamp,
    rootDir: outputDir,
    maxStep: MAX_STEP,
    layout: {
      level1: '按时间创建运行目录',
      level2: '按待处理文件创建二级目录',
      level3: '按处理流程创建三级目录'
    },
    stages: {
      a4Locate: {
        displayName: '01 稿纸提取',
        dirPattern: path.join(outputDir, '<file_name>', '01_稿纸提取'),
        description: '仅基于稿纸白色连通区域检测并裁切纸面范围，不负责A4比例或透视矫正',
        input: '原始待处理图片',
        subSteps: {
          step01_1: '01_1_纸张范围检测 <- 原始待处理图片',
          step01_2: '01_2_纸张裁切导出 <- 01_1_纸张范围检测'
        }
      },
      a4Rectify: {
        displayName: '02 A4纸张矫正',
        dirPattern: path.join(outputDir, '<file_name>', '02_A4纸张矫正'),
        description: '基于 01 输出的稿纸裁切图，执行 A4 比例约束、纸张角点检测、透视矫正和去底纹',
        input: '01_2_稿纸裁切图',
        subSteps: {
          step02_0: '02_0_A4规格约束检测 <- 01_2_稿纸裁切图',
          step02_1: '02_1_纸张角点检测 <- 01_2_稿纸裁切图',
          step02_2: '02_2_透视矫正 <- 02_1_纸张角点检测',
          step02_3: '02_3_去底纹 <- 02_2_透视矫正',
          step02_3_1: '02_3_1_去底纹输出 <- 02_2_透视矫正',
          step02_3_2: '02_3_2_矫正预处理输出 <- 02_3_1_去底纹输出'
        }
      },
      gridRectExtract: {
        displayName: '03 总方格大矩形提取',
        dirPattern: path.join(outputDir, '<file_name>', '03_总方格大矩形提取'),
        description: '先基于 02_3_2 做粗裁剪去外框，再做四角点定位、透视矫正，并输出定位标注图、计数参考图和切分输入图',
        input: '02_3_2_矫正预处理图',
        subSteps: {
          step03_0: '03_0_方格背景与边界检测 <- 02_3_2_矫正预处理图',
          step03_1: '03_1_总方格候选矩形 <- 03_0',
          step03_2: '03_2_总方格矩形纠偏 <- 03_1_总方格候选矩形',
          step03_3: '03_3_总方格裁切标注 <- 03_2_总方格矩形纠偏'
        }
      },
      gridCount: {
        displayName: '04 总方格数量计算与标注',
        dirPattern: path.join(outputDir, '<file_name>', '04_方格数量计算标注'),
        description: '计算总方格矩形的行列数量与总格数，并输出数量标注图与05阶段唯一切分输入图',
        input: '03_3_总方格计数参考图',
        subSteps: {
          step04_1: '04_1_方格数量估计 <- 03_3_总方格计数参考图',
          step04_2: '04_2_方格数量标注 <- 04_1_方格数量估计',
          step04_3: '04_3_单格切分输入 <- 03_3_总方格计数参考图'
        }
      },
      segmentation: {
        displayName: '05 单个方格切分',
        dirPattern: path.join(outputDir, '<file_name>', '05_单格切分'),
        description: '仅使用 04_3_单格切分输入图 作为输入，生成方格切分、调试图、单格图',
        input: '04_3_单格切分输入图',
        subSteps: {
          step05_1: '05_1_网格范围检测 <- 04_3_单格切分输入图',
          step05_2: '05_2_边界引导切分 <- 05_1_网格范围检测',
          step05_3: '05_3_切分调试渲染 <- 05_2_边界引导切分',
          step05_4: '05_4_单格裁切 <- 05_2_边界引导切分'
        }
      },
      cellTextExtract: {
        displayName: '06 单个方格背景与文字提取',
        dirPattern: path.join(outputDir, '<file_name>', '06_单格背景文字提取'),
        description: '对每个单格输出原图、前景mask、清洗后文字mask、文字图、背景图',
        input: '05_4_单格裁切输出',
        subSteps: {
          step06_1: '06_1_单格原图导出 <- 05_4_单格裁切',
          step06_2: '06_2_单格前景Mask <- 06_1_单格原图导出',
          step06_3: '06_3_单格清洗文字Mask <- 06_2_单格前景Mask',
          step06_4: '06_4_单格文字图 <- 06_3_单格清洗文字Mask',
          step06_5: '06_5_单格背景图 <- 06_1_单格原图导出'
        }
      },
      scoring: {
        displayName: '07 单个方格文字评分',
        dirPattern: path.join(outputDir, '<file_name>', '07_单格评分'),
        description: '以上一步切分输出作为输入，生成评分结果、标注图与汇总',
        input: '06_4_单格文字图 / 05_4_单格定位信息',
        subSteps: {
          step07_1_to_07_5: '07_1至07_5_单格评分步骤 <- 06_4_单格文字图',
          step07_6: '07_6_页面评分渲染 <- 07_7_页面评分结果 + 05_切分定位信息',
          step07_7: '07_7_页面评分结果 <- 07_1 至 07_5'
        }
      }
    },
    files: cases.map((item) => {
      const baseName = path.basename(item.imagePath, path.extname(item.imagePath));
      return {
        baseName,
        imagePath: item.imagePath,
        fileRootDir: path.join(outputDir, baseName)
      };
    })
  };
  await fs.promises.writeFile(
    path.join(outputDir, '07_STAGE_MANIFEST.json'),
    `${JSON.stringify({
      ...stageManifest,
      显示信息: buildChineseStageManifestView(stageManifest)
    }, null, 2)}\n`,
    'utf8'
  );
  const reports = [];

  for (const item of cases) {
    reports.push(await processCase(item, outputDir));
  }

  const reportPath = path.join(outputDir, '07_REPORT.md');
  if (MAX_STEP < 7) {
    const lines = ['# 分步测试报告', '', `- 最大阶段: ${MAX_STEP}`, ''];
    for (const report of reports) {
      lines.push(`## ${report.baseName}`);
      lines.push(`- 文件根目录: ${report.fileRootDir}`);
      lines.push(`- 已完成阶段: ${report.completedStep}`);
      if (report.locateDir) {
        lines.push('');
        pushStageHeader(
          lines,
          '01',
          '稿纸提取',
          '原始待处理图片 -> 01_1_纸张范围检测 -> 01_2_稿纸裁切图',
          '原始待处理图片',
          report.locateDir,
          path.join(report.locateDir, 'stage_info.json'),
          Object.values(report.locateStepDirs || {})
        );
        pushIfPresent(lines, '稿纸裁切图', report.locateImagePath);
        pushIfPresent(lines, '阶段结果JSON', report.locateMetaPath);
      }
      if (report.rectifyDir) {
        lines.push('');
        pushStageHeader(
          lines,
          '02',
          'A4纸张矫正',
          '01_2_稿纸裁切图 -> 02_0_1_A4内切清边图 -> 02_0_A4规格约束检测图 -> 02_1_纸张角点调试图 -> 02_2_透视矫正图 -> 02_3_1_检测去底纹图 -> 02_3_2_矫正预处理图',
          '01_2_稿纸裁切图',
          report.rectifyDir,
          path.join(report.rectifyDir, 'stage_info.json'),
          report.preprocessMeta ? [
            path.join(report.rectifyDir, '02_0_A4规格约束检测'),
            path.join(report.rectifyDir, '02_1_纸张角点检测'),
            path.join(report.rectifyDir, '02_2_透视矫正'),
            path.join(report.rectifyDir, '02_3_去底纹'),
            path.join(report.rectifyDir, '02_3_1_去底纹输出'),
            path.join(report.rectifyDir, '02_3_2_矫正预处理输出')
          ] : []
        );
        pushIfPresent(lines, 'A4规格约束JSON', report.rectifyA4ConstraintMetaPath);
        pushIfPresent(lines, '矫正预处理图', report.preprocessPath);
        pushIfPresent(lines, '纸张角点调试图', report.quadDebugPath);
        pushIfPresent(lines, '纸张角点JSON', report.quadMetaPath);
        pushIfPresent(lines, '阶段结果JSON', report.preprocessMetaPath);
      }
      if (report.textRectDir) {
        lines.push('');
        pushStageHeader(
          lines,
          '03',
          '总方格大矩形提取',
          '02_3_2_矫正预处理图 -> 03_0_1_粗裁剪去外框输入图 -> 03_0_2_四角点定位标注图 -> 03_0_6_单格切分输入图 -> 03_1_总方格候选矩形 -> 03_2_总方格矩形纠偏 -> 03_3_总方格裁切标注',
          '02_3_2_矫正预处理图',
          report.textRectDir,
          path.join(report.textRectDir, 'stage_info.json'),
          Object.values(report.textRectStepDirs || {})
        );
        pushIfPresent(lines, '总方格定位标注图', report.textRectAnnotatedPath);
        pushIfPresent(lines, '总方格计数参考图', report.textRectWarpedPath);
        pushIfPresent(lines, '阶段结果JSON', report.textRectMetaPath);
      }
      if (report.gridCountDir) {
        lines.push('');
        pushStageHeader(
          lines,
          '04',
          '方格数量计算标注',
          '03_3_总方格计数参考图 -> 04_1_方格数量估计 -> 04_2_方格数量标注',
          '03_3_总方格计数参考图',
          report.gridCountDir,
          path.join(report.gridCountDir, 'stage_info.json'),
          Object.values(report.gridCountStepDirs || {})
        );
        pushIfPresent(lines, '方格数量标注图', report.gridCountAnnotatedPath);
        pushIfPresent(lines, '阶段结果JSON', report.gridCountMetaPath);
      }
      if (report.segmentationCellsDir) {
        lines.push('');
        pushStageHeader(
          lines,
          '05',
          '单格切分',
          '选中的切分输入图 -> 05_1_网格范围检测 -> 05_2_边界引导切分 -> 05_3_切分调试渲染 -> 05_4_单格裁切',
          report.segmentationSelection?.selectedImagePath || report.gridSegmentationInputPath || null,
          path.dirname(report.segmentationCellsDir),
          path.join(path.dirname(report.segmentationCellsDir), 'stage_info.json'),
          Object.values(report.segmentationStepDirs || {})
        );
        pushIfPresent(lines, '单格图目录', report.segmentationCellsDir);
        pushIfPresent(lines, '阶段结果JSON', report.segmentationSummaryPath);
      }
      if (report.cellLayerDir) {
        lines.push('');
        pushStageHeader(
          lines,
          '06',
          '单格背景文字提取',
          '05_4_单格裁切 -> 06_1_单格原图导出 -> 06_2_单格前景Mask -> 06_3_单格清洗文字Mask -> 06_4_单格文字图，并由 06_1 生成 06_5_单格背景图',
          '05_4_单格裁切输出',
          report.cellLayerDir,
          path.join(report.cellLayerDir, 'stage_info.json'),
          Object.values(report.cellLayerStepDirs || {})
        );
        pushIfPresent(lines, '单格分层目录', report.cellLayerCellsDir);
      }
      if (report.scoringDir) {
        lines.push('');
        pushStageHeader(
          lines,
          '07',
          '单格评分',
          '06_4_单格文字图 -> 07_1_单格特征提取 -> 07_2_空白格判定 -> 07_3_单格结构评分 / 07_4_单格相似度评分 -> 07_5_单格总评分 -> 07_7_页面评分结果 -> 07_6_页面评分渲染',
          '06_4_单格文字图 / 05_4_单格定位信息',
          report.scoringDir,
          path.join(report.scoringDir, 'stage_info.json'),
          []
        );
        pushIfPresent(lines, '页面评分标注图', report.annotatedImagePath);
        pushIfPresent(lines, '页面评分结果JSON', report.jsonPath);
      }
      lines.push('');
    }
    await fs.promises.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(`run:       ${runTimestamp}`);
    console.log(`output:    ${outputDir}`);
    console.log(`report:    ${reportPath}`);
    return;
  }

  const lines = ['# 真实图片评分报告', ''];

  for (const report of reports) {
    const lowScoreItems = report.scoring.results
      .filter((item) => item.status === 'scored' && item.total_score !== null)
      .sort((a, b) => a.total_score - b.total_score)
      .slice(0, 10);

    lines.push(`## ${report.baseName}`);
    lines.push('');
    lines.push(`- 文件根目录: ${report.fileRootDir}`);
      lines.push('');
    pushStageHeader(
      lines,
      '01',
      '稿纸提取',
      '原始待处理图片 -> 01_1_纸张范围检测 -> 01_2_稿纸裁切图',
      '原始待处理图片',
      report.locateDir,
      path.join(report.locateDir, 'stage_info.json'),
      Object.values(report.locateStepDirs || {})
    );
    lines.push(`- 稿纸裁切图: ${report.locateImagePath}`);
    lines.push(`- 稿纸提取JSON: ${report.locateMetaPath}`);
    if (report.a4ConstraintMeta?.a4Constraint) {
      lines.push(`- A4匹配: ${report.a4ConstraintMeta.a4Constraint.isLikelyA4 ? '是' : '否'}`);
      lines.push(`- A4置信度: ${report.a4ConstraintMeta.a4Constraint.confidence}`);
      lines.push(`- A4比例误差: ${report.a4ConstraintMeta.a4Constraint.ratioErrorPercent}%`);
    }
    lines.push(`- 纸面范围: left=${report.preprocessMeta.paperBounds.left}, top=${report.preprocessMeta.paperBounds.top}, width=${report.preprocessMeta.paperBounds.width}, height=${report.preprocessMeta.paperBounds.height}`);
    lines.push('');
    pushStageHeader(
      lines,
      '02',
      'A4纸张矫正',
      '01_2_稿纸裁切图 -> 02_0_1_A4内切清边图 -> 02_0_A4规格约束检测图 -> 02_1_纸张角点调试图 -> 02_2_透视矫正图 -> 02_3_1_检测去底纹图 -> 02_3_2_矫正预处理图',
      '01_2_稿纸裁切图',
      report.rectifyDir,
      path.join(report.rectifyDir, 'stage_info.json'),
      [
        path.join(report.rectifyDir, '02_0_A4规格约束检测'),
        path.join(report.rectifyDir, '02_1_纸张角点检测'),
        path.join(report.rectifyDir, '02_2_透视矫正'),
        path.join(report.rectifyDir, '02_3_去底纹'),
        path.join(report.rectifyDir, '02_3_1_去底纹输出'),
        path.join(report.rectifyDir, '02_3_2_矫正预处理输出')
      ]
    );
    lines.push(`- A4规格约束JSON: ${report.rectifyA4ConstraintMetaPath || '无'}`);
    lines.push(`- 四顶点标注图: ${report.quadDebugPath}`);
    lines.push(`- 四顶点JSON: ${report.quadMetaPath}`);
    lines.push(`- 纸张角点: ${report.preprocessMeta.paperCorners ? report.preprocessMeta.paperCorners.map((point) => `(${Math.round(point[0])}, ${Math.round(point[1])})`).join(', ') : '无'}`);
    lines.push(`- 粗角点: ${report.preprocessMeta.roughPaperCorners ? report.preprocessMeta.roughPaperCorners.map((point) => `(${Math.round(point[0])}, ${Math.round(point[1])})`).join(', ') : '无'}`);
    lines.push(`- 精修角点: ${report.preprocessMeta.refinedPaperCorners ? report.preprocessMeta.refinedPaperCorners.map((point) => `(${Math.round(point[0])}, ${Math.round(point[1])})`).join(', ') : '无'}`);
    if (report.preprocessMeta.cornerSelection) {
      lines.push(`- 角点选择: selected=${report.preprocessMeta.cornerSelection.selected}, reason=${report.preprocessMeta.cornerSelection.reason}`);
      lines.push(`- 角点评分: rough_area=${report.preprocessMeta.cornerSelection.roughArea}, refined_area=${Math.round(report.preprocessMeta.cornerSelection.refinedArea)}, area_ratio=${report.preprocessMeta.cornerSelection.areaRatio ?? 'n/a'}, rough_angle=${report.preprocessMeta.cornerSelection.roughAngleScore ?? 'n/a'}, refined_angle=${report.preprocessMeta.cornerSelection.refinedAngleScore ?? 'n/a'}`);
    }
    lines.push('');
        pushStageHeader(
          lines,
          '03',
          '总方格大矩形提取',
          '02_3_2_矫正预处理图 -> 03_0_1_粗裁剪去外框输入图 -> 03_0_2_四角点定位标注图 -> 03_0_6_单格切分输入图 -> 03_1_总方格候选矩形 -> 03_2_总方格矩形纠偏 -> 03_3_总方格裁切标注',
          '02_3_2_矫正预处理图',
          report.textRectDir,
          path.join(report.textRectDir, 'stage_info.json'),
          Object.values(report.textRectStepDirs || {})
        );
    lines.push(`- 原图: ${report.preprocessMeta.imagePath}`);
    lines.push(`- A4矫正后图: ${report.preprocessPath}`);
    lines.push(`- 透视矫正图: ${report.preprocessWarpedPath}`);
    lines.push(`- 去底纹图: ${report.preprocessGuideRemovedPath}`);
    lines.push(`- 方格背景mask: ${report.preprocessGridBackgroundMaskPath}`);
    lines.push(`- 总方格定位标注图: ${report.textRectAnnotatedPath}`);
    lines.push(`- 大矩形JSON: ${report.textRectMetaPath}`);
    lines.push(`- 总方格计数参考图: ${report.textRectWarpedPath}`);
    pushIfPresent(lines, '矩形白纸黑字图', report.textRectPreprocessedPath);
    lines.push(`- 单格切分输入图: ${report.gridSegmentationInputPath}`);
    pushIfPresent(lines, '矩形方格mask', report.textRectMaskPath);
    lines.push(`- A4角点调试图: ${report.preprocessDebugPath}`);
    lines.push(`- A4矫正元数据: ${report.preprocessMetaPath}`);
    if (report.preprocessGridRectifiedPath) {
      lines.push(`- 03_0_6_单格切分输入图: ${report.preprocessGridRectifiedPath}`);
    }
    if (report.preprocessGridRectifiedMetaPath) {
      lines.push(`- 03_0_6_单格切分输入信息: ${report.preprocessGridRectifiedMetaPath}`);
    }
    if (report.preprocessGridEstimateMetaPath) {
    lines.push(`- 方格规格预估JSON: ${report.preprocessGridEstimateMetaPath}`);
    }
    if (report.preprocessMeta.gridEstimationInputPath) {
      lines.push(`- 方格估计输入: ${report.preprocessMeta.gridEstimationInputPath}`);
    }
    lines.push(`- 处理方式: ${report.preprocessMeta.method}`);
    lines.push(`- 方格类型: ${report.preprocessMeta.gridType || 'square'}`);
    if (report.preprocessMeta.warp) {
    lines.push(`- 透视目标尺寸: ${report.preprocessMeta.warp.targetWidth} x ${report.preprocessMeta.warp.targetHeight}`);
    }
    lines.push(`- 输出尺寸: ${report.preprocessMeta.outputInfo.width} x ${report.preprocessMeta.outputInfo.height}`);
    lines.push('');
        pushStageHeader(
          lines,
          '04',
          '总方格数量计算与标注',
          '03_3_总方格计数参考图 -> 04_1_方格数量估计 -> 04_2_方格数量标注 -> 04_3_单格切分输入图',
          '03_3_总方格计数参考图',
          report.gridCountDir,
          path.join(report.gridCountDir, 'stage_info.json'),
      Object.values(report.gridCountStepDirs || {})
    );
    lines.push(`- 数量标注图: ${report.gridCountAnnotatedPath}`);
    lines.push(`- 数量JSON: ${report.gridCountMetaPath}`);
    if (report.estimatedGrid) {
      lines.push(`- 预估方格: ${report.estimatedGrid.estimatedGridRows || 'n/a'} x ${report.estimatedGrid.estimatedGridCols || 'n/a'}, confidence=${report.estimatedGrid.confidence ?? 'n/a'}`);
    }
    if (report.effectiveGrid) {
      lines.push(`- 采用方格: ${report.effectiveGrid.rows} x ${report.effectiveGrid.cols}, source=${report.effectiveGrid.source}`);
    }
    lines.push('');
    pushStageHeader(
      lines,
      '05',
      '单个方格切分',
      '04_3_单格切分输入图 -> 05_1_网格范围检测 -> 05_2_边界引导切分 -> 05_3_切分调试渲染 -> 05_4_单格裁切',
      report.segmentationSelection?.selectedImagePath || report.segmentationMeta.imagePath,
      path.dirname(report.segmentationCellsDir),
      path.join(path.dirname(report.segmentationCellsDir), 'stage_info.json'),
      Object.values(report.segmentationStepDirs || {})
    );
    pushIfPresent(lines, '矩形去底纹图', report.textRectGuideRemovedPath);
    lines.push(`- 矩形来源: ${report.textRectMeta.sourceMethod || 'unknown'}`);
    lines.push(`- 是否自动纠偏: ${report.textRectMeta.adjusted ? '是' : '否'}`);
    lines.push(`- 矩形范围: left=${report.textRectMeta.bounds.left}, top=${report.textRectMeta.bounds.top}, width=${report.textRectMeta.bounds.width}, height=${report.textRectMeta.bounds.height}`);
    if (report.textRectMeta.sourceImageSize) {
      lines.push(`- 来源图尺寸: ${report.textRectMeta.sourceImageSize.width} x ${report.textRectMeta.sourceImageSize.height}`);
    }
    if (report.textRectMeta.areaRatio !== undefined) {
      lines.push(`- 占整页比例: ${report.textRectMeta.areaRatio}`);
    }
    if (report.textRectMeta.diagnostics?.margins) {
      lines.push(`- 裁剪边距: left=${report.textRectMeta.diagnostics.margins.left}, right=${report.textRectMeta.diagnostics.margins.right}, top=${report.textRectMeta.diagnostics.margins.top}, bottom=${report.textRectMeta.diagnostics.margins.bottom}`);
    }
    if (report.textRectMeta.diagnostics?.cropRatios) {
      lines.push(`- 裁剪比例: left=${report.textRectMeta.diagnostics.cropRatios.left}, right=${report.textRectMeta.diagnostics.cropRatios.right}, top=${report.textRectMeta.diagnostics.cropRatios.top}, bottom=${report.textRectMeta.diagnostics.cropRatios.bottom}`);
    }
    lines.push(`- 贴边告警: ${(report.textRectMeta.diagnostics?.warnings || []).join(', ') || '无'}`);
    if (report.textRectMeta.adjustment) {
      lines.push(`- 纠偏参数: insetX=${report.textRectMeta.adjustment.insetX}, insetY=${report.textRectMeta.adjustment.insetY}`);
      lines.push(`- 原始矩形: left=${report.textRectMeta.adjustment.originalBounds.left}, top=${report.textRectMeta.adjustment.originalBounds.top}, width=${report.textRectMeta.adjustment.originalBounds.width}, height=${report.textRectMeta.adjustment.originalBounds.height}`);
    }
    if (report.textRectMeta.gridRectificationGuides) {
      lines.push(`- 外框guides: left=${Math.round(report.textRectMeta.gridRectificationGuides.left)}, right=${Math.round(report.textRectMeta.gridRectificationGuides.right)}, top=${Math.round(report.textRectMeta.gridRectificationGuides.top)}, bottom=${Math.round(report.textRectMeta.gridRectificationGuides.bottom)}`);
    }
    lines.push('');
    pushStageHeader(
      lines,
      '06',
      '单个方格背景与文字提取',
      '05_4_单格裁切 -> 06_1_单格原图导出 -> 06_2_单格前景Mask -> 06_3_单格清洗文字Mask -> 06_4_单格文字图，并由 06_1 生成 06_5_单格背景图',
      '05_4_单格裁切输出',
      report.cellLayerDir,
      path.join(report.cellLayerDir, 'stage_info.json'),
      Object.values(report.cellLayerStepDirs || {})
    );
    lines.push(`- 单格层目录: ${report.cellLayerCellsDir}`);
    lines.push(`- 子步骤目录: ${Object.values(report.cellLayerStepDirs || {}).join(' ; ') || '无'}`);
    lines.push('');
    pushStageHeader(
      lines,
      '07',
      '单个方格文字评分',
      '06_4_单格文字图 -> 07_1_单格特征提取 -> 07_2_空白格判定 -> 07_3_单格结构评分 / 07_4_单格相似度评分 -> 07_5_单格总评分 -> 07_7_页面评分结果 -> 07_6_页面评分渲染',
      '06_4_单格文字图 / 05_4_单格定位信息',
      report.scoringDir || '无',
      report.scoringDir ? path.join(report.scoringDir, 'stage_info.json') : '无',
      []
    );
    lines.push(`- 单格评分目录: ${report.scoringCellStepsDir || '无'}`);
    lines.push('- 单格评分目录说明: 每个单格目录内包含07_1到07_5五个中间评分JSON');
    lines.push(`- 页面渲染目录: ${report.scoringPageRenderDir || '无'}`);
    lines.push(`- 页面结果目录: ${report.scoringPageResultDir || '无'}`);
    lines.push(`- 单格目录: ${report.segmentationCellsDir}`);
    lines.push(`- 切分输入图: ${report.segmentationMeta.stageInputPath}`);
    lines.push(`- 汇总JSON: ${report.segmentationSummaryPath}`);
    lines.push(`- 调试图: ${report.segmentationDebugPath}`);
    lines.push(`- 调试JSON: ${report.segmentationDebugMetaPath}`);
    lines.push(`- 方格数量: ${report.segmentationMeta.totalCells}`);
    lines.push(`- 网格范围: left=${report.segmentationMeta.gridBounds.left}, top=${report.segmentationMeta.gridBounds.top}, width=${report.segmentationMeta.gridBounds.width}, height=${report.segmentationMeta.gridBounds.height}`);
    if (report.segmentationMeta.alignmentStats) {
      lines.push(`- 平均列宽: ${report.segmentationMeta.alignmentStats.averageColWidth}`);
      lines.push(`- 平均行高: ${report.segmentationMeta.alignmentStats.averageRowHeight}`);
      lines.push(`- 最大列宽偏差: ${report.segmentationMeta.alignmentStats.maxColWidthDeviation}`);
      lines.push(`- 最大行高偏差: ${report.segmentationMeta.alignmentStats.maxRowHeightDeviation}`);
    }
    lines.push(`- 回退切分: ${report.segmentationMeta.debug.fallbackUsed ? '是' : '否'}`);
    lines.push(`- 使用方格背景mask: ${report.segmentationMeta.debug.guideMaskUsed ? '是' : '否'}`);
    lines.push(`- 边界模式: ${report.segmentationMeta.debug.selectedBoundaryMode || 'direct_lines'}`);
    lines.push(`- 竖线数量: ${report.segmentationMeta.debug.verticalLines.length}`);
    lines.push(`- 横线数量: ${report.segmentationMeta.debug.horizontalLines.length}`);
    if (report.segmentationMeta.debug.directBoundaryQuality) {
      lines.push(`- 直接格线质量: score=${report.segmentationMeta.debug.directBoundaryQuality.score}, blanks=${report.segmentationMeta.debug.directBoundaryQuality.blankCount}, center=${report.segmentationMeta.debug.directBoundaryQuality.averageCenterOffset}`);
    }
    if (report.segmentationMeta.debug.outerRectBoundaryQuality) {
      lines.push(`- 外框均分质量: score=${report.segmentationMeta.debug.outerRectBoundaryQuality.score}, blanks=${report.segmentationMeta.debug.outerRectBoundaryQuality.blankCount}, center=${report.segmentationMeta.debug.outerRectBoundaryQuality.averageCenterOffset}`);
    }
    if ((report.segmentationMeta.debug.outerRectVerticalLines || []).length) {
      lines.push(`- 外框均分竖线: ${(report.segmentationMeta.debug.outerRectVerticalLines || []).join(', ')}`);
    }
    if ((report.segmentationMeta.debug.outerRectHorizontalLines || []).length) {
      lines.push(`- 外框均分横线: ${(report.segmentationMeta.debug.outerRectHorizontalLines || []).join(', ')}`);
    }
    if ((report.segmentationMeta.debug.horizontalCorrections || []).length) {
      lines.push(`- 横向局部纠偏数量: ${report.segmentationMeta.debug.horizontalCorrections.length}`);
      lines.push(`- 纠偏前横线: ${(report.segmentationMeta.debug.horizontalLinesBeforeCorrection || []).join(', ') || '无'}`);
      lines.push(`- 纠偏后横线: ${(report.segmentationMeta.debug.horizontalLines || []).join(', ') || '无'}`);
      lines.push(`- 侧边共识横线: ${(report.segmentationMeta.debug.sideConsensusHorizontalLines || []).join(', ') || '无'}`);
      for (const correction of report.segmentationMeta.debug.horizontalCorrections) {
        lines.push(`- 边界${correction.boundaryIndex}纠偏: ${correction.from} -> ${correction.to}`);
      }
    }
    if (report.segmentationSelection) {
      lines.push(`- 选中切分源: ${report.segmentationSelection.selectedSource}`);
      lines.push(`- 选中质量分: ${report.segmentationSelection.quality.score}`);
      for (const candidate of report.segmentationSelection.candidates || []) {
        lines.push(`- 候选 ${candidate.source}: score=${candidate.quality.score}, blanks=${candidate.quality.blankCount}, fallback=${candidate.quality.fallbackUsed ? 'yes' : 'no'}, lines=${candidate.quality.lineCount}, preview_avg=${candidate.scoringPreview?.avgScore ?? 'n/a'}, preview_blanks=${candidate.scoringPreview?.blankCells ?? 'n/a'}`);
      }
    }
    lines.push('');
    lines.push('### 07 单个方格文字评分结果');
    lines.push(`- 标注图: ${report.annotatedImagePath}`);
    lines.push(`- 评分输入图: ${report.segmentationSelection?.selectedImagePath || '无'}`);
    lines.push(`- 摘要: ${report.summaryPath}`);
    lines.push(`- JSON: ${report.jsonPath}`);
    lines.push(`- 空白格数量: ${report.scoring.summary.blank_cells}`);
    lines.push(`- 平均分: ${report.scoring.summary.avg_score}`);
    lines.push(`- 空白格列表: ${report.scoring.summary.blank_cell_ids.join(', ') || '无'}`);
    lines.push(`- 低分格列表: ${report.scoring.summary.low_score_cell_ids.join(', ') || '无'}`);
    lines.push('- 低分样本:');
    for (const item of lowScoreItems) {
      const penalties = item.penalties.map((penalty) => penalty.message).join(' / ') || '无';
      lines.push(`  - ${item.cell_id}: ${item.total_score} 分, ${penalties}`);
    }
    lines.push('');
  }

  await fs.promises.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`run:       ${runTimestamp}`);
  console.log(`output:    ${outputDir}`);
  console.log(`report:    ${reportPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('真实图片测试失败：', error);
    process.exitCode = 1;
  });
}
