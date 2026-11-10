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
| `coordinator/` | Express + ws + jsonwebtoken + dotenv | 5000 | Emitir tickets WS de un solo uso, validar el ticket durante `/connect`, mantener `Map` de jugadores y hacer broadcast. |
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
| POST | `/ws-ticket` | Header `Authorization: Bearer <JWT>`; devuelve un ticket aleatorio, de un solo uso, válido hasta 15 segundos. Requiere origen permitido cuando la petición viene de navegador. |
| * | otras | `404 NOT_FOUND` con `hint` (rutas disponibles; el WS vive en `/connect`). |

Errores de `POST /ws-ticket`: `401 TOKEN_MISSING`, `TOKEN_MALFORMED`, `TOKEN_INVALID_SIGNATURE` o `TOKEN_EXPIRED`; `403 ORIGIN_NOT_ALLOWED`; `503 TICKET_SERVICE_BUSY`. Las respuestas de error no incluyen el JWT ni el ticket.

### 3.4 Coordinador — ticket y WebSocket `ws://localhost:5000/connect`

El JWT de usuario nunca se incluye en la URL ni en mensajes WebSocket:

1. El cliente solicita `POST /ws-ticket` con el JWT en `Authorization: Bearer <JWT>`. El endpoint valida HS256 y la expiración.
2. El coordinador genera un ticket aleatorio de 256 bits, lo asocia al payload validado y devuelve el ticket con `Cache-Control: no-store`. El ticket vence en un máximo de 15 segundos y se consume una sola vez.
3. El cliente conecta a `/connect` usando los subprotocolos `carsgame.v1` y `auth.<ticket>`. No se pone credencial en la URL; el coordinador solo devuelve `carsgame.v1` como subprotocolo seleccionado.
4. En `upgrade`, el coordinador consume el ticket antes de aceptar al usuario en el `Map`. Ticket inválido, vencido o repetido → mensaje de error y cierre `4001 "invalid token"`.

El ticket sigue siendo una credencial temporal y puede ser visible para proxies que registren headers `Sec-WebSocket-Protocol`; el JWT también puede verse en proxies que registren `Authorization` en `POST /ws-ticket`. Por eso se usa TLS (`wss://`/`https://`) en público, no se registran esos headers y el ticket es corto y de un solo uso. El coordinador rechaza con HTTP `400` cualquier query en `/connect`; no se deben conservar clientes obsoletos que envíen JWT en la URL, ya que un proxy ascendente podría registrar la URL antes del rechazo. La `JWT_SECRET` y el JWT de usuario no se entregan en la configuración pública.

**Mensajes servidor → cliente** (todos JSON con campo `type`):


| `type` | Cuándo | Forma |
|---|---|---|
| `connected` | Solo al socket recién autenticado, justo después de agregarlo al `Map` | `{ "type":"connected", "ok":true, "message":"Conexión autenticada como alice.", "userId":"1", "username":"alice", "onlineCount":2 }` |
| `players_update` | A **todos** los conectados (incluido el nuevo) cada vez que alguien entra o sale | `{ "type":"players_update", "players":[{"userId":"1","username":"alice"}, ...] }` ← formato exacto del PDF |
| `pong` | Respuesta a `ping` | `{ "type":"pong", "ok":true, "message":"Conexión viva.", "serverTime":"2026-..." }` |
| `verified` | Respuesta a `verify` para la sesión activa o un ticket válido del mismo usuario | `{ "type":"verified", "ok":true, "message":"Token verificado.", "expiresAt":"<ISO de exp>" }` |
| `error` | Mensaje del cliente inválido o fallo de autenticación | `{ "type":"error", "ok":false, "code":"UNKNOWN_MESSAGE_TYPE", "message":"...", "hint":"..." }` |

**Mensajes cliente → servidor** (para probar con `wscat`):

| `type` | Efecto |
|---|---|
| `{"type":"ping"}` | Responde `pong`. |
| `{"type":"who"}` | Responde `players_update` solo al que preguntó (útil para depurar). |
| `{"type":"verify"}` o `{"type":"verify","ticket":"<TICKET>"}` | Verifica la sesión activa o consume un ticket de renovación de la misma identidad. Nunca envía el JWT en el mensaje. |
| cualquier otra cosa | Responde `error` (ver tabla). El socket **no** se cierra por un mensaje inválido. |

**Códigos de error WS (`code` dentro de `type:"error"`):**

