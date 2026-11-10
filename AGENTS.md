# AGENTS.md — Guía para el agente de desarrollo

Este archivo define **cómo debe trabajar el agente** (Claude Code, Cursor, Copilot u otro) en este repositorio y **qué tareas le corresponden** en cada fase. La especificación completa está en [`SPEC.md`](./SPEC.md), que es la **fuente de verdad**. Si hay conflicto entre este archivo, el código existente y `SPEC.md`, gana `SPEC.md`; si `SPEC.md` contradice el PDF del taller, gana el PDF.

---

## 1. Contexto del proyecto

Taller 4 de Sistemas Distribuidos (Universidad de Boyacá): primera parte del proyecto final, un videojuego web multijugador. Esta parte implementa **identidad**:

- **Auth Service** (HTTP, :4000): registro, login, JWT de 1 h, SQLite propia.
- **Coordinador** (HTTP + WS, :5000): valida JWT en `POST /ws-ticket`, consume ticket de un solo uso en `/connect`, mantiene `Map` en memoria de jugadores y hace broadcast `players_update`.
- **Cliente Web** (HTML + JS plano, :3000): login/registro, lobby en vivo, logout.
- Los tres se despliegan con **ngrok**, cada uno en su propio túnel.

Stack: Node.js, Express, `better-sqlite3`, `bcrypt`, `jsonwebtoken`, `ws`, `dotenv`, `cors`. **Sin frameworks de frontend.**

---

## 2. Estructura del proyecto

### Estado actual (ya existe)

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

### Estructura objetivo (la que exige el PDF)

```
SSD-C.../
├── auth-service/     (index.js, package.json, .env.example)
├── coordinator/      (index.js, package.json, .env.example)
├── client/           (server.js, package.json, .env.example, public/{login.html, lobby.html, common.js, style.css})
├── .gitignore
├── README.md
├── SPEC.md
└── AGENTS.md
```

### Reglas para la transición
- **Antes de mover o borrar cualquier archivo existente, léelo.** `dashboard/common.js` y `dashboard/style.css` se **reutilizan** en `client/public/` (usa `git mv`).
- `worker/` **no pertenece a este taller**: no lo modifiques, no lo importes, no lo uses. Si estorba, repórtalo y espera instrucción; no lo borres por iniciativa propia.
- `coordinator/public/index.html` y los archivos de la raíz (`package.json`, `package-lock.json`, `.env.example`) se reconcilian en la Fase 0 según `SPEC.md` §2.2. Ante la duda, pregunta antes de eliminar.
- Cada servicio tiene su **propio** `package.json` y `node_modules`. No instales dependencias de servicio en la raíz.

---

## 3. Reglas inquebrantables

### Seguridad
1. **Nunca** guardar contraseñas en claro. `bcrypt` con ≥ 10 rounds desde el primer commit.
2. **Nunca** imprimir en logs contraseñas, hashes, JWT, tickets de conexión ni `req.body`.
3. **Nunca** hardcodear `JWT_SECRET`, puertos ni URLs. Todo va en `.env` (dotenv) y se documenta en `.env.example`.
4. **Nunca** versionar `.env`, `*.db` ni `node_modules/`.
5. `JWT_SECRET` debe ser **la misma** en `auth-service` y `coordinator`.
6. Verificar el JWT con `algorithms: ['HS256']` explícito.
7. `/login` responde un `401 INVALID_CREDENTIALS` idéntico para "usuario inexistente" y "clave incorrecta".
8. Validar el JWT en `POST /ws-ticket` y consumir el ticket en el evento **`upgrade`**, antes de registrar al jugador.
9. En el cliente, renderizar nombres con `textContent` (nunca `innerHTML` con datos del servidor).

### Contrato y consistencia (requisito del estudiante)
10. **Respeta exactamente** los formatos de `SPEC.md` §3: envoltorio HTTP `{ ok, message, ... }` / `{ ok:false, code, message, hint, details? }` y mensajes WS con campo `type`.
11. **Toda petición HTTP y todo mensaje WS debe recibir respuesta**: confirmación si salió bien, o error con `code`, `message` y `hint` que explique qué falló y cómo arreglarlo. Nada de respuestas vacías, silencios ni `res.sendStatus()` sin cuerpo.
12. No inventes endpoints, tipos de mensaje ni códigos de error que no estén en `SPEC.md`. Si hace falta uno nuevo, **agrégalo primero a `SPEC.md`** y luego impleméntalo.
13. Los campos exigidos por el PDF van al primer nivel de la respuesta (`userId`, `username`, `token`, `players`...). No los anides en `data`.
14. Los errores nunca filtran stack traces, SQL, rutas del servidor ni secretos.
15. Todo debe poder probarse con **Thunder Client** (HTTP) y **wscat** (WS) sin usar el cliente web.

