const sharp = require('sharp');

/**
 * 生成测试A4图像，包含10x7的方格
 */
async function generateTestA4Image(outputPath = 'test_a4.png', options = {}) {
  const {
    width = 1240,
    height = 1754,
    canvasWidth = width,
    canvasHeight = height,
    offsetX = 0,
    offsetY = 0
  } = options;

  const gridCols = 10;
  const gridRows = 7;
  const marginX = 180;
  const marginY = 220;
  const gridWidth = width - marginX * 2;
  const gridHeight = height - marginY * 2;

  const cellWidth = gridWidth / gridCols;
  const cellHeight = gridHeight / gridRows;

  let svg = `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="100%" height="100%" fill="white"/>`;
  svg += `<g transform="translate(${offsetX}, ${offsetY})">`;
  svg += `<rect x="${marginX}" y="${marginY}" width="${gridWidth}" height="${gridHeight}" fill="none" stroke="black" stroke-width="6"/>`;

  for (let i = 1; i < gridCols; i++) {
      const x = marginX + i * cellWidth;
      svg += `<line x1="${x}" y1="${marginY}" x2="${x}" y2="${marginY + gridHeight}" stroke="black" stroke-width="4"/>`;
  }

  for (let i = 1; i < gridRows; i++) {
      const y = marginY + i * cellHeight;
      svg += `<line x1="${marginX}" y1="${y}" x2="${marginX + gridWidth}" y2="${y}" stroke="black" stroke-width="4"/>`;
  }

  const sampleChars = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const x = marginX + col * cellWidth + cellWidth / 2;
      const y = marginY + row * cellHeight + cellHeight / 2;
      const char = sampleChars[col % sampleChars.length];
      svg += `<text x="${x}" y="${y}" font-family="sans-serif" font-size="92" text-anchor="middle" dominant-baseline="middle" fill="black">${char}</text>`;
    }
  }

  svg += '</g>';
  svg += '</svg>';

  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  console.log(`测试A4图像已生成：${outputPath}`);
}

// 如果直接运行，则生成测试图像
if (require.main === module) {
  generateTestA4Image().catch(console.error);
}

module.exports = { generateTestA4Image };
