const fs = require('fs');
const path = require('path');
const {
  CELL_STEP_DEFINITIONS,
  buildCellStepDirs,
  createEmptyStepMetaPaths
} = require('../step_definitions');

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
    const stepDefinition = CELL_STEP_DEFINITIONS[stepKey];
    if (!dirPath || !stepDefinition) {
      throw new Error(`未知的单格步骤键: ${stepKey}`);
    }

    const metaPath = path.join(dirPath, `${stepDefinition.dirName}.json`);
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
  CELL_STEP_DEFINITIONS,
  prepareCellStepArtifacts
};