### Alcance y estilo
16. No agregar frameworks de frontend ni dependencias no justificadas. Dependencias permitidas por servicio: ver `SPEC.md` §5.
17. No implementar funcionalidades de partes futuras (movimiento, replicación, tolerancia a fallos).
18. Código en JavaScript (CommonJS, como los esqueletos del PDF). Identificadores en inglés; comentarios, mensajes al usuario y documentación en **español**.
19. Mantén el código legible y defendible: el estudiante **debe poder explicarlo** en sustentación (verificación de JWT, broadcast, `close`). Prefiere claridad sobre abstracciones sofisticadas. Comentarios breves donde la lógica no sea obvia.
20. Usa los esqueletos del PDF como base; completa los `TODO` en lugar de reescribir la arquitectura.

---

## 4. Flujo de trabajo del agente

Para **cada tarea**:

1. **Leer** la fase correspondiente en `SPEC.md` y los archivos existentes que vaya a tocar.
2. **Planear** brevemente (qué archivos crea/modifica).
3. **Implementar** solo lo de esa tarea.
4. **Probar** con los comandos de `SPEC.md` §6 (curl / Thunder Client / wscat). No declarar una tarea terminada sin haber ejecutado su prueba.
5. **Commit** incremental (ver §6).
6. **Reportar** al estudiante: qué hizo, cómo probarlo, qué decisiones tomó y qué sigue.

**Puertas de calidad entre fases:** no avanzar a la siguiente fase hasta que se cumplan los criterios de aceptación de la actual (el PDF lo exige para el Auth antes del Coordinador, y para ambos antes del cliente).

---

## 5. Asignación de tareas por rol

Los roles son **modos de trabajo** de un mismo agente (o de varios, si se ejecutan en paralelo). Cada rol solo modifica su carpeta.

### 5.1 Agente de Estructura y Repo — Fase 0
**Zona de trabajo:** raíz del repo.
- [ ] Crear/actualizar `.gitignore` (`node_modules/`, `*.db`, `*.db-journal`, `*.db-wal`, `*.db-shm`, `.env`).
- [ ] Crear `auth-service/` y `client/`; conservar `coordinator/`.
- [ ] `git mv dashboard/common.js dashboard/style.css client/public/`.
- [ ] Reconciliar `worker/`, `package.json`/`package-lock.json` raíz, `.env.example` raíz y `coordinator/public/index.html` (consultar al estudiante antes de eliminar).
- [ ] `npm init -y` en `auth-service/`, `coordinator/`, `client/`.
- [ ] Crear `.env.example` por servicio (`SPEC.md` §4) y `.env` local (sin versionar).

### 5.2 Agente Auth — Fase 1
**Zona de trabajo:** `auth-service/` únicamente.
- [ ] Instalar `express better-sqlite3 bcrypt jsonwebtoken dotenv cors`.
- [ ] Implementar `index.js` a partir del esqueleto del PDF.
- [ ] Helper único `sendOk` / `sendError` (formato `SPEC.md` §3.1).
- [ ] Middlewares: `cors` (con `ngrok-skip-browser-warning` permitido), `express.json`, handler de JSON malformado → `400 INVALID_BODY`, `404 NOT_FOUND`, `500 INTERNAL_ERROR`.
- [ ] `GET /health`.
- [ ] `POST /register`: validación, bcrypt (`BCRYPT_ROUNDS` ≥ 10), INSERT, `201`; `SQLITE_CONSTRAINT_UNIQUE` → `409 USERNAME_TAKEN`.
- [ ] `POST /login`: `bcrypt.compare`, JWT `{ userId (string), username }` + `iat/exp` (1 h), `200`; fallo → `401 INVALID_CREDENTIALS`.
- [ ] Auditar que no haya logs con datos sensibles.
- [ ] Ejecutar la tabla de pruebas `SPEC.md` §6.1 completa y reportar resultados.

