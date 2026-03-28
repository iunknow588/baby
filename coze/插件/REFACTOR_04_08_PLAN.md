# 04-08 阶段重构路线图

## 目标

本路线图只处理 `04/05/06/07/08` 阶段的结构收敛，不改变主流程顺序：

- `04` 继续负责网格确认与人工复核产物
- `05` 继续负责单格切分
- `06` 继续负责单格分层
- `07` 继续负责单格与页级评分
- `08` 继续负责 OCR 识别

重构的重点不是删功能，而是把“业务阶段”和“调试步骤”拆开：

- 对外保留少量稳定阶段入口
- 对内保留足够细的可观测步骤与产物
- 修正当前不合理的依赖方向
- 降低后续维护和迁移成本

## 当前进展（2026-03-28）

- 已完成“阶段 A：先修依赖边界”
  - 新增共享模块 [utils/cell_image_analysis.js](/home/lc/luckee_dao/baby/coze/插件/utils/cell_image_analysis.js)
  - [06_单格背景文字提取插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/index.js) 不再依赖 [07_评分插件/scoring.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/scoring.js)
  - [07_评分插件/domain/cell_feature_extraction.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/domain/cell_feature_extraction.js) 已降为兼容层
- 已完成“阶段 C：收敛 06”的第一步
  - 新增 [06_单格背景文字提取插件/create_cell_layer_export_plugin.js](/home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/create_cell_layer_export_plugin.js)
  - `06_1~06_5` 仍保留外部入口，但内部已统一复用同一个 exporter helper
  - [06_单格背景文字提取插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/index.js) 已支持 `artifactLevel=minimal|standard|debug`
  - `06` 当前产物级别已收敛为：
    - `debug`: 保留 `06_1~06_5` 全量目录、步骤 JSON、单格汇总 JSON
    - `standard`: 保留 `06_4_单格文字图` 与 `06_5_单格背景图`，抑制中间层与单格汇总 JSON
    - `minimal`: 仅保留 `06_4_单格文字图` 与阶段汇总 JSON
- 已完成“阶段 D：收敛 07”的核心内聚
  - 新增 [07_评分插件/application/cell_scoring_steps.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/application/cell_scoring_steps.js)
  - 新增 [07_评分插件/application/page_scoring_aggregation_service.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/application/page_scoring_aggregation_service.js)
  - [07_评分插件/application/cell_scoring_service.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/application/cell_scoring_service.js) 与 [07_评分插件/application/page_scoring_service.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/application/page_scoring_service.js) 已不再依赖外层 `07_0~07_5` wrapper 才能完成主流程
  - [07_评分插件/application/page_scoring_service.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/application/page_scoring_service.js) 已支持按 `artifactLevel` 抑制 `07_1~07_5` 单格步骤产物
  - `07_0~07_5` 入口仍保留，用作兼容层
- 已完成“阶段 B：收敛 04”的核心内聚
  - 新增 [04_方格数量计算标注插件/domain/grid_count.js](/home/lc/luckee_dao/baby/coze/插件/04_方格数量计算标注插件/domain/grid_count.js)
  - 新增 [04_方格数量计算标注插件/presentation/grid_count_annotation.js](/home/lc/luckee_dao/baby/coze/插件/04_方格数量计算标注插件/presentation/grid_count_annotation.js)
  - [04_方格数量计算标注插件/index.js](/home/lc/luckee_dao/baby/coze/插件/04_方格数量计算标注插件/index.js) 已直接依赖内部模块，不再通过 `04_1/04_2` wrapper 完成主流程
  - `04_1/04_2` 入口仍保留，用作兼容层
- 已补充共享运行时 helper
  - 新增 [utils/require_sharp.js](/home/lc/luckee_dao/baby/coze/插件/utils/require_sharp.js)，统一处理 `sharp` 解析逻辑
