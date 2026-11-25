'use strict';

// Caída del coordinador PROPIETARIO de una sala en plena carrera (SPEC §14.4).
// coord-b es el dueño (ahí se creó la sala) y coord-a tiene al otro jugador. Se apaga
// coord-b: coord-a (el vivo de ID más bajo) adopta la sala y la carrera sigue contando
// vueltas, así que su jugador puede terminar el nivel.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const RaceTracks = require('../../shared/tracks');
const { connectPlayer, waitUntil, driveLap } = require('../test-support/harness');

const jwtSecret = 'test-secret-with-more-than-thirty-two-characters';
const coordinatorSecret = 'test-coordinator-secret';

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function spawnCoordinator(id, port, peerPort, authUrl) {
  return spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
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
      CLIENT_ORIGINS: 'http://localhost:3000',
      RACE_LAPS_PER_LEVEL: '1'
    },
    stdio: 'ignore'
  });
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

test('si cae el coordinador dueño de la sala, otro la adopta y la carrera sigue', async (t) => {
  // Auth falso con directorio de coordinadores (heartbeat + peers)
  const directory = new Map();
  const authServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/heartbeat') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const coordinator = JSON.parse(raw);
      directory.set(coordinator.coordinatorId, { ...coordinator, at: Date.now() });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/peers') {
      const excluded = url.searchParams.get('coordinatorId');
      const peers = [...directory.values()]
        .filter((entry) => entry.coordinatorId !== excluded && Date.now() - entry.at < 3000)
        .map(({ coordinatorId, coordinatorName, publicUrl, peerUrl }) => ({ coordinatorId, coordinatorName, publicUrl, peerUrl }));
      return sendJson(res, 200, { peers });
    }
    return sendJson(res, 200, { ok: true });
  });
  await new Promise((resolve) => authServer.listen(0, '127.0.0.1', resolve));
  const authUrl = `http://127.0.0.1:${authServer.address().port}`;

  const [portA, peerA, portB, peerB] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const coordA = spawnCoordinator('coord-a', portA, peerA, authUrl);
  const coordB = spawnCoordinator('coord-b', portB, peerB, authUrl);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const child of [coordA, coordB]) if (child.exitCode === null) child.kill();
    await new Promise((resolve) => authServer.close(resolve));
  });

  await waitUntil(async () => (await health(portA))?.mesh?.connectedPeerIds?.includes('coord-b'), 'el mesh entre coord-a y coord-b');

  // El 1 está en coord-b (dueño de la sala) y el 2 en coord-a
  const host = await connectPlayer(portB, '1');
  const guest = await connectPlayer(portA, '2');
  clients.push(host, guest);

  host.send({ type: 'room_create', name: 'Sala adopcion' });
  await waitUntil(() => host.last('room_created'), 'crear la sala en coord-b');
  const { roomId } = host.last('room_created');
  await waitUntil(() => guest.last('room_list')?.rooms?.some((room) => room.roomId === roomId), 'que coord-a vea la sala');
  guest.send({ type: 'room_join', roomId });
  await waitUntil(() => guest.last('room_joined'), 'unirse desde coord-a');
  host.send({ type: 'game_start' });
  await waitUntil(() => guest.last('state')?.race?.phase === 'racing', 'el verde del semáforo en coord-a', 20_000);

  // Se cae el coordinador dueño de la sala
  coordB.kill();
  await waitUntil(() => {
    const state = guest.last('state');
    return state && !state.players.some((player) => player.userId === '1');
  }, 'que coord-a saque al jugador del coordinador caído');

  // El 2 da su vuelta: solo cuenta si coord-a adoptó la sala
  const track = RaceTracks.tracks[guest.last('state').race.level - 1];
  await driveLap(guest, track, -28);
  await waitUntil(() => guest.last('state')?.race?.level === 2, 'que la vuelta cuente y empiece el nivel 2', 6000);
  const previous = guest.last('state').race.previousResults;
  assert.deepEqual(previous.results.map((result) => result.userId), ['2']);
});
