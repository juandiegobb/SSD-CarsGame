# SPEC — Talleres 4 y 5: Proyecto Final Partes I (Identidad) y II (Juego en vivo + Google)

> Sistemas Distribuidos · Universidad de Boyacá
> Objetivo: desplegar la primera pieza del videojuego web multijugador: **identidad** (registro, login, JWT) y un **canal WebSocket autenticado** que mantiene la lista de jugadores en línea.

Este documento es la fuente de verdad del proyecto. Todo lo que aquí se define sale del PDF del taller; las decisiones propias están marcadas como **[Decisión]** y deben justificarse en el README final.

---

## 1. Alcance

Tres componentes, tres procesos, tres puertos, tres túneles ngrok:

| Componente | Tecnología | Puerto | Responsabilidad |
|---|---|---|---|
| `auth-service/` | Express + node:sqlite + bcryptjs + jsonwebtoken + dotenv + cors + google-auth-library (Taller 5; en el Taller 4 era better-sqlite3 + bcrypt) | 4000 | Registrar usuarios, validar credenciales, emitir JWT (1 h). SQLite propia. |
| `coordinator/` | Express + ws + jsonwebtoken + dotenv | 5000 | Aceptar WS en `/connect?token=...`, verificar JWT, mantener `Map` de jugadores, hacer broadcast. |
| `client/` | HTML + JS plano (servido por Express minúsculo) | 3000 | Login/registro, lobby con lista en vivo, logout, manejo de cierre inesperado. |

### Fuera de alcance (no hacer)
- Replicación entre coordinadores y tolerancia a fallos (son partes posteriores del proyecto). El movimiento y el login con Google se agregan en el Taller 5 (ver §10).
- Frameworks de frontend (React, Vue, etc.). El PDF lo prohíbe explícitamente: "no es el punto del taller".
- Refresh tokens, roles, recuperación de contraseña.

---

## 2. Estructura del repositorio

### 2.1 Estructura objetivo (la que exige el PDF)

```
SSD-C.../
├── auth-service/
│   ├── index.js
│   ├── package.json
│   ├── .env.example
│   └── (users.db)            ← ignorado por git
├── coordinator/
│   ├── index.js
│   ├── package.json
│   └── .env.example
├── client/
│   ├── server.js             ← Express minúsculo (puerto 3000) + /config.js dinámico
│   ├── package.json
│   ├── .env.example
│   └── public/
│       ├── login.html
│       ├── lobby.html
│       ├── common.js
│       └── style.css
├── .gitignore
├── README.md
├── SPEC.md
└── AGENTS.md
```

### 2.2 Estructura actual detectada (a reconciliar en la Fase 0)

```
SSD-C.../
├── coordinator/
│   ├── public/index.html
│   └── index.js
├── dashboard/
│   ├── common.js
│   └── style.css
├── worker/
│   ├── public/index.html
│   └── index.js
├── .env.example
├── .gitignore
├── package-lock.json
└── package.json
```

**Diferencias con lo que pide el PDF** (el PDF manda):

| Actual | Requerido | Acción propuesta |
|---|---|---|
| No existe `auth-service/` | `auth-service/` con su `package.json` | Crear desde cero (Fase 1). |
| No existe `client/` | `client/` | Crear y **reutilizar** `dashboard/common.js` y `dashboard/style.css` moviéndolos a `client/public/` (`git mv` para conservar historial). |
| `worker/` | No existe en este taller | **No tocar ni usar.** No pertenece a la Parte I (corresponde a replicación). Decidir con el docente/equipo si se elimina antes de entregar. |
| `package.json` y `package-lock.json` en la raíz | Un `package.json` **por servicio** | Las dependencias pasan a cada servicio. El `package.json` raíz solo puede quedar con scripts de conveniencia (sin dependencias de runtime) o eliminarse. |
| `.env.example` en la raíz | `.env.example` **por servicio** | Mover/crear uno por servicio y quitar el de la raíz. |
| `coordinator/public/index.html` | Coordinador = HTTP + WS | Mover a `client/public/` si es útil o eliminar. El coordinador no sirve el cliente. |

---

## 3. Contrato de la API (consistencia para Thunder Client y wscat)

> Regla transversal pedida: **toda petición HTTP y todo mensaje WS recibe una respuesta explícita** que confirme el éxito o explique qué falló y cómo solucionarlo. Los formatos de abajo son únicos: no inventar variantes por endpoint.

### 3.1 Envoltorio de respuestas HTTP

**Éxito** (siempre `ok: true` + `message`; los campos que exige el PDF van al primer nivel):

```json
{ "ok": true, "message": "Texto legible de lo que ocurrió", "...campos propios del endpoint..." }
```

**Error** (siempre `ok: false` + `code` estable + `message` + `hint`):

```json
{
  "ok": false,
  "code": "USERNAME_TAKEN",
  "message": "El nombre de usuario ya está registrado.",
  "hint": "Elige otro username o inicia sesión en POST /login.",
  "details": [ { "field": "username", "problem": "already exists" } ]
}
```

- `code`: constante en `MAYÚSCULAS_CON_GUION_BAJO`, estable para que el cliente y las pruebas se apoyen en él.
- `message`: qué salió mal, claro, **sin filtrar información sensible** (sin stack traces, sin SQL, sin hashes, sin secretos, sin revelar si el usuario existe en `/login`).
- `hint`: qué puede hacer quien llama para solucionarlo.
- `details`: opcional, solo en errores de validación (`400`).

### 3.2 Servicio de Auth — `http://localhost:4000`

| Método | Ruta | Body | Éxito | Errores |
|---|---|---|---|---|
| GET | `/health` | — | `200 { ok, message, service:"auth-service", uptime, jwtExpiresIn }` | — |
| POST | `/register` | `{ username, password }` | **`201 { ok, message, userId, username }`** | `400 INVALID_BODY / INVALID_USERNAME / INVALID_PASSWORD`, `409 USERNAME_TAKEN`, `500 INTERNAL_ERROR` |
| POST | `/login` | `{ username, password }` | **`200 { ok, message, token, username, expiresIn }`** | `400 INVALID_BODY`, `401 INVALID_CREDENTIALS`, `500 INTERNAL_ERROR` |
| * | cualquier otra | — | — | `404 NOT_FOUND` (indica métodos/rutas disponibles en `hint`) |