| `code` | Cuándo | `hint` sugerido |
|---|---|---|
| `TOKEN_MISSING` | No se ofrece el subprotocolo con ticket | "Solicita un ticket nuevo con POST /ws-ticket." |
| `TICKET_INVALID` | Ticket inválido, vencido o ya consumido | "Solicita un ticket nuevo e inténtalo otra vez." |
| `TOKEN_TRANSPORT_UNSUPPORTED` | Se envía un JWT en un mensaje WS antiguo | "Recarga y usa el ticket de un solo uso." |
| `TOKEN_EXPIRED` | La sesión activa venció | "Inicia sesión de nuevo para obtener un token válido." |
| `TOKEN_MISMATCH` | Ticket válido de otro `userId` en el socket | "Cierra sesión e inicia con el mismo usuario." |
| `INVALID_JSON` | El cliente envió texto que no es JSON | "Envía JSON, por ejemplo {\"type\":\"ping\"}." |
| `UNKNOWN_MESSAGE_TYPE` | `type` no soportado | "Tipos soportados: ping, who." |
| `INTERNAL_ERROR` | Fallo inesperado | "Reconecta; si persiste, revisa los logs del coordinador." |

Al fallar la validación del ticket en el handshake o en un mensaje `verify`, el servidor envía el `error` correspondiente y cierra con `4001 "invalid token"`; la expiración activa conserva el cierre `4003 "token expired"`. Los errores del JWT se devuelven al pedir el ticket, antes del handshake.

**Códigos de cierre (close codes):**

| Código | Razón | Quién lo provoca | Reacción del cliente |
|---|---|---|---|
| `1000` | `"logout"` | El cliente (botón Cerrar sesión) | Cierre intencional: no mostrar alerta de error. |
| `4001` | `"invalid token"` | Coordinador: ticket inválido o sesión no autenticada | Mensaje + borrar token + volver a login. |
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
COORDINATOR_SHARED_SECRET=replace-with-the-same-random-placeholder-in-auth-and-coordinators
```

**`coordinator/.env.example`**
```
PORT=5000
JWT_SECRET=cambia-esto-por-una-clave-larga-y-aleatoria
COORDINATOR_SHARED_SECRET=replace-with-the-same-random-placeholder-in-auth-and-coordinators
CLIENT_ORIGINS=http://localhost:3000
```

**`client/.env.example`**
```
PORT=3000
AUTH_URL=http://localhost:4000
COORDINATOR_WS_URL=ws://localhost:5000
```

> `JWT_SECRET` debe ser **idéntica** en auth y coordinador (error típico #2). El navegador no lee `.env`, así que `client/server.js` expone `GET /config.js` generado dinámicamente con URLs públicas y el Client ID público de Google; no expone secretos ni JWT. Las URLs se validan y se eliminan sus credenciales, query y fragmento antes de exponerlas.
>
> `COORDINATOR_SHARED_SECRET` debe configurarse con el mismo valor secreto en auth y coordinadores. No se reutiliza el JWT de usuarios para autenticar heartbeats; los `.env.example` contienen solo un placeholder que debe reemplazarse en los `.env` locales.
>
> `CLIENT_ORIGINS` limita los orígenes permitidos para solicitar tickets al coordinador. En ngrok debe contener el origen HTTPS del cliente. El `.env.example` solo documenta el origen local.
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
5. `POST /ws-ticket`: validar JWT con `algorithms:['HS256']` y origen permitido; emitir ticket aleatorio de un solo uso. Evento `upgrade`: aceptar solo `/connect`, consumir ticket y rechazar ausente/inválido antes de agregar el jugador al `Map`.
6. `connection`: manejar duplicado (3.5), agregar al `Map`, enviar `connected`, hacer broadcast, programar timer de expiración (3.6).
7. Handler `message` (ping / who / errores) — sección 3.4.
8. Handler `close`: limpiar timer, borrar del `Map` solo si el socket es el vigente, **y luego** broadcast.
9. Handler `error` del socket para evitar caídas del proceso.

**Pruebas (wscat)** — ver sección 6.2.
**Aceptación:** casos de la tabla 6.2 pasan; cerrar una terminal de `wscat` hace que la otra reciba `players_update` sin ese usuario; el `Map` nunca queda con entradas fantasma.
**Commits sugeridos:** `feat(coordinator): servidor http+ws y health`, `feat(coordinator): ticket efímero para handshake autenticado`, `feat(coordinator): map de jugadores y broadcast`, `feat(coordinator): manejo de close y sesión duplicada`, `feat(coordinator): expiración de token en caliente`.

### Fase 3 — Cliente Web
**Dependencias (solo para servirlo):** `express`, `dotenv`.

**Tareas**
1. `client/server.js`: sirve `public/` y `GET /config.js` con `AUTH_URL` y `COORDINATOR_WS_URL` del `.env`.
2. `login.html`: **dos formularios** (registro y login). Muestra en pantalla `message` y `hint` que devuelva el servidor en caso de error (aprovechar el contrato de 3.1). Login exitoso → guarda `token` en `localStorage` y redirige a `lobby.html`.
3. `lobby.html`:
   - Si no hay token → redirige a `login.html`.
   - Muestra el `username` actual (el guardado en login o el del mensaje `connected`).
   - Solicita `POST /ws-ticket` al coordinador elegido con el JWT en el header Authorization y abre WebSocket en `/connect` usando `carsgame.v1` y el ticket temporal.
   - `onmessage`: `players_update` → re-renderiza la lista "Jugadores en línea"; `connected` → confirma estado; `error` → muestra `message` + `hint`.
   - Botón **"Cerrar sesión"**: marca cierre intencional, borra el token, `ws.close(1000, 'logout')`, redirige a login.
   - `onclose` **inesperado** (flag de cierre intencional en `false`): muestra mensaje según el código (tabla 3.4) y vuelve a login (salvo `4002`).
   - **Session watcher en cliente (`startSessionWatcher`):** sondeo cada ~300 ms comparando `localStorage.token` con el token activo + evento `storage` + latido secundario cada ~5 s enviando `{"type":"verify"}`. Si el token en `localStorage` cambia, solicita un ticket con el nuevo JWT por HTTPS y envía solo ese ticket en `verify`. Si el token fue eliminado (`null`), ejecuta cierre de sesión local inmediato con `ws.close(1000, "logout")` y mensaje. Se detiene al cerrar la sesión o recibir código `4002`.
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
   - `coordinator/.env`: `CLIENT_ORIGINS=https://<cliente>.ngrok-free.app` (además del origen local, separado por coma si se conservan ambos).
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

