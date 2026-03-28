const OUTER_FRAME_MODES = Object.freeze({
  NO_OUTER_FRAME: 'no_outer_frame',
  STANDARD_OUTER_FRAME: 'standard_outer_frame',
  NON_STANDARD_OUTER_FRAME: 'non_standard_outer_frame'
});

const OUTER_FRAME_MODE_PROFILES = Object.freeze({
  [OUTER_FRAME_MODES.NO_OUTER_FRAME]: Object.freeze({
    label: '无外框',
    fallbackReason: 'no-real-or-inferred-outer-frame',
    strategy: 'virtual-border-fallback-for-unified-segmentation',
    annotationSubtitle: '未检测到可用外框，当前为虚外框',
    annotationStyle: Object.freeze({
      stroke: '#7c3aed',
      fill: '#8b5cf6',
      dashed: true
    }),
    downstreamHints: Object.freeze({
      outerRectificationPolicy: 'virtual-border-inset-rectification',
      splitGuidePolicy: 'inner-guides-primary',
      rotationPolicy: 'inner-frame-guided-rotation',
      requiresVirtualFrame: true
    })
  }),
  [OUTER_FRAME_MODES.STANDARD_OUTER_FRAME]: Object.freeze({
    label: '标准外框',
    fallbackReason: 'standard-outer-frame',
    strategy: 'outer-frame-first-then-inner-frame-rectification',
    annotationSubtitle: '标准外框定位，进入常规外框裁剪与矫正',
    annotationStyle: Object.freeze({
      stroke: '#0284c7',
      fill: '#38bdf8',
      dashed: false
    }),
    downstreamHints: Object.freeze({
      outerRectificationPolicy: 'standard-outer-frame-rectification',
      splitGuidePolicy: 'outer-then-inner-guides',
      rotationPolicy: 'outer-frame-priority-rotation',
      requiresVirtualFrame: false
    })
  }),
  [OUTER_FRAME_MODES.NON_STANDARD_OUTER_FRAME]: Object.freeze({
    label: '非标准外框',
    fallbackReason: 'non-standard-outer-frame',
    strategy: 'asymmetric-outer-frame-guarded-rectification',
    annotationSubtitle: '非标准外框定位，按非标准模式进入外框裁剪与矫正',
    annotationStyle: Object.freeze({
      stroke: '#c2410c',
      fill: '#fb923c',
      dashed: false
    }),
    downstreamHints: Object.freeze({
      outerRectificationPolicy: 'asymmetric-guarded-rectification',
      splitGuidePolicy: 'inner-guides-with-asymmetric-guard',
      rotationPolicy: 'inner-frame-priority-rotation',
      requiresVirtualFrame: false
    })
  })
});

const TRUSTED_INFERRED_OUTER_FRAME_REASONS = new Set([
  'pattern-outer-frame-inferred',
  'broad-guide-window-outer-frame',
  'grid-rectification-outer-frame'
]);

const TRUSTED_INFERRED_OUTER_FRAME_METHODS = new Set([
  'pattern-driven-outer-frame-inference',
  'broad-raw-guide-window-outer-frame',
  'grid-rectification-vs-inner-guides'
]);

function isVirtualOuterFrame(frame) {
  if (!frame?.applied) {
    return false;
  }
  return Boolean(
    frame?.diagnostics?.virtualFrame
    || frame?.reason === 'virtual-outer-frame-from-image-border'
    || frame?.diagnostics?.method === 'virtual-outer-frame-from-image-border'
  );
}

