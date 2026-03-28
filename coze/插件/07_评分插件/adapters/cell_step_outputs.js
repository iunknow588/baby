const fs = require('fs');
const path = require('path');

const CELL_STEP_DIR_NAMES = {
  step07_1: '07_1_单格特征提取',
  step07_2: '07_2_空白格判定',
  step07_3: '07_3_单格结构评分',
  step07_4: '07_4_单格相似度评分',
  step07_5: '07_5_单格总评分'
};

function createEmptyStepMetaPaths() {
  return {
    step07_1: null,
    step07_2: null,
    step07_3: null,
    step07_4: null,
    step07_5: null
  };
}

function buildCellStepDirs(outputDir) {
  if (!outputDir) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(CELL_STEP_DIR_NAMES).map(([stepKey, dirName]) => [stepKey, path.join(outputDir, dirName)])
  );
}

async function prepareCellStepArtifacts(outputDir) {
  const stepDirs = buildCellStepDirs(outputDir);
  const stepMetaPaths = createEmptyStepMetaPaths();

  if (outputDir) {
    await Promise.all(Object.values(stepDirs).map((dirPath) => fs.promises.mkdir(dirPath, { recursive: true })));
  }

  const writeStepMeta = async (stepKey, payload) => {
    if (!outputDir) {
      return null;
    }

    const dirPath = stepDirs[stepKey];
    const fileBaseName = CELL_STEP_DIR_NAMES[stepKey];
    if (!dirPath || !fileBaseName) {
      throw new Error(`未知的单格步骤键: ${stepKey}`);
    }

    const metaPath = path.join(dirPath, `${fileBaseName}.json`);
    await fs.promises.writeFile(metaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    stepMetaPaths[stepKey] = metaPath;
    return metaPath;
  };

  return {
    stepDirs,
    stepMetaPaths,
    writeStepMeta
  };
}

module.exports = {
  CELL_STEP_DIR_NAMES,
  prepareCellStepArtifacts
};
