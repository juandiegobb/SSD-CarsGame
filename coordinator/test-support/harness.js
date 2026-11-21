'use strict';

// Ayudas para las pruebas integradas del juego: levanta un coordinador real (con un auth
// falso que acepta heartbeats) y conecta jugadores con su JWT y ticket, como el cliente.
// Está fuera de test/ para que node --test no lo corra como una prueba.

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const coordinatorDirectory = path.join(__dirname, '..');
const jwtSecret = 'test-secret-with-more-than-thirty-two-characters';
const coordinatorSecret = 'test-coordinator-secret';

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

// Devuelve { port, stop() }. stop() apaga el coordinador y el auth falso.
async function startCoordinator(id = 'coord-prueba') {
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
      COORDINATOR_ID: id,
      COORDINATOR_NAME: id,
      PORT: String(port),
      PEER_PORT: String(peerPort),
      PUBLIC_URL: `ws://127.0.0.1:${port}`,
      PEER_URL: `ws://127.0.0.1:${peerPort}`,
      AUTH_URLS: authUrl,
      CLIENT_ORIGINS: 'http://localhost:3000'
    },
    stdio: 'ignore'
  });
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error('El coordinador terminó al arrancar.');
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
  }, 'que arranque el coordinador');
  return {
    port,
    async stop() {
      child.kill();
      await new Promise((resolve) => authServer.close(resolve));
    }
  };
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
  player.close = () => socket.close();
  return player;
}

// Crea una sala con el primer jugador, une a los demás e inicia la carrera.
// Espera el verde del semáforo y devuelve el último state.
async function startRace(players) {
  const [host, ...guests] = players;
  host.send({ type: 'room_create', name: 'Prueba' });
  await waitUntil(() => host.last('room_created'), 'crear la sala');
  for (const guest of guests) {
    guest.send({ type: 'room_join', roomId: host.last('room_created').roomId });
    await waitUntil(() => guest.last('room_joined'), 'unirse a la sala');
  }
  host.send({ type: 'game_start' });
  await waitUntil(() => host.last('state')?.race?.phase === 'racing', 'el verde del semáforo', 20_000);
  return host.last('state');
}

module.exports = { startCoordinator, connectPlayer, startRace, waitUntil };
