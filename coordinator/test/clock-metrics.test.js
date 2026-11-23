'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateClockEstimate, correctedIntentLatency } = require('../../shared/clock-metrics');

test('NTP ping-pong estimates peer clock offset and network round trip', () => {
  assert.deepEqual(calculateClockEstimate(10_000, 10_280, 10_282, 10_062), {
    offsetMs: 250,
    rttMs: 60
  });
  assert.equal(calculateClockEstimate(10, 5, 6, 9), null, 'descarta una estimación con RTT negativo');
});

test('intent latency converts the remote timestamp and drops negative results', () => {
  assert.equal(correctedIntentLatency(10_262, 10_012, 250), 0);
  assert.equal(correctedIntentLatency(10_263, 10_012, 250), null);
});
