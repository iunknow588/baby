const fs = require('fs');
const path = require('path');
const { requireSharp } = require('../utils/require_sharp');
const { estimateGridCount } = require('./domain/grid_count');
const { renderGridCountAnnotation } = require('./presentation/grid_count_annotation');
const {
  GRID_COUNT_STAGE_DEFINITION,
  GRID_COUNT_STEP_DEFINITIONS,
  GRID_COUNT_SOURCE_STEPS
} = require('./step_definitions');

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
      processNo = GRID_COUNT_STAGE_DEFINITION.processNo
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
    const step04_1Definition = GRID_COUNT_STEP_DEFINITIONS.step04_1;
    const step04_2Definition = GRID_COUNT_STEP_DEFINITIONS.step04_2;
    const step04_3Definition = GRID_COUNT_STEP_DEFINITIONS.step04_3;
    const step04_1Dir = path.join(outputDir, step04_1Definition.dirName);
    const step04_2Dir = path.join(outputDir, step04_2Definition.dirName);
    const step04_3Dir = path.join(outputDir, step04_3Definition.dirName);
    await fs.promises.mkdir(step04_1Dir, { recursive: true });
    await fs.promises.mkdir(step04_2Dir, { recursive: true });
    await fs.promises.mkdir(step04_3Dir, { recursive: true });
    const step04_1MetaPath = path.join(step04_1Dir, step04_1Definition.metaFileName);
    const step04_2MetaPath = path.join(step04_2Dir, step04_2Definition.metaFileName);
    const step04_3MetaPath = path.join(step04_3Dir, step04_3Definition.metaFileName);
    const step04_1ImagePath = path.join(step04_1Dir, step04_1Definition.imageFileName);
    const step04_3ImagePath = outputCarryForwardPath || path.join(step04_3Dir, step04_3Definition.imageFileName);

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
      processNo: step04_3Definition.processNo,
      processName: step04_3Definition.processName,
      sourceStep: GRID_COUNT_SOURCE_STEPS.step04_3,
      inputPath: step04_2.outputAnnotatedPath,
      stageInputPath: imagePath,
      carryForwardImagePath: step04_3ImagePath,
      note: '输出无标注单格切分输入图，供05阶段作为唯一上游输入'
    };
    await fs.promises.writeFile(step04_3MetaPath, `${JSON.stringify(step04_3, null, 2)}\n`, 'utf8');

    const payload = {
      processNo,
      processName: GRID_COUNT_STAGE_DEFINITION.processName,
      sourceStep: GRID_COUNT_SOURCE_STEPS.stageInput,
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
        阶段名称: GRID_COUNT_STAGE_DEFINITION.processName,
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
