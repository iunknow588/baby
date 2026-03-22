# 调用说明

本目录的统一入口脚本是：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh
```

## 基本用法

默认执行两部分：

1. `05_切分插件` 单元测试
2. `07_评分插件` 真实图片流水线测试

直接执行：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh
```

## 参数说明

### `--real-only`

只执行真实图片流水线，不执行切分单元测试：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --real-only
```

### `--segment-only`

只执行切分插件单元测试，不执行真实图片流水线：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --segment-only
```

### `--max-step N`

只执行到第 `N` 个阶段，`N` 必须是 `1-7`：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --max-step 3
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --real-only --max-step 5
```

阶段编号如下：

- `1` = `01_稿纸提取`
- `2` = `02_A4纸张矫正`
- `3` = `03_总方格大矩形提取`
- `4` = `04_方格数量计算标注`
- `5` = `05_单格切分`
- `6` = `06_单格背景与文字提取`
- `7` = `07_单格评分`

其中 `01/02` 的职责已经拆分为：

- `01_稿纸提取`：只处理稿纸白色连通区域检测与裁切
- `02_A4纸张矫正`：只处理 A4 比例约束、旋转/透视矫正、去底纹预处理

### `-h` / `--help`

显示帮助：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --help
```

## 当前固定目录

脚本当前使用固定输入输出目录，不支持通过参数修改：

- 输入目录：[`test/obj`](/home/lc/luckee_dao/baby/coze/插件/test/obj)
- 输出目录：[`test/out`](/home/lc/luckee_dao/baby/coze/插件/test/out)

真实流水线运行完成后，最新结果目录会记录到：

- [`test/out/LATEST`](/home/lc/luckee_dao/baby/coze/插件/test/out/LATEST)

## 常见执行方式

完整执行：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh
```

只跑真实流水线，到总方格提取为止：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --real-only --max-step 3
```

只跑切分单元测试：

```bash
/home/lc/luckee_dao/baby/coze/插件/run_pipeline.sh --segment-only
```

## 环境要求

执行脚本前需要系统可用：

- `npm`
- `node`
- `python3`

如果缺少其中任一命令，脚本会直接退出并提示错误。

## 说明

当前脚本不支持以下参数：

- `--image-dir`
- `--out-dir`
- `--case`

如果后续需要按单个图片或自定义目录执行，需要继续扩展 `run_pipeline.sh`。
