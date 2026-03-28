const fs = require('fs');
const path = require('path');
const { requireSharp } = require('../../utils/require_sharp');

const sharp = requireSharp();

async function renderGridCountAnnotation(params) {
  const {
    imagePath,
    outputAnnotatedPath,
    outputMetaPath,
    gridRows,
    gridCols,
    totalCells,
    source = '指定值',
    sourceStep = '04_1_方格数量估计',
    processNo = '04_2',
    processName = '04_2_方格数量标注'
  } = params || {};

  if (!imagePath) {
    throw new Error('imagePath参数是必需的');
  }
  if (!outputAnnotatedPath) {
    throw new Error('outputAnnotatedPath参数是必需的');
  }

  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const verticalLines = [];
  const horizontalLines = [];

  for (let col = 0; col <= gridCols; col++) {
    const x = Math.round((width * col) / Math.max(gridCols, 1));
    verticalLines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#22c55e" stroke-width="${col === 0 || col === gridCols ? 4 : 2}" stroke-opacity="0.9"/>`
    );
  }

  for (let row = 0; row <= gridRows; row++) {
    const y = Math.round((height * row) / Math.max(gridRows, 1));
    horizontalLines.push(
      `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#0ea5e9" stroke-width="${row === 0 || row === gridRows ? 4 : 2}" stroke-opacity="0.9"/>`
    );
  }

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="#f97316" stroke-width="8"/>
      ${verticalLines.join('\n')}
      ${horizontalLines.join('\n')}
      <rect x="16" y="16" width="${Math.min(360, width - 32)}" height="82" rx="10" ry="10" fill="rgba(17,24,39,0.82)"/>
      <text x="34" y="48" font-size="24" fill="#ffffff">04_2 方格数量 ${gridRows} x ${gridCols}</text>
      <text x="34" y="78" font-size="18" fill="#d1fae5">总格数=${totalCells} 来源=${source}</text>
    </svg>
  `;

  await fs.promises.mkdir(path.dirname(outputAnnotatedPath), { recursive: true });
  await sharp(imagePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outputAnnotatedPath);

  const payload = {
    processNo,
    processName,
    sourceStep,
    inputPath: imagePath,
    imagePath,
    gridRows,
    gridCols,
    totalCells,
    source,
    imageSize: { width, height },
    outputAnnotatedPath
  };

  if (outputMetaPath) {
    await fs.promises.mkdir(path.dirname(outputMetaPath), { recursive: true });
    await fs.promises.writeFile(outputMetaPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  return payload;
}

module.exports = {
  renderGridCountAnnotation
};
