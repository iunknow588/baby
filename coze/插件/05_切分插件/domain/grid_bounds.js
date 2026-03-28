function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function detectGridBounds(mask, width, height) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX === -1 || maxY === -1) {
    return { minX: 0, maxX: width, minY: 0, maxY: height, width, height };
  }

  return {
    minX,
    maxX: maxX + 1,
    minY,
    maxY: maxY + 1,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function expandBounds(bounds, width, height, paddingRatio = 0.015) {
  const paddingX = Math.max(2, Math.floor(bounds.width * paddingRatio));
  const paddingY = Math.max(2, Math.floor(bounds.height * paddingRatio));
  const left = clamp(bounds.minX - paddingX, 0, width - 1);
  const top = clamp(bounds.minY - paddingY, 0, height - 1);
  const right = clamp(bounds.maxX + paddingX, left + 1, width);
  const bottom = clamp(bounds.maxY + paddingY, top + 1, height);
  return { left, top, width: right - left, height: bottom - top };
}

function executeGridBoundsDetection(params) {
  const {
    pageBounds = null,
    cropToGrid = true,
    sourceGuideMask = null,
    sourceMask,
    sourceWidth,
    sourceHeight,
    processNo = '05_1',
    processName = '05_1_网格范围检测'
  } = params || {};

  if (!sourceMask || !sourceWidth || !sourceHeight) {
    throw new Error('sourceMask/sourceWidth/sourceHeight参数是必需的');
  }

  const detectedGridBounds = detectGridBounds(sourceGuideMask || sourceMask, sourceWidth, sourceHeight);
  const gridBounds = pageBounds
    ? {
        left: clamp(pageBounds.left, 0, sourceWidth - 1),
        top: clamp(pageBounds.top, 0, sourceHeight - 1),
        width: clamp(pageBounds.width, 1, sourceWidth - clamp(pageBounds.left, 0, sourceWidth - 1)),
        height: clamp(pageBounds.height, 1, sourceHeight - clamp(pageBounds.top, 0, sourceHeight - 1))
      }
    : cropToGrid
      ? expandBounds(detectedGridBounds, sourceWidth, sourceHeight)
      : {
          left: 0,
          top: 0,
          width: sourceWidth,
          height: sourceHeight
        };

  return {
    processNo,
    processName,
    detectedGridBounds,
    gridBounds
  };
}

module.exports = {
  clamp,
  detectGridBounds,
  expandBounds,
  executeGridBoundsDetection
};
