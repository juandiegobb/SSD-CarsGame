'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isLocalMode, resolveCoordinatorEndpoints } = require('../auth-client');

const coordinatorDirectory = path.join(__dirname, '..');

async function unusedPort(excluded = []) {
  let port;
  do {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
  } while (excluded.includes(port));
  return port;
}

test('isLocalMode detecta --local, LOCAL_MODE y COORDINATOR_MODE', () => {
  assert.equal(isLocalMode({}, ['node', 'index.js']), false);
  assert.equal(isLocalMode({}, ['node', 'index.js', '--local']), true);
  assert.equal(isLocalMode({ LOCAL_MODE: '1' }, []), true);
  assert.equal(isLocalMode({ LOCAL_MODE: 'true' }, []), true);
  assert.equal(isLocalMode({ COORDINATOR_MODE: 'local' }, []), true);
});

test('resolveCoordinatorEndpoints en modo local ignora URLs de ngrok sin alterar el modo normal', () => {
  const ngrokEnv = {
    PUBLIC_URL: 'wss://coord-ejemplo.ngrok-free.dev',
    AUTH_URLS: 'https://auth-a.ngrok-free.dev,https://auth-b.ngrok-free.dev',
    AUTH_URL: 'https://auth-a.ngrok-free.dev'
  };

  // Modo normal / ngrok conserva la configuración de .env
  const ngrokResolved = resolveCoordinatorEndpoints({
    env: ngrokEnv,
    argv: ['node', 'index.js'],
    port: 5000,
    peerPort: 6000
  });
  assert.equal(ngrokResolved.localMode, false);
  assert.equal(ngrokResolved.publicUrl, 'wss://coord-ejemplo.ngrok-free.dev');
  assert.equal(ngrokResolved.peerUrl, 'wss://coord-ejemplo.ngrok-free.dev');
  assert.deepEqual(ngrokResolved.authUrls, [
    'https://auth-a.ngrok-free.dev',
    'https://auth-b.ngrok-free.dev'
  ]);

  // Modo local ignora ngrok y usa localhost
  const localResolved = resolveCoordinatorEndpoints({
    env: ngrokEnv,
    argv: ['node', 'index.js', '--local'],
    port: 5000,
    peerPort: 6000
  });
  assert.equal(localResolved.localMode, true);
  assert.equal(localResolved.publicUrl, 'ws://localhost:5000');
  assert.equal(localResolved.peerUrl, 'ws://localhost:6000');
  assert.deepEqual(localResolved.authUrls, [
    'http://localhost:4001',
    'http://localhost:4002',
    'http://localhost:4003',
    'http://localhost:4000'
  ]);

  // Modo local respeta overrides LOCAL_*
  const customLocalResolved = resolveCoordinatorEndpoints({
    env: {
      ...ngrokEnv,
      LOCAL_MODE: '1',
      LOCAL_PUBLIC_URL: 'ws://localhost:5050',
      LOCAL_PEER_URL: 'ws://localhost:6050',
      LOCAL_AUTH_URLS: 'http://localhost:4000'
    },
    argv: [],
    port: 5050,
    peerPort: 6050
  });
  assert.equal(customLocalResolved.localMode, true);
  assert.equal(customLocalResolved.publicUrl, 'ws://localhost:5050');
  assert.equal(customLocalResolved.peerUrl, 'ws://localhost:6050');
  assert.deepEqual(customLocalResolved.authUrls, ['http://localhost:4000']);
});

test('coordinator --local anuncia ws://localhost y envía heartbeat al auth local aunque existan URLs de ngrok en env', async (t) => {
  let receivedHeartbeat = null;
  const authServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/heartbeat' && req.method === 'POST') {
        try { receivedHeartbeat = JSON.parse(body); } catch { /* ignorar */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, peers: [] }));
    });
  });
  await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => authServer.close(resolve)));
  const mockAuthPort = authServer.address().port;

  const port = await unusedPort();
  const peerPort = await unusedPort([port]);

  const child = spawn(process.execPath, ['index.js', '--local'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      COORDINATOR_SHARED_SECRET: 'test-coordinator-secret',
      COORDINATOR_ID: 'coord-local-test',
      COORDINATOR_NAME: 'CoordLocalTest',
      PORT: String(port),
      PEER_PORT: String(peerPort),
      // URLs de ngrok simuladas que deben ser ignoradas por --local
      PUBLIC_URL: 'wss://simulado.ngrok-free.dev',
      PEER_URL: 'wss://simulado.ngrok-free.dev',
      AUTH_URLS: 'https://simulado-auth.ngrok-free.dev',
      AUTH_URL: 'https://simulado-auth.ngrok-free.dev',
      LOCAL_AUTH_URLS: `http://127.0.0.1:${mockAuthPort}`
    },
    stdio: 'ignore'
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok && receivedHeartbeat) {
        ready = true;
        break;
      }
    } catch {
      // esperar arranque
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.ok(ready, 'El coordinador en --local debe arrancar y enviar heartbeat al auth local');
  assert.equal(receivedHeartbeat.coordinatorId, 'coord-local-test');
  assert.equal(receivedHeartbeat.publicUrl, `ws://localhost:${port}`);
  assert.equal(receivedHeartbeat.peerUrl, `ws://localhost:${peerPort}`);
});
