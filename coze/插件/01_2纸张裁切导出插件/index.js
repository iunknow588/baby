const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

const execFileAsync = promisify(execFile);

function normalizePaperCorners(corners) {
  const points = Array.isArray(corners) ? corners : [];
  if (points.length !== 4) {
    return null;
  }
  const normalized = points
    .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : null)
    .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  return normalized.length === 4 ? normalized : null;
}

class PaperCropExportPlugin {
  constructor() {
    this.name = '01_2_纸张裁切导出';
    this.version = '1.0.0';
    this.processNo = '01_2';
  }

  async execute(params) {
    const {
      imagePath,
      preprocessResult,
      paperBounds = null,
      paperCorners = null,
      paperCropOutputPath,
      outputMetaPath
    } = params || {};

    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }

    const effectivePaperBounds = paperBounds || preprocessResult?.paperBounds || null;
    const effectivePaperCorners = paperCorners || preprocessResult?.paperCorners || null;
    if (!paperCropOutputPath) {
      throw new Error('paperCropOutputPath参数是必需的');
    }
    const normalizedPaperCorners = normalizePaperCorners(effectivePaperCorners);

    let rectifyMeta = null;
    if (normalizedPaperCorners) {
      await fs.promises.mkdir(path.dirname(paperCropOutputPath), { recursive: true });
      const rectifyMetaPath = outputMetaPath
        ? outputMetaPath.replace(/\.json$/i, '.rectify.json')
        : null;
      const scriptPath = path.join(__dirname, '../00_预处理插件/paper_quad_rectify.py');
      const args = [
        scriptPath,
        '--image', imagePath,
        '--corners-json', JSON.stringify(normalizedPaperCorners),
        '--output', paperCropOutputPath
      ];
      if (rectifyMetaPath) {
        args.push('--meta-output', rectifyMetaPath);
      }
      const { stdout } = await execFileAsync('python3', args, {
        cwd: path.join(__dirname, '../00_预处理插件'),
        maxBuffer: 10 * 1024 * 1024
      });
      try {
        rectifyMeta = JSON.parse((stdout || '').trim() || '{}');
      } catch (error) {
        rectifyMeta = null;
      }
    } else if (effectivePaperBounds) {
      await fs.promises.mkdir(path.dirname(paperCropOutputPath), { recursive: true });
      const cropBox = {
        left: Math.round(effectivePaperBounds.left || 0),
        top: Math.round(effectivePaperBounds.top || 0),
        width: Math.max(1, Math.round(effectivePaperBounds.width || 0)),
        height: Math.max(1, Math.round(effectivePaperBounds.height || 0))
      };
      await sharp(imagePath)
        .extract(cropBox)
        .png()
        .toFile(paperCropOutputPath);
    }

    const payload = {
      processNo: this.processNo,
      processName: '01_2_纸张裁切导出',
      imagePath,
      paperCropOutputPath,
      paperBounds: effectivePaperBounds,
      paperCorners: normalizedPaperCorners || effectivePaperCorners,
      rectifyMeta,
      sourceMethod: normalizedPaperCorners ? '01_1_纸张范围检测四点透视拉正' : '01_1_纸张范围检测边界矩形回退裁切',
      note: normalizedPaperCorners
        ? '01_2 使用 01_1 输出的稿纸四角点，将倾斜稿纸四边形直接拉正为矩形，不再通过包围框补白裁切。'
        : '01_2 在缺少四角点时，回退为边界矩形裁切。'
    };

    if (outputMetaPath) {
      await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
      await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }

    return payload;
  }
}

module.exports = new PaperCropExportPlugin();