**Reglas de validación [Decisión]:**
- Body ausente, no-JSON o no-objeto → `400 INVALID_BODY` (incluye JSON malformado capturado por un error-handler de Express).
- `username`: string, sin espacios en los extremos (`trim`), 3–32 caracteres, solo `[A-Za-z0-9_]` → si no, `400 INVALID_USERNAME`.
- `password`: string, 8–72 caracteres (72 = límite de bytes de bcrypt) → si no, `400 INVALID_PASSWORD`.
- El username es sensible a mayúsculas (documentar en README).
- Los mensajes de validación indican **qué campo y qué regla**, nunca el valor recibido de `password`.

**Reglas de seguridad (del PDF):**
- bcrypt con **mínimo 10 rounds** (`BCRYPT_ROUNDS` en `.env`, por defecto 10).
- La contraseña **nunca** se guarda en claro, **nunca** sale en una respuesta y **nunca** aparece en logs (no loguear `req.body`).
- `409` se garantiza capturando el error `SQLITE_CONSTRAINT_UNIQUE` del `INSERT` (no solo con `SELECT` previo) para evitar condiciones de carrera.
- `/login` responde el **mismo** `401 INVALID_CREDENTIALS` tanto si el usuario no existe como si la clave es errónea (evita enumeración de usuarios).
- JWT: `HS256`, payload `{ userId, username, iat, exp }`, `exp = iat + 1h` (`JWT_EXPIRES_IN` en `.env`). `userId` se emite como **string**.
- `JWT_EXPIRES_IN`: se relee en cada `POST /login` directamente del archivo `.env` mediante `dotenv.parse` (recarga en vivo sin reiniciar el servicio). Un token ya emitido conserva su `exp` original.
- `cors()` habilitado en el auth (orígenes por `.env`), permitiendo el header `ngrok-skip-browser-warning` (ver Fase 4).

**Catálogo de códigos HTTP del Auth:**

| HTTP | `code` | Cuándo | `hint` sugerido |
|---|---|---|---|
| 400 | `INVALID_BODY` | Body vacío, no JSON, o no es objeto | "Envía JSON con header Content-Type: application/json y los campos username y password." |
| 400 | `INVALID_USERNAME` | username faltante o con formato inválido | "Usa 3–32 caracteres: letras, números o guion bajo." |
| 400 | `INVALID_PASSWORD` | password faltante o fuera de 8–72 | "Usa una contraseña de 8 a 72 caracteres." |
| 401 | `INVALID_CREDENTIALS` | Login fallido | "Verifica usuario y contraseña, o regístrate en POST /register." |
| 401 | `USE_GOOGLE_LOGIN` | Login con contraseña sobre una cuenta creada con Google (Taller 5, §10.3) | "Inicia sesión con el botón \"Sign in with Google\" (POST /auth/google)." |
| 404 | `NOT_FOUND` | Ruta inexistente | "Rutas disponibles: GET /health, POST /register, POST /login." |
| 409 | `USERNAME_TAKEN` | Registro duplicado | "Elige otro username o inicia sesión en POST /login." |
| 500 | `INTERNAL_ERROR` | Error no controlado | "Intenta de nuevo; si persiste, revisa los logs del servicio." |

### 3.3 Coordinador — HTTP `http://localhost:5000`

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/health` | `200 { ok, message, service:"coordinator", uptime, onlineCount }` |
| GET | `/players` | `200 { ok, message, count, players:[{userId, username}] }` — **solo lectura/diagnóstico**, permite verificar el `Map` desde Thunder Client sin abrir WS. Nunca expone sockets ni tokens. |
| * | otras | `404 NOT_FOUND` con `hint` (rutas disponibles; el WS vive en `/connect`). |

### 3.4 Coordinador — WebSocket `ws://localhost:5000/connect?token=<JWT>`

**Handshake (verificación en el evento `upgrade`, antes de agregar al `Map`)**

