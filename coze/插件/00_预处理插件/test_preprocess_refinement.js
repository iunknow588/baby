const assert = require('assert');
const { __internals } = require('./paper_preprocess');

const {
  estimateNeutralPaperColor,
  buildReadablePreprocess
} = __internals;

function setRgbPixel(buffer, width, channels, x, y, rgb) {
  const offset = ((y * width) + x) * channels;
  buffer[offset] = rgb[0];
  buffer[offset + 1] = rgb[1];
  buffer[offset + 2] = rgb[2];
}

function runNeutralPaperColorTest() {
  const width = 20;
  const height = 20;
  const channels = 3;
  const rgb = Buffer.alloc(width * height * channels);
  const excludeMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setRgbPixel(rgb, width, channels, x, y, [204, 206, 208]);
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      excludeMask[(y * width) + x] = 1;
      setRgbPixel(rgb, width, channels, x, y, [236, 236, 236]);
    }
  }

  for (let y = 6; y < 10; y += 1) {
    for (let x = 7; x < 11; x += 1) {
      setRgbPixel(rgb, width, channels, x, y, [210, 165, 158]);
    }
  }

  for (let x = 11; x < 15; x += 1) {
    setRgbPixel(rgb, width, channels, x, 12, [52, 52, 52]);
  }

  const neutralPaperColor = estimateNeutralPaperColor(
    rgb,
    { width, height, channels },
    {
      excludeMask,
      x0: 2,
      y0: 2,
      x1: 18,
      y1: 18
    }
  );

  assert(neutralPaperColor.sampleCount >= 12, `sampleCount 过低: ${neutralPaperColor.sampleCount}`);
  assert(neutralPaperColor.r >= 200 && neutralPaperColor.r <= 208, `r 异常: ${neutralPaperColor.r}`);
  assert(neutralPaperColor.g >= 202 && neutralPaperColor.g <= 210, `g 异常: ${neutralPaperColor.g}`);
  assert(neutralPaperColor.b >= 204 && neutralPaperColor.b <= 212, `b 异常: ${neutralPaperColor.b}`);
  assert(neutralPaperColor.gray >= 202 && neutralPaperColor.gray <= 210, `gray 异常: ${neutralPaperColor.gray}`);
}

function runReadablePreprocessTest() {
  const width = 12;
  const height = 12;
  const gray = new Float32Array(width * height).fill(220);
  const blurredGray = new Float32Array(width * height).fill(220);

  for (let y = 0; y < height; y += 1) {
    gray[(y * width)] = 40;
    blurredGray[(y * width)] = 188;
  }
  for (let x = 3; x < 9; x += 1) {
    gray[(1 * width) + x] = 72;
    blurredGray[(1 * width) + x] = 192;
  }

  const guideMaskInfo = {
    left: 3,
    right: 9,
    top: 3,
    bottom: 9,
    avgCellW: 3,
    avgCellH: 3,
    xPeaks: [3, 6, 9],
    yPeaks: [3, 6, 9]
  };

  const output = buildReadablePreprocess(gray, blurredGray, width, height, guideMaskInfo);
  const outerFramePixel = output[(6 * width)];
  const headerPixel = output[(1 * width) + 4];
  const innerBackgroundPixel = output[(5 * width) + 5];

  assert(outerFramePixel < 120, `框外深色边线被抹白: ${outerFramePixel}`);
  assert(headerPixel < 150, `框外上方深色内容被抹白: ${headerPixel}`);
  assert(innerBackgroundPixel >= 245, `框内背景没有被提亮: ${innerBackgroundPixel}`);
}

function run() {
  runNeutralPaperColorTest();
  runReadablePreprocessTest();
  console.log('preprocess refinement tests passed');
}

run();