- 已完成“阶段 E：整理 05”的第一步
  - 新增 [05_切分插件/domain/grid_bounds.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/domain/grid_bounds.js)
  - 新增 [05_切分插件/domain/cell_crop.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/domain/cell_crop.js)
  - 新增 [05_切分插件/domain/boundary_guides.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/domain/boundary_guides.js)
  - 新增 [05_切分插件/domain/guide_normalization.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/domain/guide_normalization.js)，把 `05_0` 收进 `05` 内部共享层
  - 新增 [05_切分插件/presentation/debug_render.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/presentation/debug_render.js)
  - [05_切分插件/hanzi_segmentation.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/hanzi_segmentation.js) 已改为直接依赖内部模块，不再通过 `05_1/05_2/05_3/05_4` wrapper 完成主流程
  - [05_0方格边界规范化插件/index.js](/home/lc/luckee_dao/baby/coze/插件/05_0方格边界规范化插件/index.js) 已降为兼容 wrapper
  - [00_预处理插件/paper_preprocess.js](/home/lc/luckee_dao/baby/coze/插件/00_预处理插件/paper_preprocess.js) 已直接复用 `05` 共享规范化模块，不再通过 `05_0` wrapper 反向调用内部实现
  - `05_1/05_2/05_3/05_4` 入口仍保留，用作兼容层
- 已完成“阶段 F：产物策略统一”的第一步
  - 新增 [utils/artifact_policy.js](/home/lc/luckee_dao/baby/coze/插件/utils/artifact_policy.js)
  - [05_切分插件/index.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/index.js) 已支持 `artifactLevel=minimal|standard|debug`
  - [06_单格背景文字提取插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/index.js) 已支持 `artifactLevel=minimal|standard|debug`
  - [07_评分插件/index.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/index.js) 已支持通过 `artifactLevel` 抑制单格步骤目录，且不影响页级摘要、渲染与评分 JSON
  - [00_流水线插件/index.js](/home/lc/luckee_dao/baby/coze/插件/00_流水线插件/index.js) 已改为回传真实存在的 `05` 阶段产物路径，不再对被抑制的 debug 产物做路径兜底
  - [00_流水线插件/index.js](/home/lc/luckee_dao/baby/coze/插件/00_流水线插件/index.js) 已同步回传真实存在的 `06/07` 产物路径，不再把被抑制目录写进阶段输出快照
- 已完成空白目录清理
  - 已删除无实现且无引用的空目录插件占位目录
  - 已清理 `test/out` 下无文件的历史空目录
- 已完成回归验证
  - `node /home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/test/test.js`
  - `node /home/lc/luckee_dao/baby/coze/插件/test_stage_single_image_contract.js`
  - `node /home/lc/luckee_dao/baby/coze/插件/07_评分插件/test/test.js`
  - `node -c /home/lc/luckee_dao/baby/coze/插件/00_流水线插件/index.js`
  - `stage04-smoke-ok` 临时冒烟校验
  - `node /home/lc/luckee_dao/baby/coze/插件/05_切分插件/test/test.js`
  - `stage05-wrapper-smoke-ok` 临时兼容冒烟校验
  - `stage05-step2-wrapper-smoke-ok` 临时兼容冒烟校验

## 当前问题

### 1. 业务阶段与内部步骤混在一起

- `04_1/04_2/04_3`
- `06_1~06_5`
- `07_1~07_5`

这些步骤很多都更像中间产物标签，而不是需要长期对外暴露的独立能力。

### 2. 依赖方向不清晰

当前 `06_单格背景文字提取` 直接依赖 `07_评分插件/scoring` 导出的 `extractCellLayers`：

- [06_单格背景文字提取插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/index.js)
- [07_评分插件/scoring.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/scoring.js)
- [07_评分插件/domain/cell_feature_extraction.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/domain/cell_feature_extraction.js)

这会形成“上游阶段依赖下游阶段”的反向耦合。

### 3. 薄包装插件过多

例如：

- [06_1单格原图导出插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_1单格原图导出插件/index.js)
- [06_2单格前景Mask插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_2单格前景Mask插件/index.js)
- [06_3单格清洗文字Mask插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_3单格清洗文字Mask插件/index.js)
- [06_4单格文字图插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_4单格文字图插件/index.js)
- [06_5单格背景图插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_5单格背景图插件/index.js)

这些文件大多只是“把已有 buffer 写到磁盘 + 输出一个 JSON”。

### 4. 文档和目录语义偏复杂

