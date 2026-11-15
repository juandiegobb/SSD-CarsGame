'use strict';

// Taller 7: mesh entre auths (WebSocket en PEER_PORT, ruta /auth-mesh).
//
// - Una conexión por par: la inicia el auth con el authId MENOR (igual que la regla del
//   ID menor del mesh de coordinadores). Si llega una conexión duplicada, se cierra.
// - Solo entran auths que conocen el secreto compartido (header x-auth-mesh-secret)
//   y que están en AUTH_PEERS.
// - Lo primero que se manda en ambos sentidos es { type: 'hello', ... }: con eso cada
//   lado sabe quién es el otro. Antes del hello no se acepta ningún otro mensaje.
// - ping/pong cada 2 s: si un peer no contesta en 6 s se da por caído y se cierra.
// - Las conexiones salientes se reintentan cada 2 s mientras el peer esté caído.
//
// Este módulo solo mueve mensajes. Qué hacer con cada tipo lo deciden replication.js
// (heartbeat, write_propagate, write_ack, request_sync, sync_response) y election.js
// (election, vote, new_leader).

const { timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const MESH_PATH = '/auth-mesh';
const SECRET_HEADER = 'x-auth-mesh-secret';
const MESSAGE_TYPES = new Set([
  'hello',
  'heartbeat',
  'write_propagate',
  'write_ack',
  'request_sync',
  'sync_response',
  'election',
  'vote',
  'new_leader'
]);
const AUTH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function meshUrlOf(peerUrl) {
  const url = new URL(peerUrl);
  if (!url.pathname.endsWith(MESH_PATH)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${MESH_PATH}`;
  }
  return url.toString();
}

function createAuthMesh({
  config,
  secret,
  getHello,
  log = console,
  pingIntervalMs = 2000,
  deadAfterMs = 6000,
  reconnectMs = 2000
}) {
  const knownPeers = new Map(config.peers.map((peer) => [peer.authId, peer]));
  const sockets = new Map(); // authId → ws (ya identificado con hello)
  const handlers = new Map(); // type → [fn(msg, fromAuthId)]
  const upListeners = [];
  const downListeners = [];
  const reconnectTimers = new Map();
  let server = null;
  let pingTimer = null;
  let stopped = true;

  function on(type, handler) {
    if (!MESSAGE_TYPES.has(type)) throw new Error(`Tipo de mensaje del mesh desconocido: ${type}`);
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(handler);
  }

  function emit(type, msg, from) {
    for (const handler of handlers.get(type) || []) {
      try {
        handler(msg, from);
      } catch (err) {
        log.error(`[auth-mesh] Error procesando ${type} de ${from}: ${err.message}`);
      }
    }
  }

  function sendRaw(ws, msg) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function send(authId, msg) {
    const ws = sockets.get(authId);
    return ws ? sendRaw(ws, msg) : false;
  }

  function broadcast(msg) {
    let sent = 0;
    for (const ws of sockets.values()) if (sendRaw(ws, msg)) sent += 1;
    return sent;
  }

  function connectedPeers() {
    return [...sockets.keys()].sort();
  }

  // Valida el hello y decide si esta conexión se queda (devuelve el authId) o se cierra.
  function identify(ws, msg, direction) {
    const authId = msg.authId;
    if (typeof authId !== 'string' || !AUTH_ID_PATTERN.test(authId) || authId === config.authId) {
      ws.close(4001, 'hello inválido');
      return null;
    }
    if (!knownPeers.has(authId)) {
      log.error(`[auth-mesh] ${authId} no está en AUTH_PEERS: conexión rechazada.`);
      ws.close(4003, 'auth desconocido');
      return null;
    }
    // Regla del ID menor: solo aceptamos conexiones ENTRANTES de auths con ID menor al nuestro
    if (direction === 'in' && !(authId < config.authId)) {
      ws.close(4004, 'debe conectar el ID menor');
      return null;
    }
    const existing = sockets.get(authId);
    if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
      ws.close(4009, 'conexión duplicada');
      return null;
    }
    sockets.set(authId, ws);
    log.info(`[auth-mesh] Conectado con ${authId} (${direction === 'out' ? 'saliente' : 'entrante'}).`);
    for (const listener of upListeners) listener(authId);
    return authId;
  }

  function attach(ws, direction, expectedAuthId = null) {
    let peerId = null;
    ws.isAlive = true;
    ws.lastPongAt = Date.now();
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // basura: se ignora
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !MESSAGE_TYPES.has(msg.type)) return;
      ws.lastPongAt = Date.now(); // cualquier mensaje cuenta como señal de vida

      if (!peerId) {
        if (msg.type !== 'hello') return; // nada antes del hello
        if (expectedAuthId && msg.authId !== expectedAuthId) {
          ws.close(4001, 'authId distinto al esperado');
          return;
        }
        peerId = identify(ws, msg, direction);
        if (!peerId) return;
      }
      emit(msg.type, msg, peerId);
    });

    ws.on('close', () => {
      if (peerId && sockets.get(peerId) === ws) {
        sockets.delete(peerId);
        log.info(`[auth-mesh] Desconectado de ${peerId}.`);
        for (const listener of downListeners) listener(peerId);
      }
      if (direction === 'out' && expectedAuthId) scheduleReconnect(expectedAuthId);
    });
    ws.on('error', () => {}); // el 'close' que viene después se encarga

    ws.on('open', () => sendRaw(ws, { type: 'hello', ...getHello() }));
    if (ws.readyState === WebSocket.OPEN) sendRaw(ws, { type: 'hello', ...getHello() });
  }

  function connectTo(peer) {
    if (stopped || sockets.has(peer.authId)) return;
    let ws;
    try {
      ws = new WebSocket(meshUrlOf(peer.peerUrl), {
        headers: { [SECRET_HEADER]: secret, 'ngrok-skip-browser-warning': 'true' },
        maxPayload: MAX_MESSAGE_BYTES,
        handshakeTimeout: 5000
      });
    } catch {
      scheduleReconnect(peer.authId);
      return;
    }
    attach(ws, 'out', peer.authId);
  }

  function scheduleReconnect(authId) {
    if (stopped || reconnectTimers.has(authId)) return;
    const timer = setTimeout(() => {
      reconnectTimers.delete(authId);
      const peer = knownPeers.get(authId);
      if (peer) connectTo(peer);
    }, reconnectMs);
    timer.unref?.();
    reconnectTimers.set(authId, timer);
  }

  function start() {
    if (!stopped) return Promise.resolve();
    stopped = false;
    return new Promise((resolve, reject) => {
      server = new WebSocketServer({
        port: config.peerPort,
        path: MESH_PATH,
        maxPayload: MAX_MESSAGE_BYTES,
        verifyClient: (info, done) => {
          if (secretsMatch(info.req.headers[SECRET_HEADER], secret)) return done(true);
          log.error('[auth-mesh] Conexión rechazada: secreto del mesh incorrecto.');
          return done(false, 401, 'Unauthorized');
        }
      });
      server.on('connection', (ws) => attach(ws, 'in'));
      server.once('error', reject);
      server.once('listening', () => {
        server.off('error', reject);
        server.on('error', (err) => log.error(`[auth-mesh] Error del servidor del mesh: ${err.message}`));
        // Inicia las conexiones hacia los peers con ID MAYOR que el nuestro
        for (const peer of knownPeers.values()) {
          if (config.authId < peer.authId) connectTo(peer);
        }
        pingTimer = setInterval(() => {
          const now = Date.now();
          for (const ws of sockets.values()) {
            if (now - ws.lastPongAt > deadAfterMs) {
              ws.terminate(); // no contesta: se da por caído
              continue;
            }
            if (ws.readyState === WebSocket.OPEN) ws.ping();
          }
        }, pingIntervalMs);
        pingTimer.unref?.();
        resolve();
      });
    });
  }

  function stop() {
    stopped = true;
    clearInterval(pingTimer);
    for (const timer of reconnectTimers.values()) clearTimeout(timer);
    reconnectTimers.clear();
    for (const ws of sockets.values()) ws.terminate();
    sockets.clear();
    return new Promise((resolve) => {
      if (!server) return resolve();
      for (const client of server.clients) client.terminate();
      server.close(() => resolve());
      server = null;
    });
  }

  return {
    start,
    stop,
    on,
    send,
    broadcast,
    connectedPeers,
    onPeerUp: (fn) => upListeners.push(fn),
    onPeerDown: (fn) => downListeners.push(fn)
  };
}

module.exports = { createAuthMesh, MESH_PATH, SECRET_HEADER, meshUrlOf };
