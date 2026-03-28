# 07 评分插件

当前版本为规则评分 MVP，可直接消费 `05` 切分插件输出，并已对齐统一硬笔书法评分标准。

当前默认流程：

- 先对书写纸做预处理，转换为更接近“白纸黑字”
- 再进行切分
- 再进行评分和原图标注

默认评分参数位于：

- [config/defaults.json](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/config/defaults.json)

## 当前能力

- 空白格识别
- 笔画质量评分
- 结构准确性评分
- 目标字形态相似度评分
- 无模板场景整洁度评分
- 扣分项解释输出
- 批量处理 `segmentation.matrix`

## 使用方式

```bash
npm install
npm test
npm run test:real
```

```javascript
const scoringPlugin = require('./07_评分插件');

const result = await scoringPlugin.execute({
  task_id: 'task-1',
  image_id: 'page-1',
  target_chars: [['永']],
  recognized_chars: [['永']],
  options: {
    config: {
      layout: {
        center_penalty_scale: 600
      }
    },
    ocr: {
      enabled: true,
      pythonPath: '/home/lc/miniconda3/envs/paddleocr/bin/python',
      confidenceThreshold: 0.5,
      preprocess: {
        enabled: true,
        targetSize: 96,
        cropToContent: true,
        binarize: true
      }
    }
  },
  segmentation: {
    gridRows: 1,
    gridCols: 1,
    cells: [{ row: 0, col: 0, pageBox: {}, contentBox: {} }],
    matrix: [[base64OrBuffer]]
  }
});
```

## 输出内容

- `summary`
- `summary.avg_score`
- `summary.base_avg_score`
- `summary.blank_cell_ids`
- `summary.scored_cell_ids`
- `summary.low_score_cell_ids`
- `summary.review_cell_ids`
- `page_stats.status_matrix`
- `grid_results`
- `results`
- `results[].status`
- `results[].blank_reason`
- `results[].total_score`
- `results[].sub_scores`
- `results[].score_breakdown`
- `results[].penalties`
- `results[].features`
- `results[].model_outputs`
- `summary.page_total_score`
- `summary.page_penalties`
- `summary.text_audit`

说明：

- `avg_score` / `base_avg_score` 是单格基础平均分
- `page_total_score` 是叠加页级扣分后的整页最终分
- 如需控制整页单格评分并发度，可通过 `options.config.execution.page_scoring_concurrency` 覆盖默认值

## 空白方格处理

- 允许用户留空部分方格
- 空白方格不会报错，也不会强制评分
- 系统会直接返回 `status: "blank"`
- 同时返回 `blank_reason`
- 整页汇总里会给出 `summary.blank_cell_ids`
- 同时会给出 `summary.review_cell_ids`，便于上层直接标记或复核

## 推荐消费方式

- 若前端或工作流按格子二维展示，优先使用 `grid_results`
- 每个格子会直接提供 `status`、`label`、`action`、`total_score`
- 空白格默认返回 `action: "mark_blank"`

## 页级文本校验

- 若上游已经有逐格 OCR 结果，可通过 `recognized_chars` 传入
- 若未传 `recognized_chars`，也可以开启 `options.ocr.enabled = true`，由系统自动调用 PaddleOCR
- OCR 默认读取 `06_单格背景文字提取` 输出的 `textOnlyPath`，并在识别前执行单字归一化与二值化多候选识别
- 插件会执行页级：
  - 错字扣分
  - 添字扣分
  - 基于识别结果的漏字校验
- 若未传入 `recognized_chars`，文本校验自动降级，不影响评分主流程
- 若未提供 `target_chars`，OCR 结果只作为诊断输出，不参与错字/添字/漏字扣分
- 若本机 Python 存在 `~/.local` 用户级包污染，OCR 插件会强制启用 `PYTHONNOUSERSITE=1` 隔离

## 原图标注测试

- `npm run test:real` 会处理 `/home/lc/luckee_dao/baby/coze/插件/test` 下的真实图片
- 每次真实图片测试都会输出到 `/home/lc/luckee_dao/baby/coze/插件/test/out/<YYYYMMDD_HHMMSS>`
- 目录内按顺序分为 `01_preprocess`、`02_segmentation`、`03_scoring`
- 根目录说明文件按顺序命名为 `04_RUN_INFO.json`、`04_STAGE_MANIFEST.json`、`04_REPORT.md`
- 最近一次测试目录会记录在 `/home/lc/luckee_dao/baby/coze/插件/test/out/LATEST`
- 会生成：
  - 预处理后的白纸黑字图
  - 标注后的原图
  - 每格扣分点文本摘要
  - 完整 JSON 结果

## 调参方式

- 直接修改 [defaults.json](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/config/defaults.json)
- 或在 `execute(params)` 中通过 `options.config` 局部覆盖默认配置
- 当前默认页级并发评分参数位于 `config.execution.page_scoring_concurrency`

## 步骤产物输出

- 若传入 `outputDir`，系统会为每个单格输出 `07_1` 到 `07_5` 的步骤目录与步骤 JSON
- 可通过 `artifactLevel` 控制单格步骤产物：
  - `debug`：保留 `07_1` 到 `07_5` 的步骤目录与步骤 JSON
  - `standard`：抑制单格步骤目录，仅保留评分主结果、页级摘要、渲染结果，以及启用 OCR 时的 OCR 诊断目录
  - `minimal`：进一步抑制 OCR 诊断目录，仅保留评分主结果、页级摘要、渲染结果
- 单格结果中会同步返回：
  - `results[].stepDirs`
  - `results[].stepMetaPaths`

## 当前评分维度

- `stroke_quality`
- `structure_accuracy`
- `morphology_similarity`
- `cleanliness`

兼容旧链路，`sub_scores` 中仍保留 `layout / size / stability / structure / similarity` 别名字段。

补充说明：

- 无目标字场景下，正式字段仍以 `cleanliness` 表示整洁度
- 为兼容旧链路，`sub_scores.similarity` 会回退映射到 `cleanliness`
- 该映射关系会同步写入 `score_breakdown.alias_semantics`

模板字生成说明：

- 当前模板字使用可配置字体栈渲染，默认值位于 `config/defaults.json`
- 如需与教学字帖严格对齐，建议后续替换为固定模板资源

## 后续迭代

- 引入空白格分类模型
- 引入真实笔画级特征
- 引入更细的偏旁结构评分
- 引入字种自适应阈值与评分参数