En PowerShell, autentica y conserva el ticket en variables (no lo pegues en la URL):

```powershell
$login = Invoke-RestMethod -Method Post http://localhost:4000/login -ContentType "application/json" -Body '{"username":"alice","password":"<CONTRASEÑA>"}'
$ticket = (Invoke-RestMethod -Method Post http://localhost:5000/ws-ticket -Headers @{ Authorization = "Bearer $($login.token)" }).ticket
```

| # | Comando | Esperado |
|---|---|---|
| 1 | `wscat -c "ws://localhost:5000/connect" -s carsgame.v1 -s "auth.$ticket"` | Recibe `connected` y luego `players_update` con alice. |
| 2 | En otra terminal, autenticar a bob, pedir su ticket y conectarlo de igual forma | Ambas terminales reciben `players_update` con alice y bob. |
| 3 | Cerrar la terminal de bob (Ctrl+C) | Alice recibe `players_update` solo con alice. |
| 4 | `wscat -c "ws://localhost:5000/connect" -s carsgame.v1` (sin ticket) | `error TOKEN_MISSING` y cierre `4001 invalid token`. |
| 5 | Conectar con `-s carsgame.v1 -s "auth.basura"` | `error TICKET_INVALID` y cierre `4001`. |
| 6 | JWT firmado con otra `JWT_SECRET` al solicitar `/ws-ticket` | HTTP `401 TOKEN_INVALID_SIGNATURE`; no se emite ticket. |
| 7 | JWT vencido al solicitar `/ws-ticket` | HTTP `401 TOKEN_EXPIRED`; no se emite ticket. |
| 8 | Conectado: enviar `{"type":"ping"}` | `pong` con `serverTime`. |
| 9 | Conectado: enviar `{"type":"who"}` | `players_update` solo a quien preguntó. |
| 10 | Conectado: enviar `hola` | `error INVALID_JSON` (el socket sigue abierto). |
| 11 | Conectado: enviar `{"type":"x"}` | `error UNKNOWN_MESSAGE_TYPE` + `hint`. |
| 12 | Conectar dos veces con el token de alice | La primera conexión recibe cierre `4002 session replaced`; la lista muestra a alice **una sola vez**. |
| 13 | Conectar con `JWT_EXPIRES_IN=30s` y esperar | Al llegar `exp`: `error TOKEN_EXPIRED` y cierre `4003`; los demás reciben `players_update` sin ese usuario. |
| 14 | Conectado: enviar `{"type":"verify"}` | `verified` con `expiresAt`, sin reenviar JWT. |
| 15 | Conectado: enviar `{"type":"verify","ticket":"basura"}` | `error TICKET_INVALID` y cierre `4001 invalid token`. |
| 16 | Solicitar `/ws-ticket` con JWT inválido | HTTP `401`; no se emite ticket. |
| 17 | Conectado: ticket vencido o ya usado | `error TICKET_INVALID` y cierre `4001 invalid token`. |
| 18 | Conectado: ticket válido de otro usuario | `error TOKEN_MISMATCH` y cierre `4001 invalid token`. |
| 19 | Conectado: enviar `{"type":"verify","token":"<JWT>"}` | `error TOKEN_TRANSPORT_UNSUPPORTED` y cierre `4001`; el JWT no se procesa ni se refleja. |
| 20 | Conectar a `/connect?token=<JWT>` | Se rechaza el handshake HTTP `400`; no se acepta credencial en la URL. |

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
- [ ] JWT validado por `POST /ws-ticket`; ticket aleatorio de un solo uso consumido en `upgrade`, sin JWT en URL ni mensajes WS.
- [ ] Ticket inválido o ausente antes de agregar el jugador al `Map`; error WS + cierre `4001 "invalid token"`.
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
| 3 | **Código:** estructura del repo, consumo del ticket en `upgrade`, `Map` + `broadcastPlayers()`, manejo de `close`. | Tener abiertos `coordinator/index.js` y `auth-service/index.js`. |
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

