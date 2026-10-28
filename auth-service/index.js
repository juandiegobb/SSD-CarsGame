// Servicio de Autenticación (Auth Service) - Talleres 4 y 5 Sistemas Distribuidos
// Responsabilidad: Registro, Login con JWT (1h) y persistencia en SQLite propia.
// Taller 5: una sola tabla users con campo provider ('local' | 'google').
// Puerto por defecto: 4000

const fs = require('node:fs');
const path = require('node:path');
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
const PORT = Number(process.env.PORT) || 4000;
const DB_PATH = process.env.DB_PATH || 'users.db';
const ENV_PATH = path.join(__dirname, '.env');

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
    console.warn('[auth-service] Advertencia al leer .env para JWT_EXPIRES_IN:', err.message || err);
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

// Sentencias preparadas para reutilización y prevención de inyección SQL.
// Los literales SQL llevan comillas SIMPLES (SQLite interpreta las dobles como nombres de columna).
const stmts = {
  insertLocal: db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle: db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?')
};

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

// Misma regla de username para /register y /auth/google (SPEC.md §3.2).
function validateUsername(u) {
  return typeof u === 'string' && /^[A-Za-z0-9_]{3,32}$/.test(u.trim());
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
    username: user.username,
    provider: user.provider
  };
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

// GET /health - Monitoreo y estado del servicio (incluye jwtExpiresIn activo)
app.get('/health', (req, res) => {
  const activeExpiresIn = getJwtExpiresIn();
  sendOk(res, 200, 'Servicio de autenticación operativo.', {
    service: 'auth-service',
    uptime: Math.floor(process.uptime()),
    jwtExpiresIn: String(activeExpiresIn)
  });
});

// POST /register - Registro de nuevo usuario
app.post('/register', async (req, res, next) => {
  try {
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

    const cleanUsername = username.trim();

    // Hashing seguro de la contraseña
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    try {
      const info = stmts.insertLocal.run(cleanUsername, passwordHash);
      console.log(`Usuario registrado: ${cleanUsername}`);

      return sendOk(res, 201, 'Usuario registrado exitosamente.', {
        userId: String(info.lastInsertRowid),
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

    const cleanUsername = username.trim();
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
      username: user.username,
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

    // 2. ¿Ya existe este usuario de Google?
    const existing = stmts.findByGoogle.get(googleSub);
    if (existing) {
      const token = emitToken(existing);
      console.log(`Login con Google: ${existing.username}`);
      return sendOk(res, 200, 'Inicio de sesión con Google exitoso.', {
        token,
        username: existing.username,
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

    // 4. Crear el usuario de Google (el UNIQUE de username aplica a ambos providers)
    const cleanUsername = username.trim();
    try {
      const info = stmts.insertGoogle.run(cleanUsername, googleSub, email);
      const newUser = { id: String(info.lastInsertRowid), username: cleanUsername, provider: 'google' };
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
            username: raced.username,
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
    `Ruta ${req.method} ${req.originalUrl} no encontrada.`,
    'Rutas disponibles: GET /health, POST /register, POST /login, POST /auth/google.'
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
  console.error('Error interno no controlado:', err.message || err);
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
  console.log(`Auth Service escuchando en http://localhost:${PORT}`);
});

module.exports = { app, server, db };
