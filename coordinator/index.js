
// Responsabilidad: aceptar conexiones WebSocket autenticadas con JWT, mantener
// un Map de jugadores en línea y hacer broadcast de la lista ante cada cambio.
// Puerto por defecto: 5000. WebSocket en /connect?token=<JWT>.

const fs = require('node:fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const dotenv = require('dotenv');
const http = require('node:http');
const { URL } = require('node:url');
const express = require('express');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

// ── Verificación de configuración crítica ────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('Error crítico: La variable de entorno JWT_SECRET no está definida.');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = Number(process.env.PORT) || 5000;

// ── Taller 5: parámetros del mundo y del game loop (desde .env) ─────────────
const WORLD_WIDTH = Number(process.env.WORLD_WIDTH) || 800;
const WORLD_HEIGHT = Number(process.env.WORLD_HEIGHT) || 600;
const PLAYER_RADIUS = Number(process.env.PLAYER_RADIUS) || 20;
const PLAYER_SPEED = Number(process.env.PLAYER_SPEED) || 200; // px/seg
const TICK_RATE = Number(process.env.TICK_RATE) || 20;        // Hz
const TICK_MS = 1000 / TICK_RATE;
const MAX_EXTRAS_BYTES = 1024; // límite anti-abuso para extras_update

// ── Estado del coordinador ──────────────────────────────────────────────────
// Map: userId (string) → { username, provider, socket, connectedAt, expirationTimer,
//                          x, y, intent: { x, y }, extras }
const players = new Map();

// ── Helpers de respuesta HTTP (mismo formato que Auth, SPEC.md §3.1) ────────
function sendOk(res, status, message, extra = {}) {
  return res.status(status).json({ ok: true, message, ...extra });
}

function sendError(res, status, code, message, hint) {
  return res.status(status).json({ ok: false, code, message, hint });
}

// ── Helper para enviar un mensaje WS a un socket (si está abierto) ──────────
function sendWs(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ── Broadcast de la lista de jugadores a TODOS los sockets abiertos ──────────
// Formato exacto del PDF: { type, players: [{ userId, username }] }
function broadcastPlayers() {
  const playerList = [];
  for (const [userId, entry] of players) {
    playerList.push({ userId, username: entry.username });
  }
  const msg = JSON.stringify({ type: 'players_update', players: playerList });

  for (const [, entry] of players) {
    if (entry.socket.readyState === entry.socket.OPEN) {
      entry.socket.send(msg);
    }
  }
}

// ── Taller 5: estado del juego ───────────────────────────────────────────────
// Foto del estado que se envía a los clientes (nunca incluye sockets ni timers).
function snapshot() {
  const list = [];
  for (const [userId, p] of players) {
    list.push({
      userId,
      username: p.username,
      provider: p.provider,
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
    if (p.socket.readyState === p.socket.OPEN) {
      p.socket.send(msg);
    }
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

  if (players.size === 0) return; // nadie conectado: no hay a quién enviar

  for (const p of players.values()) {
    // Normalizar diagonales: sin esto (1,1) avanzaría √2 ≈ 41 % más rápido.
    const ix = p.intent.x;
    const iy = p.intent.y;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }

    // Mantener dentro del mundo
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }

  // Un solo broadcast por tick (no uno por cada intent)
  broadcast({ type: 'state', t: now, players: snapshot() });
}

setInterval(tick, TICK_MS);

// ── Express — endpoints HTTP ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

// GET /health
app.get('/health', (req, res) => {
  sendOk(res, 200, 'Coordinador operativo.', {
    service: 'coordinator',
    uptime: Math.floor(process.uptime()),
    onlineCount: players.size
  });
});

// GET /players — solo lectura y diagnóstico; nunca expone sockets ni tokens
app.get('/players', (req, res) => {
  const playerList = [];
  for (const [userId, entry] of players) {
    playerList.push({ userId, username: entry.username });
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
    `Ruta ${req.method} ${req.originalUrl} no encontrada.`,
    'Rutas HTTP disponibles: GET /health, GET /players. El WebSocket está en /connect?token=<JWT>.'
  );
});

// ── Servidor HTTP (http.createServer es requerido para el upgrade manual) ────
const server = http.createServer(app);

// ── Servidor WebSocket (noServer: true — el upgrade se maneja manualmente) ───
// ── Helper para clasificar errores de verificación JWT (reutilizado en upgrade y verify) ──
function classifyJwtError(err) {
  let code = 'TOKEN_MALFORMED';
  let message = 'El token es inválido o no puede procesarse.';
  let hint = 'Copia el token completo devuelto por POST /login.';

  if (err.name === 'TokenExpiredError') {
    code = 'TOKEN_EXPIRED';
    message = 'El token de autenticación ha expirado.';
    hint = 'Inicia sesión de nuevo en POST /login para obtener un token nuevo.';
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

const wss = new WebSocketServer({ noServer: true });

// ── Evento upgrade: verificación de JWT ANTES de aceptar la conexión WS ──────
// Error típico: no verificar en upgrade sino dentro de connection.
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

  const token = parsedUrl.searchParams.get('token');

  // Sin token
  if (!token) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      sendWs(ws, {
        type: 'error',
        ok: false,
        code: 'TOKEN_MISSING',
        message: 'No se proporcionó token de autenticación.',
        hint: 'Conéctate con ws://host/connect?token=<JWT> obtenido en POST /login.'
      });
      ws.close(4001, 'invalid token');
    });
    return;
  }

  // Verificación del token
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    const { code, message, hint } = classifyJwtError(err);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sendWs(ws, { type: 'error', ok: false, code, message, hint });
      ws.close(4001, 'invalid token');
    });
    return;
  }

  // Token válido → completar el handshake y emitir connection con el payload
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, payload);
  });
});

