// Servicio de Autenticación (Auth Service) - Talleres 4 y 5 Sistemas Distribuidos
// Responsabilidad: Registro, Login con JWT (1h) y persistencia en SQLite propia.
// Taller 5: una sola tabla users con campo provider ('local' | 'google').
// Puerto por defecto: 4000

const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
// Taller 5: node:sqlite (incluido en Node) y bcryptjs (JS puro), como en el esqueleto del PDF.
// Ninguno necesita compilarse, así que npm install funciona sin Python ni Visual Studio.
// bcryptjs lee los mismos hashes $2b$ que generaba bcrypt: las cuentas existentes siguen sirviendo.
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { hasCoordinatorEndpointConflict } = require('./coordinator-directory');
const { loadClusterConfig, ClusterConfigError } = require('./cluster-config');
const { createReplicationLog } = require('./replication-log');
const { createClusterState } = require('./cluster-state');
const { createAuthMesh } = require('./auth-mesh');
const { createReplication } = require('./replication');
const { createElection } = require('./election');

// 1. Verificación de configuración y variables de entorno críticas
if (!process.env.JWT_SECRET) {
  console.error('Error crítico: La variable de entorno JWT_SECRET no está definida.');
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('Error crítico: JWT_SECRET debe tener al menos 32 caracteres (Taller 5).');
  process.exit(1);
}

// Taller 5: Client ID de Google (Google Cloud Console → Credentials → OAuth client ID).
// [Decisión] Si falta, el servicio arranca igual (registro/login local siguen funcionando)
// y POST /auth/google responde 503 GOOGLE_NOT_CONFIGURED.
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
if (!googleClient) {
  console.warn('[auth-service] GOOGLE_CLIENT_ID no está definido: POST /auth/google responderá 503.');
}

const JWT_SECRET = process.env.JWT_SECRET;

// Taller 7: identidad de este auth dentro del grupo replicado (AUTH_ID, puertos, peers…)
let CLUSTER;
try {
  CLUSTER = loadClusterConfig();
} catch (err) {
  if (!(err instanceof ClusterConfigError)) throw err;
  console.error(`Error de configuración: ${err.message}`);
  process.exit(1);
}
const PORT = CLUSTER.port;

// Taller 7: secreto del mesh entre auths. Si no se define AUTH_MESH_SECRET se usa
// COORDINATOR_SHARED_SECRET (ya es igual en todos los auths). Sin secreto no hay mesh.
const AUTH_MESH_SECRET = (process.env.AUTH_MESH_SECRET || process.env.COORDINATOR_SHARED_SECRET || '').trim();
if (CLUSTER.peers.length > 0 && AUTH_MESH_SECRET.length < 16) {
  console.error('Error de configuración: con AUTH_PEERS hace falta AUTH_MESH_SECRET (o COORDINATOR_SHARED_SECRET) de al menos 16 caracteres, igual en todos los auths.');
  process.exit(1);
}
const DB_PATH = process.env.DB_PATH || 'users.db';
const ENV_PATH = path.join(__dirname, '.env');
const coordinators = new Map();
const COORDINATOR_TTL_MS = 6000;
const COORDINATOR_CLEANUP_INTERVAL_MS = 1000;
let coordinatorCleanupTimer = null;

function isCoordinatorLive(coordinator, now = Date.now()) {
  const lastHeartbeat = Date.parse(coordinator?.lastHeartbeat);
  if (!Number.isFinite(lastHeartbeat)) return false;

  const age = now - lastHeartbeat;
  return age >= 0 && age <= COORDINATOR_TTL_MS;
}

function pruneExpiredCoordinators(now = Date.now()) {
  let removed = 0;
  for (const [coordinatorId, coordinator] of coordinators) {
    if (!isCoordinatorLive(coordinator, now)) {
      coordinators.delete(coordinatorId);
      removed += 1;
    }
  }
  return removed;
}

function startCoordinatorCleanup() {
  if (coordinatorCleanupTimer) return;

  coordinatorCleanupTimer = setInterval(
    () => pruneExpiredCoordinators(),
    COORDINATOR_CLEANUP_INTERVAL_MS
  );
  coordinatorCleanupTimer.unref();
}

function stopCoordinatorCleanup() {
  if (!coordinatorCleanupTimer) return;
  clearInterval(coordinatorCleanupTimer);
  coordinatorCleanupTimer = null;
}

// Almacena en memoria el último valor válido de expiración (por defecto el del arranque o '1h')
let currentJwtExpiresIn = process.env.JWT_EXPIRES_IN || '1h';
// Si el valor inicial eran solo dígitos, normalizar a Number (segundos)
if (/^\d+$/.test(String(currentJwtExpiresIn).trim())) {
  currentJwtExpiresIn = Number(String(currentJwtExpiresIn).trim());
}

