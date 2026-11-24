'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const coordinatorDirectory = require('node:path').join(__dirname, '..');
const { startCoordinator, connectPlayer, waitUntil } = require('../test-support/harness');

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

function waitFor(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(`Tiempo agotado esperando: ${description}`));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  });
}

test('espectadores se conectan sin login, reciben room_list y no cambian el balanceo', { timeout: 30_000 }, async (t) => {
  const port = await unusedPort();
  const peerPort = await unusedPort([port]);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      COORDINATOR_SHARED_SECRET: 'test-coordinator-secret',
      COORDINATOR_ID: 'spectator-test',
      COORDINATOR_NAME: 'Espectadores',
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: `ws://127.0.0.1:${port}`,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URL: 'http://127.0.0.1:1',
      AUTH_URLS: 'http://127.0.0.1:1',
      MAX_SPECTATORS: '50'
    },
    stdio: 'ignore'
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const spectator = new WebSocket(`ws://127.0.0.1:${port}/spectate`);
  t.after(() => spectator.readyState === WebSocket.OPEN && spectator.close());
  const received = [];
  spectator.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    spectator.once('open', resolve);
    spectator.once('error', reject);
  });

  await waitFor(() => received.some((message) => message.type === 'room_list'), 'recibir room_list');
  const firstMessage = received.find((message) => message.type === 'connected');
  assert.equal(firstMessage.type, 'connected');
  assert.equal(firstMessage.spectating, true);

  const roomList = received.find((message) => message.type === 'room_list');
  assert.equal(roomList.type, 'room_list');
  assert.ok(Array.isArray(roomList.rooms));

  spectator.send('texto-no-json');
  await waitFor(
    () => received.some((message) => message.type === 'error' && message.code === 'INVALID_JSON'),
    'recibir INVALID_JSON'
  );
  const invalidMessage = received.find((message) => message.type === 'error');
  assert.equal(invalidMessage.code, 'INVALID_JSON');
  spectator.send(JSON.stringify({ type: 'intent', intent: { dir: { x: 1, y: 0 } } }));
  spectator.send(JSON.stringify({ type: 'ping' }));
  await waitFor(() => received.some((message) => message.type === 'pong'), 'recibir pong');
  const subsequent = received.find((message) => message.type === 'pong');
  assert.equal(subsequent.type, 'pong');

  const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
  assert.equal(metrics.spectators, 1);
  assert.deepEqual(metrics.players, { local: 0, remote: 0 });
  assert.ok(metrics.spectatorMessagesRejected >= 1);
});

test('el límite de espectadores rechaza una conexión adicional y libera el cupo', { timeout: 30_000 }, async (t) => {
  const port = await unusedPort();
  const peerPort = await unusedPort([port]);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      COORDINATOR_SHARED_SECRET: 'test-coordinator-secret',
      COORDINATOR_ID: 'spectator-limit-test',
      COORDINATOR_NAME: 'Límite',
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: `ws://127.0.0.1:${port}`,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URL: 'http://127.0.0.1:1',
      AUTH_URLS: 'http://127.0.0.1:1',
      MAX_SPECTATORS: '1'
    },
    stdio: 'ignore'
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const first = new WebSocket(`ws://127.0.0.1:${port}/spectate`);
  await new Promise((resolve, reject) => {
    first.once('open', resolve);
    first.once('error', reject);
  });

  const second = new WebSocket(`ws://127.0.0.1:${port}/spectate`);
  const rejectionPromise = new Promise((resolve, reject) => {
    let payload;
    let closeCode = null;
    const finish = () => {
      if (payload && closeCode !== null) resolve({ payload, closeCode });
    };
    second.once('message', (raw) => {
      payload = JSON.parse(raw.toString());
      finish();
    });
    second.once('close', (code) => {
      closeCode = code;
      finish();
    });
    second.once('error', reject);
  });
  const { payload, closeCode } = await rejectionPromise;
  assert.equal(payload.type, 'spectate_full');
  assert.equal(closeCode, 4503);

  const firstClosed = new Promise((resolve) => first.once('close', resolve));
  first.close();
  await firstClosed;

  const third = new WebSocket(`ws://127.0.0.1:${port}/spectate`);
  await new Promise((resolve, reject) => {
    third.once('open', resolve);
    third.once('error', reject);
  });
  third.close();
});

