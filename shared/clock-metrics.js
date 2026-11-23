'use strict';

function calculateClockEstimate(t0, t1, t2, t3) {
  if (![t0, t1, t2, t3].every(Number.isFinite)) return null;
  const rttMs = (t3 - t0) - (t2 - t1);
  if (rttMs < 0) return null;
  return {
    offsetMs: ((t1 - t0) + (t2 - t3)) / 2,
    rttMs
  };
}

function correctedIntentLatency(sentAt, receivedAt, offsetMs) {
  if (![sentAt, receivedAt, offsetMs].every(Number.isFinite)) return null;
  const latencyMs = receivedAt - (sentAt - offsetMs);
  return latencyMs >= 0 ? latencyMs : null;
}

module.exports = { calculateClockEstimate, correctedIntentLatency };
