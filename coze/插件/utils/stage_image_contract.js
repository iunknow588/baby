const path = require('path');

function normalizePaths(paths = []) {
  return [...new Set(
    (Array.isArray(paths) ? paths : [paths])
      .filter(Boolean)
      .map((inputPath) => path.resolve(inputPath))
  )];
}

function resolveSingleImageInput({
  stageName = '当前阶段',
  primaryInputPath = null,
  imagePath = null,
  legacyInputPaths = []
} = {}) {
  const uniquePaths = normalizePaths([
    primaryInputPath,
    imagePath,
    ...legacyInputPaths
  ]);

  if (!uniquePaths.length) {
    throw new Error(`${stageName}缺少唯一输入图`);
  }
  if (uniquePaths.length > 1) {
    throw new Error(`${stageName}只允许传递一张输入图，检测到多个不一致的图片参数`);
  }
  return uniquePaths[0];
}

function pickSingleNormalizedPath(inputPath = null) {
  const normalized = normalizePaths(inputPath ? [inputPath] : []);
  return normalized[0] || null;
}

function buildStageImageHandoffContract({
  stageName = '当前阶段',
  stageInputPath = null,
  stageOutputImagePath = null,
  nextStageInputPath = null
} = {}) {
  const resolvedStageInputPath = pickSingleNormalizedPath(stageInputPath);
  const resolvedStageOutputImagePath = pickSingleNormalizedPath(stageOutputImagePath);
  const resolvedNextStageInputPath = pickSingleNormalizedPath(
    nextStageInputPath || stageOutputImagePath || null
  );

  return {
    rule: `${stageName}内部与跨阶段交接都只允许传递一张图片`,
    stageInputPath: resolvedStageInputPath,
    stageOutputImagePath: resolvedStageOutputImagePath,
    nextStageInputPath: resolvedNextStageInputPath,
    allowedStageInputs: resolvedStageInputPath ? [resolvedStageInputPath] : [],
    allowedStageOutputs: resolvedStageOutputImagePath ? [resolvedStageOutputImagePath] : [],
    allowedNextStageInputs: resolvedNextStageInputPath ? [resolvedNextStageInputPath] : []
  };
}

module.exports = {
  resolveSingleImageInput,
  buildStageImageHandoffContract
};
