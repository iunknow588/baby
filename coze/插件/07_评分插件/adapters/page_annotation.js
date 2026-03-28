const sharp = require('sharp');
const { resolveConfig } = require('../config');
const { colorFromResult } = require('../presentation/page_result_view');

async function renderAnnotatedPage({ imagePath, scoringResult, outputImagePath, outputSummaryPath = null, options = {} }) {
  const fs = require('fs');
  const config = resolveConfig(options.config);
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const overlays = [];
  const summaryLines = [];

  for (const result of scoringResult.results) {
    if (!result.page_box) {
      continue;
    }

    const color = colorFromResult(result, config);
    const box = result.page_box;
    const title = result.status === 'blank' ? '空白' : `${Math.round(result.total_score)}`;
    const subtitle = result.status === 'blank'
      ? (result.blank_reason || '空白格')
      : (result.penalties.slice(0, 2).map((item) => item.message).join(' / ') || '无明显扣分');
    const fontSize = Math.max(18, Math.floor(Math.min(box.width, box.height) * 0.12));
    const tagHeight = Math.max(28, Math.floor(fontSize * 1.6));
    const tagWidth = Math.min(box.width, Math.max(70, Math.floor(box.width * 0.78)));

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="4"/>
        <rect x="${box.left}" y="${box.top}" width="${tagWidth}" height="${tagHeight}" rx="6" ry="6" fill="${color}" fill-opacity="0.88"/>
        <text x="${box.left + 8}" y="${box.top + Math.floor(tagHeight * 0.72)}" font-family="sans-serif" font-size="${fontSize}" fill="white">${title}</text>
      </svg>
    `;

    overlays.push({ input: Buffer.from(svg), top: 0, left: 0 });
    summaryLines.push(`${result.cell_id}\t${result.status}\t${title}\t${subtitle}`);
  }

  await sharp(imagePath).composite(overlays).png().toFile(outputImagePath);

  if (outputSummaryPath) {
    const lines = [
      `image: ${imagePath}`,
      `blank_cells: ${scoringResult.summary.blank_cells}`,
      `base_avg_score: ${scoringResult.summary.base_avg_score ?? scoringResult.summary.avg_score}`,
      `avg_score: ${scoringResult.summary.avg_score}`,
      `page_total_score: ${scoringResult.summary.page_total_score ?? scoringResult.summary.avg_score}`,
      `page_score_level: ${scoringResult.summary.page_score_level ?? 'n/a'}`,
      '',
      'cell_id\tstatus\tscore_or_mark\tpenalties',
      ...summaryLines
    ];
    await fs.promises.writeFile(outputSummaryPath, `${lines.join('\n')}\n`, 'utf8');
  }

  return {
    outputImagePath,
    outputSummaryPath
  };
}

module.exports = {
  renderAnnotatedPage
};