现有目录更像“内部实验过程全展开”，对日常维护者不够友好，理解成本偏高。

## 重构后的目标结构

```text
/home/lc/luckee_dao/baby/coze/插件/
  04_网格确认插件/
    index.js
    domain/grid_count.js
    presentation/grid_count_annotation.js

  05_切分插件/
    index.js
    application/segmentation_service.js
    domain/grid_bounds.js
    domain/boundary_guides.js
    domain/cell_crop.js
    presentation/debug_render.js
    hanzi_segmentation.js

  06_单格分层插件/
    index.js
    domain/cell_layers.js
    presentation/cell_layer_exporter.js

  07_评分插件/
    index.js
    application/cell_scoring_service.js
    application/page_scoring_service.js
    application/ocr_diagnostics_service.js
    domain/cell_feature_extraction.js
    domain/blank_detection.js
    domain/template_scoring.js
    domain/rule_scoring.js
    domain/page_scoring.js
    presentation/page_result_view.js
    presentation/chinese_scoring_view.js
    adapters/page_annotation.js
    adapters/cell_step_outputs.js

  08_OCR识别插件/
    index.js
    paddle_ocr_single_chars.py

  utils/
    artifact_policy.js
    grid_spec.js
    stage_image_contract.js
```

## 阶段保留与合并策略

| 阶段 | 处理建议 | 必要性 | 说明 |
|---|---|---:|---|
| `04` | 保留主阶段，合并 `04_1/04_2/04_3` 为内部模块 | 高 | `04` 仍有人工复核价值，但不需要 3 个对外子插件 |
| `05` | 保留主阶段，`05_0~05_4` 作为内部模块 | 高 | `05` 是算法核心阶段，不能压扁 |
| `06` | 保留主阶段，合并 `06_1~06_5` | 很高 | 先修依赖边界，再收敛导出步骤 |
| `07` | 保留主阶段，`07_1~07_5` 内聚到服务层 | 高 | 步骤名保留用于调试，但不必继续作为独立插件壳 |
| `08` | 保持独立 | 很高 | OCR 是外部 Python 运行时边界，需要单独维护 |

## 详细迁移清单

### 阶段 A：先修依赖边界

这是第一优先级，必须先做。

1. 新增共享模块 [utils/cell_image_analysis.js](/home/lc/luckee_dao/baby/coze/插件/utils/cell_image_analysis.js)
2. 把 `extractCellLayers` 与相关图像分层逻辑从 [07_评分插件/domain/cell_feature_extraction.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/domain/cell_feature_extraction.js) 拆出
3. 更新 [06_单格背景文字提取插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/index.js) 的引用
4. 让 `07` 通过 `shared/utils` 复用分层逻辑，而不是继续承载上游阶段的实现

必要性说明：

- 解决当前最明显的反向耦合
- 后续合并 `06_1~06_5` 才有合理边界

### 阶段 B：收敛 `04`

1. 保留 [04_方格数量计算标注插件/index.js](/home/lc/luckee_dao/baby/coze/插件/04_方格数量计算标注插件/index.js) 作为入口
2. 把 [04_1方格数量估计插件/index.js](/home/lc/luckee_dao/baby/coze/插件/04_1方格数量估计插件/index.js) 收进 `domain/grid_count.js`
3. 把 [04_2方格数量标注插件/index.js](/home/lc/luckee_dao/baby/coze/插件/04_2方格数量标注插件/index.js) 收进 `presentation/grid_count_annotation.js`
4. `04_3_单格切分输入` 改为 `04` 主阶段内部的 carry-forward 产物，不再保留独立插件概念

必要性说明：

- `04` 当前主要是展示与传递阶段
- 独立维护 `04_1/04_2` 的收益较低

### 阶段 C：收敛 `06`

1. 保留 [06_单格背景文字提取插件/index.js](/home/lc/luckee_dao/baby/coze/插件/06_单格背景文字提取插件/index.js) 作为主入口
2. 先把 `06_1~06_5` 的重复写盘逻辑收敛为一个 `cell_layer_exporter`
3. exporter 一次性输出：
   - `original`
   - `foregroundMask`
   - `cleanedForegroundMask`
   - `textOnly`
   - `backgroundOnly`
