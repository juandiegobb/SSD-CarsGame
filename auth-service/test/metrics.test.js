'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRollingSamples, percentile } = require('../../shared/rolling-samples');

test('rolling samples expire values outside the window', () => {
  let now = 0;
  const samples = createRollingSamples(100, () => now);
  samples.record(12);
  assert.deepEqual(samples.values(), [12]);

  now = 101;
  assert.deepEqual(samples.values(), []);
});

test('percentile uses nearest-rank and returns null for an empty window', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});