`UNKNOWN_MESSAGE_TYPE` pasa a listar: `ping, who, verify, intent, extras_update, room_create, room_join, room_leave, room_list, game_start, room_color_update`.

### 10.7 Salas de juego

- Las salas viven en memoria en el coordinador. Una sala tiene nombre, usuario anfitrión, estado (`waiting` o `playing`) y entre 0 y 8 miembros.
- Crear una sala une automáticamente al creador y requiere un nombre de 3–32 caracteres, letras, números, espacios o guiones.
- El anfitrión es el único usuario autorizado para iniciar la partida. No puede iniciar con menos de 2 miembros.
- Los usuarios pueden consultar las salas disponibles y entrar en una sala con espacio y estado `waiting`.
- Cada sala tiene su propio estado de juego; los estados y movimientos solo se difunden a los miembros de esa sala.
- El color de cada jugador se representa como hexadecimal `#rrggbb`. No puede haber dos jugadores con el mismo color dentro de la misma sala; el servidor valida y rechaza la duplicidad.
- Al desconectarse, el anfitrión sale de la sala y sus miembros siguen en ella; el siguiente miembro pasa a ser anfitrión. Si queda vacía, la sala se elimina.

| Mensaje cliente → servidor | Forma | Respuesta o efecto |
|---|---|---|
| `room_create` | `{"type":"room_create","name":"Nombre"}` | `room_created`, luego lista global de salas |
| `room_list` | `{"type":"room_list"}` | `room_list` solo al solicitante |
| `room_join` | `{"type":"room_join","roomId":"..."}` | `room_joined`, lista global actualizada |
| `room_leave` | `{"type":"room_leave"}` | `room_left`, lista global actualizada |
| `game_start` | `{"type":"game_start"}` | Solo el anfitrión; exige al menos 2 miembros |
| `room_color_update` | `{"type":"room_color_update","color":"#rrggbb"}` | Rechaza colores ya usados en la sala |

| Mensaje servidor → cliente | Forma |
|---|---|
| `room_list` | `{"type":"room_list","rooms":[{"roomId","name","hostUserId","hostUsername","playerCount","maxPlayers", "status"}]}` |
| `room_created` | Incluye los datos de la sala y confirma que el creador entró |
| `room_joined` | Incluye `roomId`, `name`, `hostUserId`, `hostUsername`, `players` |
| `room_left` | Confirma la salida y permite volver al lobby |
| `game_started` | Confirma el inicio y identifica a los jugadores de la sala |