1. Se extrae `token` del query param.
2. Se verifica con `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })` **en el `upgrade`**, no dentro de `connection` (error típico #3 del PDF).
3. Token válido → se completa el handshake y se emite `connection` con el payload.
4. Token inválido → **[Decisión]** se completa el handshake solo para poder enviar un mensaje de error legible y cerrar con código `4001` y razón exacta `"invalid token"` (el PDF exige ese código y texto; un rechazo HTTP 401 antes del handshake no permite enviar close codes). El usuario **nunca** llega al `Map`.

**Mensajes servidor → cliente** (todos JSON con campo `type`):

| `type` | Cuándo | Forma |
|---|---|---|
| `connected` | Solo al socket recién autenticado, justo después de agregarlo al `Map` | `{ "type":"connected", "ok":true, "message":"Conexión autenticada como alice.", "userId":"1", "username":"alice", "onlineCount":2 }` |
| `players_update` | A **todos** los conectados (incluido el nuevo) cada vez que alguien entra o sale | `{ "type":"players_update", "players":[{"userId":"1","username":"alice"}, ...] }` ← formato exacto del PDF |
| `pong` | Respuesta a `ping` | `{ "type":"pong", "ok":true, "message":"Conexión viva.", "serverTime":"2026-..." }` |
| `verified` | Respuesta a `verify` cuando el token es válido y del mismo usuario | `{ "type":"verified", "ok":true, "message":"Token verificado.", "expiresAt":"<ISO de exp>" }` |
| `error` | Mensaje del cliente inválido o fallo de autenticación | `{ "type":"error", "ok":false, "code":"UNKNOWN_MESSAGE_TYPE", "message":"...", "hint":"..." }` |

**Mensajes cliente → servidor** (para probar con `wscat`):

| `type` | Efecto |
|---|---|
| `{"type":"ping"}` | Responde `pong`. |
| `{"type":"who"}` | Responde `players_update` solo al que preguntó (útil para depurar). |
| cualquier otra cosa | Responde `error` (ver tabla). El socket **no** se cierra por un mensaje inválido. |

**Códigos de error WS (`code` dentro de `type:"error"`):**

| `code` | Cuándo | `hint` sugerido |
|---|---|---|
| `TOKEN_MISSING` | No hay `?token=` | "Conéctate con ws://host/connect?token=<JWT> obtenido en POST /login." |
| `TOKEN_MALFORMED` | El string no es un JWT | "Copia el token completo devuelto por POST /login." |
| `TOKEN_INVALID_SIGNATURE` | Firmado con otra clave | "Verifica que JWT_SECRET sea idéntica en auth-service y coordinator." |
| `TOKEN_EXPIRED` | `exp` vencido | "Inicia sesión de nuevo en POST /login para obtener un token nuevo." |
| `TOKEN_MISMATCH` | Token válido pero con `userId` distinto al de este socket | "Cierra sesión e inicia con el mismo usuario." |
| `INVALID_JSON` | El cliente envió texto que no es JSON | "Envía JSON, por ejemplo {\"type\":\"ping\"}." |
| `UNKNOWN_MESSAGE_TYPE` | `type` no soportado | "Tipos soportados: ping, who." |
| `INTERNAL_ERROR` | Fallo inesperado | "Reconecta; si persiste, revisa los logs del coordinador." |

Al fallar la validación en el handshake (`upgrade`) o en un mensaje `verify`, el servidor envía el `error` correspondiente y **a continuación** cierra el socket: con `4001 "invalid token"` para `TOKEN_MISSING`, `TOKEN_MALFORMED`, `TOKEN_INVALID_SIGNATURE` o `TOKEN_MISMATCH`; y con `4003 "token expired"` para `TOKEN_EXPIRED` (coherente con la expiración en caliente de §3.6).

**Códigos de cierre (close codes):**

| Código | Razón | Quién lo provoca | Reacción del cliente |
|---|---|---|---|
| `1000` | `"logout"` | El cliente (botón Cerrar sesión) | Cierre intencional: no mostrar alerta de error. |
| `4001` | `"invalid token"` | Coordinador: token vencido/malformado/otra clave (obligatorio por PDF) | Mensaje + borrar token + volver a login. |
| `4002` | `"session replaced"` | Coordinador: el mismo usuario abrió otra pestaña | Mensaje "Tu sesión se abrió en otra pestaña" + **no** borrar token (ver 3.5). |
| `4003` | `"token expired"` | Coordinador: el JWT venció con el socket ya abierto | Mensaje + borrar token + volver a login. |
| otros (`1006`, etc.) | Coordinador caído / red | Infraestructura | Mensaje "Se perdió la conexión con el coordinador" + volver a login. |

### 3.5 Decisión: mismo usuario en dos pestañas **[Decisión — documentar en README]**

**Política elegida: la conexión nueva reemplaza a la anterior** (se cierra la primera con `4002 "session replaced"`).

Justificación (usar en la sustentación):
- Un refresh o una reconexión tras caída de red deja a menudo un socket "zombi" del lado del servidor; rechazar la nueva dejaría al usuario bloqueado hasta que el zombi expire.
- La intención más reciente del usuario es la que debe prevalecer.
- El `Map` se indexa por `userId`, así que mantiene **una sola entrada por jugador** y la lista nunca muestra duplicados.

Detalles obligatorios de implementación:
- El `close` del socket **viejo** no debe borrar la entrada del socket **nuevo**: al manejar `close`, solo se hace `players.delete(userId)` si `players.get(userId).socket === ws`.
- Si el socket cerrado ya no era el vigente, **no** se hace broadcast adicional (solo uno, por el reemplazo).
- En el cliente, el código `4002` **no** borra el token (las pestañas comparten `localStorage`; borrarlo desconectaría a la pestaña nueva en el próximo refresh) y **no** redirige automáticamente a login con token presente (evitaría un bucle donde dos pestañas se expulsan mutuamente). Se muestra un aviso con botón "Usar la sesión aquí".

### 3.6 Expiración con el socket abierto **[Decisión]**

El JWT solo se verifica al conectar, pero el PDF pide que el cliente reaccione cuando el token vence. Por eso, al aceptar la conexión el coordinador programa `setTimeout` hasta `payload.exp` y, al cumplirse, envía `error TOKEN_EXPIRED` y cierra con `4003`. El timer se cancela en `close`. Esto hace la demo del "token de 30 segundos" visible en vivo sin recargar.

> **Nota sobre vigencia de tokens:** Un token ya emitido contiene su `exp` firmado digitalmente en el payload; modificar `JWT_EXPIRES_IN` en el `.env` solo afecta a los tokens emitidos en logins posteriores. Las sesiones ya abiertas conservan su tiempo de expiración original.

---

## 4. Variables de entorno

Ninguna secret, puerto ni URL va hardcodeada. Cada servicio tiene su `.env` (ignorado) y su `.env.example` (versionado, sin valores reales).

**`auth-service/.env.example`**
```
PORT=4000
JWT_SECRET=cambia-esto-por-una-clave-larga-y-aleatoria
JWT_EXPIRES_IN=1h
BCRYPT_ROUNDS=10
DB_PATH=users.db
CORS_ORIGINS=http://localhost:3000
```

**`coordinator/.env.example`**
```
PORT=5000
JWT_SECRET=cambia-esto-por-una-clave-larga-y-aleatoria
```

**`client/.env.example`**
```
PORT=3000
AUTH_URL=http://localhost:4000
COORDINATOR_WS_URL=ws://localhost:5000
```

> `JWT_SECRET` debe ser **idéntica** en auth y coordinador (error típico #2). El navegador no lee `.env`, así que `client/server.js` expone `GET /config.js` generado dinámicamente (`window.APP_CONFIG = { AUTH_URL, COORDINATOR_WS_URL }`) a partir de su `.env`.
>
> `JWT_EXPIRES_IN` en `auth-service/.env` se relee dinámicamente en cada petición `POST /login` (permite cambiar la duración en caliente sin reiniciar el proceso). Las demás variables (`PORT`, `JWT_SECRET`, `BCRYPT_ROUNDS`, `CORS_ORIGINS`) se cargan al iniciar el proceso y requieren reinicio del servicio para aplicar cambios.

`.gitignore` mínimo: `node_modules/`, `*.db` (y `*.db-journal`, `*.db-wal`, `*.db-shm`), `.env`.

---

## 5. Fases

Cada fase termina con **criterios de aceptación verificables** y **al menos un commit** (commits incrementales: el PDF advierte que se revisará el historial). Formato de commit: `tipo(ámbito): descripción` (p. ej. `feat(auth): endpoint POST /register con bcrypt`).

### Fase 0 — Alineación de repo y estructura
**Tareas**
1. Crear/actualizar `.gitignore` (`node_modules/`, `*.db`, `.env`).
2. Crear `auth-service/` y `client/`; mantener `coordinator/`.
3. Mover `dashboard/common.js` y `dashboard/style.css` a `client/public/` con `git mv`.
4. Resolver `worker/`, `package.json`/`package-lock.json` raíz y `.env.example` raíz según la tabla de la sección 2.2.
5. Ejecutar `npm init -y` en `auth-service/`, `coordinator/` y `client/`.
6. Crear un `.env.example` por servicio (sección 4) y su `.env` local.

**Aceptación:** la estructura coincide con 2.1; `git status` no muestra `.env`, `*.db` ni `node_modules/`.
**Commits sugeridos:** `chore: reorganizar estructura según taller`, `chore: agregar .gitignore y .env.example por servicio`.

### Fase 1 — Servicio de Auth
**Dependencias:** `express`, `better-sqlite3`, `bcrypt`, `jsonwebtoken`, `dotenv`, `cors`.

**Tareas**
1. Esqueleto del PDF: carga de `.env`, apertura de SQLite (`DB_PATH`), tabla `users` (`id`, `username UNIQUE NOT NULL`, `password_hash NOT NULL`, `created_at`).
2. Middlewares: `cors()`, `express.json()`, error-handler de JSON malformado → `400 INVALID_BODY`, handler `404`, handler `500` genérico.
3. Helper único de respuestas (`sendOk`, `sendError`) para garantizar el formato de la sección 3.1.
4. `GET /health`.
5. `POST /register` (validación → hash bcrypt → INSERT → `201`; capturar `SQLITE_CONSTRAINT_UNIQUE` → `409`).
6. `POST /login` (buscar usuario → `bcrypt.compare` → emitir JWT `{ userId, username }` con `expiresIn` → `200`; fallo → `401` genérico).
7. Verificar que ningún `console.log` imprima contraseñas, hashes o el body completo.

**Pruebas (Thunder Client / curl)** — ver sección 6.1.
**Aceptación:** todos los casos de la tabla 6.1 devuelven el status y `code` esperados; el JWT decodificado en jwt.io contiene `userId`, `username`, `iat`, `exp` con `exp - iat = 3600`; la base `users.db` solo contiene hashes (`$2b$10$...`).
**Regla del PDF:** *no avanzar a la Fase 2 hasta que esto funcione.*
**Commits sugeridos:** `feat(auth): esqueleto, db y health`, `feat(auth): registro con bcrypt`, `feat(auth): login y emisión de JWT`, `feat(auth): manejo de errores y cors`.

### Fase 2 — Coordinador
**Dependencias:** `express`, `ws`, `jsonwebtoken`, `dotenv`.

**Tareas**
1. Esqueleto del PDF: `http.createServer(app)` + `WebSocketServer({ noServer: true })`.
2. `GET /health`, `GET /players`, handler `404`.
3. `Map` `players`: `userId → { username, socket, connectedAt }`.
4. `broadcastPlayers()` a **todos** los sockets abiertos (incluido el recién conectado).
5. Evento `upgrade`: aceptar solo la ruta `/connect`; verificar JWT con `algorithms:['HS256']`; clasificar el error (`TOKEN_MISSING`, `TOKEN_MALFORMED`, `TOKEN_INVALID_SIGNATURE`, `TOKEN_EXPIRED`) a partir de `err.name`/`err.message`; en fallo → enviar `error` + `close(4001, 'invalid token')`.
6. `connection`: manejar duplicado (3.5), agregar al `Map`, enviar `connected`, hacer broadcast, programar timer de expiración (3.6).
7. Handler `message` (ping / who / errores) — sección 3.4.
8. Handler `close`: limpiar timer, borrar del `Map` solo si el socket es el vigente, **y luego** broadcast.
9. Handler `error` del socket para evitar caídas del proceso.

**Pruebas (wscat)** — ver sección 6.2.
**Aceptación:** casos de la tabla 6.2 pasan; cerrar una terminal de `wscat` hace que la otra reciba `players_update` sin ese usuario; el `Map` nunca queda con entradas fantasma.
**Commits sugeridos:** `feat(coordinator): servidor http+ws y health`, `feat(coordinator): verificación JWT en upgrade`, `feat(coordinator): map de jugadores y broadcast`, `feat(coordinator): manejo de close y sesión duplicada`, `feat(coordinator): expiración de token en caliente`.

### Fase 3 — Cliente Web
**Dependencias (solo para servirlo):** `express`, `dotenv`.

**Tareas**
1. `client/server.js`: sirve `public/` y `GET /config.js` con `AUTH_URL` y `COORDINATOR_WS_URL` del `.env`.
2. `login.html`: **dos formularios** (registro y login). Muestra en pantalla `message` y `hint` que devuelva el servidor en caso de error (aprovechar el contrato de 3.1). Login exitoso → guarda `token` en `localStorage` y redirige a `lobby.html`.
3. `lobby.html`:
   - Si no hay token → redirige a `login.html`.
   - Muestra el `username` actual (el guardado en login o el del mensaje `connected`).
   - Abre `WebSocket(`${COORDINATOR_WS_URL}/connect?token=${token}`)`.
   - `onmessage`: `players_update` → re-renderiza la lista "Jugadores en línea"; `connected` → confirma estado; `error` → muestra `message` + `hint`.
   - Botón **"Cerrar sesión"**: marca cierre intencional, borra el token, `ws.close(1000, 'logout')`, redirige a login.
   - `onclose` **inesperado** (flag de cierre intencional en `false`): muestra mensaje según el código (tabla 3.4) y vuelve a login (salvo `4002`).
   - **Session watcher en cliente (`startSessionWatcher`):** sondeo cada ~300 ms comparando `localStorage.token` con el token activo + evento `storage` + latido secundario cada ~5 s enviando `{"type":"verify","token":"..."}` al coordinador. Si el token en `localStorage` cambia o se ensucia, envía `verify` y espera el veredicto del coordinador (o temporizador de seguridad de 2 s). Si el token fue eliminado (`null`), ejecuta cierre de sesión local inmediato con `ws.close(1000, "logout")` y mensaje. Se detiene al cerrar la sesión o recibir código `4002`.
4. `common.js` (reutilizado): helpers compartidos (`API` para fetch con header `ngrok-skip-browser-warning`, lectura de config, manejo de token). `style.css` (reutilizado) para estilos.
5. Escapar el `username` al renderizar (usar `textContent`, no `innerHTML`) para evitar XSS.

**Aceptación:** con dos navegadores/ventanas de incógnito, ambos ven entrar y salir al otro **sin recargar**; "Cerrar sesión" borra el token y cierra el WS sin mostrar error; ensuciar el token en `localStorage` y recargar muestra mensaje y vuelve a login.
**Commits sugeridos:** `feat(client): servidor estático y config dinámica`, `feat(client): formularios de registro y login`, `feat(client): lobby con lista en vivo`, `feat(client): logout y manejo de cierre inesperado`.

### Fase 4 — Despliegue con ngrok
**Tareas**
1. Levantar los tres servicios locales (4000, 5000, 3000).
2. Abrir **un túnel por servicio**:
   ```bash
   ngrok http 4000   # Terminal 1 → URL pública del auth
   ngrok http 5000   # Terminal 2 → URL pública del coordinador
   ngrok http 3000   # Terminal 3 → URL pública del cliente
   ```
   > Si tu cuenta gratuita no permite varias sesiones simultáneas, define los tres túneles en un `ngrok.yml` y ejecuta `ngrok start --all` (siguen siendo tres túneles separados). Documentar el comando usado en el README.
3. Actualizar los `.env`:
   - `client/.env`: `AUTH_URL=https://<auth>.ngrok-free.app` y `COORDINATOR_WS_URL=wss://<coord>.ngrok-free.app` (**`wss://`**, no `ws://`: contenido mixto, error típico #7).
   - `auth-service/.env`: `CORS_ORIGINS=https://<cliente>.ngrok-free.app`.
4. Reiniciar los servicios para que lean el `.env`.
5. Considerar el aviso intersticial de ngrok gratuito: el `fetch` del cliente envía `ngrok-skip-browser-warning: true`, por lo que `cors()` del auth debe incluirlo en `allowedHeaders` (si no, el preflight falla).
6. Probar el flujo completo desde otro dispositivo/red usando solo la URL pública del cliente.

**Aceptación:** registro, login y lobby funcionan desde la URL pública del cliente; la consola del navegador no muestra errores de CORS ni de contenido mixto.
**Commit sugerido:** `docs: comandos y configuración de ngrok`.

### Fase 5 — README
Debe incluir (checklist del PDF):
- [ ] Diagrama de arquitectura (Mermaid o ASCII) con los 3 componentes, puertos, túneles y el flujo `register → login → JWT → WS /connect`.
- [ ] Instrucciones paso a paso para correr **cada** servicio (instalar, copiar `.env.example` → `.env`, arrancar).
- [ ] Ejemplos de `curl` para `/register` y `/login` (éxito y errores).
- [ ] Ejemplo de `wscat` para el coordinador.
- [ ] **Decisiones de diseño justificadas**: política de doble pestaña (3.5), verificación en `upgrade` y cierre `4001` (3.4), expiración en caliente (3.6), `bcrypt` rounds, `401` genérico, `userId` string, SQLite por servicio, `cors`, config dinámica del cliente.
- [ ] Tabla de códigos HTTP/WS (secciones 3.2 y 3.4).
- [ ] Comandos de ngrok usados.
- [ ] Cómo probar con Thunder Client.

**Commit sugerido:** `docs: README completo`.

### Fase 6 — Verificación final y preparación de sustentación
**Tareas**
1. Ejecutar la batería completa de pruebas (secciones 6.1, 6.2 y 6.3).
2. Revisar el checklist de la sección 7.
3. Ensayar el guion de sustentación (sección 8), incluido el cambio de expiración a 30 s en vivo.
4. Revisar `git log`: historial incremental, mensajes claros.
5. Confirmar que `.env`, `*.db` y `node_modules/` no están en el repo.

---

## 6. Plan de pruebas

### 6.1 Auth — Thunder Client / curl

Colección sugerida **"Taller4 - Auth"** (variable de entorno `{{AUTH_URL}}` = `http://localhost:4000` o la URL ngrok).

| # | Petición | Body | Esperado |
|---|---|---|---|
| 1 | `GET {{AUTH_URL}}/health` | — | `200`, `ok:true` |
| 2 | `POST /register` | `{"username":"alice","password":"secret123"}` | `201 { ok, message, userId, username }` |
| 3 | `POST /register` (repetir #2) | igual | `409 USERNAME_TAKEN` + `hint` |
| 4 | `POST /register` | `{}` | `400 INVALID_USERNAME` (con `details`) |
| 5 | `POST /register` | `{"username":"bob","password":"123"}` | `400 INVALID_PASSWORD` |
| 6 | `POST /register` | JSON roto `{"username":` | `400 INVALID_BODY` |
| 7 | `POST /login` | `{"username":"alice","password":"secret123"}` | `200 { ok, message, token, username, expiresIn }` |
| 8 | `POST /login` | clave incorrecta | `401 INVALID_CREDENTIALS` |
| 9 | `POST /login` | usuario inexistente | `401 INVALID_CREDENTIALS` (idéntico al #8) |
| 10 | `POST /login` | sin body | `400 INVALID_BODY` |
| 11 | `GET /ruta-inexistente` | — | `404 NOT_FOUND` + `hint` |

```bash
curl -X POST http://localhost:4000/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'

curl -X POST http://localhost:4000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
# → { "ok": true, "message": "...", "token": "eyJhbGc...", "username": "alice", "expiresIn": 3600 }
```

Guardar el `token` del #7 en una variable de Thunder Client (`{{TOKEN}}`) para usarlo en las pruebas WS.

### 6.2 Coordinador — wscat

```bash
npm install -g wscat
```

| # | Comando | Esperado |
|---|---|---|
| 1 | `wscat -c "ws://localhost:5000/connect?token=<TOKEN_ALICE>"` | Recibe `connected` y luego `players_update` con alice. |
| 2 | En otra terminal, conectar a bob | Ambas terminales reciben `players_update` con alice y bob. |
| 3 | Cerrar la terminal de bob (Ctrl+C) | Alice recibe `players_update` solo con alice. |
| 4 | `wscat -c "ws://localhost:5000/connect"` (sin token) | `error TOKEN_MISSING` y cierre `4001 invalid token`. |
| 5 | `...?token=basura` | `error TOKEN_MALFORMED` y cierre `4001`. |
| 6 | Token firmado con otra `JWT_SECRET` | `error TOKEN_INVALID_SIGNATURE` y cierre `4001`. |
| 7 | Token vencido (generar con `JWT_EXPIRES_IN=5s` y esperar) | `error TOKEN_EXPIRED` y cierre `4001`. |
| 8 | Conectado: enviar `{"type":"ping"}` | `pong` con `serverTime`. |
| 9 | Conectado: enviar `{"type":"who"}` | `players_update` solo a quien preguntó. |
| 10 | Conectado: enviar `hola` | `error INVALID_JSON` (el socket sigue abierto). |
| 11 | Conectado: enviar `{"type":"x"}` | `error UNKNOWN_MESSAGE_TYPE` + `hint`. |
| 12 | Conectar dos veces con el token de alice | La primera conexión recibe cierre `4002 session replaced`; la lista muestra a alice **una sola vez**. |
| 13 | Conectar con `JWT_EXPIRES_IN=30s` y esperar | Al llegar `exp`: `error TOKEN_EXPIRED` y cierre `4003`; los demás reciben `players_update` sin ese usuario. |
| 14 | Conectado: enviar `{"type":"verify","token":"<TOKEN_ALICE>"}` | `verified` con `expiresAt`. |
| 15 | Conectado: enviar `{"type":"verify","token":"basura"}` | `error TOKEN_MALFORMED` y cierre `4001 invalid token`. |
| 16 | Conectado: enviar `{"type":"verify"}` (sin token) | `error TOKEN_MISSING` y cierre `4001 invalid token`. |
| 17 | Conectado: enviar token vencido | `error TOKEN_EXPIRED` y cierre `4003 token expired`. |
| 18 | Conectado: enviar token válido de bob | `error TOKEN_MISMATCH` y cierre `4001 invalid token`. |

Verificación cruzada desde Thunder Client: `GET {{COORD_URL}}/players` debe reflejar exactamente los usuarios conectados en cada momento.

### 6.3 Cliente (manual, 2 navegadores)
1. Registrar usuario nuevo → login → lobby.
2. Segundo navegador (o incógnito) con otro usuario: ambos se ven aparecer.
3. Cerrar sesión en uno: el otro lo ve desaparecer sin recargar.
4. Editar `localStorage.token` con basura y recargar → mensaje + vuelta a login.
5. Apagar el coordinador con el lobby abierto → mensaje de conexión perdida + vuelta a login.
6. Abrir el lobby en dos pestañas con el mismo usuario → la primera muestra el aviso de sesión reemplazada.

---

## 7. Checklist de cumplimiento del PDF

**Auth**
- [ ] `POST /register`: JSON `{username,password}`, valida duplicado, bcrypt ≥10 rounds, inserta en SQLite, `201 {userId,username}` / `409`.
- [ ] `POST /login`: verifica en base, JWT con `{userId,username,iat,exp}` y 1 h, `200 {token,username}` / `401`.
- [ ] `400` para body inválido; mensajes claros sin filtrar información sensible.
- [ ] La contraseña no sale de la base ni aparece en logs.
- [ ] Base de datos SQLite propia del servicio.

**Coordinador**
- [ ] WS en `/connect?token=XXX`.
- [ ] JWT verificado **antes** de aceptar (en `upgrade`) con la misma secret; inválido → cierre `4001` + `"invalid token"`.
- [ ] `Map` `userId → { username, socket, connectedAt }`.
- [ ] Broadcast `{"type":"players_update","players":[{"userId","username"}]}` a todos (incluido el nuevo) al entrar o salir.
- [ ] Evento `close` elimina del `Map` **antes** del broadcast.
- [ ] Política de doble pestaña decidida y documentada en el README.

**Cliente**
- [ ] Login/registro con dos formularios; token en `localStorage`; redirección al lobby.
- [ ] Lobby con username actual y lista "Jugadores en línea" en vivo.
- [ ] Botón "Cerrar sesión" (borra token y cierra WS).
- [ ] Cierre inesperado del WS → mensaje y vuelta a login.

**No funcionales**
- [ ] Carpetas `auth-service/`, `coordinator/`, `client/`; `package.json` por servicio.
- [ ] Sin secret/puertos/URLs hardcodeados; `.env` por servicio con dotenv; `.env.example` versionado.
- [ ] README con diagrama, pasos, `curl`, decisiones justificadas y comandos de ngrok.
- [ ] `.gitignore` con `node_modules/`, `*.db`, `.env`.
- [ ] Commits incrementales.

**Entrega**
- [ ] Link al repo de GitHub · README completo · Tres URLs de ngrok activas durante la sustentación.

**Contrato de pruebas (requisito adicional)**
- [ ] Formatos de endpoints y mensajes WS consistentes (secciones 3.1–3.4).
- [ ] Toda petición y todo mensaje devuelve confirmación o error con `code`, `message` y `hint`.
- [ ] Todo se puede probar con Thunder Client y `wscat` sin usar el cliente web.

---

## 8. Guion de sustentación (≈ 12 min)

| Min | Qué mostrar | Preparación |
|---|---|---|
| 1 | Flujo: registrar usuario nuevo → login → lobby; **dos navegadores** viéndose entrar y salir en vivo. | Tener ambos navegadores listos, usuarios distintos. |
| 1 | **Token inválido:** editar `localStorage.token`, recargar, mostrar rechazo del coordinador. | Saber abrir DevTools → Application → Local Storage. |
| 2 | **Token vencido:** cambiar la expiración a 30 s **en vivo** (`JWT_EXPIRES_IN=30s` en `auth-service/.env`, reiniciar auth), hacer login y esperar el cierre `4003`. | Ensayar el reinicio rápido del servicio. Volver a `1h` después. |
| 3 | **Código:** estructura del repo, verificación del JWT en `upgrade`, `Map` + `broadcastPlayers()`, manejo de `close`. | Tener abiertos `coordinator/index.js` y `auth-service/index.js`. |
| 3 | **Preguntas:** doble pestaña (¿por qué reemplazar?), ¿por qué verificar en `upgrade`?, ¿por qué `401` genérico?, ¿por qué `wss://` con ngrok?, ¿qué pasa si las secrets difieren? | Repasar la sección 3 de este documento. |

Antes de entrar: las **tres URLs de ngrok activas**, servicios corriendo, `.env` con URLs públicas, usuarios de prueba creados.

---

## 9. Errores típicos a evitar (del PDF)

1. Un solo puerto para todo → son 3 procesos, 3 puertos.
2. Secret de JWT hardcodeada o distinta entre servicios.
3. Verificar el token dentro de `connection` en vez de en `upgrade`.
4. Hacer broadcast solo al que se conecta (debe ir a **todos**).
5. No manejar `close` → jugadores fantasma.
6. Guardar la contraseña en claro "solo para probar".
7. Mezclar `ws://` con `https://` (contenido mixto) → usar `wss://` con ngrok.
8. Olvidar CORS en el auth cuando cliente y auth están en orígenes distintos.

---

## 10. Taller 5 — Proyecto Final Parte II (juego en vivo + Login con Google)

> Esta sección extiende el contrato de las secciones 1–9 sin romperlo: todo lo del Taller 4 sigue funcionando igual. Lo que aquí cambia o se agrega sale del PDF del Taller 5; las decisiones propias van marcadas como **[Decisión]**.

### 10.1 Alcance nuevo

- **Juego en vivo:** los jugadores se mueven en un canvas y todos ven a todos en tiempo real. **El servidor es la autoridad**: el cliente solo envía intenciones de movimiento y el coordinador calcula las posiciones.
- **Login con Google:** además de usuario/contraseña, se puede entrar con Google. Ambos métodos producen **el mismo JWT propio** y conviven en **una sola tabla `users`**.
- **Feature extra replicado** mediante `extras` (ver 10.6).
- Siguen fuera de alcance: replicación entre coordinadores y tolerancia a fallos (talleres siguientes).

### 10.2 Esquema único de usuarios

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('local','google')),
  password_hash TEXT,           -- NULL para usuarios de Google
  google_sub TEXT UNIQUE,       -- NULL para usuarios locales
  email TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (provider = 'local'  AND password_hash IS NOT NULL AND google_sub IS NULL) OR
    (provider = 'google' AND password_hash IS NULL AND google_sub IS NOT NULL AND email IS NOT NULL)
  )
);
```

- Una sola tabla: si hubiera `users_local` y `users_google`, un mismo username podría existir dos veces y el coordinador, el score y la replicación futura tendrían que duplicarse.
- **[Decisión]** El `CHECK` de tabla hace que la propia base rechace filas inconsistentes (p. ej. un usuario de Google con contraseña).
- **[Decisión] Migración automática:** si `users.db` viene del Taller 4 (sin columna `provider`), al arrancar el auth la migra en una transacción y deja a los usuarios existentes como `provider = 'local'`. Nadie pierde su cuenta.
- Los literales SQL van con comillas **simples** (`'local'`); SQLite interpreta las dobles como nombres de columna.

### 10.3 Auth — cambios y endpoint nuevo

**[Decisión] Dependencias:** se reemplazan `better-sqlite3` y `bcrypt` por `node:sqlite` (incluido en Node ≥ 22.13) y `bcryptjs`, como en el esqueleto del PDF. Los dos anteriores son módulos nativos que en Node 24 sobre Windows había que compilar (exigían Python y herramientas de C++), y `npm install` fallaba. `bcryptjs` lee los mismos hashes `$2b$`, así que las contraseñas existentes siguen funcionando.

**JWT:** payload `{ userId, username, provider, iat, exp }` (se agrega `provider`). Mismo `JWT_SECRET`, `HS256` y `JWT_EXPIRES_IN` que antes; lo emite un único helper `emitToken(user)` para los dos métodos.

**`POST /login`:** si el usuario existe pero `provider !== 'local'`, responde `401 USE_GOOGLE_LOGIN` (la cuenta no tiene contraseña). Se compara igual contra el hash ficticio para no delatar la cuenta por tiempo de respuesta.

**[Decisión] Opción A — Google Identity Services** (botón oficial en el cliente + ID Token). Se eligió sobre el Authorization Code Flow porque no requiere `client_secret` ni `redirect_uri` en el backend, funciona igual detrás de ngrok y el backend solo tiene que verificar un token.

**`POST /auth/google`** — body `{ idToken, username? }`

| HTTP | Forma | Cuándo |
|---|---|---|
| 200 | `{ ok, message, token, username, expiresIn }` | El usuario de Google ya existía, o se creó con el `username` enviado |
| 400 | `INVALID_BODY` | Falta `idToken` o no es string |
| 400 | `INVALID_USERNAME` | El `username` enviado no cumple 3–32 `[A-Za-z0-9_]` |
| 401 | `invalid_id_token` → `INVALID_ID_TOKEN` | La firma, el emisor, la expiración o el `aud` del ID token no son válidos |
| 401 | `EMAIL_NOT_VERIFIED` | `email_verified` del payload no es `true` |
| 409 | `USERNAME_REQUIRED` | Primer login con Google y no se envió `username` → el cliente debe pedirlo y reintentar |
| 409 | `USERNAME_TAKEN` | El `username` elegido ya existe (en cualquiera de los dos providers) |
| 500 | `INTERNAL_ERROR` | Error no controlado |

- **[Decisión] Formato de error:** el PDF muestra `{ error: "username_required" }`. Para no romper el envoltorio único de §3.1, se responde `{ ok:false, code:"USERNAME_REQUIRED", message, hint, error:"username_required" }`: el `code` sigue la convención del proyecto y el campo `error` conserva literalmente el valor del PDF (`username_required`, `username_taken`, `invalid_id_token`, `email_not_verified`).
- Validaciones obligatorias (PDF): verificar la **firma** con `googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })` (nunca solo decodificar), exigir `aud === GOOGLE_CLIENT_ID`, exigir `email_verified === true`, y usar **`sub`** como llave (`google_sub`), nunca el email.
- El `idToken` nunca se escribe en logs.

**Variables nuevas en `auth-service/.env`:** `GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com`. Si falta, el auth arranca igual pero `/auth/google` responde `503 GOOGLE_NOT_CONFIGURED` **[Decisión]** (así se puede seguir trabajando en local sin credenciales de Google).

### 10.4 Coordinador — estado de juego y game loop

Estado de cada jugador en el `Map` (se extiende la entrada del Taller 4):

```
userId → { username, provider, socket, connectedAt, expirationTimer,
           x, y, intent: { x, y }, extras: {} }
