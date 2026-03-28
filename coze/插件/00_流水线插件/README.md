# 00 流水线插件

统一调度以下三段插件：

1. 00 预处理插件
2. 05 切分插件
3. 07 评分插件

适合外部工作流只调用一次接口的场景。

当前已支持将以下评分相关参数透传到 `07` 阶段：

- `target_chars`
- `recognized_chars`
- `scoringOptions.ocr`

其中：

- `target_chars` 用于单格模板结构/相似度评分
- `recognized_chars` 用于页级错字/添字/漏字文本校验
- `scoringOptions.ocr` 可启用 PaddleOCR 自动识别，自动生成 `recognized_chars`
- 若未提供 `target_chars`，自动 OCR 结果仅输出到评分结果中供诊断查看，不参与文本扣分

网格规格策略：

- 默认网格规格为 `7x10`
- 流水线会基于纸张实际检测结果尝试自动修正行列数
- 若显式传入 `gridRows` 或 `gridCols`，对应轴优先采用指定值
- 若未显式传入，则允许使用自动估计结果按轴修正

输出会按阶段落到独立目录：

- `preprocess`
- `segmentation`
- `scoring`