Códigos nuevos de sala: `INVALID_ROOM_NAME`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_ALREADY_STARTED`, `ROOM_ALREADY_JOINED`, `NOT_ROOM_HOST`, `MIN_PLAYERS_REQUIRED`, `COLOR_INVALID`, `COLOR_TAKEN`, `ROOM_NOT_JOINED`.

### 10.5 Cliente

- `GET /config.js` agrega `GOOGLE_CLIENT_ID` (desde `client/.env`).
- `login.html`: botón oficial "Sign in with Google" (Google Identity Services). Si `/auth/google` responde `USERNAME_REQUIRED`, muestra un campo "Elige tu username" y reenvía `{ idToken, username }`.
- `lobby.html`: canvas del tamaño de `welcome.world`; las flechas / WASD se traducen a `intent` (solo se envía cuando la dirección cambia); se dibuja cada `state` recibido. El cliente **nunca** calcula posiciones.
- Se conservan del Taller 4: lista de jugadores, logout, manejo de `4001/4002/4003` y watcher del token.

### 10.6 Feature extra replicado **[Decisión]**

- **Color del carro:** selector de color → `extras_update { color: "#rrggbb" }`. Todos los clientes lo ven en el próximo `state` y se mantiene durante la sesión. El cliente solo acepta colores con formato `#rrggbb` al dibujar (si otro manda basura, se usa el color por defecto).
- **Insignia de provider:** el coordinador incluye `provider` (tomado del JWT verificado, no de `extras`) en cada jugador del `state`; el cliente dibuja una "G" para Google y un candado para cuentas locales.

### 10.7 Pruebas del Taller 5

```powershell
# Cuenta de Google intentando /login → 401 USE_GOOGLE_LOGIN
curl -X POST http://localhost:4000/login -H "Content-Type: application/json" -d '{"username":"<usuario_google>","password":"cualquiera"}'

# ID token falso → 401 INVALID_ID_TOKEN
curl -X POST http://localhost:4000/auth/google -H "Content-Type: application/json" -d '{"idToken":"esto.no.sirve"}'

# Movimiento con wscat (el servidor manda state 20 veces por segundo)
$login = Invoke-RestMethod -Method Post http://localhost:4000/login -ContentType "application/json" -Body '{"username":"alice","password":"<CONTRASEÑA>"}'
$ticket = (Invoke-RestMethod -Method Post http://localhost:5000/ws-ticket -Headers @{ Authorization = "Bearer $($login.token)" }).ticket
wscat -c "ws://localhost:5000/connect" -s carsgame.v1 -s "auth.$ticket"
> {"type":"intent","intent":{"dir":{"x":1,"y":0}}}
> {"type":"intent","intent":{"dir":{"x":9999,"y":0}}}   # se sanea a 1, no teletransporta
> {"type":"extras_update","extras":{"color":"#ff5500"}}
```

Prueba manual: dos navegadores, uno con cuenta local y otro con Google; ambos se ven moverse, el color que cambia uno lo ve el otro, y la velocidad en diagonal es igual a la recta.

---

## 11. Taller 6 — Proyecto Final Parte III (varios coordinadores en mesh)

### 11.1 Alcance nuevo

- **Varios coordinadores en paralelo**, intercambiables y con el mismo estado del juego.
- **El auth también es directory service:** los coordinadores le avisan que siguen vivos (`POST /heartbeat`) y el cliente le pregunta a cuál conectarse (`GET /coordinator`).
- **Mesh:** cada coordinador se conecta por WebSocket con todos los demás y les replica lo que pasa con sus jugadores locales.
- **Cliente:** login → `GET /coordinator` → WebSocket al coordinador asignado. Muestra a cuál está conectado y, si se cae, pide otro.

```
                 ┌───────────── Auth :4000 (usuarios + directorio) ─────────────┐
   heartbeat c/2s│  POST /heartbeat   GET /coordinator   GET /peers             │
                 └───────▲──────────────────▲───────────────────▲───────────────┘
                         │                  │ (cliente)         │
   coord-a :5001 ◄═══ mesh WS ═══► coord-b :5002 ◄═══ mesh WS ═══► coord-c :5003
   (peers :5101)                   (peers :5102)                   (peers :5103)
        ▲ clientes                      ▲ clientes                      ▲ clientes
```

### 11.2 Variables de entorno de cada coordinador