4. 目录层面仍保留这 5 类产物名，便于兼容旧报告
5. 最后再删除“每一层一个薄插件”的模式

必要性说明：

- 当前 5 个插件几乎不承载算法，仅负责写盘
- 减少样板代码和调用链长度

### 阶段 D：收敛 `07`

1. 保留 [07_评分插件/index.js](/home/lc/luckee_dao/baby/coze/插件/07_评分插件/index.js) 作为主入口
2. 保留 [07_0单格评分插件/index.js](/home/lc/luckee_dao/baby/coze/插件/07_0单格评分插件/index.js) 仅作为兼容入口
3. 保留 [07_0页面评分汇总插件/index.js](/home/lc/luckee_dao/baby/coze/插件/07_0页面评分汇总插件/index.js) 仅作为兼容入口
4. 将 `07_1~07_5` 下沉为 `cell_scoring_service` 内部步骤
5. 继续保留 `07_1~07_5` 的步骤 JSON 输出名，避免破坏已有报告和测试

必要性说明：

- 当前这些插件本质上是 domain/service 的包装壳
- 更适合保留“步骤产物名”，而不是“独立插件身份”

### 阶段 E：整理 `05`

1. 保留 [05_切分插件/index.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/index.js)
2. 保留 [05_切分插件/hanzi_segmentation.js](/home/lc/luckee_dao/baby/coze/插件/05_切分插件/hanzi_segmentation.js) 作为核心算法实现
3. 把 `05_1/05_2/05_3/05_4` 逐步迁入 `application/domain/presentation`
4. `05_0方格边界规范化` 作为共享算法模块保留，但不再强调它是单独插件

必要性说明：

- `05` 内部算法复杂度高，拆分仍有价值
- 但更适合模块化，而不是插件平铺

### 阶段 F：产物策略统一

新增 [utils/artifact_policy.js](/home/lc/luckee_dao/baby/coze/插件/utils/artifact_policy.js)，统一控制：

- 生产模式最小产物
- 调试模式完整产物
- 测试模式完整步骤 JSON

建议至少支持：

- `artifactLevel=minimal`
- `artifactLevel=standard`
- `artifactLevel=debug`

必要性说明：

- 现在很多目录只是为了排查问题
- 调试需求不应绑死在生产默认输出里
- 现已在 `05/06/07` 落地第一轮统一策略，并补了对应回归约束

## 兼容策略

重构过程中必须保留一段兼容期。

### 兼容规则

- 旧入口文件先保留 wrapper
- 旧步骤目录名先不变
- 旧步骤 JSON 文件名先不变
- `pipeline_result.json` 的关键字段先不改名

### 建议做法

1. 先改内部实现与 import 方向
2. 再改目录与文件归属
3. 最后再移除旧 wrapper

## 建议执行顺序

1. 修复 `06 -> 07` 反向依赖
2. 合并 `06_1~06_5`
3. 合并 `04_1~04_3`
4. 收敛 `07_1~07_5`
5. 收敛 `05` 的目录结构
6. 引入统一 `artifactLevel`
7. 最后清理旧 wrapper

## 验收标准

### 结构验收

- `06` 不再依赖 `07`
- `04/06/07` 的薄包装插件数量明显下降
- 对外阶段入口控制在少量稳定文件内

### 兼容验收

- 现有真实流水线可继续运行
- 现有测试脚本路径不因重构立即失效
- 报告中 `04/05/06/07` 的步骤名仍可识别

### 维护验收

- 新增一个步骤时，不再需要复制多个“写文件壳”
- 维护者能快速区分：
  - 主阶段入口
  - 内部算法模块
  - 调试/展示产物模块

## 暂不处理

本轮重构先不处理以下问题：

- `00~03` 阶段更大范围的目录重命名
- OCR 模型或 Paddle 运行时替换
- 评分算法本身的指标升级
- `test/out` 历史产物格式批量迁移

## 结论

这次重构最核心的不是“删步骤”，而是：

- 保留阶段
- 合并薄壳
- 修正依赖方向
- 把调试产物从业务入口里抽象出来

如果按本路线执行，最终对外阶段仍然清晰，但内部维护成本会明显下降。
