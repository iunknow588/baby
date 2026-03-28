const fs = require('fs');
const path = require('path');
const { requireSharp } = require('../utils/require_sharp');
const { estimateGridCount } = require('./domain/grid_count');
const { renderGridCountAnnotation } = require('./presentation/grid_count_annotation');

const sharp = requireSharp();

class GridCountAnnotatePlugin {
  constructor() {
    this.name = '04_方格数量计算标注';
    this.version = '1.0.0';
    this.processNo = '04';
  }

  async execute(params) {
    const {
      imagePath,
      outputAnnotatedPath,
      outputMetaPath,
      outputCarryForwardPath = null,
      gridRows,
      gridCols,
      source = 'provided',
      processNo = '04'
    } = params || {};

    if (!imagePath) {
      throw new Error('imagePath参数是必需的');
    }
    if (!outputAnnotatedPath) {
      throw new Error('outputAnnotatedPath参数是必需的');
    }
    if (!outputMetaPath) {
      throw new Error('outputMetaPath参数是必需的');
    }

    const outputDir = path.dirname(outputMetaPath);
    const step04_1Dir = path.join(outputDir, '04_1_方格数量估计');
    const step04_2Dir = path.join(outputDir, '04_2_方格数量标注');
    const step04_3Dir = path.join(outputDir, '04_3_单格切分输入');
    await fs.promises.mkdir(step04_1Dir, { recursive: true });
    await fs.promises.mkdir(step04_2Dir, { recursive: true });
    await fs.promises.mkdir(step04_3Dir, { recursive: true });
    const step04_1MetaPath = path.join(step04_1Dir, '04_1_方格数量估计.json');
    const step04_2MetaPath = path.join(step04_2Dir, '04_2_方格数量标注.json');
    const step04_3MetaPath = path.join(step04_3Dir, '04_3_单格切分输入.json');
    const step04_1ImagePath = path.join(step04_1Dir, '04_1_方格数量估计图.png');
    const step04_3ImagePath = outputCarryForwardPath || path.join(step04_3Dir, '04_3_单格切分输入图.png');

    const step04_1 = await estimateGridCount({
      imagePath,
      gridRows,
      gridCols,
      source,
      outputMetaPath: step04_1MetaPath,
      outputImagePath: step04_1ImagePath
    });

    const step04_2 = await renderGridCountAnnotation({
      imagePath,
      outputAnnotatedPath: path.join(step04_2Dir, path.basename(outputAnnotatedPath)),
      outputMetaPath: step04_2MetaPath,
      gridRows,
      gridCols,
      totalCells: step04_1.totalCells,
      source
    });

    await sharp(imagePath).png().toFile(step04_3ImagePath);
    const step04_3 = {
      processNo: '04_3',
      processName: '04_3_单格切分输入',
      sourceStep: '04_2_方格数量标注',
      inputPath: step04_2.outputAnnotatedPath,
      stageInputPath: imagePath,
      carryForwardImagePath: step04_3ImagePath,
      note: '输出无标注单格切分输入图，供05阶段作为唯一上游输入'
    };
    await fs.promises.writeFile(step04_3MetaPath, `${JSON.stringify(step04_3, null, 2)}\n`, 'utf8');

    const payload = {
      processNo,
      processName: '04_方格数量计算标注',
      sourceStep: '03_4_字帖内框裁剪与矫正',
      stageInputPath: imagePath,
      gridRows,
      gridCols,
      totalCells: step04_1.totalCells,
      source,
      imageSize: step04_1.imageSize,
      outputAnnotatedPath: step04_2.outputAnnotatedPath,
      carryForwardInputPath: step04_3ImagePath,
      stepSummaries: {
        step04_1: {
          totalCells: step04_1.totalCells,
          imageSize: step04_1.imageSize,
          source: step04_1.source
        },
        step04_2: {
          outputAnnotatedPath: step04_2.outputAnnotatedPath,
          imageSize: step04_2.imageSize
        },
        step04_3: {
          carryForwardImagePath: step04_3ImagePath
        }
      },
      stepDirs: {
        step04_1: step04_1Dir,
        step04_2: step04_2Dir,
        step04_3: step04_3Dir
      },
      stepMetaPaths: {
        step04_1: step04_1MetaPath,
        step04_2: step04_2MetaPath,
        step04_3: step04_3MetaPath
      },
      显示信息: {
        阶段编号: processNo,
        阶段名称: '04_方格数量计算标注',
        阶段输入图: imagePath,
        行数: gridRows,
        列数: gridCols,
        总格数: step04_1.totalCells,
        方格数量来源: source,
        输出文件: {
          方格数量标注图: step04_2.outputAnnotatedPath,
          单格切分输入图: step04_3ImagePath,
          阶段结果JSON: outputMetaPath
        }
      }
    };

    await fs.promises.mkdir(outputDir, { recursive: true });
    await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return payload;
  }
}

module.exports = new GridCountAnnotatePlugin();
