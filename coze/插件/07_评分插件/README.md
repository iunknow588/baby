# 07 评分插件

当前版本为规则评分 MVP，可直接消费 `05` 切分插件输出。

当前默认流程：

- 先对书写纸做预处理，转换为更接近“白纸黑字”
- 再进行切分
- 再进行评分和原图标注

默认评分参数位于：

- [config/defaults.json](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/config/defaults.json)

## 当前能力

- 空白格识别
- 布局分
- 主体大小分
- 稳定性粗分
- 目标字结构分
- 目标字模板相似度评分
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
  options: {
    config: {
      layout: {
        center_penalty_scale: 600
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
- `results[].penalties`
- `results[].features`
- `results[].model_outputs`

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

## 后续迭代

- 引入空白格分类模型
- 引入质量回归模型
- 引入更细的偏旁结构评分
- 引入字种自适应阈值与评分参数