// Función que lee el .env en caliente en cada consulta sin reiniciar el proceso
function getJwtExpiresIn() {
  try {
    if (fs.existsSync(ENV_PATH)) {
      const rawEnv = fs.readFileSync(ENV_PATH, 'utf8');
      const parsed = dotenv.parse(rawEnv);
      if (parsed && parsed.JWT_EXPIRES_IN !== undefined) {
        const val = parsed.JWT_EXPIRES_IN.trim();

        // 1. Si son solo dígitos (ej. "10"), convertir con Number() para interpretarlo como SEGUNDOS
        // (un string numérico "10" en jsonwebtoken se interpretaría como 10 milisegundos)
        if (/^\d+$/.test(val)) {
          const num = Number(val);
          if (num > 0) {
            currentJwtExpiresIn = num;
            return currentJwtExpiresIn;
          }
        } else if (/^\d+[smhdw]$/i.test(val)) {
          // 2. Valores con sufijo de tiempo (ej. '10s', '30s', '1h', '7d')
          currentJwtExpiresIn = val;
          return currentJwtExpiresIn;
        }

        // 3. Valor inválido o vacío: emitir advertencia genérica sin filtrar contenido ni secretos
        if (val !== '') {
          console.warn('[auth-service] Advertencia: Formato de JWT_EXPIRES_IN inválido en .env. Se conserva el último valor válido.');
        }
      }
    }
  } catch (err) {
    console.warn('[auth-service] No se pudo leer la configuración dinámica de JWT_EXPIRES_IN.');
  }
  return currentJwtExpiresIn;
}

// BCRYPT_ROUNDS: Mínimo 10 por especificación de seguridad
let configuredRounds = Number(process.env.BCRYPT_ROUNDS) || 10;
if (configuredRounds < 10) {
  configuredRounds = 10;
}
const BCRYPT_ROUNDS = configuredRounds;

// Hash ficticio para mitigar ataques de temporización (timing attacks) en el login
const DUMMY_HASH = bcrypt.hashSync('dummy_password_timing_defense', BCRYPT_ROUNDS);

// 2. Inicialización de la base de datos SQLite propia
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL'); // Modo WAL para mejor concurrencia

// Una sola tabla para los dos métodos de autenticación (SPEC.md §10.2).
// Si hubiera dos tablas (users_local, users_google), un mismo username podría existir
// dos veces y el resto del sistema (coordinador, score, replicación) tendría que duplicarse.
// El CHECK de tabla impide filas inconsistentes: local ⇒ password_hash y sin google_sub;
// google ⇒ google_sub y email, sin password_hash.
const USERS_TABLE_SQL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local','google')),
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    email TEXT,
    picture_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (provider = 'local'  AND password_hash IS NOT NULL AND google_sub IS NULL) OR
      (provider = 'google' AND password_hash IS NULL AND google_sub IS NOT NULL AND email IS NOT NULL)
    )
  )
