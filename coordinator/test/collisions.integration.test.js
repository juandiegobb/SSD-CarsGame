'use strict';

// Choques de verdad (SPEC §14.4): un coordinador real, dos carros en la misma carrera que
// aceleran uno contra el otro. En ningún `state` que mande el servidor quedan encimados.

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
const PLAYER_RADIUS = 20;

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitUntil(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Tiempo agotado esperando: ${description}`);
}

async function connectPlayer(port, userId) {
  const token = jwt.sign({ userId, username: `p${userId}`, provider: 'local' }, jwtSecret, { expiresIn: '1h' });
  const response = await fetch(`http://127.0.0.1:${port}/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  const { ticket } = await response.json();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/connect`, ['carsgame.v1', `auth.${ticket}`]);
  const player = { userId, socket, messages: [] };
  socket.on('message', (raw) => {
    try { player.messages.push(JSON.parse(raw.toString())); } catch { /* ignorar */ }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  player.send = (message) => socket.send(JSON.stringify(message));
  player.last = (type) => [...player.messages].reverse().find((message) => message.type === type);
  return player;
}

test('dos carros que aceleran uno contra el otro nunca quedan encimados', async (t) => {
  // Auth falso: solo acepta heartbeats y no tiene peers
  const authServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/peers') ? { peers: [] } : { ok: true }));
  });
  await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  const authUrl = `http://127.0.0.1:${authServer.address().port}`;

  const port = await unusedPort();
  const peerPort = await unusedPort();
  const child = spawn(process.execPath, ['index.js'], {
    cwd: coordinatorDirectory,
    env: {
      ...process.env,
      SKIP_DOTENV: '1',
      JWT_SECRET: jwtSecret,
      COORDINATOR_SHARED_SECRET: coordinatorSecret,
      COORDINATOR_ID: 'coord-choques',
      COORDINATOR_NAME: 'Choques',
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: `ws://127.0.0.1:${port}`,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URLS: authUrl,
      CLIENT_ORIGINS: 'http://localhost:3000'
    },
    stdio: 'ignore'
  });
  const players = [];
  t.after(async () => {
    for (const player of players) player.socket.close();
    child.kill();
    await new Promise((resolve) => authServer.close(resolve));
  });

  await waitUntil(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
  }, 'que arranque el coordinador');

  players.push(await connectPlayer(port, '1'), await connectPlayer(port, '2'));
  const [host, guest] = players;
  host.send({ type: 'room_create', name: 'Choques' });
  await waitUntil(() => host.last('room_created'), 'crear la sala');
  guest.send({ type: 'room_join', roomId: host.last('room_created').roomId });
  await waitUntil(() => guest.last('room_joined'), 'unirse a la sala');
  host.send({ type: 'game_start' });

  // Esperar el verde del semáforo (6 s)
  await waitUntil(() => host.last('state')?.race?.phase === 'racing', 'el verde del semáforo', 20_000);

  // Cada uno acelera hacia el otro durante 2 s
  const positionsOf = (state) => Object.fromEntries(state.players.map((p) => [p.userId, p]));
  const start = positionsOf(host.last('state'));
  const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
  const towards = (from, to) => ({ x: sign(to.x - from.x), y: sign(to.y - from.y) });
  const statesBefore = host.messages.length;
  const push = setInterval(() => {
    host.send({ type: 'intent', intent: { dir: towards(start['1'], start['2']) } });
    guest.send({ type: 'intent', intent: { dir: towards(start['2'], start['1']) } });
  }, 50);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  clearInterval(push);

  const states = host.messages.slice(statesBefore).filter((message) => message.type === 'state');
  assert.ok(states.length > 20, `llegaron ${states.length} estados`);
  let closest = Infinity;
  for (const state of states) {
    const positions = positionsOf(state);
    if (!positions['1'] || !positions['2']) continue;
    closest = Math.min(closest, Math.hypot(positions['1'].x - positions['2'].x, positions['1'].y - positions['2'].y));
  }
  // El servidor redondea las posiciones a 0,1 px
  assert.ok(closest >= 2 * PLAYER_RADIUS - 0.5, `los carros quedaron a ${closest.toFixed(1)} px (mínimo ${2 * PLAYER_RADIUS})`);
  const end = positionsOf(states.at(-1));
  const moved = Math.hypot(end['1'].x - start['1'].x, end['1'].y - start['1'].y);
  assert.ok(moved > 0, 'el carro sí se movió (no quedó congelado)');
});
