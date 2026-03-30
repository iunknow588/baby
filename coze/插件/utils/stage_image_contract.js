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

function resolveSingleMetaInput({
  stageName = '当前阶段',
  primaryMetaPath = null,
  metaPath = null,
  legacyMetaPaths = []
} = {}) {
  const uniquePaths = normalizePaths([
    primaryMetaPath,
    metaPath,
    ...legacyMetaPaths
  ]);

  if (!uniquePaths.length) {
    return null;
  }
  if (uniquePaths.length > 1) {
    throw new Error(`${stageName}只允许传递一个配套JSON，检测到多个不一致的JSON参数`);
  }
  return uniquePaths[0];
}

function pickSingleNormalizedPath(inputPath = null) {
  const normalized = normalizePaths(inputPath ? [inputPath] : []);
  return normalized[0] || null;
}

function pickStageBundleImagePath(stageBundle = null) {
  if (!stageBundle || typeof stageBundle !== 'object' || Array.isArray(stageBundle)) {
    return null;
  }
  return (
    stageBundle.imagePath ||
    stageBundle.stageOutputImagePath ||
    stageBundle.nextStageInputPath ||
    null
  );
}

function pickStageBundleMetaPath(stageBundle = null) {
  if (!stageBundle || typeof stageBundle !== 'object' || Array.isArray(stageBundle)) {
    return null;
  }
  return (
    stageBundle.metaPath ||
    stageBundle.jsonPath ||
    stageBundle.stageOutputMetaPath ||
    stageBundle.nextStageInputMetaPath ||
    null
  );
}

function resolveStageImageJsonInput({
  stageName = '当前阶段',
  stageInput = null,
  primaryInputPath = null,
  primaryMetaPath = null,
  imagePath = null,
  metaPath = null,
  legacyInputPaths = [],
  legacyMetaPaths = []
} = {}) {
  const resolvedImagePath = resolveSingleImageInput({
    stageName,
    primaryInputPath: pickStageBundleImagePath(stageInput) || primaryInputPath,
    imagePath,
    legacyInputPaths
  });
  const resolvedMetaPath = resolveSingleMetaInput({
    stageName,
    primaryMetaPath: pickStageBundleMetaPath(stageInput) || primaryMetaPath,
    metaPath,
    legacyMetaPaths
  });

  return {
    imagePath: resolvedImagePath,
    metaPath: resolvedMetaPath,
    jsonPath: resolvedMetaPath,
    stageInput: stageInput && typeof stageInput === 'object' && !Array.isArray(stageInput)
      ? stageInput
      : null
  };
}

function buildStageImageJsonPayload({
  role = 'stageOutput',
  stageName = '当前阶段',
  processNo = null,
  processName = null,
  imagePath = null,
  metaPath = null
} = {}) {
  const resolvedImagePath = pickSingleNormalizedPath(imagePath);
  const resolvedMetaPath = pickSingleNormalizedPath(metaPath);
  return {
    bundleType: 'stage-image+json',
    role,
    stageName,
    processNo,
    processName,
    imagePath: resolvedImagePath,
    metaPath: resolvedMetaPath,
    jsonPath: resolvedMetaPath
  };
}

function buildStageImageHandoffContract({
  stageName = '当前阶段',
  stageInputPath = null,
  stageInputMetaPath = null,
  stageOutputImagePath = null,
  stageOutputMetaPath = null,
  nextStageInputPath = null,
  nextStageInputMetaPath = null,
  processNo = null,
  processName = null
} = {}) {
  const resolvedStageInputPath = pickSingleNormalizedPath(stageInputPath);
  const resolvedStageInputMetaPath = pickSingleNormalizedPath(stageInputMetaPath);
  const resolvedStageOutputImagePath = pickSingleNormalizedPath(stageOutputImagePath);
  const resolvedStageOutputMetaPath = pickSingleNormalizedPath(stageOutputMetaPath);
  const resolvedNextStageInputPath = pickSingleNormalizedPath(
    nextStageInputPath || stageOutputImagePath || null
  );
  const resolvedNextStageInputMetaPath = pickSingleNormalizedPath(
    nextStageInputMetaPath || stageOutputMetaPath || null
  );

  return {
    rule: `${stageName}内部与跨阶段交接都只允许传递一张图片，并配套一个JSON描述该图片信息`,
    stageInputPath: resolvedStageInputPath,
    stageInputMetaPath: resolvedStageInputMetaPath,
    stageOutputImagePath: resolvedStageOutputImagePath,
    stageOutputMetaPath: resolvedStageOutputMetaPath,
    nextStageInputPath: resolvedNextStageInputPath,
    nextStageInputMetaPath: resolvedNextStageInputMetaPath,
    stageInput: buildStageImageJsonPayload({
      role: 'stageInput',
      stageName,
      processNo,
      processName,
      imagePath: resolvedStageInputPath,
      metaPath: resolvedStageInputMetaPath
    }),
    stageOutput: buildStageImageJsonPayload({
      role: 'stageOutput',
      stageName,
      processNo,
      processName,
      imagePath: resolvedStageOutputImagePath,
      metaPath: resolvedStageOutputMetaPath
    }),
    nextStageInput: buildStageImageJsonPayload({
      role: 'nextStageInput',
      stageName,
      processNo,
      processName,
      imagePath: resolvedNextStageInputPath,
      metaPath: resolvedNextStageInputMetaPath
    }),
    allowedStageInputs: resolvedStageInputPath ? [resolvedStageInputPath] : [],
    allowedStageInputMetaPaths: resolvedStageInputMetaPath ? [resolvedStageInputMetaPath] : [],
    allowedStageOutputs: resolvedStageOutputImagePath ? [resolvedStageOutputImagePath] : [],
    allowedStageOutputMetaPaths: resolvedStageOutputMetaPath ? [resolvedStageOutputMetaPath] : [],
    allowedNextStageInputs: resolvedNextStageInputPath ? [resolvedNextStageInputPath] : [],
    allowedNextStageInputMetaPaths: resolvedNextStageInputMetaPath ? [resolvedNextStageInputMetaPath] : []
  };
}

module.exports = {
  resolveSingleImageInput,
  resolveSingleMetaInput,
  resolveStageImageJsonInput,
  buildStageImageJsonPayload,
  buildStageImageHandoffContract
};
