const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function parseJsonFromMixedStdout(stdoutText) {
  const text = String(stdoutText || '').trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const lines = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        return JSON.parse(lines[index]);
      } catch (lineError) {
        continue;
      }
    }
    throw error;
  }
}

function buildRecognizedMatrix(results, rows, cols) {
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(null));
  for (const item of results || []) {
    if (!Number.isInteger(item?.row) || !Number.isInteger(item?.col)) {
      continue;
    }
    if (!matrix[item.row] || item.col < 0 || item.col >= matrix[item.row].length) {
      continue;
    }
    matrix[item.row][item.col] = item.recognized_char || null;
  }
  return matrix;
}

function resolvePythonPath(options = {}) {
  return (
    options.pythonPath ||
    process.env.PADDLE_OCR_PYTHON ||
    '/home/lc/miniconda3/envs/paddleocr/bin/python'
  );
}

function resolveScriptPath(options = {}) {
  return options.scriptPath || path.join(__dirname, 'paddle_ocr_single_chars.py');
}

function resolvePreprocessConfig(options = {}) {
  const preprocess = options.preprocess || {};
  return {
    enabled: preprocess.enabled !== false,
    target_size: Number.isInteger(preprocess.targetSize) ? preprocess.targetSize : 96,
    crop_to_content: preprocess.cropToContent !== false,
    binarize: preprocess.binarize !== false,
    try_original: preprocess.tryOriginal !== false,
    try_otsu: preprocess.tryOtsu !== false
  };
}

function resolveRecognitionConfig(options = {}) {
  const recognition = options.recognition || {};
  return {
    single_char_mode: recognition.singleCharMode !== false,
    prefer_rec_only: recognition.preferRecOnly !== false,
    reject_non_cjk_ascii: recognition.rejectNonCjkAscii !== false
  };
}

class PaddleOcrPlugin {
  constructor() {
    this.name = '08_OCR识别';
    this.version = '1.0.0';
  }

  async execute(params) {
    const {
      cells = [],
      gridRows,
      gridCols,
      outputDir = null,
      options = {}
    } = params || {};

    if (!Array.isArray(cells)) {
      throw new Error('cells 参数必须是数组');
    }
    if (!Number.isInteger(gridRows) || !Number.isInteger(gridCols)) {
      throw new Error('gridRows 和 gridCols 参数是必需的');
    }

    const pythonPath = resolvePythonPath(options);
    const scriptPath = resolveScriptPath(options);
    const preprocessConfig = resolvePreprocessConfig(options);
    const recognitionConfig = resolveRecognitionConfig(options);
    const pythonLibDir = path.join(path.dirname(path.dirname(pythonPath)), 'lib');
    const manifest = {
      config: {
        lang: options.lang || 'ch',
        use_angle_cls: options.useAngleCls !== false,
        show_log: Boolean(options.showLog),
        confidence_threshold: Number.isFinite(options.confidenceThreshold)
          ? Number(options.confidenceThreshold)
          : 0.5,
        preprocess: preprocessConfig,
        recognition: recognitionConfig
      },
      cells: cells.map((item) => ({
        cell_id: item.cell_id,
        row: item.row,
        col: item.col,
        target_char: item.target_char || null,
        image_path: item.image_path || null
      }))
    };

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paddle-ocr-cells-'));
    const manifestPath = path.join(tmpDir, 'manifest.json');
    await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    try {
      const childEnv = {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
        CUDA_VISIBLE_DEVICES: '',
        FLAGS_use_cuda: '0',
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
          ? `${pythonLibDir}:${process.env.LD_LIBRARY_PATH}`
          : pythonLibDir
      };
      const { stdout, stderr } = await execFileAsync(pythonPath, [scriptPath, manifestPath], {
        env: childEnv,
        maxBuffer: 1024 * 1024 * 16
      });
      const payload = parseJsonFromMixedStdout(stdout);
      const results = Array.isArray(payload.results) ? payload.results : [];
      const recognizedChars = buildRecognizedMatrix(results, gridRows, gridCols);
      const meta = {
        supported: Boolean(payload.supported),
        engine: payload.engine || 'PaddleOCR',
        pythonPath,
        scriptPath,
        isolatedUserSite: true,
        stderr: stderr ? String(stderr).trim() : '',
        config: payload.config || manifest.config,
        runtime: payload.runtime || null,
        results,
        recognized_chars: recognizedChars
      };

      if (outputDir) {
        await fs.promises.mkdir(outputDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(outputDir, '08_OCR识别结果.json'),
          `${JSON.stringify(meta, null, 2)}\n`,
          'utf8'
        );
      }

      return meta;
    } catch (error) {
      let parsedStdout = null;
      try {
        parsedStdout = parseJsonFromMixedStdout(error.stdout);
      } catch (parseError) {
        parsedStdout = null;
      }
      const signal = error.signal || null;
      const stderrText = error.stderr ? String(error.stderr).trim() : '';
      const baseError = parsedStdout?.error || error.message;
      const signalHint = signal === 'SIGILL' || /Illegal instruction/i.test(stderrText) || /Illegal instruction/i.test(baseError)
        ? '当前 PaddlePaddle 轮子可能与机器 CPU 指令集不兼容，请更换兼容版本或在支持 AVX 的环境运行'
        : '请确认 PADDLE_OCR_PYTHON 指向安装了 paddleocr/paddle/cv2 的 Python 3.8~3.10 环境';
      const diagnostic = {
        supported: Boolean(parsedStdout?.supported),
        engine: parsedStdout?.engine || 'PaddleOCR',
        pythonPath,
        scriptPath,
        isolatedUserSite: true,
        error: baseError,
        signal,
        traceback: parsedStdout?.traceback || null,
        stderr: stderrText,
        runtime: parsedStdout?.runtime || null,
        hint: signalHint,
        recognized_chars: null,
        results: []
      };
      if (outputDir) {
        await fs.promises.mkdir(outputDir, { recursive: true });
        await fs.promises.writeFile(
          path.join(outputDir, '08_OCR识别结果.json'),
          `${JSON.stringify(diagnostic, null, 2)}\n`,
          'utf8'
        );
      }
      return diagnostic;
    } finally {
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = new PaddleOcrPlugin();
