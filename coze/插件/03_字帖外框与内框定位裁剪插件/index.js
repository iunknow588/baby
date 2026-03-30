const fs = require('fs');
const os = require('os');
const path = require('path');
const gridRectCandidatePlugin = require('../03_1辅助内框候选范围插件/index');
const gridRectAdjustPlugin = require('../03_2辅助内框范围纠偏插件/index');
const gridRectCropAnnotatePlugin = require('../03_3辅助内框裁剪标注插件/index');
const gridBoundaryLocalizePlugin = require('../03_0方格边界局部化插件/index');
const { extractGridArtifactsFromWarpedImages } = require('../00_预处理插件/paper_preprocess');
const { DEFAULT_GRID_ROWS, DEFAULT_GRID_COLS } = require('../utils/grid_spec');
const {
  isVirtualOuterFrame,
  isTrustedInferredOuterFrame,
  resolveOuterFrameMode,
  buildOuterCornerAnnotationStyleByMode,
  buildModeRoutingPlan
} = require('./outer_frame_modes');
const {
  resolveSingleImageInput,
  buildStageImageHandoffContract
} = require('../utils/stage_image_contract');
const { requireSharp } = require('../utils/require_sharp');
const sharp = requireSharp();

function normalizeCornerQuad(corners) {
  const points = (Array.isArray(corners) ? corners : [])
    .map((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : null)
    .filter((point) => point && Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length !== 4) {
    return null;
  }
  const sums = points.map((point) => point[0] + point[1]);
  const diffs = points.map((point) => point[0] - point[1]);
  return [
    points[sums.indexOf(Math.min(...sums))],
    points[diffs.indexOf(Math.max(...diffs))],
    points[sums.indexOf(Math.max(...sums))],
    points[diffs.indexOf(Math.min(...diffs))]
  ];
}

function getQuadBounds(corners) {
  const quad = normalizeCornerQuad(corners);
  if (!quad) {
    return null;
  }
  return {
    left: Math.round(Math.min(...quad.map((point) => Number(point[0])))),
    right: Math.round(Math.max(...quad.map((point) => Number(point[0])))),
    top: Math.round(Math.min(...quad.map((point) => Number(point[1])))),
    bottom: Math.round(Math.max(...quad.map((point) => Number(point[1]))))
  };
}

function getMedianGap(peaks = [], fallback = 0) {
  const values = (Array.isArray(peaks) ? peaks : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let index = 1; index < values.length; index += 1) {
    const gap = values[index] - values[index - 1];
    if (gap > 1) {
      gaps.push(gap);
    }
  }
  if (!gaps.length) {
    return Number(fallback) || 0;
  }
  return gaps[Math.floor(gaps.length / 2)];
}

function buildInnerFrameQuad(gridStage) {
  return normalizeCornerQuad(
    gridStage?.gridBoundaryDetection?.cornerAnchors?.corners
    || gridStage?.gridBoundaryDetection?.corners
    || null
  );
}

function buildGuideAlignedQuad(guides) {
  if (!guides) {
    return null;
  }
  const left = Number(guides.left);
  const right = Number(guides.right);
  const top = Number(guides.top);
  const bottom = Number(guides.bottom);
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return null;
  }
  return normalizeCornerQuad([
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom]
  ]);
}

function buildPreferredInnerDisplayQuad(gridStage) {
  const cornerQuad = buildInnerFrameQuad(gridStage);
  const guideQuad = buildGuideAlignedQuad(gridStage?.gridBoundaryDetection?.guides || null);
  if (!cornerQuad) {
    return guideQuad;
  }
  if (!guideQuad) {
    return cornerQuad;
  }
  const outerState = resolveOuterFrameState(gridStage);
  if (!outerState.virtualOuterFrameApplied) {
    return cornerQuad;
  }
  const horizontalDrift = Math.max(
    Math.abs(Number(cornerQuad[0][0]) - Number(cornerQuad[3][0])),
    Math.abs(Number(cornerQuad[1][0]) - Number(cornerQuad[2][0]))
  );
  const verticalDrift = Math.max(
    Math.abs(Number(cornerQuad[0][1]) - Number(cornerQuad[1][1])),
    Math.abs(Number(cornerQuad[3][1]) - Number(cornerQuad[2][1]))
  );
  const guideWidth = Math.max(1, Number(guideQuad[1][0]) - Number(guideQuad[0][0]));
  const guideHeight = Math.max(1, Number(guideQuad[2][1]) - Number(guideQuad[0][1]));
  const mildPerspectiveDrift = (
    horizontalDrift <= Math.max(3, Math.round(guideWidth * 0.01))
    && verticalDrift <= Math.max(3, Math.round(guideHeight * 0.01))
  );
  return mildPerspectiveDrift ? guideQuad : cornerQuad;
}

