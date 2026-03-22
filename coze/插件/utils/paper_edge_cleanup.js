let sharp;

try {
  sharp = require('sharp');
} catch (error) {
  sharp = require('../05_切分插件/node_modules/sharp');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toHexByte(value) {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function resolvePaperBorderSpec(width, height, edgeCleanup) {
  if (!edgeCleanup?.applied || !edgeCleanup.paperColor || width <= 0 || height <= 0) {
    return null;
  }

  const insets = edgeCleanup.insets || {};
  const borderLeft = insets.left > 0 ? Math.max(6, Math.min(24, Math.round(width * 0.012))) : 0;
  const borderRight = insets.right > 0 ? Math.max(6, Math.min(24, Math.round(width * 0.012))) : 0;
  const borderTop = insets.top > 0 ? Math.max(8, Math.min(28, Math.round(height * 0.014))) : 0;
  const borderBottom = insets.bottom > 0 ? Math.max(8, Math.min(28, Math.round(height * 0.014))) : 0;
  if (borderLeft + borderRight + borderTop + borderBottom <= 0) {
    return null;
  }

  return {
    color: `#${toHexByte(edgeCleanup.paperColor.r)}${toHexByte(edgeCleanup.paperColor.g)}${toHexByte(edgeCleanup.paperColor.b)}`,
    borderLeft,
    borderRight,
    borderTop,
    borderBottom
  };
}

function buildPaperBorderOverlaySvg(width, height, edgeCleanup) {
  const spec = resolvePaperBorderSpec(width, height, edgeCleanup);
  if (!spec) {
    return null;
  }

  const overlays = [];
  if (spec.borderTop > 0) {
    overlays.push(`<rect x="0" y="0" width="${width}" height="${spec.borderTop}" fill="${spec.color}"/>`);
  }
  if (spec.borderBottom > 0) {
    overlays.push(`<rect x="0" y="${Math.max(0, height - spec.borderBottom)}" width="${width}" height="${spec.borderBottom}" fill="${spec.color}"/>`);
  }
  if (spec.borderLeft > 0) {
    overlays.push(`<rect x="0" y="0" width="${spec.borderLeft}" height="${height}" fill="${spec.color}"/>`);
  }
  if (spec.borderRight > 0) {
    overlays.push(`<rect x="${Math.max(0, width - spec.borderRight)}" y="0" width="${spec.borderRight}" height="${height}" fill="${spec.color}"/>`);
  }

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlays.join('')}</svg>`;
}

async function applySolidPaperBorder(imagePath, edgeCleanup) {
  if (!imagePath) {
    return false;
  }

  const metadata = await sharp(imagePath).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  const svg = buildPaperBorderOverlaySvg(width, height, edgeCleanup);
  if (!svg) {
    return false;
  }

  const buffer = await sharp(imagePath)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
  await require('fs').promises.writeFile(imagePath, buffer);
  return true;
}

module.exports = {
  clamp,
  buildPaperBorderOverlaySvg,
  applySolidPaperBorder
};
