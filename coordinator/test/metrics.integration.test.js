'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

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

test('GET /metrics exposes HTTP, tick, player, WebSocket and replication metrics', async (t) => {
  const port = await unusedPort();
  const peerPort = await unusedPort([port]);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      COORDINATOR_SHARED_SECRET: 'test-coordinator-secret',
      COORDINATOR_ID: 'metrics-test',
      COORDINATOR_NAME: 'Prueba',
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

  async function getMetrics() {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(response.status, 200);
    return response.json();
  }

  let healthResponse;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
      break;
    } catch {
      if (child.exitCode !== null) throw new Error('El coordinador terminó antes de exponer /metrics.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(healthResponse, 'el coordinador inicia dentro del tiempo esperado');
  assert.equal(healthResponse.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 100));
  let metrics = await getMetrics();
  assert.equal(metrics.ok, true);
  assert.equal(typeof metrics.http.rps, 'number');
  assert.equal(typeof metrics.http.latencyMs.p50, 'number');
  assert.equal(typeof metrics.http.latencyMs.p95, 'number');
  assert.equal(typeof metrics.http.latencyMs.p99, 'number');
  assert.equal(metrics.ws.connections, 0);
  assert.equal(metrics.tick.configuredHz, 20);
  assert.ok(metrics.tick.effectiveHz > 0);
  assert.deepEqual(metrics.players, { local: 0, remote: 0 });
  assert.equal(metrics.spectators, 0);
  assert.equal(metrics.replication.intentLagMs.p50, null);
  assert.equal(metrics.replication.intentLagMs.p95, null);
  assert.deepEqual(metrics.replication.clockOffsetMs, {});

  const peerSocket = new WebSocket(`ws://127.0.0.1:${port}/mesh`);
  t.after(() => {
    if (peerSocket.readyState === WebSocket.OPEN) peerSocket.close();
  });
  let clockPingAnswered = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El mesh no intercambió el ping de reloj.')), 5000);
    peerSocket.once('open', () => {
      peerSocket.send(JSON.stringify({
        type: 'hello',
        coordinatorId: 'coord-a',
        coordinatorName: 'Peer de prueba'
      }));
    });
    peerSocket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type !== 'clock_ping' || clockPingAnswered) return;
      clockPingAnswered = true;
      const t1 = Date.now();
      const t2 = Date.now();
      peerSocket.send(JSON.stringify({
        type: 'clock_pong',
        origin: 'coord-a',
        t0: message.t0,
        t1,
        t2
      }));
      clearTimeout(timer);
      resolve();
    });
    peerSocket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const clockDeadline = Date.now() + 5000;
  do {
    metrics = await getMetrics();
    if (metrics.ws.connections === 1 && typeof metrics.replication.clockOffsetMs['coord-a'] === 'number') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < clockDeadline);
  assert.equal(metrics.ws.connections, 1);
  assert.equal(typeof metrics.replication.clockOffsetMs['coord-a'], 'number');

  peerSocket.send(JSON.stringify({
    type: 'player_joined',
    origin: 'coord-a',
    userId: 'remote-player',
    username: 'remoto',
    x: 100,
    y: 100,
    extras: {}
  }));
  peerSocket.send(JSON.stringify({
    type: 'intent_replicate',
    origin: 'coord-a',
    userId: 'remote-player',
    sentAt: Date.now() - 1000,
    intent: { dir: { x: 1, y: 0 } }
  }));
  const intentDeadline = Date.now() + 5000;
  do {
    metrics = await getMetrics();
    if (metrics.replication.intentLagMs.p50 !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < intentDeadline);
  assert.deepEqual(metrics.players, { local: 0, remote: 1 });
  assert.equal(typeof metrics.replication.intentLagMs.p50, 'number');
  assert.equal(typeof metrics.replication.intentLagMs.p95, 'number');
});