```

- Posición inicial aleatoria dentro del mundo. Constantes por `.env`: `WORLD_WIDTH` (800), `WORLD_HEIGHT` (600), `PLAYER_RADIUS` (20), `PLAYER_SPEED` (200 px/s), `TICK_RATE` (20 Hz).
- **Game loop** con `setInterval(tick, 1000 / TICK_RATE)`: calcula `dt` real con `Date.now()`, normaliza diagonales con `Math.hypot`, mueve `x/y` según `intent`, recorta a los bordes del mundo y hace **un** broadcast de `state` por tick.
- El handler de mensajes **solo guarda** `intent`/`extras`; nunca mueve ni hace broadcast (errores típicos 2 y 4 del PDF).
- **[Decisión]** El loop solo hace broadcast si hay jugadores conectados. `players_update` se sigue enviando al entrar/salir alguien (compatibilidad con el lobby del Taller 4).

**Mensajes servidor → cliente nuevos:**

| `type` | Cuándo | Forma |
|---|---|---|
| `welcome` | Al socket recién autenticado, después de `connected` | `{ "type":"welcome", "you":{ "userId","username","provider" }, "world":{ "width","height","playerRadius","tickRate" } }` |
| `state` | A todos, una vez por tick | `{ "type":"state", "t":<ms>, "players":[{ "userId","username","provider","x","y","extras" }] }` |

**Mensajes cliente → servidor nuevos:**

| `type` | Forma | Efecto |
|---|---|---|
| `intent` | `{ "type":"intent", "intent":{ "dir":{ "x":-1\|0\|1, "y":-1\|0\|1 } } }` | Guarda `p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) }`. No confía en el valor: `{x: 9999}` queda en `1`. |
| `extras_update` | `{ "type":"extras_update", "extras":{ ... } }` | Si es un objeto (no array) y su JSON mide ≤ 1024 bytes, reemplaza `p.extras`. Se replica en el próximo `state`. |

**[Decisión] Respuestas a `intent` / `extras_update`:** un `intent` válido **no** recibe respuesta individual (se mandan varios por segundo; la confirmación es el siguiente `state`). Uno inválido sí recibe `error` sin cerrar el socket:

| `code` | Cuándo | `hint` |
|---|---|---|
| `INVALID_INTENT` | Falta `intent.dir` o `x`/`y` no son números | "Envía {\"type\":\"intent\",\"intent\":{\"dir\":{\"x\":1,\"y\":0}}}." |
| `INVALID_EXTRAS` | `extras` no es objeto, es array o supera 1024 bytes | "Envía un objeto JSON de hasta 1024 bytes en extras." |

`UNKNOWN_MESSAGE_TYPE` pasa a listar: `ping, who, verify, intent, extras_update`.

### 10.5 Cliente

- `GET /config.js` agrega `GOOGLE_CLIENT_ID` (desde `client/.env`).
- `login.html`: botón oficial "Sign in with Google" (Google Identity Services). Si `/auth/google` responde `USERNAME_REQUIRED`, muestra un campo "Elige tu username" y reenvía `{ idToken, username }`.
- `lobby.html`: canvas del tamaño de `welcome.world`; las flechas / WASD se traducen a `intent` (solo se envía cuando la dirección cambia); se dibuja cada `state` recibido. El cliente **nunca** calcula posiciones.
- Se conservan del Taller 4: lista de jugadores, logout, manejo de `4001/4002/4003` y watcher del token.

### 10.6 Feature extra replicado **[Decisión]**

- **Color del carro:** selector de color → `extras_update { color: "#rrggbb" }`. Todos los clientes lo ven en el próximo `state` y se mantiene durante la sesión. El cliente solo acepta colores con formato `#rrggbb` al dibujar (si otro manda basura, se usa el color por defecto).
- **Insignia de provider:** el coordinador incluye `provider` (tomado del JWT verificado, no de `extras`) en cada jugador del `state`; el cliente dibuja una "G" para Google y un candado para cuentas locales.

### 10.7 Pruebas del Taller 5

```bash
# Cuenta de Google intentando /login → 401 USE_GOOGLE_LOGIN
curl -X POST http://localhost:4000/login -H "Content-Type: application/json" -d '{"username":"<usuario_google>","password":"cualquiera"}'

# ID token falso → 401 INVALID_ID_TOKEN
curl -X POST http://localhost:4000/auth/google -H "Content-Type: application/json" -d '{"idToken":"esto.no.sirve"}'

# Movimiento con wscat (el servidor manda state 20 veces por segundo)
wscat -c "ws://localhost:5000/connect?token=<JWT>"
> {"type":"intent","intent":{"dir":{"x":1,"y":0}}}
> {"type":"intent","intent":{"dir":{"x":9999,"y":0}}}   # se sanea a 1, no teletransporta
> {"type":"extras_update","extras":{"color":"#ff5500"}}
```

Prueba manual: dos navegadores, uno con cuenta local y otro con Google; ambos se ven moverse, el color que cambia uno lo ve el otro, y la velocidad en diagonal es igual a la recta.
