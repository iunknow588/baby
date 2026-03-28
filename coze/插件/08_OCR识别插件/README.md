# 08 OCR识别插件

基于 PaddleOCR 的逐格识别插件。

用途：

- 输入单格文字图路径列表
- 输出 `recognized_chars` 二维矩阵
- 供 `07_评分插件` 做页级错字/添字/漏字校验
- 默认对单字图执行轻量预处理：内容紧框、居中归一化、Otsu 二值化多候选识别
- 默认启用单字识别模式：优先尝试 `rec-only`，并过滤单字中文场景下明显不合理的拉丁字母误识别

## 运行要求

- 推荐 Python 3.8 ~ 3.10
- 需要安装：
  - `paddleocr`
  - `paddlepaddle`
  - `opencv-python` 或 `opencv-python-headless`
- 插件会强制使用 `PYTHONNOUSERSITE=1` 调用 Python，避免被 `~/.local` 下的用户级包污染
- 插件默认以 CPU-only 方式运行，不启用 GPU
- 插件会优先注入所选 Python 环境自身的 `lib` 目录，避免误用系统旧版 `libstdc++`
- 若初始化阶段出现 `Illegal instruction`，通常是当前 `paddlepaddle` 轮子与机器 CPU 指令集不兼容，需要更换兼容版本

当前机器已验证可运行的 CPU 兼容组合：

- `paddlepaddle==2.6.2`
- `paddleocr==2.10.0`

适用场景：

- 老 CPU 或仅支持 `AVX`、不支持 `AVX2` 的环境

## 配置方式

优先级：

1. `options.pythonPath`
2. 环境变量 `PADDLE_OCR_PYTHON`
3. 默认值 `/home/lc/miniconda3/envs/paddleocr/bin/python`

## 主要参数

```js
{
  cells: [
    {
      cell_id: '0_0',
      row: 0,
      col: 0,
      target_char: '永',
      image_path: '/abs/path/to/cell.png'
    }
  ],
  gridRows: 1,
  gridCols: 1,
  options: {
    pythonPath: '/home/lc/miniconda3/envs/paddleocr/bin/python',
    lang: 'ch',
    useAngleCls: true,
    confidenceThreshold: 0.5,
    preprocess: {
      enabled: true,
      targetSize: 96,
      cropToContent: true,
      binarize: true
    },
    recognition: {
      singleCharMode: true,
      preferRecOnly: true,
      rejectNonCjkAscii: true
    }
  }
}
```

## 输出

- `supported`
- `engine`
- `recognized_chars`
- `results`
- `runtime`
- `config.preprocess`
- `config.recognition`
- `error` / `traceback` / `hint`（失败时）
