const ARTIFACT_LEVEL_ORDER = Object.freeze({
  minimal: 0,
  standard: 1,
  debug: 2
});

function normalizeArtifactLevel(level, fallback = 'debug') {
  const normalized = String(level || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ARTIFACT_LEVEL_ORDER, normalized)) {
    return normalized;
  }
  return fallback;
}

function isArtifactLevelAtLeast(level, targetLevel) {
  const normalizedLevel = normalizeArtifactLevel(level);
  const normalizedTarget = normalizeArtifactLevel(targetLevel);
  return ARTIFACT_LEVEL_ORDER[normalizedLevel] >= ARTIFACT_LEVEL_ORDER[normalizedTarget];
}

function resolveArtifactLevelInput(params = {}) {
  return (
    params.artifactLevel ??
    params.artifact_level ??
    params.options?.artifactLevel ??
    params.options?.artifact_level ??
    null
  );
}

function resolveSegmentationArtifactPolicy(params = {}) {
  const artifactLevel = normalizeArtifactLevel(
    resolveArtifactLevelInput(params),
    'debug'
  );

  return {
    artifactLevel,
    emitStep05_1: isArtifactLevelAtLeast(artifactLevel, 'standard'),
    emitStep05_2: isArtifactLevelAtLeast(artifactLevel, 'standard'),
    emitStep05_3: isArtifactLevelAtLeast(artifactLevel, 'debug'),
    emitStep05_4: isArtifactLevelAtLeast(artifactLevel, 'standard'),
    emitSummary: true,
    emitCells: true
  };
}

function resolveCellLayerArtifactPolicy(params = {}) {
  const artifactLevel = normalizeArtifactLevel(resolveArtifactLevelInput(params), 'debug');

  return {
    artifactLevel,
    emitStep06_1: isArtifactLevelAtLeast(artifactLevel, 'debug'),
    emitStep06_2: isArtifactLevelAtLeast(artifactLevel, 'debug'),
    emitStep06_3: isArtifactLevelAtLeast(artifactLevel, 'debug'),
    emitStep06_4: true,
    emitStep06_5: isArtifactLevelAtLeast(artifactLevel, 'standard'),
    emitPerCellMeta: isArtifactLevelAtLeast(artifactLevel, 'debug'),
    emitLayerStepMeta: isArtifactLevelAtLeast(artifactLevel, 'debug'),
    emitSummary: true
  };
}

function resolveScoringArtifactPolicy(params = {}) {
  const artifactLevel = normalizeArtifactLevel(resolveArtifactLevelInput(params), 'debug');

  return {
    artifactLevel,
    emitCellStepArtifacts: isArtifactLevelAtLeast(artifactLevel, 'debug'),
    emitOcrDiagnostics: isArtifactLevelAtLeast(artifactLevel, 'standard')
  };
}

module.exports = {
  ARTIFACT_LEVEL_ORDER,
  normalizeArtifactLevel,
  isArtifactLevelAtLeast,
  resolveSegmentationArtifactPolicy,
  resolveCellLayerArtifactPolicy,
  resolveScoringArtifactPolicy
};