function resolveOuterFrameState(gridStage) {
  const extraction = gridStage?.outerFrameExtraction || null;
  const inferred = gridStage?.inferredOuterFrame || null;
  const currentInnerBounds = gridStage?.gridBoundaryDetection?.guides
    ? {
        left: Math.round(Number(gridStage.gridBoundaryDetection.guides.left || 0)),
        right: Math.round(Number(gridStage.gridBoundaryDetection.guides.right || 0)),
        top: Math.round(Number(gridStage.gridBoundaryDetection.guides.top || 0)),
        bottom: Math.round(Number(gridStage.gridBoundaryDetection.guides.bottom || 0))
      }
    : getQuadBounds(buildInnerFrameQuad(gridStage));
  const currentPatternProfile = (
    gridStage?.gridBoundaryDetection?.guides?.globalPattern?.patternProfile
    || gridStage?.gridBoundaryDetection?.globalPattern?.patternProfile
    || null
  );
  const processingOuterQuad = normalizeCornerQuad(
    extraction?.component?.outerQuad
    || inferred?.outerQuad
    || null
  );
  const referenceOuterQuad = normalizeCornerQuad(
    extraction?.component?.outerQuad
    || inferred?.diagnostics?.detectedOuterBorder?.outerQuad
    || inferred?.outerQuad
    || null
  );
  const realOuterFrameDetected = Boolean(extraction?.applied);
  const virtualOuterFrameApplied = !realOuterFrameDetected && isVirtualOuterFrame(inferred);
  const inferredOuterFrameApplied = !realOuterFrameDetected && !virtualOuterFrameApplied && Boolean(inferred?.applied);
  const modeInfo = resolveOuterFrameMode({
    extraction,
    inferred,
    currentInnerBounds,
    currentPatternProfile,
    realOuterFrameDetected,
    inferredOuterFrameApplied
  });
  const processingRefinedOuterFrame = extraction?.component?.refinedOuterFrame || inferred?.refinedOuterFrame || null;
  const referenceRefinedOuterFrame = extraction?.component?.refinedOuterFrame
    || inferred?.diagnostics?.detectedOuterBorder?.refinedOuterFrame
    || inferred?.refinedOuterFrame
    || null;
  const outerFrameKind = realOuterFrameDetected
    ? 'real'
    : (inferredOuterFrameApplied ? 'inferred' : (virtualOuterFrameApplied ? 'virtual' : 'none'));
  const modeRouting = buildModeRoutingPlan(modeInfo, outerFrameKind);
  return {
    extraction,
    inferred,
    processingOuterQuad,
    referenceOuterQuad,
    realOuterFrameDetected,
    inferredOuterFrameApplied,
    virtualOuterFrameApplied,
    modeInfo,
    modeRouting,
    processingRefinedOuterFrame,
    referenceRefinedOuterFrame,
    outerFrameKind,
    currentInnerBounds,
    currentPatternProfile,
    source: realOuterFrameDetected
      ? (extraction?.reason || null)
      : (inferred?.reason || extraction?.reason || null)
  };
}

function buildVirtualOuterFrameFromInnerGrid(gridStage, imageInfo = {}, options = {}) {
  const innerQuad = buildInnerFrameQuad(gridStage);
  const innerBounds = getQuadBounds(innerQuad);
  const guides = gridStage?.gridBoundaryDetection?.guides || null;
  const width = Number(imageInfo.width) || 0;
  const height = Number(imageInfo.height) || 0;
  if (!innerQuad || !innerBounds || width <= 0 || height <= 0) {
    return null;
  }
  const gridCols = Math.max(1, Number(options.gridCols) || 1);
  const gridRows = Math.max(1, Number(options.gridRows) || 1);
  const cellWidth = getMedianGap(
    guides?.xPeaks,
    (innerBounds.right - innerBounds.left) / gridCols
  );
  const cellHeight = getMedianGap(
    guides?.yPeaks,
    (innerBounds.bottom - innerBounds.top) / gridRows
  );
  const insetX = Math.max(
    6,
    Math.min(
      18,
      Math.round(Math.max(width * 0.004, Math.min(12, cellWidth * 0.03)))
    )
  );
  const insetY = Math.max(
    6,
    Math.min(
      18,
      Math.round(Math.max(height * 0.004, Math.min(12, cellHeight * 0.03)))
    )
  );
  const left = insetX;
  const top = insetY;
  const right = Math.max(left + 1, width - 1 - insetX);
  const bottom = Math.max(top + 1, height - 1 - insetY);
  const outerQuad = normalizeCornerQuad([
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom]
  ]);
  if (!outerQuad) {
    return null;
  }
  return {
    applied: true,
    reason: 'virtual-outer-frame-from-image-border',
    outerQuad,
    refinedOuterFrame: {
      left,
      right,
      top,
      bottom
    },
    diagnostics: {
      method: 'virtual-outer-frame-from-image-border',
      virtualFrame: true,
      basedOn: 'image-border-slight-inset',
      innerBounds,
      borderInset: {
        x: insetX,
        y: insetY
      },
      replacedOuterFrameInference: options.replacedOuterFrameInference || null,
      cellWidth: Number(cellWidth.toFixed(3)),
      cellHeight: Number(cellHeight.toFixed(3))
    }
  };
}