test('50 espectadores simultáneos se mantienen fuera del conteo de jugadores y balanceo', { timeout: 30_000 }, async (t) => {
  const port = await unusedPort();
  const peerPort = await unusedPort([port]);
  const heartbeatLoads = [];
  const authServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/heartbeat' && req.method === 'POST') {
        heartbeatLoads.push(JSON.parse(body));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, coordinators: [] }));
    });
  });
  await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  const authPort = authServer.address().port;
  t.after(() => new Promise((resolve) => authServer.close(resolve)));

  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      COORDINATOR_SHARED_SECRET: 'test-coordinator-secret',
      COORDINATOR_ID: 'spectator-fifty-test',
      COORDINATOR_NAME: 'Cincuenta',
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: `ws://127.0.0.1:${port}`,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URL: `http://127.0.0.1:${authPort}`,
      AUTH_URLS: `http://127.0.0.1:${authPort}`,
      MAX_SPECTATORS: '50'
    },
    stdio: 'ignore'
  });
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  const readyDeadline = Date.now() + 10_000;
  let healthResponse;
  while (Date.now() < readyDeadline) {
    try {
      healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
      if (healthResponse.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(healthResponse?.ok, 'el coordinador inició');

  function connectSpectator() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/spectate`);
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tiempo agotado al conectar espectador.')), 10_000);
      socket.once('open', () => {
        clearTimeout(timeout);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  const firstFifty = await Promise.all(Array.from({ length: 50 }, connectSpectator));
  assert.ok(firstFifty.every((socket) => socket.readyState === WebSocket.OPEN));

  const fiftyFirst = new WebSocket(`ws://127.0.0.1:${port}/spectate`);
  sockets.push(fiftyFirst);
  const fiftyFirstClose = new Promise((resolve) => {
    fiftyFirst.once('close', resolve);
  });
  const rejection = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('El espectador 51 no fue rechazado a tiempo.')), 10_000);
    fiftyFirst.once('message', (raw) => {
      clearTimeout(timeout);
      resolve(JSON.parse(raw.toString()));
    });
    fiftyFirst.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  assert.equal(rejection.type, 'spectate_full');
  assert.equal(await fiftyFirstClose, 4503);
  assert.ok(firstFifty.every((socket) => socket.readyState === WebSocket.OPEN));

  const playerListResponse = await fetch(`http://127.0.0.1:${port}/players`);
  const playerList = await playerListResponse.json();
  assert.equal(playerList.count, 0);
  assert.deepEqual(playerList.players, []);

  const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
  const metrics = await metricsResponse.json();
  assert.equal(metrics.spectators, 50);
  assert.equal(metrics.ws.connections, 50);
  assert.deepEqual(metrics.players, { local: 0, remote: 0 });

  await waitFor(
    () => heartbeatLoads.some((heartbeat) => heartbeat.connectedPlayers === 0 && heartbeat.load === 0),
    'heartbeat con cero jugadores pese a 50 espectadores'
  );

  const released = firstFifty[0];
  const releasedPromise = new Promise((resolve) => released.once('close', resolve));
  released.close();
  await releasedPromise;

  const replacement = await connectSpectator();
  assert.equal(replacement.readyState, WebSocket.OPEN);
  assert.ok(firstFifty.slice(1).every((socket) => socket.readyState === WebSocket.OPEN));
  const afterReplacement = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
  assert.equal(afterReplacement.spectators, 50);
});

test('watch usa el roomId real, recibe estados y no aplica intents del espectador', { timeout: 30_000 }, async (t) => {
  const coordinator = await startCoordinator('spectator-room-test');
  const player = await connectPlayer(coordinator.port, 'watch-owner');
  const spectator = new WebSocket(`ws://127.0.0.1:${coordinator.port}/spectate`);
  const messages = [];
  spectator.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  t.after(async () => {
    spectator.close();
    player.close();
    await coordinator.stop();
  });
  await new Promise((resolve, reject) => {
    spectator.once('open', resolve);
    spectator.once('error', reject);
  });

  player.send({ type: 'room_create', name: 'Sala de prueba' });
  await waitUntil(() => player.last('room_created'), 'crear sala para el espectador');
  const roomId = player.last('room_created').roomId;
  assert.equal(typeof roomId, 'string');

  spectator.send(JSON.stringify({ type: 'watch', roomId }));
  await waitUntil(
    () => messages.some((message) => message.type === 'state' && message.players?.some((entry) => entry.userId === 'watch-owner')),
    'recibir el estado de la sala seleccionada'
  );
  const initialState = messages.filter((message) => message.type === 'state').at(-1);
  const playerState = initialState.players.find((entry) => entry.userId === 'watch-owner');
  spectator.send(JSON.stringify({ type: 'intent', intent: { dir: { x: 1, y: 0 } } }));
  await waitUntil(
    () => messages.filter((message) => message.type === 'state').at(-1) !== initialState,
    'recibir un tick posterior al intent rechazado'
  );
  const nextPlayerState = messages.filter((message) => message.type === 'state').at(-1).players
    .find((entry) => entry.userId === 'watch-owner');
  assert.deepEqual([nextPlayerState.x, nextPlayerState.y], [playerState.x, playerState.y]);

  player.send({ type: 'room_leave' });
  await waitUntil(
    () => messages.some((message) => message.type === 'room_list' && !message.rooms.some((room) => room.roomId === roomId)),
    'retornar al lobby al desaparecer la sala'
  );
});
