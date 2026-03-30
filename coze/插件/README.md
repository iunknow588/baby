# 调用说明

本目录当前有 3 个入口脚本：

- 总路由脚本：[`run_pipeline.sh`](/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh)
- 默认真实流水线脚本：[`run_pipeline_real.sh`](/home/lc/luckee_dao/baby/coze/插件/run_pipeline_real.sh)
- 验证/测试脚本：[`run_pipeline_verify.sh`](/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh)

## 推荐用法

最常用的方式仍然是：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh
```

## 重构路线

`04~08` 阶段的结构整理与重构路线已统一收口到 `works-docs/baby` 文档目录：

- [09-Coze插件04-08阶段重构路线图.md](/home/lc/luckee_dao/works-docs/baby/汉字评分系统/09-Coze插件04-08阶段重构路线图.md)
- [汉字评分系统设计文档 README](/home/lc/luckee_dao/works-docs/baby/汉字评分系统/README.md)

建议后续重构按该文档的执行顺序推进，先修依赖边界，再收敛薄包装步骤。

路由规则如下：

- 不带参数：自动执行默认真实流水线脚本，只跑真实图片流水线
- 带参数：自动转到验证/测试脚本，由显式参数决定执行哪些测试或高级流水线选项

## 默认模式

默认模式是最简、最常用模式：

- 不执行回归测试
- 不执行单元测试
- 只执行 `07_评分插件` 真实图片流水线

直接执行：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh
```

或：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_real.sh
```

## 验证/测试模式

如果需要：

- 预处理回归测试
- 切分单元测试
- 评分单元测试
- 显式指定真实流水线
- 指定样本
- 指定最大阶段

请使用验证/测试脚本：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --help
```

或通过总路由脚本带参数调用：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --help
```

## 验证脚本参数

### 显式任务参数

执行真实流水线：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --with-real-pipeline
```

执行预处理回归：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --with-preprocess-test
```

执行切分单测：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --with-segment-test
```

执行评分单测：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --with-score-test
```

全部执行：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --all
```

### 兼容任务参数

只执行真实流水线：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --real-only
```

只执行预处理回归：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --preprocess-only
```

只执行切分单测：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --segment-only
```

只执行评分单测：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --score-only
```

### 高级流水线参数

指定样本：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --cases 1,4
```

指定最大阶段：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --max-step 3
```

指定样本并限制阶段：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline_verify.sh --cases 1,4 --max-step 3
```

阶段编号如下：

- `1` = `01_稿纸提取`
- `2` = `02_A4纸张矫正`
- `3` = `03_字帖外框与内框定位裁剪`
- `4` = `04_方格数量计算标注`
- `5` = `05_单格切分`
- `6` = `06_单格背景与文字提取`
- `7` = `07_单格评分`

其中 `01/02` 的职责已经拆分为：

- `01_稿纸提取`：只处理稿纸白色连通区域检测与裁切
- `02_A4纸张矫正`：只处理 A4 比例约束、旋转/透视矫正、去底纹预处理

`01/02/03` 现在统一采用“单图阶段合同”：

- 每个阶段入口只接受一张 `stageInputPath`
- 阶段结果显式产出一张 `stageOutputImagePath`
- 下一阶段只允许消费 `nextStageInputPath`
- 阶段内部子步骤如果收到多张不一致图片参数，会直接报错，避免阶段之间相互耦合

## 03 阶段外框语义

`03_字帖外框与内框定位裁剪` 的外框语义分为 4 类：

- `real`：真实外框（直接检测到）
- `inferred`：推断外框（未直接检测到真实外框，但有可靠推断证据）
- `virtual`：虚外框（真实与推断都不可用时，回退到图像边缘轻微内缩矩形）
- `none`：未检测到外框（理论保留态，正常流程会尽量避免）

真实流水线的 `07_REPORT.md` 已同步输出以下字段，便于定位：

- `外框模式` / `外框模式编码`（无外框、标准外框、非标准外框）
- `外框类型`
- `外框来源`（原始 reason/source）
- `外框来源说明`（中文解释）
- `处理策略`（当前模式下的推荐裁剪与矫正策略）
- `模式路由` / `切分策略提示` / `旋转策略提示` / `外框矫正策略提示`

`03_字帖外框与内框定位裁剪结果.json` 中也新增了结构化字段，供后续插件直接分支：

- `modeRouting`（模式路由总览）
- `downstreamModeHints`（切分/旋转/外框矫正策略提示）
- `modeFallbackInfo`（是否触发虚外框回退）

`00_流水线插件` 在进入 `05_单格切分` 前，固定按内框阶段信息选择边界引导优先级与 `forceUniformGrid`，并把最终决策写入 `pipeline_result.json` 的 `segmentationModePolicy`。该策略与外框模式解耦。

默认会启用一次“次优先级切分探测”并按质量分自动择优，报告中可查看：

- `切分探测开关`
- `切分探测已比对`
- `切分探测已切换`

## 当前固定目录

脚本当前使用固定输入输出目录，不支持通过参数修改：

- 输入目录：[`test/obj`](/home/lc/luckee_dao/baby/coze/插件/test/obj)
- 输出目录：[`test/out`](/home/lc/luckee_dao/baby/coze/插件/test/out)

真实流水线运行完成后，最新结果目录会记录到：

- [`test/out/LATEST`](/home/lc/luckee_dao/baby/coze/插件/test/out/LATEST)

## 常见执行方式

默认真实流水线：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh
```

显式跑预处理回归：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --with-preprocess-test
```

显式跑切分单测：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --with-segment-test
```

只跑真实流水线，到字帖内框裁剪与矫正为止：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --cases 1,4 --max-step 3
```

执行全部验证与真实流水线：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --all
```

## 环境要求

执行脚本前需要系统可用：

- `npm`
- `node`
- `python3`

如果缺少其中任一命令，脚本会直接退出并提示错误。

## 说明

当前脚本仍不支持以下参数：

- `--image-dir`
- `--out-dir`
- `--case`

如果后续需要按单个图片或自定义目录执行，需要继续扩展验证脚本。
