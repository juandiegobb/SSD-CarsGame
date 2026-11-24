'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createTraceBuffer, sanitizeDetail } = require('../../shared/trace-buffer');

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('traceBuffer: circular buffer maintains max 500 entries and drops oldest', () => {
  const buffer = createTraceBuffer(500);
  for (let i = 0; i < 520; i++) {
    buffer.record({
      traceId: `trace-${i}`,
      service: 'auth',
      id: 'auth-test',
      event: 'test_event',
      at: new Date(Date.now() + i * 10).toISOString(),
      durationMs: i,
      detail: `item ${i}`
    });
  }

  assert.equal(buffer.size(), 500);
  // The first 20 (trace-0 to trace-19) should have been evicted
  assert.equal(buffer.getTraces('trace-0').length, 0);
  assert.equal(buffer.getTraces('trace-19').length, 0);
  // trace-20 to trace-519 exist
  assert.equal(buffer.getTraces('trace-20').length, 1);
  assert.equal(buffer.getTraces('trace-519').length, 1);
});

test('traceBuffer: sanitizeDetail redacts passwords, tokens and secrets', () => {
  const sanitizedString = sanitizeDetail('password: mysecretpassword token: myjwttoken secret: shh');
  assert.ok(!sanitizedString.includes('mysecretpassword'));
  assert.ok(!sanitizedString.includes('myjwttoken'));
  assert.ok(!sanitizedString.includes('shh'));
  assert.ok(sanitizedString.includes('[REDACTED]'));

  const sanitizedObject = sanitizeDetail({
    username: 'alice',
    password: 'rawpassword',
    token: 'jwt-12345',
    nested: { secret: 'topsecret' }
  });
  assert.equal(sanitizedObject.username, 'alice');
  assert.equal(sanitizedObject.password, '[REDACTED]');
  assert.equal(sanitizedObject.token, '[REDACTED]');
  assert.equal(sanitizedObject.nested.secret, '[REDACTED]');
});

test('traceBuffer: getTraces returns chronological entries or empty array for unknown traceId', () => {
  const buffer = createTraceBuffer(50);
  const t1 = new Date(1000).toISOString();
  const t2 = new Date(2000).toISOString();

  buffer.record({ traceId: 'trace-abc', service: 'auth', id: 'auth-1', event: 'event_2', at: t2, detail: 'second' });
  buffer.record({ traceId: 'trace-abc', service: 'auth', id: 'auth-1', event: 'event_1', at: t1, detail: 'first' });

  const traces = buffer.getTraces('trace-abc');
  assert.equal(traces.length, 2);
  assert.equal(traces[0].event, 'event_1');
  assert.equal(traces[1].event, 'event_2');

  assert.deepEqual(buffer.getTraces('trace-nonexistent'), []);
  assert.deepEqual(buffer.getTraces(''), []);
});

test('HTTP trace middleware and GET /traces/:traceId in auth-service', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-traces-test-'));
  const port = await unusedPort();
  const previousEnv = {
    PORT: process.env.PORT,
    DB_PATH: process.env.DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
    COORDINATOR_SHARED_SECRET: process.env.COORDINATOR_SHARED_SECRET,
    PEER_URL: process.env.PEER_URL,
    PUBLIC_URL: process.env.PUBLIC_URL,
    AUTH_PEERS: process.env.AUTH_PEERS,
    AUTH_ID: process.env.AUTH_ID
  };

  delete process.env.PEER_URL;
  delete process.env.PUBLIC_URL;
  delete process.env.AUTH_PEERS;
  delete process.env.AUTH_ID;

  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: path.join(tempDirectory, 'users.db'),
    JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
    COORDINATOR_SHARED_SECRET: 'test-coordinator-secret'
  });

  const service = require('../index');
  t.after(async () => {
    if (service.server.listening) {
      await new Promise((resolve) => service.server.close(resolve));
    }
    service.db.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    for (const [key, val] of Object.entries(previousEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  if (!service.server.listening) {
    await new Promise((resolve) => service.server.once('listening', resolve));
  }

  // 1. Request with custom x-trace-id
  const customTraceId = 'my-custom-trace-12345';
  const res1 = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { 'x-trace-id': customTraceId }
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.headers.get('x-trace-id'), customTraceId);

  // 2. Request without x-trace-id generates a UUID
  const res2 = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res2.status, 200);
  const genTraceId = res2.headers.get('x-trace-id');
  assert.ok(genTraceId, 'Debe devolver header x-trace-id');
  assert.ok(/^[0-9a-f-]{36}$/i.test(genTraceId), 'Debe ser formato UUID');

  // Small delay to allow 'finish' event to record in traceBuffer
  await new Promise((r) => setTimeout(r, 50));

  // 3. GET /traces/:traceId for existing trace
  const traceRes = await fetch(`http://127.0.0.1:${port}/traces/${customTraceId}`);
  assert.equal(traceRes.status, 200);
  const traceData = await traceRes.json();
  assert.equal(traceData.ok, true);
  assert.equal(traceData.traceId, customTraceId);
  assert.ok(Array.isArray(traceData.traces));
  assert.ok(traceData.traces.length >= 2, 'Debe tener al menos http_request y http_response');
  assert.equal(traceData.traces[0].event, 'http_request');
  assert.equal(traceData.traces[1].event, 'http_response');

  // 4. GET /traces/:traceId for non-existent trace
  const notFoundRes = await fetch(`http://127.0.0.1:${port}/traces/unknown-trace-9999`);
  assert.equal(notFoundRes.status, 404);
  const notFoundData = await notFoundRes.json();
  assert.equal(notFoundData.ok, false);
  assert.equal(notFoundData.code, 'TRACE_NOT_FOUND');
  assert.ok(notFoundData.message);
  assert.ok(notFoundData.hint);
});