`;

// Crea la tabla o, si viene de una base del Taller 4 (sin columna provider), la migra
// conservando a los usuarios existentes como 'local'. Todo en una transacción.
function ensureUsersTable() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);

  if (columns.length === 0) {
    db.exec(USERS_TABLE_SQL);
    return;
  }
  if (columns.includes('provider')) {
    return; // ya tiene el esquema del Taller 5
  }

  console.log('[auth-service] Migrando users.db del Taller 4 al esquema con provider...');
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE users RENAME TO users_taller4');
    db.exec(USERS_TABLE_SQL);
    db.exec(`
      INSERT INTO users (id, username, provider, password_hash, created_at)
      SELECT id, username, 'local', password_hash, created_at FROM users_taller4
    `);
    db.exec('DROP TABLE users_taller4');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log('[auth-service] Migración completada: los usuarios existentes quedaron como provider=local.');
}
ensureUsersTable();

// Taller 6 (corrección): foto de perfil de Google. Si la base es anterior y no tiene
// la columna, se agrega sin tocar a los usuarios existentes (quedan con NULL).
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'picture_url')) {
  db.exec('ALTER TABLE users ADD COLUMN picture_url TEXT');
  console.log('[auth-service] Columna picture_url agregada a users.');
}

// Los nombres de usuario representan la misma identidad sin importar las mayúsculas.
// Se guardan siempre en minúsculas para que la información mostrada sea uniforme.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase ON users(username COLLATE NOCASE)');
db.exec('BEGIN');
try {
  const rows = db.prepare('SELECT id, username FROM users').all();
  const updateUsername = db.prepare('UPDATE users SET username = ? WHERE id = ?');
  for (const row of rows) {
    const normalized = String(row.username || '').trim().toLowerCase();
    if (normalized && normalized !== row.username) updateUsername.run(normalized, row.id);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// Sentencias preparadas para reutilización y prevención de inyección SQL.
// Los literales SQL llevan comillas SIMPLES (SQLite interpreta las dobles como nombres de columna).
const stmts = {
  insertLocal: db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle: db.prepare("INSERT INTO users (username, provider, google_sub, email, picture_url) VALUES (?, 'google', ?, ?, ?)"),
  updatePicture: db.prepare('UPDATE users SET picture_url = ? WHERE id = ?'),
  findByUsername: db.prepare('SELECT * FROM users WHERE username COLLATE NOCASE = ?'),
  findByGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?')
};

// Taller 7: registro numerado de escrituras (replication_log) y metadatos (term, voto).
// Las bases anteriores al Taller 7 anotan una vez a sus usuarios para poder replicarlos.
const replicationLog = createReplicationLog(db);
const backfilledUsers = replicationLog.backfillExistingUsers();
if (backfilledUsers > 0) {
  console.log(`[auth-service] ${backfilledUsers} usuario(s) existente(s) anotado(s) en replication_log.`);
}

// Taller 7: rol de este auth (leader / replica / candidate), term y líder conocido.
// Un auth solo es líder de una vez. En grupo arranca como réplica: si ya hay líder lo
// aprende en el hello del mesh; si no, se elige uno (election.js). Nunca recupera solo
// el liderazgo que tenía antes de caerse.
const clusterState = createClusterState({ config: CLUSTER, replicationLog });
let lastLoggedRole = null;
clusterState.onChange((state, reason) => {
  const summary = `${state.role}|${state.term}|${state.leaderId}`;
  if (summary === lastLoggedRole) return;
  lastLoggedRole = summary;
  console.log(`[auth-service] Rol: ${state.role} · term ${state.term} · líder: ${state.leaderId || 'desconocido'} (${reason}).`);
});
if (CLUSTER.peers.length === 0) clusterState.startWithProvisionalLeader();
else clusterState.startAsReplica();

// Taller 7: mesh entre auths + replicación (heartbeat, write_propagate/ack, sync) + elección
let replication = null;
const authMesh = createAuthMesh({
  config: CLUSTER,
  secret: AUTH_MESH_SECRET,
  getHello: () => replication.hello()
});
replication = createReplication({ config: CLUSTER, mesh: authMesh, clusterState, replicationLog });
const election = createElection({ config: CLUSTER, mesh: authMesh, clusterState, replicationLog });

// Opción B (SPEC §13.7): el líder responde la escritura cuando al menos 1 réplica la confirmó.
// Si nadie confirma en REPLICATION_ACK_TIMEOUT_MS → 503 replication_timeout (el cambio queda
// en el líder y llegará a las réplicas por sync, pero el cliente sabe que no está confirmado).
async function confirmReplicated(res, entry) {
  if (!entry) return true;
  const confirmed = await replication.waitForAck(entry.seq);
  if (confirmed) return true;
  sendError(
    res,
    503,
    'REPLICATION_TIMEOUT',
    'El registro quedó en el líder, pero ninguna réplica lo confirmó a tiempo.',
    'Intenta iniciar sesión en unos segundos; si no funciona, vuelve a registrarte.',
    undefined,
    { error: 'replication_timeout' }
  );
  return false;
}

// 3. Helpers únicos de respuesta según SPEC.md §3.1
function sendOk(res, status, message, extra = {}) {
  return res.status(status).json({
    ok: true,
    message,
    ...extra
  });
}

function sendError(res, status, code, message, hint, details = undefined, extra = {}) {
  const payload = {
    ok: false,
    code,
    message,
    hint,
    ...extra
  };
  if (details !== undefined) {
    payload.details = details;
  }
  return res.status(status).json(payload);
}

function hasValidCoordinatorSecret(providedSecret) {
  const expectedSecret = process.env.COORDINATOR_SHARED_SECRET;
  if (typeof expectedSecret !== 'string' || expectedSecret.length === 0 ||
      typeof providedSecret !== 'string' || providedSecret.length === 0) {
    return false;
  }

  const expected = Buffer.from(expectedSecret, 'utf8');
  const provided = Buffer.from(providedSecret, 'utf8');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function isValidCoordinatorUrl(value) {
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

function isValidCoordinatorName(value) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    [...value.trim()].length <= 48 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

// Misma regla de username para /register y /auth/google (SPEC.md §3.2).
function validateUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_]{3,32}$/.test(u.trim());
}

function normalizeUsername(u) {
  return typeof u === 'string' ? u.trim().toLowerCase() : u;
}

// Solo se acepta la foto si es una URL https de Google (lh3.googleusercontent.com, etc.).
// Así nadie puede colar en el JWT una URL arbitraria que luego se muestre a otros jugadores.
function safePictureUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.googleusercontent.com') ? url.href : null;
  } catch {
    return null;
  }
}

function isUniqueViolation(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (err.message && err.message.includes('UNIQUE constraint failed')));
}

// Emite el JWT propio del sistema. Es el mismo para usuarios locales y de Google:
// el coordinador no necesita saber cómo se autenticó cada jugador, solo verifica la firma.
// provider viaja en el payload para poder mostrar una insignia en el juego.
function emitToken(user) {
  const payload = {
    userId: String(user.id),
    username: normalizeUsername(user.username),
    provider: user.provider
  };
  // Taller 6: la foto de perfil de Google viaja en el JWT para que el lobby la muestre
  if (user.picture_url) payload.picture = user.picture_url;
  try {
    return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: getJwtExpiresIn() });
  } catch (signErr) {
    console.warn('[auth-service] Advertencia al firmar con expiración dinámica. Usando respaldo de 1h.');
    return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  }
}

// Segundos de vigencia de un token (exp - iat), para informarlo al cliente.
function tokenLifetimeSeconds(token) {
  const decoded = jwt.decode(token);
  return (decoded && decoded.exp && decoded.iat) ? decoded.exp - decoded.iat : 3600;
}

// 4. Configuración de Express y Middlewares
const app = express();

// CORS: orígenes permitidos desde .env, con soporte para el header de ngrok y preflight OPTIONS
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origen (curl, Thunder Client, mobile apps)
    if (!origin) return callback(null, true);
if (allowedOrigins.includes(origin) || allowedOrigins.includes('*') || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('ngrok-free.app') || origin.includes('ngrok-free.dev') || origin.includes('ngrok.io')) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

// Parser de cuerpo JSON
app.use(express.json({ limit: '4kb' }));

// 5. Endpoints de la API

// Taller 7: solo el líder acepta escrituras (single-writer replication, SPEC.md §13.4).
// Una réplica responde 503 not_leader con la URL del líder para que el cliente repita ahí.
// Si no se sabe quién es el líder (elección en curso), 503 no_leader: hay que reintentar.
// kind = 'write' (registrar, crear cuenta), 'read' (login en una réplica demasiado atrasada)
//        o 'directory' (heartbeats y consultas del directorio de coordinadores)
function rejectNotLeader(res, kind = 'write') {
  const { role, leaderUrl } = clusterState.describe();
  if (role !== 'candidate' && leaderUrl) {
    return sendError(
      res,
      503,
      'NOT_LEADER',
      kind === 'read'
        ? 'Esta réplica está atrasada respecto al líder: la petición la atiende el líder.'
        : kind === 'directory'
          ? 'Este auth es una réplica: el directorio de coordinadores lo atiende el líder.'
          : 'Este auth es una réplica: las escrituras las atiende el líder.',
      'Repite la misma petición contra leaderUrl.',
      undefined,
      { error: 'not_leader', leaderUrl }
    );
  }
  return sendError(
    res,
    503,
    'NO_LEADER',
    'Se está eligiendo un nuevo líder; por unos segundos no se aceptan escrituras.',
    'Reintenta en unos segundos.',
    undefined,
    { error: 'no_leader' }
  );
}

// Taller 7: el directorio de coordinadores vive en memoria y NO se replica (SPEC.md §13.4).
// Solo el líder lo atiende; una réplica responde 503 not_leader con leaderUrl y el
// coordinador o el cliente repiten ahí. Al cambiar de líder, el nuevo empieza vacío y los
// coordinadores lo llenan con su siguiente heartbeat (≤ 2 s).
function requireLeaderDirectory(req, res, next) {
  if (clusterState.isLeader()) return next();
  return rejectNotLeader(res, 'directory');
}

// GET /health - Monitoreo y estado del servicio (incluye jwtExpiresIn activo)
app.get('/health', (req, res) => {
  const activeExpiresIn = getJwtExpiresIn();
  sendOk(res, 200, 'Servicio de autenticación operativo.', {
    service: 'auth-service',
    uptime: Math.floor(process.uptime()),
    jwtExpiresIn: String(activeExpiresIn)
  });
});

// POST /heartbeat - Registra o actualiza un coordinador autenticado en memoria.
app.post('/heartbeat', requireLeaderDirectory, (req, res) => {
  if (!hasValidCoordinatorSecret(req.get('x-coordinator-secret'))) {
    return sendError(
      res,
      401,
      'UNAUTHORIZED',
      'No autorizado.',
      'Verifica las credenciales de servicio e inténtalo de nuevo.'
    );
  }

  const { coordinatorId, coordinatorName, publicUrl, peerUrl, load, connectedPlayers, uptime } = req.body || {};
  const validCoordinatorId = typeof coordinatorId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(coordinatorId);
  const displayName = coordinatorName === undefined ? coordinatorId : coordinatorName;
  const playerCount = connectedPlayers === undefined ? load : connectedPlayers;
  const validLoad = Number.isSafeInteger(playerCount) && playerCount >= 0 &&
    (load === undefined || connectedPlayers === undefined || load === connectedPlayers);
  const validUptime = uptime === undefined || (Number.isSafeInteger(uptime) && uptime >= 0);

  if (!validCoordinatorId || !isValidCoordinatorName(displayName) || !isValidCoordinatorUrl(publicUrl) ||
      !isValidCoordinatorUrl(peerUrl) || !validLoad || !validUptime) {
    return sendError(
      res,
      400,
      'INVALID_BODY',
      'Los datos del coordinador son inválidos o están incompletos.',
      'Envía coordinatorId, coordinatorName, publicUrl y peerUrl válidos, connectedPlayers como entero no negativo (o load por compatibilidad) y uptime opcional en segundos.'
    );
  }

  const existingCoordinator = coordinators.get(coordinatorId);
  if (hasCoordinatorEndpointConflict(existingCoordinator, { publicUrl, peerUrl })) {
    return sendError(
      res,
      409,
      'COORDINATOR_ID_CONFLICT',
      'El identificador del coordinador ya está registrado con otros endpoints.',
      'Asigna un COORDINATOR_ID único a cada coordinador y vuelve a iniciar esta instancia.'
    );
  }

  coordinators.set(coordinatorId, {
    coordinatorId,
    coordinatorName: displayName.trim(),
    publicUrl,
    peerUrl,
    load: playerCount,
    connectedPlayers: playerCount,
    uptime: uptime ?? 0,
    lastHeartbeat: new Date().toISOString(),
    pendingAssignments: 0
  });

  return sendOk(res, 200, 'Heartbeat recibido.');
});

// GET /coordinator - Selecciona el coordinador vigente con menor carga.
// Distribuye equitativamente entre los coordinadores vigentes con menor carga.
let coordinatorTieBreaker = 0;

app.get('/coordinator', requireLeaderDirectory, (req, res) => {
  const now = Date.now();
  const liveCoordinators = [...coordinators.values()]
    .filter((coordinator) => isCoordinatorLive(coordinator, now))
    .sort((a, b) => (a.coordinatorId < b.coordinatorId ? -1 : a.coordinatorId > b.coordinatorId ? 1 : 0));

  if (liveCoordinators.length === 0) {
    return res.status(503).json({ error: 'no_coordinators_available' });
  }

  // Descartar asignaciones pendientes que superen 5 segundos sin completarse
  for (const c of liveCoordinators) {
    if (c.pendingAssignments && (now - (c.lastAssignmentAt || 0) > 5000)) {
      c.pendingAssignments = 0;
    }
  }

  // Calcular la carga mínima efectiva (carga reportada + asignaciones recientes)
  let minEffectiveLoad = Infinity;
  for (const c of liveCoordinators) {
    const effective = (c.load || 0) + (c.pendingAssignments || 0);
    if (effective < minEffectiveLoad) {
      minEffectiveLoad = effective;
    }
  }

  const tiedCandidates = liveCoordinators.filter(
    (c) => ((c.load || 0) + (c.pendingAssignments || 0)) === minEffectiveLoad
  );

  const selected = tiedCandidates[coordinatorTieBreaker % tiedCandidates.length];
  coordinatorTieBreaker = (coordinatorTieBreaker + 1) % 1000000;

  selected.pendingAssignments = (selected.pendingAssignments || 0) + 1;
  selected.lastAssignmentAt = now;

  return res.json({
    coordinatorId: selected.coordinatorId,
    coordinatorName: selected.coordinatorName || selected.coordinatorId,
    publicUrl: selected.publicUrl
  });
});

// GET /peers - Lista coordinadores vigentes excepto el solicitante, sin mutar el directorio.
// Taller 7: GET /status - estado de este auth dentro del grupo replicado. Lo responde
// cualquier rol (líder, réplica o candidato) y nunca redirige: sirve para la demo y el debug.
app.get('/status', (req, res) => {
  const state = clusterState.describe();
  return res.json({
    authId: CLUSTER.authId,
    role: state.role,
    term: state.term,
    publicUrl: CLUSTER.publicUrl,
    peerUrl: CLUSTER.peerUrl,
    leaderUrl: state.leaderUrl,
    knownPeers: clusterState.listPeers().map((peer) => peer.authId),
    connectedPeers: authMesh.connectedPeers(),
    lastAppliedSeq: state.lastAppliedSeq,
    users: replicationLog.usersCount()
  });
});

// Rol de un peer visto desde aquí: lo que dijo el mesh o, si aún no se sabe, se deduce del líder conocido
function peerRole(peer, leaderId) {
  if (!peer.connected) return 'unreachable';
  if (leaderId) return peer.authId === leaderId ? 'leader' : 'replica';
  return peer.role;
}

// GET /peers tiene dos usos, según el parámetro (SPEC.md §13.5):
//   GET /peers                     → Taller 7: los auth-services conocidos por este nodo
//   GET /peers?coordinatorId=<ID>  → Taller 6: el directorio de coordinadores (así lo llaman siempre)
app.get('/peers', (req, res) => {
  const coordinatorId = req.query.coordinatorId;
  if (coordinatorId === undefined) {
    const { leaderId } = clusterState.describe();
    return res.json({
      peers: clusterState.listPeers().map((peer) => ({
        authId: peer.authId,
        publicUrl: peer.publicUrl,
        peerUrl: peer.peerUrl,
        role: peerRole(peer, leaderId),
        connected: peer.connected
      }))
    });
  }

  // Con coordinatorId es el directorio de coordinadores (Taller 6) → solo el líder
  if (!clusterState.isLeader()) return rejectNotLeader(res, 'directory');

  if (typeof coordinatorId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(coordinatorId)) {
    return sendError(
      res,
      400,
      'INVALID_COORDINATOR_ID',
      'El identificador del coordinador es inválido o no fue proporcionado.',
      'Envía un coordinatorId válido como parámetro de consulta.'
    );
  }

  const now = Date.now();
  const peers = [...coordinators.values()]
    .filter((coordinator) =>
      coordinator.coordinatorId !== coordinatorId &&
      isCoordinatorLive(coordinator, now)
    )
    .sort((a, b) => a.coordinatorId < b.coordinatorId ? -1 : a.coordinatorId > b.coordinatorId ? 1 : 0)
    .map(({ coordinatorId: peerId, coordinatorName, publicUrl, peerUrl }) => ({
      coordinatorId: peerId,
      coordinatorName: coordinatorName || peerId,
      publicUrl,
      peerUrl
    }));

  return res.json({ peers });
});

// GET /coordinators - Inspección de estado sin modificar el directorio.
app.get('/coordinators', requireLeaderDirectory, (req, res) => {
  const now = Date.now();
  const directory = [...coordinators.values()]
    .sort((a, b) => a.coordinatorId < b.coordinatorId ? -1 : a.coordinatorId > b.coordinatorId ? 1 : 0)
    .map(({ coordinatorId, coordinatorName, publicUrl, peerUrl, load, connectedPlayers, uptime, lastHeartbeat }) => ({
      coordinatorId,
      coordinatorName: coordinatorName || coordinatorId,
      publicUrl,
      peerUrl,
      load,
      connectedPlayers,
      uptime,
      lastHeartbeat,
      live: isCoordinatorLive({ lastHeartbeat }, now)
    }));

  return sendOk(res, 200, 'Directorio de coordinadores.', { coordinators: directory });
});

// POST /register - Registro de nuevo usuario
app.post('/register', async (req, res, next) => {
  try {
    // Taller 7: registrar es una escritura → solo el líder
    if (!clusterState.isLeader()) return rejectNotLeader(res);

    // Validación de existencia y tipo de body
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(
        res,
        400,
        'INVALID_BODY',
        'El cuerpo de la petición es inválido o no es un objeto JSON.',
        'Envía JSON con header Content-Type: application/json y los campos username y password.'
      );
    }

    const { username, password } = req.body;

    // Validación de username: string, 3 a 32 caracteres, alfanumérico o guion bajo
    if (!validateUsername(username)) {
      return sendError(
        res,
        400,
        'INVALID_USERNAME',
        'El nombre de usuario es inválido o no cumple el formato requerido.',
        'Usa 3–32 caracteres: letras, números o guion bajo.',
        [{ field: 'username', problem: 'must be 3-32 characters: letters, numbers or underscore' }]
      );
    }

    // Validación de password: string, 8 a 72 caracteres (72 = límite de bcrypt)
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return sendError(
        res,
        400,
        'INVALID_PASSWORD',
        'La contraseña es inválida o no cumple con la longitud permitida.',
        'Usa una contraseña de 8 a 72 caracteres.',
        [{ field: 'password', problem: 'must be between 8 and 72 characters' }]
      );
    }

    const cleanUsername = normalizeUsername(username);

    if (stmts.findByUsername.get(cleanUsername)) {
      return sendError(
        res,
        409,
        'USERNAME_TAKEN',
        'El nombre de usuario ya está registrado.',
        'Elige otro username o inicia sesión con cualquier combinación de mayúsculas y minúsculas.',
        [{ field: 'username', problem: 'already exists (case-insensitive)' }]
      );
    }

    // Hashing seguro de la contraseña
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    try {
      // Taller 7: la fila en users y su entrada en replication_log van en una sola transacción
      let newUserId;
      const entry = replicationLog.recordLocalWrite('register', () => {
        const info = stmts.insertLocal.run(cleanUsername, passwordHash);
        newUserId = Number(info.lastInsertRowid);
        return replicationLog.dataForUser('register', newUserId);
      });
      console.log(`Usuario registrado: ${cleanUsername} (seq ${entry.seq})`);
      if (!(await confirmReplicated(res, entry))) return;

      return sendOk(res, 201, 'Usuario registrado exitosamente.', {
        userId: String(newUserId),
        username: cleanUsername
      });
    } catch (dbErr) {
      // Capturar restricción UNIQUE para evitar condiciones de carrera
      if (isUniqueViolation(dbErr)) {
        return sendError(
          res,
          409,
          'USERNAME_TAKEN',
          'El nombre de usuario ya está registrado.',
          'Elige otro username o inicia sesión en POST /login.',
          [{ field: 'username', problem: 'already exists' }]
        );
      }
      throw dbErr;
    }
  } catch (err) {
    next(err);
  }
});

// POST /login - Autenticación y emisión de JWT
app.post('/login', async (req, res, next) => {
  try {
    // Validación básica de presencia de campos sin filtrar reglas avanzadas
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length === 0
    ) {
      return sendError(
        res,
        400,
        'INVALID_BODY',
        'El cuerpo de la petición es inválido o no es un objeto JSON.',
        'Envía JSON con header Content-Type: application/json y los campos username y password.'
      );
    }

    const { username, password } = req.body;

    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username.trim() ||
      !password
    ) {
      return sendError(
        res,
        400,
        'INVALID_BODY',
        'Se requieren los campos username y password como cadenas de texto.',
        'Envía JSON con header Content-Type: application/json y los campos username y password.'
      );
    }

    // Taller 7: login es una lectura. Una réplica responde solo si no está muy atrasada
    // (READ_LAG_TOLERANCE); si no, redirige al líder. Así una réplica atrasada nunca emite tokens.
    if (!clusterState.canServeReads()) return rejectNotLeader(res, 'read');

    const cleanUsername = normalizeUsername(username);
    const user = stmts.findByUsername.get(cleanUsername);

    if (!user) {
      // Comparación contra hash ficticio para evitar enumeración por temporización
      await bcrypt.compare(password, DUMMY_HASH);
      return sendError(
        res,
        401,
        'INVALID_CREDENTIALS',
        'Credenciales inválidas.',
        'Verifica usuario y contraseña, o regístrate en POST /register.'
      );
    }

    // Taller 5: un usuario de Google no tiene contraseña (password_hash es NULL).
    // Se compara contra el hash ficticio para que el tiempo de respuesta no lo delate
    // y se le indica que use el botón de Google.
    if (user.provider !== 'local') {
      await bcrypt.compare(password, DUMMY_HASH);
      return sendError(
        res,
        401,
        'USE_GOOGLE_LOGIN',
        'Esta cuenta se creó con Google y no tiene contraseña.',
        'Inicia sesión con el botón "Sign in with Google" (POST /auth/google).'
      );
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return sendError(
        res,
        401,
        'INVALID_CREDENTIALS',
        'Credenciales inválidas.',
        'Verifica usuario y contraseña, o regístrate en POST /register.'
      );
    }

    // Emisión de JWT con HS256 explícito y expiración recargada en caliente
    const token = emitToken(user);
    const expiresIn = tokenLifetimeSeconds(token);

    console.log(`Login exitoso: ${user.username}`);

    return sendOk(res, 200, 'Inicio de sesión exitoso.', {
      token,
      username: normalizeUsername(user.username),
      expiresIn
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/google - Login con Google (Taller 5, opción A: Google Identity Services)
// Flujo: el cliente obtiene un ID Token con el botón oficial de Google y lo envía aquí.
// 1) Verificamos la FIRMA del ID Token contra Google (no basta con decodificarlo).
// 2) Si el google_sub ya existe → 200 con nuestro JWT.
// 3) Si es la primera vez y no mandó username → 409 USERNAME_REQUIRED (el cliente lo pide).
// 4) Si mandó username → creamos el usuario (409 USERNAME_TAKEN si ya existe).
app.post('/auth/google', async (req, res, next) => {
  try {
    if (!googleClient) {
      return sendError(
        res,
        503,
        'GOOGLE_NOT_CONFIGURED',
        'El login con Google no está configurado en este servidor.',
        'Define GOOGLE_CLIENT_ID en auth-service/.env y reinicia el servicio.'
      );
    }

    const { idToken, username } = req.body || {};

    if (typeof idToken !== 'string' || !idToken) {
      return sendError(
        res,
        400,
        'INVALID_BODY',
        'Se requiere el campo idToken como cadena de texto.',
        'Envía { "idToken": "<ID token de Google>" } con Content-Type: application/json.'
      );
    }

    // 1. Verificar el ID Token: firma con las claves públicas de Google, emisor, expiración
    //    y audience. Sin audience aceptaríamos tokens emitidos para OTRAS apps de Google.
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      return sendError(
        res,
        401,
        'INVALID_ID_TOKEN',
        'El ID token de Google no es válido.',
        'Vuelve a pulsar "Sign in with Google"; el token pudo vencer o ser de otra aplicación.',
        undefined,
        { error: 'invalid_id_token' }
      );
    }

    if (!payload || payload.email_verified !== true) {
      return sendError(
        res,
        401,
        'EMAIL_NOT_VERIFIED',
        'El correo de tu cuenta de Google no está verificado.',
        'Verifica tu correo en Google e inténtalo de nuevo.',
        undefined,
        { error: 'email_not_verified' }
      );
    }

    // sub = identificador estable del usuario en Google. El email NO sirve como llave
    // porque el usuario puede cambiarlo.
    const googleSub = payload.sub;
    const email = payload.email;
    const pictureUrl = safePictureUrl(payload.picture);

    // Taller 7: buscar al usuario es una lectura; una réplica muy atrasada podría no conocerlo
    // y pedirle un username a alguien que ya tiene cuenta → mejor redirigir al líder.
    if (!clusterState.canServeReads()) return rejectNotLeader(res, 'read');

    // 2. ¿Ya existe este usuario de Google?
    const existing = stmts.findByGoogle.get(googleSub);
    if (existing) {
      // La foto puede cambiar en Google: se actualiza en cada ingreso.
      // Taller 7: actualizarla es una escritura; una réplica deja la foto como está
      // (el líder la actualizará en un próximo ingreso) y responde el login igual.
      if (pictureUrl !== existing.picture_url && clusterState.isLeader()) {
        replicationLog.recordLocalWrite('update_picture', () => {
          stmts.updatePicture.run(pictureUrl, existing.id);
          return replicationLog.dataForUser('update_picture', existing.id);
        });
        existing.picture_url = pictureUrl;
      }
      const token = emitToken(existing);
      console.log(`Login con Google: ${existing.username}`);
      return sendOk(res, 200, 'Inicio de sesión con Google exitoso.', {
        token,
        username: normalizeUsername(existing.username),
        expiresIn: tokenLifetimeSeconds(token)
      });
    }

    // 3. Primera vez: hace falta que el usuario elija su username
    if (username === undefined || username === null || username === '') {
      return sendError(
        res,
        409,
        'USERNAME_REQUIRED',
        'Es tu primer ingreso con Google: elige un nombre de usuario.',
        'Reenvía POST /auth/google con { idToken, username }.',
        undefined,
        { error: 'username_required' }
      );
    }

    if (!validateUsername(username)) {
      return sendError(
        res,
        400,
        'INVALID_USERNAME',
        'El nombre de usuario es inválido o no cumple el formato requerido.',
        'Usa 3–32 caracteres: letras, números o guion bajo.',
        [{ field: 'username', problem: 'must be 3-32 characters: letters, numbers or underscore' }]
      );
    }

    // Taller 7: crear el usuario es una escritura → solo el líder.
    // (La réplica sí pudo responder antes username_required o el formato inválido.)
    if (!clusterState.isLeader()) return rejectNotLeader(res);

    // 4. Crear el usuario de Google (el UNIQUE de username aplica a ambos providers)
    const cleanUsername = normalizeUsername(username);
    if (stmts.findByUsername.get(cleanUsername)) {
      return sendError(
        res,
        409,
        'USERNAME_TAKEN',
        'El nombre de usuario ya está registrado.',
        'Elige otro nombre de usuario con letras diferentes a las existentes.',
        [{ field: 'username', problem: 'already exists (case-insensitive)' }],
        { error: 'username_taken' }
      );
    }
    try {
      let newUserId;
      const entry = replicationLog.recordLocalWrite('register_google', () => {
        const info = stmts.insertGoogle.run(cleanUsername, googleSub, email, pictureUrl);
        newUserId = Number(info.lastInsertRowid);
        return replicationLog.dataForUser('register_google', newUserId);
      });
      if (!(await confirmReplicated(res, entry))) return;
      const newUser = { id: String(newUserId), username: cleanUsername, provider: 'google', picture_url: pictureUrl };
      const token = emitToken(newUser);
      console.log(`Usuario de Google registrado: ${cleanUsername}`);
      return sendOk(res, 200, 'Cuenta creada con Google e inicio de sesión exitoso.', {
        token,
        username: cleanUsername,
        expiresIn: tokenLifetimeSeconds(token)
      });
    } catch (dbErr) {
      if (isUniqueViolation(dbErr)) {
        // Puede chocar el username o, en una carrera, el google_sub. Si ya existe el sub,
        // otro request creó la cuenta un instante antes: devolvemos su sesión.
        const raced = stmts.findByGoogle.get(googleSub);
        if (raced) {
          const token = emitToken(raced);
          return sendOk(res, 200, 'Inicio de sesión con Google exitoso.', {
            token,
            username: normalizeUsername(raced.username),
            expiresIn: tokenLifetimeSeconds(token)
          });
        }
        return sendError(
          res,
          409,
          'USERNAME_TAKEN',
          'El nombre de usuario ya está registrado.',
          'Elige otro username y reenvía POST /auth/google con { idToken, username }.',
          [{ field: 'username', problem: 'already exists' }],
          { error: 'username_taken' }
        );
      }
      throw dbErr;
    }
  } catch (err) {
    next(err);
  }
});

// Handler 404 para cualquier ruta inexistente
app.use((req, res) => {
  sendError(
    res,
    404,
    'NOT_FOUND',
    'La ruta solicitada no existe.',
    'Rutas disponibles: GET /health, GET /status, GET /peers, GET /peers?coordinatorId=<ID>, POST /heartbeat, GET /coordinator, GET /coordinators, POST /register, POST /login, POST /auth/google.'
  );
});

// Error-handler centralizado (4 argumentos)
app.use((err, req, res, next) => {
  // Manejo de JSON malformado
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400 && 'body' in err)) {
    return sendError(
      res,
      400,
      'INVALID_BODY',
      'JSON malformado o no parseable en el cuerpo de la petición.',
      'Envía JSON válido con header Content-Type: application/json.'
    );
  }

  // Errores internos no controlados: nunca exponer stack traces, SQL ni secretos
  console.error(`[auth-service] Error interno no controlado (${err.code || err.name || 'UNKNOWN'}).`);
  return sendError(
    res,
    500,
    'INTERNAL_ERROR',
    'Ocurrió un error interno en el servidor.',
    'Intenta de nuevo; si persiste, revisa los logs del servicio.'
  );
});

// 6. Arranque del servidor HTTP
const server = app.listen(PORT, () => {
  startCoordinatorCleanup();
  console.log(`Auth Service ${CLUSTER.authId} escuchando en http://localhost:${PORT} (pública: ${CLUSTER.publicUrl}).`);
  console.log(`  Mesh de auth: ${CLUSTER.peerUrl} · peers: ${CLUSTER.peers.map((peer) => peer.authId).join(', ') || 'ninguno (auth único)'} · base: ${DB_PATH}`);
  const state = clusterState.describe();
  console.log(`  Rol: ${state.role} · term: ${state.term} · líder: ${state.leaderId || 'desconocido'} · usuarios: ${replicationLog.usersCount()} · lastAppliedSeq: ${state.lastAppliedSeq}`);
});
server.once('close', stopCoordinatorCleanup);

if (CLUSTER.peers.length > 0) {
  authMesh.start()
    .then(() => {
      replication.start();
      election.start();
      console.log(`  Mesh de auth escuchando en el puerto ${CLUSTER.peerPort} (ruta /auth-mesh).`);
    })
    .catch((err) => {
      console.error(`Error crítico: no se pudo abrir el mesh de auth en el puerto ${CLUSTER.peerPort} (${err.code || err.message}).`);
      process.exit(1);
    });
  server.once('close', () => {
    election.stop();
    replication.stop();
    void authMesh.stop();
  });
}

module.exports = {
  app,
  server,
  db,
  clusterState,
  authMesh,
  coordinators,
  isCoordinatorLive,
  pruneExpiredCoordinators
};