// ── Evento connection: gestión del jugador ────────────────────────────────────
wss.on('connection', (ws, payload) => {
  const userId = String(payload.userId);
  const username = payload.username;
  // provider viene del JWT verificado (no del cliente). Tokens del Taller 4 no lo traen → 'local'.
  const provider = payload.provider === 'google' ? 'google' : 'local';

  // Política de doble pestaña (SPEC.md §3.5): la conexión nueva reemplaza a la anterior.
  // Justificación: un socket "zombi" de una reconexión o refresh bloquearía al usuario
  // si se rechazara la nueva conexión. La intención más reciente del usuario prevalece.
  if (players.has(userId)) {
    const existing = players.get(userId);
    // Cancela el timer de expiración de la sesión anterior
    clearTimeout(existing.expirationTimer);
    // Cierra el socket viejo con el código 4002 (el cliente sabrá que fue reemplazado)
    if (existing.socket.readyState === existing.socket.OPEN) {
      existing.socket.close(4002, 'session replaced');
    }
    console.log(`Sesión reemplazada para: ${username}`);
  }

  // Registrar la nueva entrada en el Map
  const entry = {
    username,
    socket: ws,
    connectedAt: new Date().toISOString(),
    expirationTimer: null,
    provider,
    // Taller 5: posición inicial aleatoria dentro del mundo, quieto y sin extras
    x: PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - 2 * PLAYER_RADIUS),
    y: PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: { x: 0, y: 0 },
    extras: {}
  };
  players.set(userId, entry);

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
        // Sanitizar a -1, 0, 1: NO confiar en el cliente ({x: 9999} queda en 1)
        entry.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
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
        break;
      }

      case 'who':
        // Responde players_update solo al socket que preguntó
        {
          const playerList = [];
          for (const [uid, e] of players) {
            playerList.push({ userId: uid, username: e.username });
          }
          sendWs(ws, { type: 'players_update', players: playerList });
        }
        break;

      case 'verify': {
        // Validación de presencia y tipo de token
        if (!msg.token || typeof msg.token !== 'string') {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'TOKEN_MISSING',
            message: 'No se proporcionó token de autenticación.',
            hint: 'Envía un token válido en el campo token: {"type":"verify","token":"<JWT>"}.'
          });
          ws.close(4001, 'invalid token');
          return;
        }

        let verifyPayload;
        try {
          verifyPayload = jwt.verify(msg.token, JWT_SECRET, { algorithms: ['HS256'] });
        } catch (err) {
          const { code, message, hint } = classifyJwtError(err);
          sendWs(ws, { type: 'error', ok: false, code, message, hint });
          const closeCode = (code === 'TOKEN_EXPIRED') ? 4003 : 4001;
          const closeReason = (code === 'TOKEN_EXPIRED') ? 'token expired' : 'invalid token';
          ws.close(closeCode, closeReason);
          return;
        }

        // Token válido pero de otro usuario
        if (String(verifyPayload.userId) !== userId) {
          sendWs(ws, {
            type: 'error',
            ok: false,
            code: 'TOKEN_MISMATCH',
            message: 'El token no corresponde a esta sesión.',
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
          message: `Tipo de mensaje no reconocido: ${msg.type ?? '(sin tipo)'}.`,
          hint: 'Tipos soportados: ping, who, verify, intent, extras_update.'
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
      players.delete(userId);
      console.log(`Jugador desconectado: ${username}`);
      broadcastPlayers();
    }
  });

  // ── Errores del socket (evita caídas del proceso) ──────────────────────────
  ws.on('error', (err) => {
    console.error(`Error en el socket de ${username}:`, err.message || err.code || err);
  });
});

// ── Arranque del servidor ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Coordinador escuchando en http://localhost:${PORT}`);
  console.log(`WebSocket disponible en ws://localhost:${PORT}/connect?token=<JWT>`);
});

module.exports = { app, server, wss, players };