| Variable | Ejemplo | Para qué |
|---|---|---|
| `COORDINATOR_ID` | `coord-a` | Identificador único en el mesh |
| `PORT` | `5001` | WebSocket de clientes (`/connect`, ticket temporal por subprotocolo) |
| `PEER_PORT` | `5101` | WebSocket de **peers** (otros coordinadores) |
| `PUBLIC_URL` | `ws://localhost:5001` (o el `wss://` de ngrok) | URL que el auth le da a los clientes |
| `PEER_URL` | `ws://localhost:5101` | URL a la que se conectan los otros coordinadores |
| `AUTH_URL` | `http://localhost:4000` | Dónde mandar los heartbeats y pedir `/peers` |
| `JWT_SECRET` | igual en todos | Mismo secreto que el auth |

**[Decisión]** Puerto de peers separado del de clientes, como recomienda el PDF: el tráfico entre coordinadores no se mezcla con el de los jugadores y los peers no necesitan túnel de ngrok si corren en la misma máquina.

### 11.3 Auth — endpoints del directorio

El auth guarda **en memoria** un `Map` independiente de los usuarios, identificado por `coordinatorId`. Cada entrada contiene `coordinatorId`, `publicUrl`, `peerUrl`, `load` y `lastHeartbeat`. El heartbeat registra o reemplaza la entrada con el mismo ID. Un coordinador es vigente hasta que transcurren 6 segundos desde `lastHeartbeat` (incluido el instante exacto de 6 segundos); al superar ese límite se considera expirado. Auth comprueba la vigencia con una función reutilizable y limpia periódicamente las entradas expiradas del `Map`; el temporizador es complementario a la comprobación por antigüedad.

**`POST /heartbeat`** — lo llama cada coordinador cada 2 s.

```json
{ "coordinatorId": "coord-a", "publicUrl": "ws://localhost:5001", "peerUrl": "ws://localhost:5101", "load": 7 }
```

Debe incluir el header `x-coordinator-secret` con el valor compartido entre Auth y coordinadores. Si falta la configuración o el header no coincide, se rechaza con un error genérico `401 UNAUTHORIZED`. Auth compara los valores con `crypto.timingSafeEqual` después de comprobar que tengan la misma longitud. `coordinatorId` debe ser una cadena de 1–64 caracteres alfanuméricos, guion o guion bajo, iniciando con un carácter alfanumérico; las URL deben usar `ws://` o `wss://` sin credenciales, query ni fragmento; `load` debe ser un entero no negativo.

| HTTP | Forma | Cuándo |
|---|---|---|
| 200 | `{ "ok": true, "message": "Heartbeat recibido." }` | Registrado o actualizado (`lastHeartbeat` con la fecha y hora actual) |
| 400 | `INVALID_BODY` | Falta algún campo o tiene un tipo incorrecto |
| 401 | `UNAUTHORIZED` | Falta el secreto, no coincide o no está configurado |

**`GET /coordinator`** — lo llama el cliente después del login, antes de abrir el WebSocket.

| HTTP | Forma | Cuándo |
|---|---|---|
| 200 | `{ "coordinatorId": "coord-b", "publicUrl": "ws://localhost:5002" }` | El vivo con **menos** `connectedPlayers` (si empatan, el primero) |
| 503 | `{ "error": "no_coordinators_available" }` | No hay ningún coordinador vivo |

**[Decisión]** Es *client-side load balancing*: el auth no proxea tráfico, solo le dice al cliente a dónde conectarse.

**`GET /peers`** — lo llaman los coordinadores al arrancar y periódicamente.

```json
{ "peers": [ { "coordinatorId": "coord-a", "peerUrl": "ws://localhost:5101" }, { "coordinatorId": "coord-c", "peerUrl": "ws://localhost:5103" } ] }
```

Cada coordinador **quita su propio ID** de la lista.

**`GET /coordinators`** *(solo para depurar y para la demo)* — lista de los vivos con `connectedPlayers`, `uptime` y segundos desde el último heartbeat.

### 11.4 Protocolo del mesh (WebSocket entre coordinadores)

- **Una sola conexión por par.** **[Decisión] Regla del ID menor:** si `"coord-a" < "coord-b"` (orden lexicográfico), `coord-a` inicia la conexión y `coord-b` espera. Si llega una conexión de un peer con el que ya hay una abierta, se cierra la nueva.
- **Todos los mensajes llevan `origin`** (el `coordinatorId` que lo originó). Si `origin` es uno mismo, se descarta. **Nadie retransmite** lo que recibe de un peer: todos lo reciben directo del origen. Así no hay bucles.
- Lo que llega de un peer **también se valida** (mismas reglas que con los clientes: `Math.sign` en el intent, extras de máximo 1024 bytes).