function solveLinearSystem(matrix, vector) {
  const size = Array.isArray(matrix) ? matrix.length : 0;
  if (!size || !Array.isArray(vector) || vector.length !== size) {
    return null;
  }
  const augmented = matrix.map((row, index) => [...row.map(Number), Number(vector[index])]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let maxRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[maxRow][pivot])) {
        maxRow = row;
      }
    }
    if (Math.abs(augmented[maxRow][pivot]) < 1e-9) {
      return null;
    }
    if (maxRow !== pivot) {
      [augmented[pivot], augmented[maxRow]] = [augmented[maxRow], augmented[pivot]];
    }
    const pivotValue = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      augmented[pivot][column] /= pivotValue;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) {
        continue;
      }
      const factor = augmented[row][pivot];
      if (!factor) {
        continue;
      }
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function computeHomographyMatrix(sourceQuad, targetQuad) {
  const src = normalizeCornerQuad(sourceQuad);
  const dst = normalizeCornerQuad(targetQuad);
  if (!src || !dst) {
    return null;
  }
  const matrix = [];
  const vector = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = src[index];
    const [u, v] = dst[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const solution = solveLinearSystem(matrix, vector);
  if (!solution) {
    return null;
  }
  return [
    [solution[0], solution[1], solution[2]],
    [solution[3], solution[4], solution[5]],
    [solution[6], solution[7], 1]
  ];
}

function applyHomographyToPoint(point, homography) {
  if (!Array.isArray(point) || point.length < 2 || !homography) {
    return null;
  }
  const x = Number(point[0]);
  const y = Number(point[1]);
  const denominator = (homography[2][0] * x) + (homography[2][1] * y) + homography[2][2];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return null;
  }
  const mappedX = ((homography[0][0] * x) + (homography[0][1] * y) + homography[0][2]) / denominator;
  const mappedY = ((homography[1][0] * x) + (homography[1][1] * y) + homography[1][2]) / denominator;
  return [mappedX, mappedY];
}

function projectQuadToOuterRectifiedImage(quad, outerRectifyDetails) {
  const normalizedQuad = normalizeCornerQuad(quad);
  const rectified = outerRectifyDetails?.rectifiedOuterFrame || null;
  const padding = outerRectifyDetails?.paddedOutput?.padding || null;
  const cropBox = outerRectifyDetails?.croppedOutput?.cropBox || null;
  const sourceQuad = normalizeCornerQuad(
    outerRectifyDetails?.outerQuad
    || rectified?.orderedCorners
    || null
  );
  if (!normalizedQuad || !rectified || !sourceQuad) {
    return null;
  }
  const targetWidth = Number(rectified.targetWidth) || 0;
  const targetHeight = Number(rectified.targetHeight) || 0;
  if (targetWidth <= 1 || targetHeight <= 1) {
    return null;
  }
  let offsetX = 0;
  let offsetY = 0;
  if (padding) {
    offsetX = Number(padding.left) || 0;
    offsetY = Number(padding.top) || 0;
  } else if (cropBox) {
    offsetX = -(Number(cropBox.left) || 0);
    offsetY = -(Number(cropBox.top) || 0);
  }
  const targetQuad = [
    [offsetX, offsetY],
    [offsetX + targetWidth - 1, offsetY],
    [offsetX + targetWidth - 1, offsetY + targetHeight - 1],
    [offsetX, offsetY + targetHeight - 1]
  ];
  const homography = computeHomographyMatrix(sourceQuad, targetQuad);
  if (!homography) {
    return null;
  }
  return normalizeCornerQuad(normalizedQuad.map((point) => applyHomographyToPoint(point, homography)));
}

