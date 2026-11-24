'use strict';

const crypto = require('node:crypto');

function sanitizeDetail(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') {
    return detail
      .replace(/password[:=]\s*\S+/gi, 'password:[REDACTED]')
      .replace(/token[:=]\s*\S+/gi, 'token:[REDACTED]')
      .replace(/secret[:=]\s*\S+/gi, 'secret:[REDACTED]')
      .replace(/ticket[:=]\s*\S+/gi, 'ticket:[REDACTED]')
      .replace(/idToken[:=]\s*\S+/gi, 'idToken:[REDACTED]');
  }
  if (typeof detail === 'object') {
    if (Array.isArray(detail)) {
      return detail.map((item) => sanitizeDetail(item));
    }
    const copy = {};
    for (const [key, value] of Object.entries(detail)) {
      if (/password|token|secret|ticket|hash|idtoken/i.test(key)) {
        copy[key] = '[REDACTED]';
      } else if (value && typeof value === 'object') {
        copy[key] = sanitizeDetail(value);
      } else {
        copy[key] = value;
      }
    }
    return copy;
  }
  return String(detail);
}

function createTraceBuffer(capacity = 500) {
  const buffer = [];

  function record({ traceId, service, id, event, at = new Date().toISOString(), durationMs = null, detail = '' }) {
    if (!traceId || typeof traceId !== 'string') return null;
    const cleanTraceId = traceId.trim();
    if (!cleanTraceId) return null;

    const entry = {
      traceId: cleanTraceId,
      service: typeof service === 'string' ? service : 'unknown',
      id: typeof id === 'string' ? id : 'unknown',
      event: typeof event === 'string' ? event : 'unknown',
      at: typeof at === 'string' ? at : new Date(at).toISOString(),
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      detail: sanitizeDetail(detail)
    };

    if (buffer.length >= capacity) {
      buffer.shift();
    }
    buffer.push(entry);
    return entry;
  }

  function getTraces(traceId) {
    if (!traceId || typeof traceId !== 'string') return [];
    const clean = traceId.trim();
    return buffer
      .filter((entry) => entry.traceId === clean)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  function getRecentTraceIds(limit = 30) {
    const seen = new Set();
    const ids = [];
    for (let i = buffer.length - 1; i >= 0; i--) {
      const id = buffer[i].traceId;
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
        if (ids.length >= limit) break;
      }
    }
    return ids;
  }

  function size() {
    return buffer.length;
  }

  function clear() {
    buffer.length = 0;
  }

  return {
    record,
    getTraces,
    getRecentTraceIds,
    size,
    clear,
    capacity
  };
}

module.exports = { createTraceBuffer, sanitizeDetail };