### 5.3 Agente Coordinador — Fase 2
**Zona de trabajo:** `coordinator/` únicamente. **Prerrequisito:** Fase 1 aprobada.
- [ ] Instalar `express ws jsonwebtoken dotenv`.
- [ ] Servidor `http` + `WebSocketServer({ noServer: true })`.
- [ ] `GET /health`, `GET /players`, `404`.
- [ ] `POST /ws-ticket`: verificar JWT; en `upgrade`, consumir ticket efímero de un solo uso antes de aceptar el WebSocket; en fallo → mensaje `error` + `close(4001, 'invalid token')`.
- [ ] `players` Map (`userId → { username, socket, connectedAt }`) y `broadcastPlayers()` a **todos** los sockets abiertos.
- [ ] Política de doble pestaña (reemplazar con `4002 "session replaced"`): el `close` del socket viejo **no** debe borrar la entrada del nuevo (comparar `players.get(userId).socket === ws`).
- [ ] Enviar `connected` al socket nuevo; luego `players_update` a todos.
- [ ] `message`: `ping → pong`, `who → players_update`, `INVALID_JSON`, `UNKNOWN_MESSAGE_TYPE` (sin cerrar el socket).
- [ ] Timer de expiración en caliente → `TOKEN_EXPIRED` + `close(4003)`; limpiar timer en `close`.
- [ ] `close`: limpiar timer → borrar del `Map` (solo si es el socket vigente) → broadcast.
- [ ] `ws.on('error')` para evitar caídas del proceso.
- [ ] Ejecutar la tabla de pruebas `SPEC.md` §6.2 con `wscat` y reportar resultados.

### 5.4 Agente Cliente — Fase 3
**Zona de trabajo:** `client/` únicamente. **Prerrequisito:** Fases 1 y 2 aprobadas.
- [ ] `server.js`: Express en `PORT` (3000), sirve `public/` y `GET /config.js` (`window.APP_CONFIG = { AUTH_URL, COORDINATOR_WS_URL }` desde `.env`).
- [ ] `login.html`: formularios de registro y login; mostrar `message` + `hint` del servidor; guardar `token` en `localStorage`; redirigir a `lobby.html`.
- [ ] `lobby.html`: validar token, mostrar username, abrir WS, renderizar `players_update`, mostrar `error`/`connected`.
- [ ] Botón **Cerrar sesión**: bandera de cierre intencional, borrar token, `ws.close(1000, 'logout')`, volver a login.
- [ ] `onclose` inesperado: mensaje por código (`SPEC.md` §3.4) y volver a login; **excepción `4002`**: no borrar token ni redirigir con bucle; mostrar aviso con botón "Usar la sesión aquí".
- [ ] Reutilizar `common.js` y `style.css`; `fetch` con header `ngrok-skip-browser-warning: true`.
- [ ] Sin frameworks. `textContent` para renderizar nombres.
- [ ] Ejecutar la prueba manual `SPEC.md` §6.3.

### 5.5 Agente DevOps / ngrok — Fase 4
**Zona de trabajo:** archivos `.env` locales (no versionados) y documentación.
- [ ] Guiar al estudiante para abrir tres túneles (`ngrok http 4000|5000|3000`) o usar `ngrok.yml` + `ngrok start --all` si el plan gratuito limita sesiones.
- [ ] Indicar los cambios de `.env`: `AUTH_URL=https://...`, `COORDINATOR_WS_URL=wss://...` (nunca `ws://` con ngrok), `CORS_ORIGINS=https://<cliente>...`.
- [ ] Recordar reiniciar los servicios tras cambiar `.env`.
- [ ] Diagnosticar CORS, contenido mixto y el aviso intersticial de ngrok si aparecen.
- [ ] **Nunca** escribir URLs de ngrok ni secretos reales en archivos versionados.
- [ ] Registrar los comandos usados para el README.

