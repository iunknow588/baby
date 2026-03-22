const assert = require('assert');
const { evaluateDominantEdgeQuadGuard } = require('./paper_preprocess');

function approxEqual(actual, expected, epsilon = 1e-6) {
  return Math.abs(actual - expected) <= epsilon;
}

function run() {
  const overshootCase = evaluateDominantEdgeQuadGuard({
    normalizedRefined: [
      [150, 124],
      [1558, 67],
      [1578, 2368],
      [147, 2441]
    ],
    edgeQuad: [
      [148, 69],
      [1563, 69],
      [1564, 2484],
      [145, 2484]
    ],
    cellWidth: 203,
    cellHeight: 196,
    projectedTopLeftAnchor: [150, 68.5],
    projectedTopRightAnchor: [1574, 68.5],
    projectedBottomLeftAnchor: [300, 2484.2],
    projectedBottomRightAnchor: [1062, 2483.4]
  });

  assert.strictEqual(overshootCase.rejectProjectedBottomAnchors, true);
  assert.strictEqual(overshootCase.dominantBottomWithinLocalTolerance, false);
  assert.strictEqual(overshootCase.dominantSidesWithinLocalTolerance, true);
  assert(overshootCase.dominantBottomOvershoot > 100);
  assert(approxEqual(overshootCase.localBottomBandY, (2368 + 2441) / 2));

  const stableCase = evaluateDominantEdgeQuadGuard({
    normalizedRefined: [
      [280, 191],
      [2256, 191],
      [2233, 3251],
      [280, 3251]
    ],
    edgeQuad: [
      [280, 191],
      [2257, 191],
      [2233, 3251],
      [280, 3251]
    ],
    cellWidth: 282,
    cellHeight: 278,
    projectedTopLeftAnchor: [280, 191],
    projectedTopRightAnchor: [2257, 191],
    projectedBottomLeftAnchor: [280, 3251],
    projectedBottomRightAnchor: [2233, 3251]
  });

  assert.strictEqual(stableCase.rejectProjectedTopAnchors, false);
  assert.strictEqual(stableCase.rejectProjectedBottomAnchors, false);
  assert.strictEqual(stableCase.dominantTopWithinLocalTolerance, true);
  assert.strictEqual(stableCase.dominantBottomWithinLocalTolerance, true);
  assert.strictEqual(stableCase.dominantSidesWithinLocalTolerance, true);

  console.log('guard tests passed');
}

run();