function isTrustedInferredOuterFrame(frame, getQuadBounds) {
  if (!frame?.applied || isVirtualOuterFrame(frame)) {
    return false;
  }
  const reason = String(frame?.reason || '');
  const method = String(frame?.diagnostics?.method || '');
  const diagnostics = frame?.diagnostics || {};
  const refinedBounds = frame?.refinedOuterFrame || (typeof getQuadBounds === 'function'
    ? getQuadBounds(frame?.outerQuad || null)
    : null);
  const innerBounds = diagnostics?.innerBounds || null;
  const gaps = diagnostics?.gaps || (
    refinedBounds && innerBounds
      ? {
          top: Math.max(0, Number(innerBounds.top) - Number(refinedBounds.top)),
          bottom: Math.max(0, Number(refinedBounds.bottom) - Number(innerBounds.bottom)),
          left: Math.max(0, Number(innerBounds.left) - Number(refinedBounds.left)),
          right: Math.max(0, Number(refinedBounds.right) - Number(innerBounds.right))
        }
      : null
  );
  const cellWidth = Number(diagnostics?.cellWidth) || 0;
  const cellHeight = Number(diagnostics?.cellHeight) || 0;
  const lateralTinyThreshold = Math.max(6, Math.round(Math.max(0, cellWidth) * 0.045));
  const verticalGapThreshold = Math.max(20, Math.round(Math.max(0, cellHeight) * 0.12));
  const topGap = Number(gaps?.top) || 0;
  const bottomGap = Number(gaps?.bottom) || 0;
  const leftGap = Number(gaps?.left) || 0;
  const rightGap = Number(gaps?.right) || 0;
  const avgVerticalGap = (topGap + bottomGap) / 2;
  const avgLateralGap = (leftGap + rightGap) / 2;
  const headerFooterDominatedGapSignature = (
    reason === 'pattern-outer-frame-inferred'
    && method === 'pattern-driven-outer-frame-inference'
    && String(diagnostics?.outerFramePattern || '') === 'full-margin-outer-frame'
    && !diagnostics?.tightenedByFinalGuides
    && topGap >= verticalGapThreshold
    && bottomGap >= verticalGapThreshold
    && leftGap <= lateralTinyThreshold
    && rightGap <= lateralTinyThreshold
    && avgVerticalGap >= Math.max(24, avgLateralGap * 4)
    && (Number(diagnostics?.gapRatio) || 0) >= 6
  );
  if (headerFooterDominatedGapSignature) {
    return false;
  }
  return Boolean(
    refinedBounds
    && (
      TRUSTED_INFERRED_OUTER_FRAME_REASONS.has(reason)
      || TRUSTED_INFERRED_OUTER_FRAME_METHODS.has(method)
      || diagnostics?.detectedOuterBorder
      || diagnostics?.outerBounds
    )
  );
}

function buildOuterPatternContext(extraction, inferred) {
  const inferredDiagnostics = inferred?.diagnostics || null;
  const extractionPattern = extraction?.component?.separation?.metrics?.outerFramePattern || null;
  const inferredPattern = inferredDiagnostics?.outerFramePattern || null;
  const sourceReason = inferred?.reason || extraction?.reason || null;
  return {
    sourceReason,
    method: inferredDiagnostics?.method || null,
    pattern: extractionPattern || inferredPattern || null,
    gaps: inferredDiagnostics?.gaps || null,
    diagnostics: inferredDiagnostics
  };
}