| `type` | Forma | Cuándo |
|---|---|---|
| `hello` | `{ type, coordinatorId }` | Primer mensaje al abrir la conexión |
| `player_joined` | `{ type, origin, userId, username, provider, x, y, extras }` | Un cliente se conecta a `origin`. **También** se envía uno por cada jugador local al recibir un `hello` (así un coordinador que arranca tarde conoce a los que ya estaban) |
| `player_left` | `{ type, origin, userId }` | Un cliente se desconecta de `origin` |
| `intent_replicate` | `{ type, origin, userId, intent: { dir: { x, y } } }` | Un cliente local manda un intent |
| `extras_replicate` | `{ type, origin, userId, extras }` | Un cliente local cambia sus extras |
| `player_sync` | `{ type, origin, players: [{ userId, x, y }] }` | **[Decisión]** Cada ~1 s, la posición real de los jugadores locales de `origin`, para corregir desviaciones |
| `room_replicate` | `{ type, origin, op, roomId, ... }` | **[Propuesta]** Replicar salas: `op` = `create`, `join`, `leave`, `start`, `color`, `host` |

**Jugadores remotos:** cada jugador del `Map` lleva `home` (el coordinador al que está conectado) y `local: true/false`. Los remotos **no tienen socket**: nunca se les manda nada directamente.

**Peer caído:** si se cierra la conexión con un peer, se borran todos los jugadores cuyo `home` sea ese peer (un coordinador muerto con Ctrl+C nunca manda `player_left`).

**Game loop (20 Hz):**
1. Aplica los intents de **todos** los jugadores, locales y remotos.
2. Hace broadcast del `state` **solo a sus clientes locales** (nunca a los peers). Cada `state` incluye a todos los jugadores del mundo.

**`welcome`:** se agrega `coordinatorId` para que el cliente muestre a qué coordinador está conectado.

### 11.5 Cliente

1. Después del login, `GET /coordinator` al auth (`requestCoordinator()` en `common.js`).
2. Abre el WebSocket al `publicUrl` recibido, con el token como siempre.
3. Muestra en el lobby **"Coordinador: coord-b · Tick: 20 Hz"**.
4. **Si se cae el coordinador, no reconecta al mismo:** vuelve a pedir `GET /coordinator` y se conecta al que diga.

**[Decisiones del cliente]**
- **Coordinador caído aún anunciado:** durante los 6 s en que el auth todavía no lo descarta, puede seguir devolviéndolo. El cliente lo recuerda 10 s y, si el auth se lo vuelve a dar, espera y pregunta otra vez en vez de conectarse.
- **Reintentos:** cada 2 s, máximo 15 (unos 30 s). Si se agotan, vuelve al login con un mensaje.
- **503 o auth caído:** mensaje claro (`NO_COORDINATORS_AVAILABLE` / `AUTH_UNREACHABLE`) y reintentos automáticos.
- **Compatibilidad:** si el auth responde 404 a `GET /coordinator` (versión del Taller 5), el cliente usa el coordinador único del `.env`.
- **Al reconectar** se vuelve a la lista de salas y se reactiva el teclado (`game.resume()`).

### 11.6 Pruebas del Taller 6

```bash
# Heartbeat a mano
curl -X POST http://localhost:4000/heartbeat -H "Content-Type: application/json" \
  -d '{"coordinatorId":"coord-x","publicUrl":"ws://localhost:5009","peerUrl":"ws://localhost:5109","connectedPlayers":0,"uptime":1}'

curl http://localhost:4000/coordinator   # el menos cargado, o 503
curl http://localhost:4000/peers         # los vivos (coord-x desaparece a los 6 s)
```

Prueba manual (sustentación):
1. Tres coordinadores con puertos distintos → los tres aparecen en `/peers`.
2. Cuatro clientes → el auth los reparte (no van los 4 al mismo).
3. Alice en `coord-a` y Bob en `coord-b`: cada pestaña muestra su coordinador y se ven moverse en vivo.
4. Ctrl+C a un coordinador → sus clientes se desconectan, el auth deja de devolverlo después de 6 s y los clientes se reconectan a uno vivo.
