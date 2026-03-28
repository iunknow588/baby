const { requireSharp } = require('../../utils/require_sharp');

const sharp = requireSharp();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveBoundaryPair(boundaries, index, totalCount, totalLength) {
  if (Array.isArray(boundaries) && Array.isArray(boundaries[index]) && boundaries[index].length >= 2) {
    return boundaries[index];
  }

  const fallbackStart = Math.round((totalLength * index) / Math.max(totalCount, 1));
  const fallbackEnd = Math.round((totalLength * (index + 1)) / Math.max(totalCount, 1));
  return [fallbackStart, Math.max(fallbackStart + 1, fallbackEnd)];
}

function buildDarkMask(data, info, threshold) {
  const { width, height, channels } = info;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index++) {
    const offset = index * channels;
    let intensity = 255;
    for (let channel = 0; channel < Math.min(channels, 3); channel++) {
      intensity = Math.min(intensity, data[offset + channel]);
    }
    mask[index] = intensity < threshold ? 1 : 0;
  }
  return mask;
}

function cropMaskBounds(mask, width, height, thresholdRatio = 0.003) {
  const minimumDarkPixelsPerLine = Math.max(1, Math.floor(Math.max(width, height) * thresholdRatio));
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    let rowDarkPixels = 0;
    for (let x = 0; x < width; x++) {
      const value = mask[y * width + x];
      rowDarkPixels += value;
      if (value) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    if (rowDarkPixels >= minimumDarkPixelsPerLine) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX === -1 || maxY === -1) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function trimCellToContent(cellBuffer, threshold) {
  const image = sharp(cellBuffer).ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  const mask = buildDarkMask(data, info, threshold);
  const bounds = cropMaskBounds(mask, info.width, info.height);
  if (!bounds) {
    return {
      buffer: await image.png().toBuffer(),
      contentBox: { left: 0, top: 0, width: info.width, height: info.height }
    };
  }
  const paddingX = Math.max(2, Math.floor(bounds.width * 0.08));
  const paddingY = Math.max(2, Math.floor(bounds.height * 0.08));
  const left = clamp(bounds.left - paddingX, 0, info.width - 1);
  const top = clamp(bounds.top - paddingY, 0, info.height - 1);
  const width = clamp(bounds.width + paddingX * 2, 1, info.width - left);
  const height = clamp(bounds.height + paddingY * 2, 1, info.height - top);
  return {
    buffer: await image.extract({ left, top, width, height }).png().toBuffer(),
    contentBox: { left, top, width, height }
  };
}

async function executeCellCrop(params) {
  const {
    sourceImage,
    gridBounds,
    xBoundaries,
    yBoundaries,
    row,
    col,
    gridRows,
    gridCols,
    cellInsetRatio = 0,
    trimContent = false,
    threshold,
    processNo = '05_4',
    processName = '05_4_单格裁切'
  } = params || {};

  const [cellLeft, cellRight] = resolveBoundaryPair(xBoundaries, col, gridCols, gridBounds.width);
  const [cellTop, cellBottom] = resolveBoundaryPair(yBoundaries, row, gridRows, gridBounds.height);
  const cellWidth = cellRight - cellLeft;
  const cellHeight = cellBottom - cellTop;
  const insetX = Math.max(1, Math.floor(cellWidth * cellInsetRatio));
  const insetY = Math.max(1, Math.floor(cellHeight * cellInsetRatio));
  const localLeft = clamp(cellLeft + insetX, 0, cellRight - 1);
  const localTop = clamp(cellTop + insetY, 0, cellBottom - 1);
  const extractWidth = Math.max(1, cellWidth - insetX * 2);
  const extractHeight = Math.max(1, cellHeight - insetY * 2);
  const pageLeft = gridBounds.left + localLeft;
  const pageTop = gridBounds.top + localTop;

  const extracted = await sourceImage.clone().extract({
    left: pageLeft,
    top: pageTop,
    width: extractWidth,
    height: extractHeight
  }).png().toBuffer();

  const trimmed = trimContent
    ? await trimCellToContent(extracted, threshold)
    : { buffer: extracted, contentBox: { left: 0, top: 0, width: extractWidth, height: extractHeight } };

  return {
    processNo,
    processName,
    buffer: trimmed.buffer,
    contentBox: trimmed.contentBox,
    pageBox: { left: pageLeft, top: pageTop, width: extractWidth, height: extractHeight }
  };
}

module.exports = {
  clamp,
  resolveBoundaryPair,
  buildDarkMask,
  cropMaskBounds,
  trimCellToContent,
  executeCellCrop
};