### 5.6 Agente Documentación — Fase 5
**Zona de trabajo:** `README.md`.
- [ ] Diagrama de arquitectura (Mermaid o ASCII).
- [ ] Instrucciones paso a paso por servicio.
- [ ] Ejemplos `curl` para `/register` y `/login` (éxitos y errores) y de `wscat`.
- [ ] Decisiones de diseño **justificadas** (`SPEC.md` §3.4, 3.5, 3.6 y §9): doble pestaña, verificación en `upgrade` + cierre `4001`, expiración en caliente, bcrypt, `401` genérico, `wss://`, etc.
- [ ] Tablas de códigos HTTP/WS.
- [ ] Comandos de ngrok usados.
- [ ] Guía de pruebas con Thunder Client.
- [ ] Todo el README en español.

### 5.7 Agente QA — Fase 6
**Zona de trabajo:** solo lectura + reportes (corrige bugs únicamente en coordinación con el rol dueño de la carpeta).
- [ ] Ejecutar `SPEC.md` §6.1, §6.2 y §6.3 completas.
- [ ] Revisar el checklist `SPEC.md` §7 punto por punto.
- [ ] Buscar secretos/contraseñas/tokens en logs y en el historial de git.
- [ ] Verificar `.gitignore` y que `git ls-files` no incluya `.env`, `*.db` ni `node_modules/`.
- [ ] Revisar que `git log` muestre commits incrementales y mensajes claros.
- [ ] Ensayar con el estudiante el guion de sustentación (`SPEC.md` §8), incluido el cambio de expiración a 30 s en vivo.
- [ ] Entregar un reporte: ✅ cumple / ❌ no cumple / ⚠️ observación, por cada ítem.

---

## 6. Política de commits

El PDF indica que **se revisará el historial** y que un único commit final es motivo de penalización. Por tanto:

- **Un commit por tarea lógica** (idealmente varios por fase). Nunca un commit gigante.
- Formato: `tipo(ámbito): descripción en español, en presente`.
  - Tipos: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
  - Ámbitos: `auth`, `coordinator`, `client`, `repo`, `docs`.
- Ejemplos:
  - `chore(repo): reorganizar estructura según taller`
  - `feat(auth): registro con bcrypt y manejo de duplicados`
  - `feat(auth): login con emisión de JWT de 1 hora`
  - `feat(coordinator): ticket efímero para handshake autenticado`
  - `fix(coordinator): evitar que el close del socket viejo borre al nuevo`
  - `feat(client): lobby con lista de jugadores en vivo`
  - `docs: README con diagrama y comandos de ngrok`
- Nunca incluir `.env`, `*.db` ni `node_modules/` en un commit. Revisar `git status` antes de cada commit.
- No reescribir el historial (`rebase`, `push --force`) sin autorización del estudiante.

---

## 7. Definición de "terminado"

Una tarea se considera terminada **solo si**:

1. Cumple el comportamiento descrito en `SPEC.md`.
2. Fue probada con los comandos de `SPEC.md` §6 y el resultado coincide con lo esperado.
3. Devuelve confirmación o error con `code` + `message` + `hint` en **todos** sus caminos (éxito, validación, fallo interno).
4. No introduce secretos, contraseñas ni datos sensibles en logs ni en el repo.
5. Está commiteada con un mensaje claro.
6. El estudiante puede explicarla (el agente deja comentarios útiles y un resumen en su reporte).

---

## 8. Formato de reporte al finalizar cada tarea

```
## Tarea: <nombre> (Fase X)
**Hecho:** <resumen en 2–4 líneas>
**Archivos:** <creados/modificados>
**Cómo probar:** <comandos exactos curl / Thunder Client / wscat>
**Resultado de pruebas:** <caso → esperado → obtenido>
**Decisiones:** <qué se decidió y por qué (material para el README)>
**Pendiente / riesgos:** <si aplica>
**Commit(s):** <mensajes>
```

---

## 9. Cuándo detenerse y preguntar al estudiante

- Antes de **eliminar** `worker/`, `coordinator/public/index.html` o archivos de la raíz.
- Si `SPEC.md` y el código existente se contradicen y no es obvio cuál prevalece.
- Si hace falta una dependencia no listada en `SPEC.md`.
- Si ngrok o el entorno impiden cumplir un requisito del PDF tal como está escrito.
- Si hay que cambiar un endpoint, un `type` de mensaje WS o un `code` ya definidos (afecta las pruebas del estudiante).
- Antes de cualquier operación destructiva de git.

Todo lo demás: decide con criterio, justifica en el reporte y continúa.
