
// Responsabilidad: aceptar conexiones WebSocket autenticadas, mantener
// un Map de jugadores en línea y hacer broadcast de la lista ante cada cambio.
// El JWT se intercambia por un ticket de un solo uso antes del handshake WS.

const { randomBytes } = require('node:crypto');
const readline = require('node:readline/promises');
const fs = require('node:fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const dotenv = require('dotenv');
const http = require('node:http');
const { URL } = require('node:url');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const RaceTracks = require('../shared/tracks');
const { planRebalance } = require('./rebalance');

// ── Verificación de configuración crítica ────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('Error crítico: La variable de entorno JWT_SECRET no está definida.');
  process.exit(1);
}

function parsePort(name, value, fallback) {
  const port = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Error de configuración: ${name} debe ser un puerto entre 1 y 65535.`);
    process.exit(1);
  }
  return port;
}

function parseServiceUrl(name, value, fallback, protocols) {
  let url;
  try {
    url = new URL(value || fallback);
  } catch {
    console.error(`Error de configuración: ${name} no es una URL válida.`);
    process.exit(1);
  }

  if (!protocols.includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash) {
    console.error(`Error de configuración: ${name} debe usar ${protocols.join(' o ')} sin credenciales, query ni fragmento.`);
    process.exit(1);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const PORT = parsePort('PORT', process.env.PORT, 5000);
const defaultPeerPort = PORT <= 64535 ? PORT + 1000 : PORT - 1000;
const PEER_PORT = parsePort('PEER_PORT', process.env.PEER_PORT, defaultPeerPort);
if (PEER_PORT === PORT) {
  console.error('Error de configuración: PEER_PORT debe ser distinto de PORT.');
  process.exit(1);
}

const COORDINATOR_ID = (process.env.COORDINATOR_ID || `coord-${PORT}`).trim();
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(COORDINATOR_ID)) {
  console.error('Error de configuración: COORDINATOR_ID debe tener de 1 a 64 caracteres alfanuméricos, guion o guion bajo.');
  process.exit(1);
}

function isValidCoordinatorName(value) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    [...value.trim()].length <= 48 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

let COORDINATOR_NAME = process.env.COORDINATOR_NAME?.trim() || '';
if (COORDINATOR_NAME && !isValidCoordinatorName(COORDINATOR_NAME)) {
  console.error('Error de configuración: COORDINATOR_NAME debe tener entre 1 y 48 caracteres y no incluir controles.');
  process.exit(1);
}

const PUBLIC_URL = parseServiceUrl(
  'PUBLIC_URL',
  process.env.PUBLIC_URL,
  `ws://localhost:${PORT}`,
  ['ws:', 'wss:']
);
const PEER_URL = parseServiceUrl(
  'PEER_URL',
  process.env.PEER_URL,
  `ws://localhost:${PEER_PORT}`,
  ['ws:', 'wss:']
);
const AUTH_URL = parseServiceUrl(
  'AUTH_URL',
  process.env.AUTH_URL,
  'http://localhost:4000',
  ['http:', 'https:']
);
const COORDINATOR_SHARED_SECRET = process.env.COORDINATOR_SHARED_SECRET;
if (!COORDINATOR_SHARED_SECRET || !COORDINATOR_SHARED_SECRET.trim()) {
  console.error('Error de configuración: COORDINATOR_SHARED_SECRET es obligatorio para enviar heartbeats autenticados a Auth.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const CLIENT_ORIGINS = new Set(
  (process.env.CLIENT_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const APP_WS_PROTOCOL = 'carsgame.v1';
const WS_TICKET_PROTOCOL_PREFIX = 'auth.';
const WS_TICKET_TTL_MS = 15_000;
const MAX_PENDING_WS_TICKETS = 1000;
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const PEER_DISCOVERY_INTERVAL_MS = 2000;
const PEER_DISCOVERY_TIMEOUT_MS = 5000;
const PEER_HELLO_TIMEOUT_MS = 5000;
const PEER_SYNC_INTERVAL_MS = 1000;
const PEER_REBALANCE_INTERVAL_MS = 3000;
const PLAYER_REBALANCE_TIMEOUT_MS = 15_000;

// ── Taller 5: parámetros del mundo y del game loop (desde .env) ─────────────
const WORLD_WIDTH = Number(process.env.WORLD_WIDTH) || 800;
const WORLD_HEIGHT = Number(process.env.WORLD_HEIGHT) || 600;
const PLAYER_RADIUS = Number(process.env.PLAYER_RADIUS) || 20;
const PLAYER_SPEED = Number(process.env.PLAYER_SPEED) || 200; // px/seg
const TICK_RATE = Number(process.env.TICK_RATE) || 20;        // Hz
const TICK_MS = 1000 / TICK_RATE;
const MAX_EXTRAS_BYTES = 1024; // límite anti-abuso para extras_update
const ROOM_COLORS = ['#2f6fed', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#ffffff'];
const RACE_LAPS_PER_LEVEL = 3;
const RACE_COUNTDOWN_MS = 6000;
const RACE_COUNTDOWN_COLOR_MS = 2000;

// ── Estado del coordinador ──────────────────────────────────────────────────
// Map: userId (string) → { username, provider, socket, connectedAt, expirationTimer,
//                          x, y, intent: { x, y }, extras }
const players = new Map();
const wsTickets = new Map();
let heartbeatTimer = null;
let heartbeatInFlight = false;
let heartbeatAbortController = null;
let peerDiscoveryTimer = null;
let peerDiscoveryInFlight = false;
let peerDiscoveryAbortController = null;
let peerDiscoveryStopped = false;
let peers = [];
const peerConnections = new Map();
const pendingPeerConnections = new Map();
const peerHttpServer = http.createServer();
const peerWss = new WebSocketServer({ noServer: true });
let gameLoopTimer = null;
let peerSyncTimer = null;
let peerRebalanceTimer = null;
const rebalanceInFlight = new Map();
function normalizeUsername(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : username;
}
const rooms = new Map();
let nextRoomId = 1;

function countOpenLocalPlayers() {
  let count = 0;
  for (const player of players.values()) {
    if (isOpenSocket(player.socket)) count += 1;
  }
  return count;
}

async function sendHeartbeat() {
  if (heartbeatInFlight || !COORDINATOR_SHARED_SECRET) return;

  heartbeatInFlight = true;
  const controller = new AbortController();
  heartbeatAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
  timeout.unref();

  try {
    const connectedPlayers = countOpenLocalPlayers();
    const response = await fetch(`${AUTH_URL}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
        'x-coordinator-secret': COORDINATOR_SHARED_SECRET
      },
      body: JSON.stringify({
        coordinatorId: COORDINATOR_ID,
        coordinatorName: COORDINATOR_NAME,
        publicUrl: PUBLIC_URL,
        peerUrl: PEER_URL,
        connectedPlayers,
        uptime: Math.floor(process.uptime()),
        load: connectedPlayers
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.error(`[coordinator] Auth rechazó el heartbeat (HTTP ${response.status}).`);
    }
  } catch {
    if (!controller.signal.aborted || heartbeatTimer) {
      console.error('[coordinator] No se pudo enviar el heartbeat a Auth.');
    }
  } finally {
    clearTimeout(timeout);
    if (heartbeatAbortController === controller) heartbeatAbortController = null;
    heartbeatInFlight = false;
  }
}

function sendLocalPlayersToPeer(ws) {
  for (const [userId, player] of players) {
    if (!player.local || !isOpenSocket(ws)) continue;
    ws.send(JSON.stringify({
      type: 'player_joined',
      origin: COORDINATOR_ID,
      userId,
      username: player.username,
      provider: player.provider,
      picture: player.picture,
      coordinatorName: player.coordinatorName,
      x: player.x,
      y: player.y,
      extras: player.extras
    }));
  }
}

function startHeartbeat() {
  if (heartbeatTimer || !COORDINATOR_SHARED_SECRET) return;

  void sendHeartbeat();
  heartbeatTimer = setInterval(() => {
    void sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (heartbeatAbortController) heartbeatAbortController.abort();
}

function isValidPeerUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

function isValidDiscoveredPeer(peer) {
  return peer !== null &&
    typeof peer === 'object' &&
    !Array.isArray(peer) &&
    typeof peer.coordinatorId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(peer.coordinatorId) &&
    (peer.coordinatorName === undefined || isValidCoordinatorName(peer.coordinatorName)) &&
    isValidPeerUrl(peer.publicUrl) &&
    isValidPeerUrl(peer.peerUrl);
}

async function refreshPeers() {
  if (peerDiscoveryInFlight || peerDiscoveryStopped) return;

  peerDiscoveryInFlight = true;
  const controller = new AbortController();
  peerDiscoveryAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), PEER_DISCOVERY_TIMEOUT_MS);
  timeout.unref();

  try {
    const endpoint = new URL(`${AUTH_URL}/peers`);
    endpoint.searchParams.set('coordinatorId', COORDINATOR_ID);
    const response = await fetch(endpoint, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: controller.signal
    });
    if (!response.ok) {
      console.error(`[coordinator] Auth rechazó la consulta de peers (HTTP ${response.status}).`);
      return;
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.peers) || !payload.peers.every(isValidDiscoveredPeer)) {
      console.error('[coordinator] Auth devolvió una lista de peers inválida.');
      return;
    }

    peers = payload.peers
      .filter((peer) => peer.coordinatorId !== COORDINATOR_ID)
      .map(({ coordinatorId, coordinatorName, publicUrl, peerUrl }) => ({
        coordinatorId,
        coordinatorName: isValidCoordinatorName(coordinatorName) ? coordinatorName.trim() : coordinatorId,
        publicUrl,
        peerUrl
      }));
    connectDiscoveredPeers();
  } catch {
    if (!peerDiscoveryStopped) {
      console.error('[coordinator] No se pudo consultar la lista de peers en Auth.');
    }
  } finally {
    clearTimeout(timeout);
    if (peerDiscoveryAbortController === controller) peerDiscoveryAbortController = null;
    peerDiscoveryInFlight = false;
  }
}

function startPeerDiscovery() {
  if (peerDiscoveryTimer) return;

  peerDiscoveryStopped = false;
  void refreshPeers();
  peerDiscoveryTimer = setInterval(() => {
    void refreshPeers();
  }, PEER_DISCOVERY_INTERVAL_MS);
  peerDiscoveryTimer.unref();
}

function stopPeerDiscovery() {
  peerDiscoveryStopped = true;
  if (peerDiscoveryTimer) {
    clearInterval(peerDiscoveryTimer);
    peerDiscoveryTimer = null;
  }
  if (peerDiscoveryAbortController) peerDiscoveryAbortController.abort();
}

function syncPlayerPositions() {
  const localPlayers = [];
  for (const [userId, player] of players) {
    if (player.local) localPlayers.push({ userId, x: player.x, y: player.y });
  }
  if (localPlayers.length) broadcastPeer({ type: 'player_sync', players: localPlayers });
}

function startPeerSync() {
  if (peerSyncTimer) return;
  peerSyncTimer = setInterval(syncPlayerPositions, PEER_SYNC_INTERVAL_MS);
  peerSyncTimer.unref();
}

function stopPeerSync() {
  if (!peerSyncTimer) return;
  clearInterval(peerSyncTimer);
  peerSyncTimer = null;
}

function sendRebalanceRequest(userId, target) {
  const player = players.get(userId);
  if (!player?.local || player.home !== COORDINATOR_ID || !isOpenSocket(player.socket)) return;

  sendWs(player.socket, {
    type: 'rebalance',
    sourceCoordinatorId: COORDINATOR_ID,
    coordinatorId: target.coordinatorId,
    coordinatorName: target.coordinatorName,
    publicUrl: target.publicUrl
  });
}

function runPeerRebalance() {
  const activeCoordinators = [
    { coordinatorId: COORDINATOR_ID, coordinatorName: COORDINATOR_NAME, publicUrl: PUBLIC_URL },
    ...peers
  ].sort((a, b) => a.coordinatorId < b.coordinatorId ? -1 : a.coordinatorId > b.coordinatorId ? 1 : 0);
  if (activeCoordinators.length < 2 || activeCoordinators[0].coordinatorId !== COORDINATOR_ID) return;
  if (peers.some((peer) => !isOpenSocket(peerConnections.get(peer.coordinatorId)))) return;

  const coordinatorById = new Map(activeCoordinators.map((coordinator) =>
    [coordinator.coordinatorId, coordinator]));
  const assignments = planRebalance(
    players,
    activeCoordinators.map(({ coordinatorId }) => coordinatorId),
    rebalanceInFlight
  );

  for (const assignment of assignments) {
    const target = coordinatorById.get(assignment.targetId);
    if (!target || !isValidPeerUrl(target.publicUrl)) continue;

    rebalanceInFlight.set(assignment.userId, target.coordinatorId);
    setTimeout(() => {
      if (rebalanceInFlight.get(assignment.userId) === target.coordinatorId) {
        rebalanceInFlight.delete(assignment.userId);
      }
    }, PLAYER_REBALANCE_TIMEOUT_MS).unref();

    const request = {
      type: 'player_rebalance',
      sourceId: assignment.sourceId,
      targetId: target.coordinatorId,
      targetName: target.coordinatorName,
      targetUrl: target.publicUrl,
      userId: assignment.userId
    };

    if (assignment.sourceId === COORDINATOR_ID) {
      sendRebalanceRequest(assignment.userId, {
        coordinatorId: target.coordinatorId,
        coordinatorName: target.coordinatorName,
        publicUrl: target.publicUrl
      });
    } else {
      broadcastPeer(request);
    }
  }
}

function startPeerRebalance() {
  if (peerRebalanceTimer) return;
  peerRebalanceTimer = setInterval(runPeerRebalance, PEER_REBALANCE_INTERVAL_MS);
  peerRebalanceTimer.unref();
}

function stopPeerRebalance() {
  if (!peerRebalanceTimer) return;
  clearInterval(peerRebalanceTimer);
  peerRebalanceTimer = null;
  rebalanceInFlight.clear();
}

function acceptRebalanceRequest(peerId, message) {
  const activeIds = [COORDINATOR_ID, ...peers.map((peer) => peer.coordinatorId)].sort();
  const target = peers.find((peer) =>
    peer.coordinatorId === message.targetId && peer.publicUrl === message.targetUrl);
  if (peerId !== activeIds[0] ||
      message.sourceId !== COORDINATOR_ID ||
      typeof message.userId !== 'string' ||
      !target ||
      !isValidPeerUrl(message.targetUrl)) return;

  sendRebalanceRequest(message.userId, {
    coordinatorId: target.coordinatorId,
    coordinatorName: target.coordinatorName,
    publicUrl: target.publicUrl
  });
}

function acceptPlayerTransfer(peerId, message) {
  if (message.previousCoordinatorId !== COORDINATOR_ID ||
      message.targetId !== peerId ||
      typeof message.userId !== 'string' ||
      !Number.isFinite(message.x) ||
      !Number.isFinite(message.y) ||
      !isValidPeerExtras(message.extras)) return;

  const player = players.get(message.userId);
  if (!player?.local || player.home !== COORDINATOR_ID) return;

  const previousSocket = player.socket;
  clearTimeout(player.expirationTimer);
  player.expirationTimer = null;
  player.socket = null;
  player.local = false;
  player.home = peerId;
  player.coordinatorName = isValidCoordinatorName(message.coordinatorName)
    ? message.coordinatorName.trim()
    : peerId;
  player.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, message.x));
  player.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, message.y));
  player.extras = message.extras;
  rebalanceInFlight.delete(message.userId);
  broadcastPlayers();
  broadcastRoomList();
  const room = player.roomId ? rooms.get(player.roomId) : null;
  if (room) {
    replicateRoom(room, 'join');
    broadcastRoom(room.roomId, roomUpdateMessage(room));
  }
  if (isOpenSocket(previousSocket)) {
    previousSocket.close(4002, 'session replaced');
  }
  void sendHeartbeat();
}

function confirmPlayerMigration(ws, userId, player, sourceCoordinatorId) {
  if (!player.migrationSource || player.migrationSource !== sourceCoordinatorId) {
    sendWs(ws, {
      type: 'error',
      ok: false,
      code: 'MIGRATION_NOT_PENDING',
      message: 'No hay un traslado pendiente para esta conexión.',
      hint: 'Conserva la conexión actual y solicita nuevamente el balanceo.'
    });
    return;
  }

  const previousCoordinatorId = player.migrationSource;
  player.migrationSource = null;
  if (isOpenSocket(peerConnections.get(previousCoordinatorId))) {
    broadcastPeer({
      type: 'player_transfer_complete',
      previousCoordinatorId,
      targetId: COORDINATOR_ID,
      coordinatorName: COORDINATOR_NAME,
      userId,
      x: player.x,
      y: player.y,
      extras: player.extras
    });
  }
  sendWs(ws, {
    type: 'migration_complete',
    ok: true,
    message: 'El cambio de coordinador se completó.'
  });
}

function sendMigratedRoomState(ws, userId, player) {
  if (!player.roomId) return;
  const room = rooms.get(player.roomId);
  if (!room || !room.members.has(userId)) return;

  sendWs(ws, {
    type: 'room_joined',
    roomId: room.roomId,
    name: room.name,
    hostUserId: room.hostUserId,
    hostUsername: room.hostUsername,
    players: roomPlayerList(room),
    status: room.status,
    race: raceSnapshot(room)
  });
  if (room.status === 'playing') {
    sendWs(ws, { type: 'race_update', roomId: room.roomId, race: raceSnapshot(room) });
  }
}

function shutdownCoordinator() {
  stopHeartbeat();
  stopPeerDiscovery();
  stopPeerSync();
  stopPeerRebalance();
  if (gameLoopTimer) {
    clearInterval(gameLoopTimer);
    gameLoopTimer = null;
  }
  for (const client of wss.clients) {
    client.close(1001, 'server shutdown');
  }
  for (const client of peerWss.clients) client.close(1001, 'server shutdown');
  peerHttpServer.close();
  server.close();
}

// ── Helpers de respuesta HTTP (mismo formato que Auth, SPEC.md §3.1) ────────
function sendOk(res, status, message, extra = {}) {
  return res.status(status).json({ ok: true, message, ...extra });
}

function sendError(res, status, code, message, hint) {
  return res.status(status).json({ ok: false, code, message, hint });
}

// ── Helper para enviar un mensaje WS a un socket (si está abierto) ──────────
function isOpenSocket(socket) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function sendWs(ws, payload) {
  if (isOpenSocket(ws)) {
    ws.send(JSON.stringify(payload));
  }
}

function roomSummary(room) {
  return {
    roomId: room.roomId,
    name: room.name,
    hostUserId: room.hostUserId,
    hostUsername: normalizeUsername(room.hostUsername),
    playerCount: room.members.size,
    maxPlayers: 8,
    status: room.status
  };
}

function roomPlayerList(room) {
  return [...room.members.values()].map((memberId) => {
    const player = players.get(memberId);
    return player ? {
      userId: memberId,
      username: String(player.username || '').toLowerCase(),
      color: player.extras.color || null,
      picture: player.picture || null,
      coordinatorId: player.home,
      coordinatorName: player.coordinatorName || player.home
    } : null;
  }).filter(Boolean);
}

function raceSnapshot(room) {
  const race = room.race || {};
  return {
    level: race.level || 1,
    phase: race.phase || 'waiting',
    countdownStartedAt: Number.isFinite(race.countdownStartedAt) ? race.countdownStartedAt : null,
    serverTime: Number.isFinite(race.serverTime) ? race.serverTime : Date.now(),
    laps: { ...(race.laps || {}) }
  };
}

function roomUpdateMessage(room) {
  return {
    type: 'room_updated',
    roomId: room.roomId,
    players: roomPlayerList(room),
    status: room.status,
    hostUserId: room.hostUserId,
    hostUsername: room.hostUsername,
    race: raceSnapshot(room)
  };
}

function roomReplicationPayload(room) {
  return {
    roomId: room.roomId,
    room: {
      name: room.name,
      hostUserId: room.hostUserId,
      hostUsername: room.hostUsername,
      status: room.status,
      owner: room.owner,
      race: raceSnapshot(room),
      members: [...room.members].map((userId) => {
        const player = players.get(userId);
        if (!player) return null;
        return {
          userId,
          username: player.username,
          provider: player.provider,
          picture: player.picture,
          x: player.x,
          y: player.y,
          extras: player.extras,
          home: player.home,
          coordinatorName: player.coordinatorName || player.home
        };
      }).filter(Boolean)
    }
  };
}

function replicateRoom(room, op) {
  broadcastPeer({
    type: 'room_replicate',
    op,
    roomId: room.roomId,
    room: roomReplicationPayload(room).room
  });
}

function startRaceLevel(room, level, now) {
  const race = {
    level,
    phase: 'countdown',
    countdownStartedAt: now,
    serverTime: now,
    laps: {},
    previousPositions: new Map()
  };
  const track = RaceTracks.tracks[level - 1];

  for (const [index, userId] of [...room.members].entries()) {
    const player = players.get(userId);
    if (!player) continue;
    const position = RaceTracks.spawnAtStart(track, index, WORLD_WIDTH, WORLD_HEIGHT);
    player.x = position.x;
    player.y = position.y;
    player.intent = { x: 0, y: 0 };
    race.laps[userId] = 0;
    race.previousPositions.set(userId, position);
  }

  room.race = race;
}

function publishRaceUpdate(room, operation = 'race') {
  replicateRoom(room, operation);
  broadcastRoom(room.roomId, {
    type: operation === 'start' ? 'game_started' : 'race_update',
    roomId: room.roomId,
    race: raceSnapshot(room),
    ...(operation === 'start' ? { players: roomPlayerList(room) } : {})
  });
}

function replicateRoomRemoval(roomId) {
  broadcastPeer({ type: 'room_replicate', op: 'leave', roomId, room: null });
}

function sendLocalRoomsToPeer(ws) {
  for (const room of rooms.values()) {
    if (room.owner !== COORDINATOR_ID || !isOpenSocket(ws)) continue;
    ws.send(JSON.stringify({
      type: 'room_replicate',
      origin: COORDINATOR_ID,
      op: 'create',
      ...roomReplicationPayload(room)
    }));
  }
}

function applyRemoteRoom(peerId, message) {
  if (!['create', 'join', 'leave', 'start', 'race', 'color', 'host'].includes(message.op) ||
      typeof message.roomId !== 'string' || !message.roomId ||
      message.roomId.length > 128) return;

  if (!message.room) {
    if (message.op !== 'leave') return;
    rooms.delete(message.roomId);
    broadcastRoomList();
    return;
  }

  const data = message.room;
  if (typeof data.name !== 'string' ||
      !/^[A-Za-z0-9ÁÉÍÓÚáéíóúÑñ _-]{3,32}$/.test(data.name) ||
      typeof data.hostUserId !== 'string' ||
      !['waiting', 'playing'].includes(data.status) ||
      typeof data.owner !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(data.owner) ||
      !Array.isArray(data.members) || data.members.length > 8) return;

  const members = new Set();
  for (const member of data.members) {
    if (!member || typeof member.userId !== 'string' || !member.userId ||
        typeof member.username !== 'string' ||
        !Number.isFinite(member.x) || !Number.isFinite(member.y) ||
        typeof member.home !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(member.home) ||
        (member.coordinatorName !== undefined && !isValidCoordinatorName(member.coordinatorName)) ||
        !isValidPeerExtras(member.extras)) return;
    members.add(member.userId);
  }
  if (!members.has(data.hostUserId)) return;

  const raceData = data.race || { level: 1, phase: 'waiting', countdownStartedAt: null, serverTime: Date.now(), laps: {} };
  if (!Number.isInteger(raceData.level) || raceData.level < 1 || raceData.level > RaceTracks.tracks.length ||
      !['waiting', 'countdown', 'racing', 'finished'].includes(raceData.phase) ||
      (raceData.countdownStartedAt !== null && !Number.isFinite(raceData.countdownStartedAt)) ||
      !Number.isFinite(raceData.serverTime) ||
      !raceData.laps || typeof raceData.laps !== 'object' || Array.isArray(raceData.laps)) return;
  const laps = {};
  for (const [memberId, completedLaps] of Object.entries(raceData.laps)) {
    if (!members.has(memberId) || !Number.isInteger(completedLaps) ||
        completedLaps < 0 || completedLaps > RACE_LAPS_PER_LEVEL) return;
    laps[memberId] = completedLaps;
  }

  const previousRoom = rooms.get(message.roomId);
  const preserveLocalRace = previousRoom?.owner === COORDINATOR_ID && !['start', 'race'].includes(message.op);
  const resetRacePositions = message.op === 'start' ||
    (message.op === 'create' && data.status === 'playing') ||
    (message.op === 'race' && previousRoom &&
      (raceData.level !== previousRoom.race?.level || raceData.phase !== previousRoom.race?.phase));
  for (const member of data.members) {
    const existing = players.get(member.userId);
    if (existing?.local) {
      if (!existing.roomId || existing.roomId === message.roomId) existing.roomId = message.roomId;
      if (resetRacePositions) {
        existing.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, member.x));
        existing.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, member.y));
        existing.intent = { x: 0, y: 0 };
      }
      continue;
    }
    players.set(member.userId, {
      username: member.username.trim().toLowerCase(),
      provider: member.provider === 'google' ? 'google' : 'local',
      picture: typeof member.picture === 'string' && member.picture.startsWith('https://') ? member.picture : null,
      coordinatorName: isValidCoordinatorName(member.coordinatorName)
        ? member.coordinatorName.trim()
        : member.home,
      socket: null,
      connectedAt: existing?.connectedAt || new Date().toISOString(),
      expirationTimer: null,
      x: Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, member.x)),
      y: Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, member.y)),
      intent: resetRacePositions ? { x: 0, y: 0 } : existing?.intent || { x: 0, y: 0 },
      extras: member.extras,
      roomId: message.roomId,
      home: member.home,
      local: false
    });
  }
  if (previousRoom) {
    for (const previousMemberId of previousRoom.members) {
      if (!members.has(previousMemberId)) {
        const player = players.get(previousMemberId);
        if (player?.roomId === message.roomId) player.roomId = null;
      }
    }
  }

  const room = {
    roomId: message.roomId,
    name: data.name,
    hostUserId: data.hostUserId,
    hostUsername: data.hostUsername || players.get(data.hostUserId)?.username || '',
    members,
    status: data.status,
    owner: data.owner,
    race: {
      level: preserveLocalRace ? previousRoom.race.level : raceData.level,
      phase: preserveLocalRace ? previousRoom.race.phase : raceData.phase,
      countdownStartedAt: preserveLocalRace ? previousRoom.race.countdownStartedAt : raceData.countdownStartedAt,
      serverTime: preserveLocalRace ? previousRoom.race.serverTime : raceData.serverTime,
      laps: preserveLocalRace
        ? Object.fromEntries([...members]
          .filter((memberId) => Object.hasOwn(previousRoom.race?.laps || {}, memberId))
          .map((memberId) => [memberId, previousRoom.race.laps[memberId]]))
        : laps,
      previousPositions: preserveLocalRace
        ? previousRoom.race.previousPositions
        : new Map()
    }
  };
  rooms.set(room.roomId, room);
  broadcastRoomList();
  broadcastRoom(room.roomId, roomUpdateMessage(room));
  if (message.op === 'start') {
    broadcastRoom(room.roomId, {
      type: 'game_started',
      roomId: room.roomId,
      players: roomPlayerList(room),
      race: raceSnapshot(room)
    });
  } else if (message.op === 'race') {
    broadcastRoom(room.roomId, { type: 'race_update', roomId: room.roomId, race: raceSnapshot(room) });
  }
  broadcastPlayers();
}

function broadcastRoomList() {
  const payload = {
    type: 'room_list',
    rooms: [...rooms.values()].map(roomSummary)
  };
  broadcastToLobby(payload);
}

function broadcastToLobby(payload) {
  for (const player of players.values()) {
    if (!player.roomId && isOpenSocket(player.socket)) {
      sendWs(player.socket, payload);
    }
  }
}

function broadcastRoom(roomId, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const memberId of room.members) {
    const player = players.get(memberId);
    if (player && isOpenSocket(player.socket)) sendWs(player.socket, payload);
  }
}

function roomExistsWithUser(room, userId) {
  return room && room.members.has(String(userId));
}

function broadcastPeer(payload) {
  const message = JSON.stringify({ ...payload, origin: COORDINATOR_ID });
  for (const ws of peerConnections.values()) {
    if (isOpenSocket(ws)) ws.send(message);
  }
}

function isValidPeerExtras(extras) {
  return extras !== null && typeof extras === 'object' && !Array.isArray(extras) &&
    Buffer.byteLength(JSON.stringify(extras)) <= MAX_EXTRAS_BYTES;
}

function acceptRemotePlayer(peerId, message) {
  const userId = typeof message.userId === 'string' ? message.userId : '';
  if (!userId || userId.length > 128 ||
      typeof message.username !== 'string' ||
      !Number.isFinite(message.x) || !Number.isFinite(message.y) ||
      !isValidPeerExtras(message.extras)) return;

  const existing = players.get(userId);
  if (existing?.local) return;
  players.set(userId, {
    username: message.username.trim().toLowerCase(),
    provider: message.provider === 'google' ? 'google' : 'local',
    picture: typeof message.picture === 'string' && message.picture.startsWith('https://') ? message.picture : null,
    coordinatorName: isValidCoordinatorName(message.coordinatorName)
      ? message.coordinatorName.trim()
      : peerId,
    socket: null,
    connectedAt: new Date().toISOString(),
    expirationTimer: null,
    x: Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, message.x)),
    y: Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, message.y)),
    intent: existing?.intent || { x: 0, y: 0 },
    extras: message.extras,
    roomId: existing?.roomId || null,
    home: peerId,
    local: false
  });
  broadcastPlayers();
}

function removeRemotePlayer(peerId, userId, notify = true) {
  if (typeof userId !== 'string') return;
  const entry = players.get(userId);
  if (!entry || entry.local || entry.home !== peerId) return;

  players.delete(userId);
  const room = entry.roomId ? rooms.get(entry.roomId) : null;
  if (room) {
    room.members.delete(userId);
    delete room.race?.laps?.[userId];
    room.race?.previousPositions?.delete(userId);
    if (room.members.size === 0) rooms.delete(room.roomId);
    else {
      if (room.hostUserId === userId) {
        room.hostUserId = [...room.members][0];
        room.hostUsername = players.get(room.hostUserId)?.username || '';
      }
      if (notify) broadcastRoom(room.roomId, roomUpdateMessage(room));
    }
    if (notify) broadcastRoomList();
  }
  if (notify) broadcastPlayers();
  return true;
}

function removePlayersFromPeer(peerId) {
  const removedRoomIds = new Set();
  let removedAny = false;
  for (const [userId, entry] of players) {
    if (!entry.local && entry.home === peerId) {
      if (entry.roomId) removedRoomIds.add(entry.roomId);
      removedAny = removeRemotePlayer(peerId, userId, false) || removedAny;
    }
  }
  if (!removedAny) return;
  for (const roomId of removedRoomIds) {
    const room = rooms.get(roomId);
    if (room && room.members.size > 0) broadcastRoom(roomId, roomUpdateMessage(room));
  }
  broadcastRoomList();
  broadcastPlayers();
}

function acceptRemoteIntent(peerId, message) {
  const player = typeof message.userId === 'string' ? players.get(message.userId) : null;
  const dir = message.intent && message.intent.dir;
  if (!player || player.local || player.home !== peerId ||
      !dir || typeof dir.x !== 'number' || typeof dir.y !== 'number' ||
      !Number.isFinite(dir.x) || !Number.isFinite(dir.y)) return;
  player.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
}

function acceptRemoteExtras(peerId, message) {
  const player = typeof message.userId === 'string' ? players.get(message.userId) : null;
  if (!player || player.local || player.home !== peerId || !isValidPeerExtras(message.extras)) return;
  player.extras = message.extras;
  if (player.roomId && rooms.has(player.roomId)) {
    broadcastRoom(player.roomId, {
      type: 'room_updated',
      roomId: player.roomId,
      players: roomPlayerList(rooms.get(player.roomId)),
      status: rooms.get(player.roomId).status,
      hostUserId: rooms.get(player.roomId).hostUserId,
      hostUsername: rooms.get(player.roomId).hostUsername
    });
  }
}

function acceptRemotePositions(peerId, message) {
  if (!Array.isArray(message.players)) return;
  for (const update of message.players) {
    if (!update || typeof update.userId !== 'string' ||
        !Number.isFinite(update.x) || !Number.isFinite(update.y)) continue;
    const player = players.get(update.userId);
    if (!player || player.local || player.home !== peerId) continue;
    player.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, update.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, update.y));
  }
}

function assignAvailableRoomColor(room, userId) {
  const used = new Set(roomPlayerList(room).map((player) => player.color));
  const color = ROOM_COLORS.find((candidate) => !used.has(candidate));
  if (color) players.get(userId).extras = { ...(players.get(userId).extras || {}), color };
}

// ── Broadcast de la lista de jugadores a TODOS los sockets abiertos ──────────
// Formato exacto del PDF: { type, players: [{ userId, username }] }
function broadcastPlayers() {
  const playerList = [];
  for (const [userId, entry] of players) {
    playerList.push({
      userId,
      username: normalizeUsername(entry.username),
      picture: entry.picture || null,
      coordinatorId: entry.home,
      coordinatorName: entry.coordinatorName || entry.home
    });
  }
  const msg = JSON.stringify({ type: 'players_update', players: playerList });

  for (const entry of players.values()) {
    if (isOpenSocket(entry.socket)) entry.socket.send(msg);
  }
}

// ── Taller 5: estado del juego ───────────────────────────────────────────────
// Foto del estado que se envía a los clientes (nunca incluye sockets ni timers).
function snapshot(roomId = null) {
  const list = [];
  for (const [userId, p] of players) {
    if (roomId ? p.roomId !== roomId : p.roomId) continue;
    list.push({
      userId,
      username: String(p.username || '').toLowerCase(),
      provider: p.provider,
      coordinatorId: p.home,
      coordinatorName: p.coordinatorName || p.home,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      extras: p.extras
    });
  }
  return list;
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const p of players.values()) {
    if (isOpenSocket(p.socket)) p.socket.send(msg);
  }
}

// ── Game loop (20 Hz): el servidor es la autoridad ───────────────────────────
// El handler de mensajes SOLO guarda la intención; quien mueve es este loop.
// Así la velocidad no depende de cuántos mensajes mande el cliente.
let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000; // segundos reales desde el tick anterior
  lastTick = now;

  if (players.size === 0) return;

  for (const room of rooms.values()) {
    if (room.owner !== COORDINATOR_ID || room.status !== 'playing' ||
        room.race?.phase !== 'countdown' || !Number.isFinite(room.race.countdownStartedAt)) continue;
    if (now - room.race.countdownStartedAt >= RACE_COUNTDOWN_COLOR_MS * 3) {
      room.race.phase = 'racing';
      room.race.serverTime = now;
      publishRaceUpdate(room);
    }
  }

  const changedRaceRooms = new Set();
  for (const [userId, p] of players) {
    if (p.roomId && !rooms.has(p.roomId)) continue;
    const room = p.roomId ? rooms.get(p.roomId) : null;
    const race = room?.race;
    const completedLaps = race?.laps?.[userId] || 0;
    const canMove = !room || room.status !== 'playing' ||
      (race?.phase === 'racing' && completedLaps < RACE_LAPS_PER_LEVEL);
    const previousPosition = { x: p.x, y: p.y };

    if (canMove) {
      // Normalizar diagonales: sin esto (1,1) avanzaría √2 ≈ 41 % más rápido.
      const ix = p.intent.x;
      const iy = p.intent.y;
      const mag = Math.hypot(ix, iy);
      if (mag > 0) {
        const dx = (ix / mag) * PLAYER_SPEED * dt;
        const dy = (iy / mag) * PLAYER_SPEED * dt;
        const track = room ? RaceTracks.tracks[race.level - 1] : null;
        const candidate = {
          x: Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x + dx)),
          y: Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y + dy))
        };
        if (!track || RaceTracks.isOnRoad(track, candidate.x, candidate.y, PLAYER_RADIUS, WORLD_WIDTH, WORLD_HEIGHT)) {
          p.x = candidate.x;
          p.y = candidate.y;
        } else {
          const horizontal = {
            x: Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x + dx)),
            y: p.y
          };
          const vertical = {
            x: p.x,
            y: Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y + dy))
          };
          if (RaceTracks.isOnRoad(track, horizontal.x, horizontal.y, PLAYER_RADIUS, WORLD_WIDTH, WORLD_HEIGHT)) {
            p.x = horizontal.x;
          } else if (RaceTracks.isOnRoad(track, vertical.x, vertical.y, PLAYER_RADIUS, WORLD_WIDTH, WORLD_HEIGHT)) {
            p.y = vertical.y;
          }
        }
      }
    }

    // Mantener dentro del mundo
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));

    if (room?.owner === COORDINATOR_ID && room.status === 'playing' && race.phase === 'racing') {
      const before = race.previousPositions.get(userId) || previousPosition;
      if ((race.laps[userId] || 0) < RACE_LAPS_PER_LEVEL &&
          RaceTracks.crossesFinish(RaceTracks.tracks[race.level - 1], before, p, WORLD_WIDTH, WORLD_HEIGHT)) {
        race.laps[userId] = (race.laps[userId] || 0) + 1;
        if (race.laps[userId] === RACE_LAPS_PER_LEVEL) p.intent = { x: 0, y: 0 };
        changedRaceRooms.add(room);
      }
      race.previousPositions.set(userId, { x: p.x, y: p.y });
    }
  }

  for (const room of rooms.values()) {
    if (room.owner === COORDINATOR_ID && room.status === 'playing' && room.race.phase === 'racing' &&
        room.members.size > 0 &&
        [...room.members].every((userId) => (room.race.laps[userId] || 0) >= RACE_LAPS_PER_LEVEL)) {
      changedRaceRooms.add(room);
    }
  }

  for (const room of changedRaceRooms) {
    const everyoneFinished = [...room.members].every((userId) =>
      (room.race.laps[userId] || 0) >= RACE_LAPS_PER_LEVEL
    );
    if (everyoneFinished) {
      if (room.race.level < RaceTracks.tracks.length) {
        startRaceLevel(room, room.race.level + 1, now);
      } else {
        room.race.phase = 'finished';
        room.race.serverTime = now;
      }
    }
    publishRaceUpdate(room);
  }

  // La pista muestra a los miembros durante la espera y durante la partida.
  // Solo se reproducen movimientos cuando el anfitrión inicia la sala.
  for (const room of rooms.values()) {
    broadcastRoom(room.roomId, {
      type: 'state',
      t: now,
      players: snapshot(room.roomId),
      race: raceSnapshot(room)
    });
  }
}

gameLoopTimer = setInterval(tick, TICK_MS);

// ── Express — endpoints HTTP ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

function allowTicketOrigin(req, res) {
  const origin = req.get('origin');
  if (!origin) return true;
  if (!CLIENT_ORIGINS.has(origin)) return false;

  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, ngrok-skip-browser-warning');
  res.set('Access-Control-Max-Age', '600');
  return true;
}

function pruneWsTickets(now = Date.now()) {
  for (const [ticket, entry] of wsTickets) {
    if (entry.expiresAt <= now) wsTickets.delete(ticket);
  }
}

function consumeWsTicket(ticket) {
  if (typeof ticket !== 'string' || !ticket) return null;
  const entry = wsTickets.get(ticket);
  wsTickets.delete(ticket);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.payload;
}

app.options('/ws-ticket', (req, res) => {
  if (!allowTicketOrigin(req, res)) {
    return sendError(res, 403, 'ORIGIN_NOT_ALLOWED', 'El origen no está autorizado.', 'Usa el origen configurado para el cliente.');
  }
  return res.status(204).end();
});

app.post('/ws-ticket', (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  if (!allowTicketOrigin(req, res)) {
    return sendError(res, 403, 'ORIGIN_NOT_ALLOWED', 'El origen no está autorizado.', 'Usa el origen configurado para el cliente.');
  }

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!match) {
    return sendError(res, 401, 'TOKEN_MISSING', 'No se proporcionó autenticación.', 'Inicia sesión y vuelve a solicitar la conexión.');
  }

  let payload;
  try {
    payload = jwt.verify(match[1], JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    const { code, message, hint } = classifyJwtError(err);
    return sendError(res, 401, code, message, hint);
  }

  const now = Date.now();
  pruneWsTickets(now);
  if (wsTickets.size >= MAX_PENDING_WS_TICKETS) {
    return sendError(res, 503, 'TICKET_SERVICE_BUSY', 'No se pueden preparar más conexiones en este momento.', 'Espera unos segundos e inténtalo de nuevo.');
  }

  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = Math.min(now + WS_TICKET_TTL_MS, payload.exp * 1000);
  wsTickets.set(ticket, { payload, expiresAt });

  return sendOk(res, 200, 'Ticket de conexión emitido.', {
    ticket,
    expiresIn: Math.max(1, Math.ceil((expiresAt - now) / 1000))
  });
});

// GET /health
app.get('/health', (req, res) => {
  sendOk(res, 200, 'Coordinador operativo.', {
    service: 'coordinator',
    coordinatorId: COORDINATOR_ID,
    coordinatorName: COORDINATOR_NAME,
    uptime: Math.floor(process.uptime()),
    onlineCount: players.size,
    mesh: {
      discoveredPeerIds: peers.map((peer) => peer.coordinatorId).sort(),
      connectedPeerIds: [...peerConnections.keys()].sort(),
      pendingPeerIds: [...pendingPeerConnections.keys()].sort()
    }
  });
});

// GET /players — solo lectura y diagnóstico; nunca expone sockets ni tokens
app.get('/players', (req, res) => {
  const playerList = [];
  for (const [userId, entry] of players) {
    playerList.push({
      userId,
      username: normalizeUsername(entry.username),
      coordinatorId: entry.home,
      coordinatorName: entry.coordinatorName || entry.home
    });
  }
  sendOk(res, 200, `Hay ${players.size} jugador(es) en línea.`, {
    count: players.size,
    players: playerList
  });
});

// Handler 404 para rutas HTTP desconocidas
app.use((req, res) => {
  sendError(
    res, 404,
    'NOT_FOUND',
    'La ruta solicitada no existe.',
    'Rutas HTTP disponibles: GET /health, GET /players y POST /ws-ticket. Solicita un ticket antes de conectar al WebSocket.'
  );
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400 && 'body' in err)) {
    return sendError(res, 400, 'INVALID_BODY', 'El cuerpo JSON no es válido.', 'Envía una petición sin cuerpo o JSON válido.');
  }
  console.error(`[coordinator] Error HTTP no controlado (${err.code || err.name || 'UNKNOWN'}).`);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Ocurrió un error interno.', 'Intenta de nuevo; si persiste, revisa los logs del servicio.');
});

// ── Servidor HTTP (http.createServer es requerido para el upgrade manual) ────
const server = http.createServer(app);

peerHttpServer.on('upgrade', (req, socket, head) => {
  let peerPath;
  try {
    peerPath = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (peerPath !== '/mesh') {
    socket.destroy();
    return;
  }
  peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws));
});

function attachPeerConnection(ws, expectedPeerId = null, initiatedLocally = false) {
  const helloTimer = setTimeout(() => ws.close(4000, 'hello timeout'), PEER_HELLO_TIMEOUT_MS);
  helloTimer.unref();
  let peerId = null;

  const sendHello = () => {
    if (isOpenSocket(ws)) {
      ws.send(JSON.stringify({
        type: 'hello',
        coordinatorId: COORDINATOR_ID,
        coordinatorName: COORDINATOR_NAME
      }));
    }
  };
  if (initiatedLocally) ws.once('open', sendHello);
  else sendHello();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.close(4000, 'invalid message');
      return;
    }

    if (!peerId) {
      if (msg.type !== 'hello' || typeof msg.coordinatorId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(msg.coordinatorId) ||
          (msg.coordinatorName !== undefined && !isValidCoordinatorName(msg.coordinatorName)) ||
          msg.coordinatorId === COORDINATOR_ID ||
          (expectedPeerId && msg.coordinatorId !== expectedPeerId)) {
        ws.close(4000, 'invalid hello');
        return;
      }
      peerId = msg.coordinatorId;
      const shouldInitiate = COORDINATOR_ID < peerId;
      if (initiatedLocally !== shouldInitiate ||
          (peerConnections.has(peerId) && peerConnections.get(peerId) !== ws)) {
        ws.close(4000, 'duplicate peer');
        return;
      }
      clearTimeout(helloTimer);
      peerConnections.set(peerId, ws);
      pendingPeerConnections.delete(peerId);
      console.log(`[coordinator] Mesh conectado con ${peerId}.`);
      sendLocalPlayersToPeer(ws);
      sendLocalRoomsToPeer(ws);
      return;
    }

    if (msg.origin !== peerId) return;
    if (msg.type === 'player_joined') {
      acceptRemotePlayer(peerId, msg);
    } else if (msg.type === 'player_left') {
      removeRemotePlayer(peerId, msg.userId);
    } else if (msg.type === 'intent_replicate') {
      acceptRemoteIntent(peerId, msg);
    } else if (msg.type === 'extras_replicate') {
      acceptRemoteExtras(peerId, msg);
    } else if (msg.type === 'player_sync') {
      acceptRemotePositions(peerId, msg);
    } else if (msg.type === 'room_replicate') {
      applyRemoteRoom(peerId, msg);
    } else if (msg.type === 'player_rebalance') {
      acceptRebalanceRequest(peerId, msg);
    } else if (msg.type === 'player_transfer_complete') {
      rebalanceInFlight.delete(msg.userId);
      acceptPlayerTransfer(peerId, msg);
    }
  });

  ws.on('close', (code) => {
    clearTimeout(helloTimer);
    if (expectedPeerId && pendingPeerConnections.get(expectedPeerId) === ws) {
      pendingPeerConnections.delete(expectedPeerId);
    }
    if (peerId && peerConnections.get(peerId) === ws) {
      peerConnections.delete(peerId);
      console.log(`[coordinator] Mesh desconectado de ${peerId} (${code}).`);
      removePlayersFromPeer(peerId);
    }
  });
  ws.on('error', (err) => {
    console.error(`[coordinator] Error en peer ${peerId || 'sin identificar'} (${err.code || 'UNKNOWN'}).`);
  });
}

peerWss.on('connection', (ws) => attachPeerConnection(ws));

function connectDiscoveredPeers() {
  for (const peer of peers) {
    if (COORDINATOR_ID >= peer.coordinatorId ||
        peerConnections.has(peer.coordinatorId) ||
        pendingPeerConnections.has(peer.coordinatorId)) continue;

    const ws = new WebSocket(`${peer.peerUrl.replace(/\/+$/, '')}/mesh`);
    pendingPeerConnections.set(peer.coordinatorId, ws);
    attachPeerConnection(ws, peer.coordinatorId, true);
  }
}

// ── Servidor WebSocket (noServer: true — el upgrade se maneja manualmente) ───
// ── Helper para clasificar errores de verificación JWT (reutilizado en upgrade y verify) ──
function classifyJwtError(err) {
  let code = 'TOKEN_MALFORMED';
  let message = 'El token es inválido o no puede procesarse.';
  let hint = 'Inicia sesión de nuevo y solicita otro ticket de conexión.';

  if (err.name === 'TokenExpiredError') {
    code = 'TOKEN_EXPIRED';
    message = 'El token de autenticación ha expirado.';
    hint = 'Inicia sesión de nuevo para obtener una sesión vigente.';
  } else if (err.name === 'JsonWebTokenError') {
    if (err.message === 'invalid signature') {
      code = 'TOKEN_INVALID_SIGNATURE';
      message = 'La firma del token no es válida.';
      hint = 'Verifica que JWT_SECRET sea idéntica en auth-service y coordinator.';
    }
  }

  return { code, message, hint };
}

// ── Helper para leer expiración dinámica configurada en .env en vivo ─────────
function getLiveJwtExpiresInSeconds() {
  try {
    const authEnvPath = path.join(__dirname, '../auth-service/.env');
    if (fs.existsSync(authEnvPath)) {
      const parsed = dotenv.parse(fs.readFileSync(authEnvPath, 'utf8'));
      if (parsed.JWT_EXPIRES_IN) {
        let val = parsed.JWT_EXPIRES_IN.trim();
        if (/^\d+$/.test(val)) return Number(val);
        const match = val.match(/^(\d+)([smhdw]?)$/i);
        if (match) {
          const num = Number(match[1]);
          const unit = (match[2] || 's').toLowerCase();
          switch (unit) {
            case 's': return num;
            case 'm': return num * 60;
            case 'h': return num * 3600;
            case 'd': return num * 86400;
            case 'w': return num * 604800;
            default: return num;
          }
        }
      }
    }
  } catch {}
  return null;
}

const wss = new WebSocketServer({
  noServer: true,
  handleProtocols(protocols) {
    return protocols.has(APP_WS_PROTOCOL) ? APP_WS_PROTOCOL : false;
  }
});

// ── Evento upgrade: consumir el ticket antes de aceptar la conexión WS ───────
server.on('upgrade', (req, socket, head) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Solo se acepta la ruta /connect
  if (parsedUrl.pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (parsedUrl.search) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const offeredProtocols = (req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  const ticketProtocol = offeredProtocols.find((protocol) => protocol.startsWith(WS_TICKET_PROTOCOL_PREFIX));
  const ticket = ticketProtocol ? ticketProtocol.slice(WS_TICKET_PROTOCOL_PREFIX.length) : '';

  if (!offeredProtocols.includes(APP_WS_PROTOCOL)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // El JWT nunca viaja en la URL ni en los subprotocolos; solo el ticket efímero.
  const payload = consumeWsTicket(ticket);
  if (!ticket) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      sendWs(ws, {
        type: 'error',
        ok: false,
        code: 'TOKEN_MISSING',
        message: 'No se proporcionó un ticket de conexión.',
        hint: 'Solicita uno con POST /ws-ticket usando Authorization: Bearer <JWT>.'
      });
      ws.close(4001, 'invalid token');
    });
    return;
  }

  if (!payload) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      sendWs(ws, {
        type: 'error',
        ok: false,
        code: 'TICKET_INVALID',
        message: 'El ticket de conexión no es válido o ya fue usado.',
        hint: 'Solicita un ticket nuevo y conecta dentro de su vigencia.'
      });
      ws.close(4001, 'invalid token');
    });
    return;
  }

  // Ticket válido y consumido → completar el handshake con el payload ya verificado.
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, payload);
  });
});

// ── Evento connection: gestión del jugador ────────────────────────────────────
wss.on('connection', (ws, payload) => {
  const userId = String(payload.userId);
  const username = typeof payload.username === 'string' ? payload.username.trim().toLowerCase() : payload.username;
  // provider viene del JWT verificado (no del cliente). Tokens del Taller 4 no lo traen → 'local'.
  const provider = payload.provider === 'google' ? 'google' : 'local';
  // Foto de perfil de Google: viene del JWT ya verificado (el auth solo pone URLs https de Google)
  const picture = typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture : null;

  // Política de doble pestaña (SPEC.md §3.5): la conexión nueva reemplaza a la anterior.
  // Justificación: un socket "zombi" de una reconexión o refresh bloquearía al usuario
  // si se rechazara la nueva conexión. La intención más reciente del usuario prevalece.
  const previousEntry = players.get(userId);
  const migratedEntry = previousEntry && !previousEntry.local &&
    previousEntry.home !== COORDINATOR_ID
    ? previousEntry
    : null;

  if (previousEntry?.local) {
    const existing = previousEntry;
    // Cancela el timer de expiración de la sesión anterior
    clearTimeout(existing.expirationTimer);
    // Cierra el socket viejo con el código 4002 (el cliente sabrá que fue reemplazado)
    if (isOpenSocket(existing.socket)) {
      existing.socket.close(4002, 'session replaced');
    }
    console.log(`Sesión reemplazada para: ${username}`);
  }

  // Registrar la nueva entrada en el Map
  const entry = {
    username,
    socket: ws,
    connectedAt: migratedEntry?.connectedAt || new Date().toISOString(),
    expirationTimer: null,
    provider,
    picture,
    x: migratedEntry?.x ?? PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - 2 * PLAYER_RADIUS),
    y: migratedEntry?.y ?? PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: migratedEntry?.intent || { x: 0, y: 0 },
    extras: migratedEntry?.extras || {},
    roomId: migratedEntry?.roomId || null,
    migrationSource: migratedEntry?.home || null,
    home: COORDINATOR_ID,
    coordinatorName: COORDINATOR_NAME,
    local: true
  };
  players.set(userId, entry);
  broadcastPeer({
    type: 'player_joined',
    coordinatorName: COORDINATOR_NAME,
    userId,
    username,
    provider,
    picture,
    x: entry.x,
    y: entry.y,
    extras: entry.extras
  });
  console.log(`Jugador conectado: ${username}`);

  // Mensaje de bienvenida solo al socket nuevo
  sendWs(ws, {
    type: 'connected',
    ok: true,
    message: `Conexión autenticada como ${username}.`,
    userId,
    username,
    onlineCount: players.size
  });

  // Taller 5: welcome con el mundo, para que el cliente dimensione el canvas
  sendWs(ws, {
    type: 'welcome',
    coordinatorId: COORDINATOR_ID,
    coordinatorName: COORDINATOR_NAME,
    you: { userId, username, provider },
    world: {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      playerRadius: PLAYER_RADIUS,
      tickRate: TICK_RATE
    }
  });

  // Broadcast de la lista actualizada a TODOS (incluido el nuevo)
  broadcastPlayers();
  sendMigratedRoomState(ws, userId, entry);
  if (migratedEntry && entry.roomId) {
    const room = rooms.get(entry.roomId);
    if (room) {
      replicateRoom(room, 'join');
      broadcastRoom(room.roomId, roomUpdateMessage(room));
    }
  }
  void sendHeartbeat();

  // Timer de expiración en caliente
  // Al vencer el JWT mientras el socket sigue abierto, se notifica y se cierra.
  const msUntilExpiry = payload.exp * 1000 - Date.now();
  if (msUntilExpiry > 0) {
    entry.expirationTimer = setTimeout(() => {
      console.log(`Token expirado para: ${username}`);
      sendWs(ws, {
        type: 'error',
        ok: false,
        code: 'TOKEN_EXPIRED',
        message: 'Tu token de autenticación ha expirado.',
        hint: 'Inicia sesión de nuevo en POST /login para obtener un token nuevo.'
      });
      ws.close(4003, 'token expired');
    }, msUntilExpiry);
  }

  // ── Mensajes cliente → servidor ────────────────────────────────────────────
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Texto que no es JSON válido
      sendWs(ws, {
        type: 'error',
        ok: false,
        code: 'INVALID_JSON',
        message: 'El mensaje recibido no es JSON válido.',
        hint: 'Envía JSON, por ejemplo {"type":"ping"}.'
      });
      return;
    }

    switch (msg.type) {
      case 'ping':
        sendWs(ws, {
          type: 'pong',
          ok: true,
          message: 'Conexión viva.',
          serverTime: new Date().toISOString()
        });
        break;

      case 'intent': {
        // Solo se guarda la intención; el movimiento lo hace el game loop.
        const dir = msg.intent && msg.intent.dir;
        if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number' ||
            !Number.isFinite(dir.x) || !Number.isFinite(dir.y)) {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'INVALID_INTENT',
            message: 'La intención de movimiento no tiene el formato esperado.',
            hint: 'Envía {"type":"intent","intent":{"dir":{"x":1,"y":0}}} con x e y en -1, 0 o 1.'
          });
          break;
        }
        // Durante el semáforo y al terminar una pista, no se aceptan movimientos.
        const room = entry.roomId ? rooms.get(entry.roomId) : null;
        const completedLaps = room?.race?.laps?.[userId] || 0;
        const movementLocked = room?.status === 'playing' &&
          (room.race.phase !== 'racing' || completedLaps >= RACE_LAPS_PER_LEVEL);
        // Sanitizar a -1, 0, 1: NO confiar en el cliente ({x: 9999} queda en 1)
        entry.intent = movementLocked ? { x: 0, y: 0 } : { x: Math.sign(dir.x), y: Math.sign(dir.y) };
        broadcastPeer({
          type: 'intent_replicate',
          userId,
          intent: { dir: entry.intent }
        });
        break;
      }

      case 'room_list':
        sendWs(ws, { type: 'room_list', rooms: [...rooms.values()].map(roomSummary) });
        break;

      case 'migration_ack':
        confirmPlayerMigration(ws, userId, entry, msg.sourceCoordinatorId);
        break;

      case 'room_create': {
        const name = typeof msg.name === 'string' ? msg.name.trim() : '';
        if (!/^[A-Za-z0-9ÁÉÍÓÚáéíóúÑñ _-]{3,32}$/.test(name)) {
          sendWs(ws, { type: 'error', ok: false, code: 'INVALID_ROOM_NAME', message: 'El nombre de la sala no es válido.', hint: 'Usa entre 3 y 32 letras, números, espacios o guiones.' });
          break;
        }
        if (entry.roomId) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_ALREADY_JOINED', message: 'Ya estás dentro de una sala.', hint: 'Sal de la sala actual antes de crear otra.' });
          break;
        }
        const roomId = `${COORDINATOR_ID}-room-${Date.now()}-${nextRoomId++}`;
        const room = {
          roomId,
          name,
          hostUserId: userId,
          hostUsername: username,
          members: new Set([userId]),
          status: 'waiting',
          owner: COORDINATOR_ID,
          race: { level: 1, phase: 'waiting', countdownStartedAt: null, serverTime: Date.now(), laps: {}, previousPositions: new Map() }
        };
        rooms.set(roomId, room);
        entry.roomId = roomId;
        const startPosition = RaceTracks.spawnAtStart(RaceTracks.tracks[0], 0, WORLD_WIDTH, WORLD_HEIGHT);
        entry.x = startPosition.x;
        entry.y = startPosition.y;
        assignAvailableRoomColor(room, userId);
        replicateRoom(room, 'create');
        broadcastRoomList();
        sendWs(ws, { type: 'room_created', roomId, name, hostUserId: userId, hostUsername: username, players: roomPlayerList(room) });
        sendWs(ws, { type: 'room_joined', roomId, name, hostUserId: userId, hostUsername: username, players: roomPlayerList(room) });
        broadcastRoom(roomId, { type: 'room_updated', roomId, players: roomPlayerList(room), status: room.status });
        break;
      }

      case 'room_join': {
        const room = rooms.get(String(msg.roomId || ''));
        if (!room) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_NOT_FOUND', message: 'La sala ya no está disponible.', hint: 'Regresa al listado y elige otra sala.' });
          break;
        }
        if (entry.roomId) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_ALREADY_JOINED', message: 'Ya estás dentro de una sala.', hint: 'Sal de la sala actual antes de entrar en otra.' });
          break;
        }
        if (room.status !== 'waiting') {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_ALREADY_STARTED', message: 'Esta sala ya comenzó la partida.', hint: 'Espera a que termine o elige otra sala.' });
          break;
        }
        if (room.members.size >= 8) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_FULL', message: 'La sala está llena.', hint: 'Elige una sala con espacio disponible.' });
          break;
        }
        room.members.add(userId);
        entry.roomId = room.roomId;
        const startPosition = RaceTracks.spawnAtStart(RaceTracks.tracks[0], room.members.size - 1, WORLD_WIDTH, WORLD_HEIGHT);
        entry.x = startPosition.x;
        entry.y = startPosition.y;
        assignAvailableRoomColor(room, userId);
        replicateRoom(room, 'join');
        broadcastRoomList();
        sendWs(ws, { type: 'room_joined', roomId: room.roomId, name: room.name, hostUserId: room.hostUserId, hostUsername: room.hostUsername, players: roomPlayerList(room) });
        broadcastRoom(room.roomId, { type: 'room_updated', roomId: room.roomId, players: roomPlayerList(room), status: room.status });
        break;
      }

      case 'room_leave': {
        const room = entry.roomId ? rooms.get(entry.roomId) : null;
        if (!room) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_NOT_JOINED', message: 'No estás dentro de una sala.', hint: 'Elige una sala del listado para entrar.' });
          break;
        }
        const roomId = room.roomId;
        room.members.delete(userId);
        delete room.race?.laps?.[userId];
        room.race?.previousPositions?.delete(userId);
        entry.roomId = null;
        if (room.members.size === 0) rooms.delete(roomId);
        else if (room.hostUserId === userId) {
          room.hostUserId = [...room.members][0];
          room.hostUsername = players.get(room.hostUserId)?.username || '';
        }
        if (rooms.has(roomId)) replicateRoom(room, 'leave');
        else replicateRoomRemoval(roomId);
        sendWs(ws, { type: 'room_left', ok: true, message: 'Has salido de la sala.' });
        broadcastRoom(roomId, roomUpdateMessage(room));
        broadcastRoomList();
        break;
      }

      case 'room_transfer_host': {
        const room = entry.roomId ? rooms.get(entry.roomId) : null;
        if (!room) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_NOT_JOINED', message: 'Debes estar dentro de una sala.', hint: 'Entra en una sala antes de cambiar su creador.' });
          break;
        }
        if (room.hostUserId !== userId) {
          sendWs(ws, { type: 'error', ok: false, code: 'NOT_ROOM_HOST', message: 'Solo el creador actual puede transferir el rol.', hint: 'Solicita al creador actual que realice el cambio.' });
          break;
        }

        const targetUserId = typeof msg.targetUserId === 'string' ? msg.targetUserId : '';
        if (targetUserId === userId) {
          sendWs(ws, { type: 'error', ok: false, code: 'HOST_TRANSFER_TO_SELF', message: 'No puedes transferirte el rol de creador a ti mismo.', hint: 'Selecciona a otro participante de la sala.' });
          break;
        }

        const target = players.get(targetUserId);
        if (!room.members.has(targetUserId) || !target || target.roomId !== room.roomId) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_MEMBER_NOT_FOUND', message: 'El participante seleccionado no pertenece a esta sala.', hint: 'Elige a un participante que siga dentro de la sala.' });
          break;
        }

        room.hostUserId = targetUserId;
        room.hostUsername = target.username;
        replicateRoom(room, 'host');
        broadcastRoom(room.roomId, {
          type: 'room_updated',
          roomId: room.roomId,
          players: roomPlayerList(room),
          status: room.status,
          hostUserId: room.hostUserId,
          hostUsername: room.hostUsername
        });
        broadcastRoomList();
        break;
      }

      case 'game_start': {
        const room = entry.roomId ? rooms.get(entry.roomId) : null;
        if (!room) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_NOT_JOINED', message: 'Debes entrar a una sala.', hint: 'Crea una sala o únete a una existente.' });
          break;
        }
        if (room.hostUserId !== userId) {
          sendWs(ws, { type: 'error', ok: false, code: 'NOT_ROOM_HOST', message: 'Solo el creador puede iniciar la carrera.', hint: 'Espera a que el creador de la sala inicie la partida.' });
          break;
        }
        if (room.status !== 'waiting') {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_ALREADY_STARTED', message: 'La carrera de esta sala ya inició.', hint: 'Espera a que termine el nivel actual.' });
          break;
        }
        if (room.members.size < 2) {
          sendWs(ws, { type: 'error', ok: false, code: 'MIN_PLAYERS_REQUIRED', message: 'Faltan pilotos para comenzar.', hint: 'Necesitas al menos 2 jugadores en la sala.' });
          break;
        }
        room.status = 'playing';
        startRaceLevel(room, 1, Date.now());
        publishRaceUpdate(room, 'start');
        broadcastRoomList();
        break;
      }

      case 'room_color_update': {
        const room = entry.roomId ? rooms.get(entry.roomId) : null;
        const color = typeof msg.color === 'string' ? msg.color.toLowerCase() : '';
        if (!room) {
          sendWs(ws, { type: 'error', ok: false, code: 'ROOM_NOT_JOINED', message: 'Debes estar dentro de una sala.', hint: 'Entra en una sala antes de elegir el color.' });
          break;
        }
        if (!ROOM_COLORS.includes(color)) {
          sendWs(ws, { type: 'error', ok: false, code: 'COLOR_INVALID', message: 'Ese color no está disponible.', hint: 'Elige uno de los 8 colores de la sala.' });
          break;
        }
        let colorTaken = false;
        for (const memberId of room.members) {
          if (memberId !== userId && players.get(memberId)?.extras.color === color) {
            colorTaken = true;
            break;
          }
        }
        if (colorTaken) {
          sendWs(ws, { type: 'error', ok: false, code: 'COLOR_TAKEN', message: 'Otro piloto ya usa ese color.', hint: 'Elige un color diferente para tu carro.' });
          break;
        }
        entry.extras = { ...entry.extras, color };
        broadcastPeer({ type: 'extras_replicate', userId, extras: entry.extras });
        replicateRoom(room, 'color');
        broadcastRoom(room.roomId, { type: 'room_updated', roomId: room.roomId, players: roomPlayerList(room), status: room.status });
        break;
      }

      case 'extras_update': {
        const extras = msg.extras;
        const valid = extras && typeof extras === 'object' && !Array.isArray(extras) &&
          Buffer.byteLength(JSON.stringify(extras)) <= MAX_EXTRAS_BYTES;
        if (!valid) {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'INVALID_EXTRAS',
            message: 'Los extras deben ser un objeto JSON de hasta 1024 bytes.',
            hint: 'Envía {"type":"extras_update","extras":{"color":"#ff5500"}}.'
          });
          break;
        }
        // Se replica a todos en el próximo state (persistente durante la sesión)
        entry.extras = extras;
        broadcastPeer({ type: 'extras_replicate', userId, extras: entry.extras });
        break;
      }

      case 'who':
        // Responde players_update solo al socket que preguntó
        {
          const playerList = [];
          for (const [uid, e] of players) {
            playerList.push({
              userId: uid,
              username: e.username,
              coordinatorId: e.home,
              coordinatorName: e.coordinatorName || e.home
            });
          }
          sendWs(ws, { type: 'players_update', players: playerList });
        }
        break;

      case 'verify': {
        if (Object.hasOwn(msg, 'token')) {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'TOKEN_TRANSPORT_UNSUPPORTED',
            message: 'No se aceptan JWT en mensajes WebSocket.',
            hint: 'Solicita un ticket de un solo uso con POST /ws-ticket.'
          });
          ws.close(4001, 'invalid token');
          return;
        }

        let verifyPayload = payload;
        if (msg.ticket !== undefined) {
          verifyPayload = consumeWsTicket(msg.ticket);
          if (!verifyPayload) {
            sendWs(ws, {
              type: 'error',
              ok: false,
              code: 'TICKET_INVALID',
              message: 'El ticket de verificación no es válido o ya fue usado.',
              hint: 'Solicita un ticket nuevo e inténtalo otra vez.'
            });
            ws.close(4001, 'invalid token');
            return;
          }
        }

        if (String(verifyPayload.userId) !== userId) {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'TOKEN_MISMATCH',
            message: 'La sesión no corresponde a este usuario.',
            hint: 'Cierra sesión e inicia con el mismo usuario.'
          });
          ws.close(4001, 'invalid token');
          return;
        }

        // Validación de expiración activa en caliente
        if (msg.forceExpired === true) {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'TOKEN_EXPIRED',
            message: 'Tu token de autenticación ha expirado.',
            hint: 'Inicia sesión de nuevo en POST /login para obtener un token nuevo.'
          });
          ws.close(4003, 'token expired');
          return;
        }

        const activeMaxAge = (typeof msg.maxAge === 'number' && msg.maxAge > 0)
          ? msg.maxAge
          : getLiveJwtExpiresInSeconds();

        if (activeMaxAge && (Math.floor(Date.now() / 1000) - verifyPayload.iat) >= activeMaxAge) {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'TOKEN_EXPIRED',
            message: 'Tu token de autenticación ha expirado.',
            hint: 'Inicia sesión de nuevo en POST /login para obtener un token nuevo.'
          });
          ws.close(4003, 'token expired');
          return;
        }

        // Token válido y del mismo usuario: responder verified
        // No se reprograma el timer de expiración (conserva el exp original del socket)
        sendWs(ws, {
          type: 'verified',
          ok: true,
          message: 'Token verificado.',
          expiresAt: new Date(verifyPayload.exp * 1000).toISOString()
        });
        break;
      }

      default:
        sendWs(ws, {
          type: 'error',
          ok: false,
          code: 'UNKNOWN_MESSAGE_TYPE',
          message: 'Tipo de mensaje no reconocido.',
          hint: 'Tipos soportados: ping, who, verify, migration_ack, intent, extras_update, room_create, room_join, room_leave, room_list, game_start, room_color_update.'
        });
    }
  });

  // ── Cierre del socket ──────────────────────────────────────────────────────
  ws.on('close', () => {
    // CRÍTICO: solo borrar del Map y cancelar el timer si este socket es el vigente.
    // Si fue reemplazado (política 3.5), el timer del viejo ya fue cancelado al reemplazarlo
    // y el socket viejo cierra pero NO debe tocar la entrada/timer del nuevo ni hacer broadcast.
    if (players.get(userId)?.socket === ws) {
      clearTimeout(entry.expirationTimer);
      broadcastPeer({ type: 'player_left', userId });
      const roomId = entry.roomId;
      players.delete(userId);
      if (roomId) {
        const room = rooms.get(roomId);
        if (room) {
          room.members.delete(userId);
          delete room.race?.laps?.[userId];
          room.race?.previousPositions?.delete(userId);
          if (room.members.size === 0) rooms.delete(roomId);
          else {
            if (room.hostUserId === userId) {
              room.hostUserId = [...room.members][0];
              room.hostUsername = players.get(room.hostUserId)?.username || '';
            }
            // Avisar a los que quedan aunque el que se fue no fuera el anfitrión,
            // para que su lista de pilotos y su paleta de colores se actualicen.
            broadcastRoom(roomId, { type: 'room_updated', roomId, players: roomPlayerList(room), status: room.status, hostUserId: room.hostUserId, hostUsername: room.hostUsername });
          }
          if (rooms.has(roomId)) replicateRoom(room, 'leave');
          else replicateRoomRemoval(roomId);
        }
        broadcastRoomList();
      }
      console.log(`Jugador desconectado: ${username}`);
      broadcastPlayers();
      void sendHeartbeat();
    }
  });

  // ── Errores del socket (evita caídas del proceso) ──────────────────────────
  ws.on('error', (err) => {
    console.error(`Error en el socket de ${username} (${err.code || 'UNKNOWN'}).`);
  });
});

// ── Arranque del servidor ─────────────────────────────────────────────────────
async function promptForCoordinatorName() {
  if (COORDINATOR_NAME) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Define COORDINATOR_NAME o inicia el coordinador desde una terminal interactiva para elegir su nombre.');
  }

  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (!COORDINATOR_NAME) {
      const answer = (await prompt.question(`¿Qué nombre tendrá el coordinador ${COORDINATOR_ID}? `)).trim();
      if (isValidCoordinatorName(answer)) {
        COORDINATOR_NAME = answer;
      } else {
        console.error('Ingresa un nombre de 1 a 48 caracteres, sin saltos de línea ni caracteres de control.');
      }
    }
  } finally {
    prompt.close();
  }
}

async function startCoordinator() {
  await promptForCoordinatorName();
  server.listen(PORT, () => {
    console.log(`Coordinador "${COORDINATOR_NAME}" (${COORDINATOR_ID}) escuchando en http://localhost:${PORT} y peers en ws://localhost:${PEER_PORT}/mesh.`);
    console.log(`WebSocket disponible en ws://localhost:${PORT}/connect (ticket efímero por subprotocolo)`);
    peerHttpServer.listen(PEER_PORT);
    startHeartbeat();
    startPeerDiscovery();
    startPeerSync();
    startPeerRebalance();
  });
}

startCoordinator().catch((err) => {
  console.error(`[coordinator] No se pudo iniciar: ${err.message}`);
  process.exitCode = 1;
});
server.once('close', () => {
  stopHeartbeat();
  stopPeerDiscovery();
  stopPeerSync();
  stopPeerRebalance();
  if (peerHttpServer.listening) peerHttpServer.close();
  if (gameLoopTimer) {
    clearInterval(gameLoopTimer);
    gameLoopTimer = null;
  }
});
process.once('SIGINT', shutdownCoordinator);
process.once('SIGTERM', shutdownCoordinator);

module.exports = {
  app,
  server,
  wss,
  peerWss,
  peerConnections,
  players,
  rooms,
  countOpenLocalPlayers,
  sendHeartbeat,
  stopHeartbeat,
  refreshPeers,
  stopPeerDiscovery,
  get peers() {
    return peers;
  },
  config: {
    COORDINATOR_ID,
    get coordinatorName() {
      return COORDINATOR_NAME;
    },
    PORT,
    PEER_PORT,
    PUBLIC_URL,
    PEER_URL,
    AUTH_URL,
    hasCoordinatorSharedSecret: Boolean(COORDINATOR_SHARED_SECRET)
  }
};