function isLikelyStandardOuterFramePattern(context) {
  const pattern = String(context?.pattern || '').trim();
  if (pattern && pattern !== 'full-margin-outer-frame') {
    return false;
  }
  const sourceReason = String(context?.sourceReason || '');
  if (sourceReason === 'broad-guide-window-outer-frame') {
    return false;
  }
  const diagnostics = context?.diagnostics || {};
  const refinedBounds = context?.refinedBounds || null;
  const innerBounds = context?.currentInnerBounds || diagnostics?.innerBounds || null;
  const gaps = context?.gaps || (
    refinedBounds && innerBounds
      ? {
          top: Math.max(0, Number(innerBounds.top) - Number(refinedBounds.top)),
          bottom: Math.max(0, Number(refinedBounds.bottom) - Number(innerBounds.bottom)),
          left: Math.max(0, Number(innerBounds.left) - Number(refinedBounds.left)),
          right: Math.max(0, Number(refinedBounds.right) - Number(innerBounds.right))
        }
      : null
  );
  if (!gaps || typeof gaps !== 'object') {
    return true;
  }
  const topGap = Number(gaps.top) || 0;
  const bottomGap = Number(gaps.bottom) || 0;
  const leftGap = Number(gaps.left) || 0;
  const rightGap = Number(gaps.right) || 0;
  const values = ['top', 'bottom', 'left', 'right']
    .map((key) => Number(gaps[key]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 4) {
    return false;
  }
  const patternProfileFamily = String(
    context?.currentPatternProfile?.family
    || diagnostics?.patternProfileFamily
    || ''
  ).trim();
  const patternProfileMode = String(
    context?.currentPatternProfile?.profileMode
    || diagnostics?.patternProfileMode
    || ''
  ).trim();
  if (
    (patternProfileFamily === 'circle-mi-grid' || patternProfileMode.includes('circle-mi-grid'))
    && topGap > 0
    && bottomGap > 0
    && leftGap > 0
    && rightGap > 0
  ) {
    const lateralRatio = Math.max(leftGap, rightGap) / Math.max(1, Math.min(leftGap, rightGap));
    return lateralRatio <= 2.6;
  }
  const maxGap = Math.max(...values);
  const minGap = Math.max(1, Math.min(...values));
  return (maxGap / minGap) <= 3.2;
}

function resolveOuterFrameMode(outerFrameState) {
  if (!outerFrameState.realOuterFrameDetected && !outerFrameState.inferredOuterFrameApplied) {
    const profile = OUTER_FRAME_MODE_PROFILES[OUTER_FRAME_MODES.NO_OUTER_FRAME];
    return {
      mode: OUTER_FRAME_MODES.NO_OUTER_FRAME,
      label: profile.label,
      reason: profile.fallbackReason,
      strategy: profile.strategy,
      pattern: null
    };
  }
  const context = buildOuterPatternContext(outerFrameState.extraction, outerFrameState.inferred);
  context.currentInnerBounds = outerFrameState.currentInnerBounds || null;
  context.currentPatternProfile = outerFrameState.currentPatternProfile || null;
  context.refinedBounds = outerFrameState.extraction?.component?.refinedOuterFrame
    || outerFrameState.inferred?.refinedOuterFrame
    || null;
  const isStandard = isLikelyStandardOuterFramePattern(context);
  if (isStandard) {
    const profile = OUTER_FRAME_MODE_PROFILES[OUTER_FRAME_MODES.STANDARD_OUTER_FRAME];
    return {
      mode: OUTER_FRAME_MODES.STANDARD_OUTER_FRAME,
      label: profile.label,
      reason: context.sourceReason || profile.fallbackReason,
      strategy: profile.strategy,
      pattern: context.pattern || null
    };
  }
  const profile = OUTER_FRAME_MODE_PROFILES[OUTER_FRAME_MODES.NON_STANDARD_OUTER_FRAME];
  return {
    mode: OUTER_FRAME_MODES.NON_STANDARD_OUTER_FRAME,
    label: profile.label,
    reason: context.sourceReason || profile.fallbackReason,
    strategy: profile.strategy,
    pattern: context.pattern || null
  };
}

function resolveModeProfile(mode) {
  return OUTER_FRAME_MODE_PROFILES[mode] || OUTER_FRAME_MODE_PROFILES[OUTER_FRAME_MODES.NO_OUTER_FRAME];
}

function buildOuterCornerAnnotationStyleByMode(mode) {
  const profile = resolveModeProfile(mode);
  return {
    subtitle: profile.annotationSubtitle,
    ...profile.annotationStyle
  };
}

function buildModeRoutingPlan(modeInfo, outerFrameKind = 'none') {
  const profile = resolveModeProfile(modeInfo?.mode);
  return {
    mode: modeInfo?.mode || OUTER_FRAME_MODES.NO_OUTER_FRAME,
    modeLabel: modeInfo?.label || profile.label,
    modeReason: modeInfo?.reason || profile.fallbackReason,
    modePattern: modeInfo?.pattern || null,
    processingStrategy: modeInfo?.strategy || profile.strategy,
    outerFrameKind,
    annotation: {
      subtitle: profile.annotationSubtitle,
      ...profile.annotationStyle
    },
    downstreamHints: {
      ...profile.downstreamHints
    }
  };
}

module.exports = {
  OUTER_FRAME_MODES,
  isVirtualOuterFrame,
  isTrustedInferredOuterFrame,
  resolveOuterFrameMode,
  buildOuterCornerAnnotationStyleByMode,
  buildModeRoutingPlan
};
