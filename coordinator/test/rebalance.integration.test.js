'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const coordinatorDirectory = path.join(__dirname, '..');
const jwtSecret = 'test-secret-with-more-than-thirty-two-characters';
const coordinatorSecret = 'test-coordinator-secret';

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function waitUntil(check, description, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Tiempo agotado esperando: ${description}`);
}

async function waitForHealth(port, process) {
  await waitUntil(async () => {
    if (process.exitCode !== null) throw new Error('El coordinador terminó antes de iniciar.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, `health en ${port}`);
}

async function readHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return response.ok ? response.json() : null;
}

async function requestTicket(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = await response.json();
  assert.equal(response.status, 200, payload.message || payload.code);
  return payload.ticket;
}

function createClient(userId) {
  const token = jwt.sign(
    { userId, username: `player${userId}`, provider: 'local' },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
  const client = {
    userId,
    token,
    socket: null,
    coordinatorId: null,
    history: [],
    migrationTarget: null,
    migrationSource: null,
    migrationPromise: null,
    async connect(publicUrl, coordinatorId) {
      const port = new URL(publicUrl).port;
      const ticket = await requestTicket(port, token);
      const socket = new WebSocket(`${publicUrl}/connect`, [
        'carsgame.v1',
        `auth.${ticket}`
      ]);
      await new Promise((resolve, reject) => {
        socket.once('open', () => {
          client.socket = socket;
          client.coordinatorId = coordinatorId;
          resolve();
        });
        socket.once('error', reject);
        socket.on('message', (raw) => {
          let message;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            return;
          }
          client.history.push({ message, at: Date.now(), coordinatorId });
          if (message.type === 'connected' && client.migrationTarget === coordinatorId) {
            socket.send(JSON.stringify({
              type: 'migration_ack',
              sourceCoordinatorId: client.migrationSource
            }));
          }
          if (message.type === 'migration_complete') {
            client.migrationTarget = null;
            client.migrationSource = null;
          }
          if (message.type === 'rebalance' && client.migrationTarget !== message.coordinatorId) {
            client.migrationTarget = message.coordinatorId;
            client.migrationSource = message.sourceCoordinatorId;
            client.migrationPromise = client.connect(message.publicUrl, message.coordinatorId);
            client.migrationPromise.catch(() => {
              client.migrationTarget = null;
              client.migrationSource = null;
            });
          }
        });
      });
    },
    send(message) {
      assert.ok(this.socket && this.socket.readyState === WebSocket.OPEN);
      this.socket.send(JSON.stringify(message));
    },
    close() {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
    }
  };
  return client;
}

function latestMessage(client, type, predicate = () => true, after = 0) {
  return [...client.history].reverse().find(({ message, at }) =>
    at >= after && message.type === type && predicate(message))?.message;
}

function latestEntry(client, type, predicate = () => true, coordinatorId = null) {
  return [...client.history].reverse().find((entry) =>
    entry.message.type === type &&
    predicate(entry.message) &&
    (!coordinatorId || entry.coordinatorId === coordinatorId));
}

function spawnCoordinator({ id, port, peerPort, authUrl, publicUrl }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      JWT_SECRET: jwtSecret,
      COORDINATOR_SHARED_SECRET: coordinatorSecret,
      COORDINATOR_ID: id,
      COORDINATOR_NAME: id,
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: publicUrl,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URL: authUrl,
      CLIENT_ORIGINS: 'http://localhost:3000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.output += chunk.toString(); });
  return child;
}

test('migra jugadores y mantiene sus salas y progreso al agregar un coordinador', async (t) => {
  const directory = new Map();
  const authServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/heartbeat') {
      if (req.headers['x-coordinator-secret'] !== coordinatorSecret) {
        sendJson(res, 401, { ok: false });
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const coordinator = JSON.parse(raw);
      directory.set(coordinator.coordinatorId, coordinator);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/peers') {
      const excludedId = url.searchParams.get('coordinatorId');
      const peers = [...directory.values()]
        .filter((entry) => entry.coordinatorId !== excludedId)
        .map(({ coordinatorId, coordinatorName, publicUrl, peerUrl }) => ({
          coordinatorId,
          coordinatorName,
          publicUrl,
          peerUrl
        }));
      sendJson(res, 200, { peers });
      return;
    }
    sendJson(res, 404, { ok: false });
  });
  await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  const authUrl = `http://127.0.0.1:${authServer.address().port}`;
  const players = [createClient('1'), createClient('2'), createClient('3')];
  const processes = [];

  t.after(async () => {
    for (const player of players) player.close();
    for (const process of processes) {
      if (process.exitCode === null) process.kill();
    }
    await new Promise((resolve) => authServer.close(resolve));
  });

  const portA = await unusedPort();
  const peerPortA = await unusedPort([portA]);
  const urlA = `ws://127.0.0.1:${portA}`;
  const coordinatorA = spawnCoordinator({
    id: 'coord-a',
    port: portA,
    peerPort: peerPortA,
    authUrl,
    publicUrl: urlA
  });
  processes.push(coordinatorA);
  await waitForHealth(portA, coordinatorA);

  for (const player of players) {
    await player.connect(urlA, 'coord-a');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await waitUntil(
    () => players.every((player) => latestMessage(player, 'connected')),
    'las conexiones iniciales'
  );

  players[0].send({ type: 'room_create', name: 'Sala de prueba' });
  await waitUntil(() => latestMessage(players[0], 'room_created'), 'crear la sala');
  const roomId = latestMessage(players[0], 'room_created').roomId;
  for (const player of players.slice(1)) {
    player.send({ type: 'room_join', roomId });
    await waitUntil(
      () => latestMessage(player, 'room_joined', (message) => message.roomId === roomId),
      'unir jugadores a la sala'
    );
  }
  players[0].send({ type: 'game_start' });
  await waitUntil(
    () => players.every((player) => latestMessage(
      player,
      'game_started',
      (message) => message.roomId === roomId
    )),
    'iniciar la carrera'
  );
  await waitUntil(
    () => players.every((player) => latestEntry(
      player,
      'state',
      (message) => message.players?.some((entry) => entry.userId === player.userId)
    )),
    'recibir el estado inicial de los jugadores'
  );
  const positionsBeforeMigration = new Map(players.map((player) => {
    const state = latestEntry(
      player,
      'state',
      (message) => message.players?.some((entry) => entry.userId === player.userId)
    ).message;
    const position = state.players.find((entry) => entry.userId === player.userId);
    return [player.userId, { x: position.x, y: position.y }];
  }));

  const portB = await unusedPort();
  const peerPortB = await unusedPort();
  const urlB = `ws://127.0.0.1:${portB}`;
  const migrationStartedAt = Date.now();
  const coordinatorB = spawnCoordinator({
    id: 'coord-b',
    port: portB,
    peerPort: peerPortB,
    authUrl,
    publicUrl: urlB
  });
  processes.push(coordinatorB);
  await waitForHealth(portB, coordinatorB);
  await waitUntil(async () => {
    const [healthA, healthB] = await Promise.all([
      readHealth(portA),
      readHealth(portB)
    ]);
    return healthA?.mesh?.connectedPeerIds.includes('coord-b') &&
      healthB?.mesh?.connectedPeerIds.includes('coord-a');
  }, 'confirmar el enlace mesh en ambos coordinadores');

  try {
    await waitUntil(
      () => players.filter((player) => player.coordinatorId === 'coord-b').length === 1,
      'distribuir los tres jugadores entre ambos coordinadores'
    );
  } catch (error) {
    const assignments = players.map((player) => ({
      userId: player.userId,
      coordinatorId: player.coordinatorId,
      messages: [...new Set(player.history.map(({ message }) => message.type))]
    }));
    throw new Error(`${error.message}; asignaciones=${JSON.stringify(assignments)}; auth=${JSON.stringify([...directory.values()])}; logs=${processes.map((process) => process.output).join('\n')}`);
  }
  await waitUntil(
    () => [...directory.values()].some((entry) => entry.connectedPlayers === 2) &&
      [...directory.values()].some((entry) => entry.connectedPlayers === 1),
    'actualizar las cargas de los coordinadores'
  );
  for (const player of players.filter((entry) => entry.coordinatorId === 'coord-b')) {
    await waitUntil(
      () => latestEntry(
        player,
        'state',
        (message) => message.players?.some((entry) => entry.userId === player.userId),
        'coord-b'
      ),
      `recibir el estado de ${player.userId} en el destino`
    );
    const restoredRoom = latestMessage(
      player,
      'room_joined',
      (message) => message.roomId === roomId && message.status === 'playing',
      migrationStartedAt
    );
    assert.ok(restoredRoom, `No se restauró la sala del jugador ${player.userId}.`);
    assert.equal(restoredRoom.race.level, 1);
    assert.ok(['countdown', 'racing'].includes(restoredRoom.race.phase));
    const migratedState = latestEntry(
      player,
      'state',
      (message) => message.players?.some((entry) => entry.userId === player.userId),
      'coord-b'
    )?.message;
    assert.ok(migratedState, `No se recibió el estado del jugador ${player.userId} en el destino.`);
    const migratedPosition = migratedState.players.find((entry) => entry.userId === player.userId);
    const previousPosition = positionsBeforeMigration.get(player.userId);
    assert.ok(Math.abs(migratedPosition.x - previousPosition.x) < 5);
    assert.ok(Math.abs(migratedPosition.y - previousPosition.y) < 5);
  }

  const expectedUserIds = players.map((player) => player.userId);
  const rosterRequestedAt = Date.now();
  for (const player of players) player.send({ type: 'who' });
  await waitUntil(
    () => players.every((player) => latestMessage(
      player,
      'players_update',
      (message) => expectedUserIds.every((userId) =>
        message.players.some((entry) => entry.userId === userId)),
      rosterRequestedAt
    )),
    'mostrar a todos los jugadores en todos los coordinadores'
  );

  const sharedRoomListRequestedAt = Date.now();
  for (const player of players) player.send({ type: 'room_list' });
  await waitUntil(
    () => players.every((player) => latestMessage(
      player,
      'room_list',
      (message) => message.rooms.some((room) => room.roomId === roomId),
      sharedRoomListRequestedAt
    )),
    'mostrar la misma sala en todos los coordinadores'
  );

  const leaveRequestedAt = Date.now();
  for (const player of players) {
    player.send({ type: 'room_leave' });
    await waitUntil(
      () => latestMessage(player, 'room_left', () => true, leaveRequestedAt),
      `salir de la sala desde ${player.userId}`
    );
  }
  const emptyRoomListRequestedAt = Date.now();
  for (const player of players) player.send({ type: 'room_list' });
  await waitUntil(
    () => players.every((player) => latestMessage(
      player,
      'room_list',
      (message) => message.rooms.every((room) => room.roomId !== roomId),
      emptyRoomListRequestedAt
    )),
    'sincronizar la eliminación de la sala en todos los coordinadores'
  );

  const host = players.find((player) => player.coordinatorId === 'coord-b');
  assert.ok(host, 'Debe haber un jugador conectado al segundo coordinador.');
  const createRoomAt = Date.now();
  host.send({ type: 'room_create', name: 'Sala desde coord-b' });
  await waitUntil(
    () => latestMessage(host, 'room_created', () => true, createRoomAt),
    'crear una sala desde el segundo coordinador'
  );
  const sharedRoomId = latestMessage(host, 'room_created', () => true, createRoomAt).roomId;
  await waitUntil(
    () => players.filter((player) => player !== host).every((player) => latestMessage(
      player,
      'room_list',
      (message) => message.rooms.some((room) => room.roomId === sharedRoomId),
      createRoomAt
    )),
    'propagar la nueva sala a los otros coordinadores'
  );

  const joinRequestedAt = Date.now();
  for (const player of players.filter((entry) => entry !== host)) {
    player.send({ type: 'room_join', roomId: sharedRoomId });
    await waitUntil(
      () => latestMessage(
        player,
        'room_joined',
        (message) => message.roomId === sharedRoomId,
        joinRequestedAt
      ),
      `unir al jugador ${player.userId} a una sala de otro coordinador`
    );
  }
  const gameStartedAt = Date.now();
  host.send({ type: 'game_start' });
  await waitUntil(
    () => players.every((player) => latestMessage(
      player,
      'game_started',
      (message) => message.roomId === sharedRoomId,
      gameStartedAt
    )),
    'iniciar una partida con jugadores conectados a distintos coordinadores'
  );
  await waitUntil(
    () => players.every((player) => latestMessage(
      player,
      'state',
      (message) => expectedUserIds.every((userId) =>
        message.players.some((entry) => entry.userId === userId)),
      gameStartedAt
    )),
    'mostrar a todos los jugadores en la misma partida distribuida'
  );
});
