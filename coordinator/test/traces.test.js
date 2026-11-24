'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { createTraceBuffer } = require('../../shared/trace-buffer');

const coordinatorDirectory = path.join(__dirname, '..');

async function unusedPort(excludedPorts = []) {
  let port;
  do {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
  } while (excludedPorts.includes(port));
  return port;
}

test('coordinator: circular buffer caps at 500 and drops oldest entries', () => {
  const buffer = createTraceBuffer(500);
  for (let i = 0; i < 510; i++) {
    buffer.record({
      traceId: `coord-trace-${i}`,
      service: 'coordinator',
      id: 'coord-test',
      event: 'test_event',
      at: new Date(Date.now() + i * 5).toISOString(),
      durationMs: null,
      detail: `event ${i}`
    });
  }

  assert.equal(buffer.size(), 500);
  assert.equal(buffer.getTraces('coord-trace-0').length, 0);
  assert.equal(buffer.getTraces('coord-trace-9').length, 0);
  assert.equal(buffer.getTraces('coord-trace-10').length, 1);
  assert.equal(buffer.getTraces('coord-trace-509').length, 1);
});

test('coordinator: HTTP traceId propagation, GET /traces/:traceId and 404', async (t) => {
  const port = await unusedPort();
  const peerPort = await unusedPort([port]);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      COORDINATOR_SHARED_SECRET: 'test-coordinator-secret',
      COORDINATOR_ID: 'traces-test-coord',
      COORDINATOR_NAME: 'PruebaTraces',
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: `ws://127.0.0.1:${port}`,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URL: 'http://127.0.0.1:1',
      AUTH_URLS: 'http://127.0.0.1:1'
    },
    stdio: 'ignore'
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  // Wait until server is listening
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(ready, 'El coordinador debe arrancar y responder /health');

  // 1. Request with custom x-trace-id
  const testTraceId = 'coordinator-trace-999';
  const res1 = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { 'x-trace-id': testTraceId }
  });
  assert.equal(res1.status, 200);
  assert.equal(res1.headers.get('x-trace-id'), testTraceId);

  // 2. Request without x-trace-id generates one
  const res2 = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res2.status, 200);
  const genTraceId = res2.headers.get('x-trace-id');
  assert.ok(genTraceId, 'Debe devolver x-trace-id');
  assert.ok(/^[0-9a-f-]{36}$/i.test(genTraceId));

  await new Promise((r) => setTimeout(r, 50));

  // 3. GET /traces/:traceId for existing trace
  const traceRes = await fetch(`http://127.0.0.1:${port}/traces/${testTraceId}`);
  assert.equal(traceRes.status, 200);
  const traceData = await traceRes.json();
  assert.equal(traceData.ok, true);
  assert.equal(traceData.traceId, testTraceId);
  assert.ok(Array.isArray(traceData.traces));
  assert.ok(traceData.traces.length >= 2);
  assert.equal(traceData.traces[0].service, 'coordinator');
  assert.equal(traceData.traces[0].id, 'traces-test-coord');

  // 4. GET /traces/:traceId for non-existent trace returns 404
  const notFoundRes = await fetch(`http://127.0.0.1:${port}/traces/non-existent-trace-id`);
  assert.equal(notFoundRes.status, 404);
  const notFoundData = await notFoundRes.json();
  assert.equal(notFoundData.ok, false);
  assert.equal(notFoundData.code, 'TRACE_NOT_FOUND');
  assert.ok(notFoundData.hint);
});

test('coordinator: WS peer messages accept messages with and without traceId', async (t) => {
  const port = await unusedPort();
  const peerPort = await unusedPort([port]);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      COORDINATOR_SHARED_SECRET: 'test-coordinator-secret',
      COORDINATOR_ID: 'coord-ws-test',
      COORDINATOR_NAME: 'WsTest',
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: `ws://127.0.0.1:${port}`,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URL: 'http://127.0.0.1:1',
      AUTH_URLS: 'http://127.0.0.1:1'
    },
    stdio: 'ignore'
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  // Wait until server is listening
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Connect to peer mesh endpoint
  const ws = new WebSocket(`ws://127.0.0.1:${port}/mesh`);
  t.after(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // Send hello from peer with ID lexicographically lower than COORDINATOR_ID ('coord-ws-test')
  // so that initiatedLocally === false is accepted by the tie-breaking logic.
  ws.send(JSON.stringify({
    type: 'hello',
    coordinatorId: 'aaa-peer',
    coordinatorName: 'PeerSim',
    publicUrl: 'ws://127.0.0.1:9999',
    peerUrl: 'ws://127.0.0.1:9998'
  }));

  await new Promise((r) => setTimeout(r, 100));

  // 1. Send room_replicate WITH traceId
  const traceWithId = 'trace-room-with-id-111';
  ws.send(JSON.stringify({
    type: 'room_replicate',
    origin: 'aaa-peer',
    op: 'create',
    roomId: 'room-test-1',
    traceId: traceWithId,
    room: {
      roomId: 'room-test-1',
      name: 'Sala Test',
      hostUserId: 'user-host',
      status: 'waiting',
      owner: 'aaa-peer',
      members: [{
        userId: 'user-host',
        username: 'HostUser',
        x: 100,
        y: 100,
        home: 'aaa-peer',
        extras: { color: '#ffffff' }
      }]
    }
  }));

  // 2. Send room_replicate WITHOUT traceId (backward compatibility)
  ws.send(JSON.stringify({
    type: 'room_replicate',
    origin: 'aaa-peer',
    op: 'create',
    roomId: 'room-test-2',
    room: {
      roomId: 'room-test-2',
      name: 'Sala Test 2',
      hostUserId: 'user-host-2',
      status: 'waiting',
      owner: 'aaa-peer',
      members: [{
        userId: 'user-host-2',
        username: 'HostUser2',
        x: 120,
        y: 120,
        home: 'aaa-peer',
        extras: { color: '#00ff00' }
      }]
    }
  }));

  await new Promise((r) => setTimeout(r, 100));

  // The coordinator should have recorded trace for traceWithId
  const traceRes = await fetch(`http://127.0.0.1:${port}/traces/${traceWithId}`);
  assert.equal(traceRes.status, 200);
  const traceJson = await traceRes.json();
  assert.equal(traceJson.ok, true);
  assert.ok(traceJson.traces.some((t) => t.event === 'room_replicate_recv'));

  // Coordinator is still healthy and running
  const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthRes.status, 200);
});
