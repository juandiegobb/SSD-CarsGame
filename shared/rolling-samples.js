'use strict';

const { performance } = require('node:perf_hooks');

function createRollingSamples(windowMs = 60_000, now = () => performance.now()) {
  const samples = [];

  function prune(at = now()) {
    const cutoff = at - windowMs;
    while (samples.length > 0 && samples[0].at < cutoff) samples.shift();
  }

  function record(value, at = now()) {
    if (!Number.isFinite(value) || !Number.isFinite(at)) return;
    samples.push({ at, value });
    prune(at);
  }

  function values(at = now()) {
    prune(at);
    return samples.filter((sample) => sample.at <= at).map((sample) => sample.value);
  }

  return { record, values };
}

function percentile(values, percentileRank) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileRank * sorted.length) - 1);
  return sorted[index];
}

module.exports = { createRollingSamples, percentile };