async function renderQuadCornersAnnotation(imagePath, outputPath, quad, options = {}) {
  if (!imagePath || !outputPath || !quad) {
    return null;
  }
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const stroke = String(options.stroke || '#2563eb');
  const fill = String(options.fill || '#60a5fa');
  const title = String(options.title || '四角定位');
  const subtitle = String(options.subtitle || '四角点与边界框');
  const labelPrefix = String(options.labelPrefix || 'P');
  const polygonDashArray = options.dashed ? ' stroke-dasharray="20 14"' : '';
  const labelOutline = 'rgba(255,255,255,0.96)';
  const labels = quad.map((point, index) => {
    const x = Math.max(0, Math.min(width - 1, Math.round(point[0])));
    const y = Math.max(0, Math.min(height - 1, Math.round(point[1])));
    const label = `${labelPrefix}${index + 1} (${x},${y})`;
    const labelWidth = Math.max(96, Math.min(210, 18 + label.length * 8));
    const labelX = Math.min(Math.max(12, x + 10), Math.max(12, width - labelWidth - 12));
    const labelY = Math.max(20, y - 14);
    return `
      <circle cx="${x}" cy="${y}" r="10" fill="${fill}" stroke="${stroke}" stroke-width="4"/>
      <text x="${labelX + 8}" y="${labelY}" font-size="14" fill="#111827" stroke="${labelOutline}" stroke-width="4" paint-order="stroke fill" stroke-linejoin="round">${label}</text>
    `;
  }).join('\n');
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <polygon points="${quad.map((point) => `${Math.round(point[0])},${Math.round(point[1])}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="6"${polygonDashArray}/>
      ${labels}
      <text x="30" y="48" font-size="24" fill="#111827" stroke="${labelOutline}" stroke-width="6" paint-order="stroke fill" stroke-linejoin="round">${title}</text>
      <text x="30" y="78" font-size="18" fill="#065f46" stroke="${labelOutline}" stroke-width="5" paint-order="stroke fill" stroke-linejoin="round">${subtitle}</text>
    </svg>
  `;
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(imagePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputPath);
  return outputPath;
}

async function writeJson(outputPath, payload) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function exportVirtualOuterFrameCrop(imagePath, outputImagePath, outerFrame, metaPath = null) {
  const outerQuad = normalizeCornerQuad(outerFrame?.outerQuad || null);
  const bounds = outerFrame?.refinedOuterFrame || getQuadBounds(outerQuad);
  if (!imagePath || !outputImagePath || !outerQuad || !bounds) {
    return null;
  }
  const extractWidth = Math.max(1, bounds.right - bounds.left + 1);
  const extractHeight = Math.max(1, bounds.bottom - bounds.top + 1);
  await fs.promises.mkdir(path.dirname(outputImagePath), { recursive: true });
  await sharp(imagePath)
    .extract({
      left: bounds.left,
      top: bounds.top,
      width: extractWidth,
      height: extractHeight
    })
    .png()
    .toFile(outputImagePath);
  const result = {
    applied: true,
    reason: 'virtual-outer-frame-crop',
    source: 'virtual_outer_frame',
    outputMode: 'virtual-outer-frame-crop',
    outputPath: outputImagePath,
    outerQuad,
    refinedOuterFrame: bounds,
    rectifiedOuterFrame: {
      orderedCorners: outerQuad,
      targetWidth: extractWidth,
      targetHeight: extractHeight,
      sourceTopWidth: extractWidth,
      sourceBottomWidth: extractWidth,
      sourceLeftHeight: extractHeight,
      sourceRightHeight: extractHeight
    },
    croppedOutput: {
      width: extractWidth,
      height: extractHeight,
      cropBox: {
        left: 0,
        top: 0,
        right: extractWidth - 1,
        bottom: extractHeight - 1,
        width: extractWidth,
        height: extractHeight
      },
      method: 'virtual-outer-frame-raw'
    },
    virtualFrame: true,
    inferredDiagnostics: outerFrame?.diagnostics || null
  };
  if (metaPath) {
    await writeJson(metaPath, result);
  }
  return result;
}

async function pathExists(targetPath) {
  if (!targetPath) {
    return false;
  }
  try {
    await fs.promises.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function buildOuterCornerLocalizationResult(gridStage, outputImagePath = null) {
  const outerFrameState = resolveOuterFrameState(gridStage);
  return {
    processNo: '03_1',
    processName: '03_1_外框四角定位',
    applied: Boolean(outerFrameState.referenceOuterQuad),
    source: outerFrameState.source,
    outputImagePath,
    corners: outerFrameState.referenceOuterQuad,
    referenceOuterQuad: outerFrameState.referenceOuterQuad,
    processingOuterQuad: outerFrameState.processingOuterQuad,
    outerFrameExists: outerFrameState.realOuterFrameDetected || outerFrameState.inferredOuterFrameApplied,
    realOuterFrameDetected: outerFrameState.realOuterFrameDetected,
    inferredOuterFrameApplied: outerFrameState.inferredOuterFrameApplied,
    virtualOuterFrameApplied: outerFrameState.virtualOuterFrameApplied,
    outerFrameKind: outerFrameState.outerFrameKind,
    outerFrameMode: outerFrameState.modeInfo.mode,
    outerFrameModeLabel: outerFrameState.modeInfo.label,
    outerFrameModeReason: outerFrameState.modeInfo.reason,
    outerFrameModePattern: outerFrameState.modeInfo.pattern,
    processingStrategy: outerFrameState.modeInfo.strategy,
    modeRouting: outerFrameState.modeRouting,
    refinedOuterFrame: outerFrameState.referenceRefinedOuterFrame,
    inferredDiagnostics: outerFrameState.inferred?.diagnostics || null
  };
}

function buildOuterRectificationResult(gridStage, outputImagePath = null, outputMetaPath = null, details = null) {
  const outerFrameState = resolveOuterFrameState(gridStage);
  const resolvedOutputImagePath = gridStage?.outerFrameRectifiedOutputPath || outputImagePath || null;
  const resolvedOutputMetaPath = gridStage?.outerFrameRectifiedMetaPath || outputMetaPath || null;
  const applied = Boolean(
    resolvedOutputImagePath
    && (
      details?.applied
      || outerFrameState.realOuterFrameDetected
      || outerFrameState.inferredOuterFrameApplied
      || outerFrameState.virtualOuterFrameApplied
    )
  );
  return {
    processNo: '03_2',
    processName: '03_2_外框裁剪与矫正',
    applied,
    reason: outerFrameState.realOuterFrameDetected
      ? (outerFrameState.extraction?.reason || details?.reason || null)
      : (
        outerFrameState.inferredOuterFrameApplied
          ? (outerFrameState.inferred?.reason || details?.reason || 'inferred-outer-frame-exported')
          : (
            outerFrameState.virtualOuterFrameApplied
              ? (outerFrameState.inferred?.reason || details?.reason || 'virtual-outer-frame-exported')
              : (details?.reason || (gridStage?.outerFrameRectifiedOutputPath ? 'outer-frame-exported' : 'outer-frame-not-found'))
          )
      ),
    outputImagePath: resolvedOutputImagePath,
    outputMetaPath: resolvedOutputMetaPath,
    outerQuad: outerFrameState.processingOuterQuad,
    referenceOuterQuad: outerFrameState.referenceOuterQuad,
    outerFrameKind: outerFrameState.outerFrameKind,
    realOuterFrameDetected: outerFrameState.realOuterFrameDetected,
    inferredOuterFrameApplied: outerFrameState.inferredOuterFrameApplied,
    virtualOuterFrameApplied: outerFrameState.virtualOuterFrameApplied,
    outerFrameMode: outerFrameState.modeInfo.mode,
    outerFrameModeLabel: outerFrameState.modeInfo.label,
    outerFrameModeReason: outerFrameState.modeInfo.reason,
    outerFrameModePattern: outerFrameState.modeInfo.pattern,
    processingStrategy: outerFrameState.modeInfo.strategy,
    modeRouting: outerFrameState.modeRouting,
    refinedOuterFrame: outerFrameState.processingRefinedOuterFrame,
    referenceRefinedOuterFrame: outerFrameState.referenceRefinedOuterFrame,
    details
  };
}

function buildInnerCornerLocalizationResult(gridStage, outputImagePath = null, options = {}) {
  const detection = gridStage?.gridBoundaryDetection || null;
  const innerQuad = buildInnerFrameQuad(gridStage);
  const displayQuad = normalizeCornerQuad(options.displayQuad) || null;
  const displayCoordinateSpace = options.displayCoordinateSpace
    || (options.inputSourceStep === '03_2_外框裁剪与矫正' ? '03_2_外框裁剪与矫正图' : '02_3_2_1_矫正预处理图');
  return {
    processNo: '03_3',
    processName: '03_3_内框四角定位',
    applied: Boolean(innerQuad),
    source: detection?.source || null,
    outputImagePath,
    inputImagePath: options.inputImagePath || null,
    inputSourceStep: options.inputSourceStep || null,
    corners: innerQuad,
    displayCorners: displayQuad,
    displayCoordinateSpace,
    cornerAnchors: detection?.cornerAnchors || null,
    guides: detection?.guides || null
  };
}

function buildGridGuideDiagnostics(gridStage) {
  const detection = gridStage?.gridBoundaryDetection || null;
  return {
    note: '内部均分线/切分参考线仅用于内框四角点质量诊断与后续步骤。',
    patternProfile: detection?.guides?.globalPattern?.patternProfile || null,
    rawGuides: detection?.rawGuides || null,
    normalizedGuides: detection?.guides || null,
    gridRectificationGuides: gridStage?.gridRectification?.guides || null,
    guideConstraintRepair: gridStage?.guideConstraintRepair || null,
    topGuideConfirmation: gridStage?.topGuideConfirmation || null,
    topLeadingRowRepair: gridStage?.topLeadingRowRepair || null,
    cornerRefinement: gridStage?.cornerRefinement || null,
    realBoundaryRefinement: gridStage?.realBoundaryRefinement || null
  };
}

function buildOuterCornerAnnotationStyle(outerCorner) {
  const mode = outerCorner?.outerFrameMode || null;
  return buildOuterCornerAnnotationStyleByMode(mode);
}

async function readJsonIfExists(jsonPath) {
  if (!jsonPath) {
    return null;
  }
  try {
    return JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

async function ensureModeDrivenOuterFrameFallback(gridStage, options = {}) {
  const {
    stageInputPath,
    step03_2ImagePath,
    step03_2MetaPath,
    gridRows,
    gridCols
  } = options;
  const shouldReuseExistingInferredOuterFrame = isTrustedInferredOuterFrame(
    gridStage?.inferredOuterFrame,
    getQuadBounds
  );
  if (gridStage?.outerFrameExtraction?.applied || shouldReuseExistingInferredOuterFrame) {
    return {
      fallbackApplied: false,
      fallbackMode: 'reuse-existing-inferred-outer-frame'
    };
  }
  const preprocessMeta = await sharp(stageInputPath).metadata();
  const virtualOuterFrame = buildVirtualOuterFrameFromInnerGrid(
    gridStage,
    {
      width: preprocessMeta.width || 0,
      height: preprocessMeta.height || 0
    },
    {
      gridRows,
      gridCols,
      replacedOuterFrameInference: gridStage?.inferredOuterFrame?.applied
        ? {
            reason: gridStage.inferredOuterFrame.reason || null,
            diagnostics: gridStage.inferredOuterFrame.diagnostics || null
          }
        : null
    }
  );
  if (!virtualOuterFrame) {
    return {
      fallbackApplied: false,
      fallbackMode: 'virtual-outer-frame-not-available'
    };
  }
  gridStage.inferredOuterFrame = virtualOuterFrame;
  await exportVirtualOuterFrameCrop(
    stageInputPath,
    step03_2ImagePath,
    virtualOuterFrame,
    step03_2MetaPath
  );
  return {
    fallbackApplied: true,
    fallbackMode: 'virtual-outer-frame-from-image-border'
  };
}

class GridOuterRectExtractPlugin {
  constructor() {
    this.name = '03_字帖外框与内框定位裁剪';
    this.version = '1.0.0';
  }

  async execute(params) {
    const {
      baseName,
      stageInputPath = null,
      preprocessPath,
      preprocessWarpedPath,
      preprocessGuideRemovedPath,
      gridRows = DEFAULT_GRID_ROWS,
      gridCols = DEFAULT_GRID_COLS,
      outputDir,
      textRectMetaPath,
      textRectAnnotatedPath,
      textRectWarpedPath
    } = params || {};

    const resolvedStageInputPath = resolveSingleImageInput({
      stageName: '03阶段',
      primaryInputPath: stageInputPath,
      legacyInputPaths: [preprocessPath, preprocessWarpedPath, preprocessGuideRemovedPath]
    });
    if (!resolvedStageInputPath || !outputDir) {
      throw new Error('03阶段输入图参数不完整');
    }

    const resolvedPreprocessPath = resolvedStageInputPath;
    const resolvedPreprocessWarpedPath = resolvedStageInputPath;
    const resolvedPreprocessGuideRemovedPath = resolvedStageInputPath;

    const step03_1Dir = path.join(outputDir, '03_1_外框四角定位');
    const step03_2Dir = path.join(outputDir, '03_2_外框裁剪与矫正');
    const step03_3Dir = path.join(outputDir, '03_3_内框四角定位');
    const step03_4Dir = path.join(outputDir, '03_4_字帖内框裁剪与矫正');
    await fs.promises.mkdir(step03_1Dir, { recursive: true });
    await fs.promises.mkdir(step03_2Dir, { recursive: true });
    await fs.promises.mkdir(step03_3Dir, { recursive: true });
    await fs.promises.mkdir(step03_4Dir, { recursive: true });

    const step03_1ImagePath = path.join(step03_1Dir, '03_1_外框四角定位图.png');
    const step03_1MetaPath = path.join(step03_1Dir, '03_1_外框四角定位.json');
    const step03_2ImagePath = path.join(step03_2Dir, '03_2_外框裁剪与矫正图.png');
    const step03_2MetaPath = path.join(step03_2Dir, '03_2_外框裁剪与矫正.json');
    const step03_3ImagePath = textRectAnnotatedPath || path.join(step03_3Dir, '03_3_内框四角定位图.png');
    const step03_3MetaPath = path.join(step03_3Dir, '03_3_内框四角定位.json');
    const step03_4ImagePath = textRectWarpedPath || path.join(step03_4Dir, '03_4_字帖内框裁剪与矫正图.png');
    const step03_4MetaPath = path.join(step03_4Dir, '03_4_字帖内框裁剪与矫正.json');

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stage03-restructure-'));
    try {
      const internalAnnotatedPath = path.join(tempDir, 'internal_inner_annotation.png');
      const internalGridRectifiedPath = path.join(tempDir, 'internal_inner_rectified.png');
      const internalGridRectifiedMetaPath = path.join(tempDir, 'internal_inner_rectified.json');
      const internalCandidateAnnotatedPath = path.join(tempDir, 'internal_candidate.png');
      const internalAdjustedAnnotatedPath = path.join(tempDir, 'internal_adjusted.png');
      const internalCropAnnotatedPath = path.join(tempDir, 'internal_crop_annotation.png');

      const gridStage = await extractGridArtifactsFromWarpedImages({
        preprocessInputPath: resolvedPreprocessPath,
        warpedImagePath: resolvedPreprocessWarpedPath,
        guideRemovedInputPath: resolvedPreprocessGuideRemovedPath,
        outputPath: resolvedPreprocessPath,
        gridAnnotatedOutputPath: internalAnnotatedPath,
        gridBackgroundMaskOutputPath: null,
        outerFrameRectifiedOutputPath: step03_2ImagePath,
        outerFrameRectifiedMetaPath: step03_2MetaPath,
        gridRectifiedOutputPath: internalGridRectifiedPath,
        gridRectifiedMetaPath: internalGridRectifiedMetaPath,
        gridRows,
        gridCols,
        enableA4GuideConstraint: false,
        disableOuterFrameCleanup: true,
        processNo: '03'
      });

      const modeFallbackInfo = await ensureModeDrivenOuterFrameFallback(
        gridStage,
        {
          stageInputPath: resolvedPreprocessPath,
          step03_2ImagePath,
          step03_2MetaPath,
          gridRows,
          gridCols
        }
      );

      const outerCorner = buildOuterCornerLocalizationResult(gridStage, step03_1ImagePath);
      if (outerCorner.applied && outerCorner.corners) {
        const annotationStyle = buildOuterCornerAnnotationStyle(outerCorner);
        await renderQuadCornersAnnotation(
          resolvedPreprocessPath,
          step03_1ImagePath,
          outerCorner.corners,
          {
            title: '03_1 外框四角定位',
            subtitle: annotationStyle.subtitle,
            stroke: annotationStyle.stroke,
            fill: annotationStyle.fill,
            labelPrefix: 'O',
            dashed: annotationStyle.dashed
          }
        );
      }
      await writeJson(step03_1MetaPath, outerCorner);

      const outerRectifyDetails = await readJsonIfExists(step03_2MetaPath);
      const outerRectify = buildOuterRectificationResult(
        gridStage,
        step03_2ImagePath,
        step03_2MetaPath,
        outerRectifyDetails
      );
      const outerRectifyImageExists = await pathExists(outerRectify.outputImagePath);
      if (!outerRectifyImageExists) {
        outerRectify.applied = false;
        outerRectify.outputImagePath = null;
        if (outerRectify.reason === 'virtual-outer-frame-exported' || outerRectify.reason === 'outer-frame-exported') {
          outerRectify.reason = 'outer-frame-image-not-generated';
        }
      }
      await writeJson(step03_2MetaPath, outerRectify);

      const innerCornerDisplayInputPath = outerRectifyImageExists ? outerRectify.outputImagePath : resolvedPreprocessPath;
      const innerCornerDisplayQuad = projectQuadToOuterRectifiedImage(
        buildPreferredInnerDisplayQuad(gridStage),
        outerRectifyImageExists ? outerRectify.details : null
      ) || buildPreferredInnerDisplayQuad(gridStage);
      const innerCorner = buildInnerCornerLocalizationResult(
        gridStage,
        step03_3ImagePath,
        {
          inputImagePath: innerCornerDisplayInputPath,
          inputSourceStep: outerRectifyImageExists ? '03_2_外框裁剪与矫正' : '02_3_2_矫正预处理图',
          displayCoordinateSpace: outerRectifyImageExists ? '03_2_外框裁剪与矫正图' : '02_3_2_1_矫正预处理图',
          displayQuad: innerCornerDisplayQuad
        }
      );
      if (innerCorner.applied && innerCorner.corners) {
        await renderQuadCornersAnnotation(
          innerCornerDisplayInputPath,
          step03_3ImagePath,
          innerCorner.displayCorners || innerCorner.corners,
          {
            title: '03_3 内框四角定位',
            subtitle: outerRectifyImageExists ? '基于 03_2 外框裁剪与矫正图的内框四角点定位结果' : '基于矫正预处理图的内框四角点定位结果',
            stroke: '#059669',
            fill: '#34d399',
            labelPrefix: 'I'
          }
        );
      }
      await writeJson(step03_3MetaPath, innerCorner);

      const rawInnerRectifiedPath = gridStage.gridRectifiedOutputPath || null;
      if (!rawInnerRectifiedPath) {
        throw new Error('03阶段未产出内框裁剪与矫正输入图');
      }
      const candidate = await gridRectCandidatePlugin.execute({
        preprocessImagePath: rawInnerRectifiedPath,
        maskPath: null,
        gridBoundaryDetection: null,
        gridRectification: null,
        explicitBounds: {
          left: 0,
          top: 0,
          width: (await sharp(rawInnerRectifiedPath).metadata()).width || 0,
          height: (await sharp(rawInnerRectifiedPath).metadata()).height || 0,
          source: '03_4_字帖内框裁剪与矫正直通'
        },
        explicitSourceMethod: '03_4内部残留边线清理前直通',
        explicitSourceStep: '03_4_字帖内框裁剪与矫正',
        outputImagePath: internalCandidateAnnotatedPath
      });
      const adjusted = await gridRectAdjustPlugin.execute({
        bounds: candidate.bounds,
        imageInfo: candidate.imageInfo,
        gridRectification: gridStage.gridRectification || null,
        inputPath: internalCandidateAnnotatedPath,
        outputImagePath: internalAdjustedAnnotatedPath
      });
      const cropResult = await gridRectCropAnnotatePlugin.execute({
        baseName,
        bounds: adjusted.bounds,
        stageInputPath: rawInnerRectifiedPath,
        preprocessGridBackgroundMaskPath: null,
        segmentationMode: 'passthrough',
        annotationInputPath: internalAdjustedAnnotatedPath,
        annotatedPath: internalCropAnnotatedPath,
        warpedCropPath: step03_4ImagePath
      });

      const rawInnerRectifiedMeta = await readJsonIfExists(internalGridRectifiedMetaPath);
      const localizedBoundaryGuides = gridStage.gridBoundaryDetection?.guides
        ? gridBoundaryLocalizePlugin.execute({ guides: gridStage.gridBoundaryDetection.guides, bounds: cropResult.bounds })
        : null;
      const internalFlowSummary = {
        candidate: {
          processNo: candidate?.processNo || null,
          processName: candidate?.processName || null,
          sourceMethod: candidate?.sourceMethod || null,
          sourceStep: candidate?.sourceStep || null,
          bounds: candidate?.bounds || null,
          cleanupDiagnostics: candidate?.cleanupDiagnostics || null
        },
        adjusted: {
          processNo: adjusted?.processNo || null,
          processName: adjusted?.processName || null,
          adjusted: Boolean(adjusted?.adjusted),
          bounds: adjusted?.bounds || null,
          diagnostics: adjusted?.diagnostics || null,
          adjustment: adjusted?.adjustment || null
        },
        cropResult: {
          processNo: cropResult?.processNo || null,
          processName: cropResult?.processName || null,
          sourceStep: cropResult?.sourceStep || null,
          baseName,
          bounds: cropResult?.bounds || null,
          segmentationMode: cropResult?.segmentationMode || null,
          warpedCropPath: step03_4ImagePath,
          gridSegmentationInputPath: step03_4ImagePath,
          gridSegmentationInputGenerated: false,
          sourceImageSize: cropResult?.sourceImageSize || null
        }
      };
      const innerRectify = {
        processNo: '03_4',
        processName: '03_4_字帖内框裁剪与矫正',
        inputPath: rawInnerRectifiedPath,
        outputImagePath: step03_4ImagePath,
        outputMetaPath: step03_4MetaPath,
        sourceMethod: candidate.sourceMethod,
        bounds: cropResult.bounds,
        cleanupDiagnostics: candidate.cleanupDiagnostics || null,
        rawInnerRectifiedMeta,
        localizedBoundaryGuides,
        internalFlow: internalFlowSummary
      };
      await writeJson(step03_4MetaPath, innerRectify);

      const finalBounds = cropResult.bounds || adjusted.bounds;
      const finalSourceImageSize = cropResult.sourceImageSize || {
        width: candidate.imageInfo.width,
        height: candidate.imageInfo.height
      };
      const payload = {
        processNo: '03',
        processName: '03_字帖外框与内框定位裁剪',
        baseName,
        stageInputPath: resolvedStageInputPath,
        stageOutputImagePath: step03_4ImagePath,
        nextStageInputPath: step03_4ImagePath,
        handoffContract: buildStageImageHandoffContract({
          stageName: '03阶段',
          stageInputPath: resolvedStageInputPath,
          stageOutputImagePath: step03_4ImagePath,
          nextStageInputPath: step03_4ImagePath
        }),
        outerFrameExtraction: gridStage.outerFrameExtraction || null,
        inferredOuterFrame: gridStage.inferredOuterFrame || null,
        outerFrameMode: outerCorner.outerFrameMode,
        outerFrameModeLabel: outerCorner.outerFrameModeLabel,
        outerFrameModeReason: outerCorner.outerFrameModeReason,
        outerFrameProcessingStrategy: outerCorner.processingStrategy,
        modeRouting: outerCorner.modeRouting || null,
        modeFallbackInfo,
        downstreamModeHints: outerCorner.modeRouting?.downstreamHints || null,
        cornerLocalization: {
          outerFrameCorners: outerCorner.corners || null,
          innerGridCorners: innerCorner.corners || null
        },
        outerCornerLocalization: outerCorner,
        outerFrameRectification: outerRectify,
        innerCornerLocalization: innerCorner,
        innerFrameRectification: innerRectify,
        gridGuideDiagnostics: buildGridGuideDiagnostics(gridStage),
        inputPaths: {
          stageInputPath: resolvedStageInputPath
        },
        outputPaths: {
          stageOutputImagePath: step03_4ImagePath,
          outerCornerAnnotatedPath: outerCorner.outputImagePath || null,
          outerCornerMetaPath: step03_1MetaPath,
          outerRectifiedPath: outerRectify.outputImagePath || null,
          outerRectifiedMetaPath: step03_2MetaPath,
          innerCornerAnnotatedPath: innerCorner.outputImagePath || null,
          innerCornerMetaPath: step03_3MetaPath,
          innerRectifiedPath: step03_4ImagePath,
          innerRectifiedMetaPath: step03_4MetaPath
        },
        bounds: finalBounds,
        sourceImageSize: finalSourceImageSize,
        areaRatio: Number(((finalBounds.width * finalBounds.height) / Math.max(1, finalSourceImageSize.width * finalSourceImageSize.height)).toFixed(4)),
        sourceMethod: candidate.sourceMethod || null,
        adjusted: Boolean(adjusted?.adjusted),
        diagnostics: adjusted?.diagnostics || null,
        adjustment: adjusted?.adjustment || null,
        gridRectificationGuides: gridStage.gridRectification?.guides || null,
        segmentationInputPath: step03_4ImagePath,
        annotatedImagePath: step03_3ImagePath,
        warpedCropPath: step03_4ImagePath,
        gridSegmentationInputPath: step03_4ImagePath,
        gridSegmentationInputGenerated: false,
        gridRectifiedSourceStep: '03_4_字帖内框裁剪与矫正',
        localizedBoundaryGuides,
        internalFlow: {
          gridStage,
          ...internalFlowSummary
        },
        stepDirs: {
          step03_1: step03_1Dir,
          step03_2: step03_2Dir,
          step03_3: step03_3Dir,
          step03_4: step03_4Dir
        },
        stepMetaPaths: {
          step03_1: step03_1MetaPath,
          step03_2: step03_2MetaPath,
          step03_3: step03_3MetaPath,
          step03_4: step03_4MetaPath
        },
        显示信息: {
          阶段编号: '03',
          阶段名称: '03_字帖外框与内框定位裁剪',
          输入文件: {
            阶段输入图: resolvedStageInputPath
          },
          输出文件: {
            '03_1_外框四角定位图': outerCorner.outputImagePath || null,
            '03_2_外框裁剪与矫正图': outerRectify.outputImagePath || null,
            '03_3_内框四角定位图': innerCorner.outputImagePath || null,
            '03_4_字帖内框裁剪与矫正图': step03_4ImagePath
          }
        }
      };

      await writeJson(textRectMetaPath, payload);
      return payload;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
}

module.exports = new GridOuterRectExtractPlugin();
