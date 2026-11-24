# Guía de Demo y Sustentación: Observabilidad y Dashboard (Track 2.2 - Parte B)

Este documento detalla el procedimiento para verificar y sustentar el **Track 2.2 (Auditoría y Observabilidad: Trazas Distribuidas y Dashboard en Vivo)** implementado para el proyecto final de Sistemas Distribuidos (Universidad de Boyacá).

---

## 1. Requisitos y Arranque del Sistema

Para iniciar el clúster completo (3 réplicas de autenticación con elección de líder, 3 coordinadores en malla P2P y el servidor cliente):

```powershell
.\start-all.ps1
```

O si necesitas instalar dependencias previamente:
```powershell
.\start-all.ps1 -Install
```

Este script abre:
1. `auth-a` (:4001, mesh :4101)
2. `auth-b` (:4002, mesh :4102)
3. `auth-c` (:4003, mesh :4103)
4. `coord-1` (:5001, mesh :6001)
5. `coord-2` (:5002, mesh :6002)
6. `coord-3` (:5003, mesh :6003)
7. `client` en http://localhost:3000

---

## 2. Acceso al Dashboard de Observabilidad

1. Abre tu navegador web en:
   **http://localhost:3000/dashboard.html**
2. Verás tres secciones principales:
   - **Resumen Global (KPIs):** Líder actual de autenticación y su `term`, número total de jugadores en la malla, total de conexiones WebSocket activas y tick rate promedio del clúster.
   - **Clúster de Autenticación (Auth Service):** Estado en tiempo real de cada uno de los 3 nodos (Líder / Réplica / Candidato), término actual, secuencia aplicada (`lastAppliedSeq`), lag de replicación, peticiones por segundo (RPS) y latencia HTTP (percentiles p50 y p95).
   - **Malla de Coordinadores (Coordinators):** Estado operativo de cada nodo, jugadores locales vs. remotos, tick rate efectivo (Hz reales medidos en el último segundo), conexiones WebSocket, latencia de replicación de intents y desfase de relojes (estimación NTP con cada par).
   - **Rastreador de Trazas (`traceId`):** Barra de búsqueda para rastrear peticiones, listado de trazas recientes detectadas y visualizador de línea de tiempo paso a paso.

---

## 3. Demostración 1: Caída de un Coordinador (menos de 3 segundos)

**Objetivo:** Demostrar que el dashboard detecta la caída de un nodo en menos de 3 segundos sin que el resto del sistema ni la interfaz se bloqueen.

1. Mantén la ventana de **http://localhost:3000/dashboard.html** abierta.
2. Identifica la ventana de terminal de `coord-2` o `coord-3`.
3. Presiona `Ctrl + C` en la terminal de ese coordinador para terminar el proceso.
4. **Resultado en el Dashboard:**
   - En **menos de 2 segundos** (el dashboard realiza polling cada 1 segundo con `Promise.allSettled`), la tarjeta correspondiente al coordinador caído cambia su etiqueta a:
     `🔴 Caído - Sin respuesta de red`
   - Las demás tarjetas de `coord-1`, los 3 auths y los KPIs continúan actualizándose en vivo sin errores.
   - El contador de coordinadores activos se actualiza en el resumen (ej: "2 de 3 coordinador(es) activo(s)").

---

## 4. Demostración 2: Registro de Usuario y Traza Distribuida Completa

**Objetivo:** Registrar un nuevo usuario y observar la propagación del `traceId` a través del cliente, el líder de auth, la replicación hacia las réplicas y los acks de quórum.

1. Abre una nueva pestaña en el navegador en **http://localhost:3000/login.html**.
2. En la sección de registro, ingresa un nombre de usuario nuevo (ej. `piloto_demo`) y contraseña.
3. Haz clic en **Registrarse**.
4. En las herramientas de desarrollador (F12 -> Red / Network), o en la respuesta de la petición HTTP, notarás la cabecera:
   `x-trace-id: <UUID>`
5. Regresa al Dashboard (**http://localhost:3000/dashboard.html**):
   - En la sección **"Rastreador de Trazas"**, verás que el `traceId` recién generado ya aparece en la lista de chips de **"Trazas recientes detectadas"**.
   - Haz clic sobre ese chip (o pega el UUID en el campo de texto y haz clic en **Buscar Traza**).
6. **Línea de Tiempo Reconstruida:**
   Verás la reconstrucción exacta y ordenada cronológicamente de la petición atravesando los servicios:
   - `#1 (+0 ms) [auth: líder]` `http_request` `POST /register`
   - `#2 (+X ms) [auth: líder]` `write_propagate_send` `seq N (register)`
   - `#3 (+X ms) [auth: réplica 1]` `write_propagate_recv` `seq N (register) de auth líder`
   - `#4 (+X ms) [auth: réplica 1]` `write_ack_send` `seq N a auth líder`
   - `#5 (+X ms) [auth: líder]` `write_ack_recv` `confirmado por auth réplica (seq N)`
   - `#6 (+X ms) [auth: líder]` `http_response` `POST /register -> 201` (duración total en ms)

---

## 5. Demostración 3: Propagación en la Malla de Coordinadores

1. Ingresa al lobby y conéctate al juego.
2. Al unirte a una sala o mover el vehículo:
   - Se emite `room_replicate` o `intent_replicate` (muestreado).
   - En el dashboard, busca el traceId correspondiente y verás la traza distribuida P2P:
     `[coord-1]` `room_replicate_send` -> `[coord-2]` `room_replicate_recv` -> `[coord-3]` `room_replicate_recv`.

---

## 6. Preguntas Clave para la Sustentación

### Pregunta 1: ¿Cómo funciona el dashboard en vivo?
**Respuesta:**
1. **Recolección No Bloqueante:** El dashboard ejecuta un ciclo de consulta cada 1 segundo (`setInterval(..., 1000)`).
2. **Descubrimiento Dinámico de Nodos:** Obtiene las URLs de los servicios de autenticación a través de la configuración pública (`window.APP_CONFIG.AUTH_URLS`) y consulta el directorio activo en `/coordinators` del líder de autenticación para descubrir las URLs de los coordinadores en tiempo real.
3. **Resiliencia ante Fallos:** Utiliza `Promise.allSettled` y `try/catch` individuales con timeout de red. Si un servicio se apaga o responde con error 5xx, la promesa se captura, la tarjeta se marca visualmente con el distintivo rojo `🔴 Caído`, y los demás servicios continúan reportando sin degradar la pantalla.
4. **Seguridad contra Inyección:** Toda la renderización del DOM se realiza con `document.createElement` y `textContent` (nunca `innerHTML` con datos provenientes del servidor).

### Pregunta 2: ¿Cómo se reconstruye una petición con su traza a través de los servicios?
**Respuesta:**
1. **Identificador Único (`traceId`):** Cada petición HTTP entrante es interceptada por un middleware que extrae la cabecera `x-trace-id`. Si no existe, se genera un UUID aleatorio criptográficamente seguro (`crypto.randomUUID()`). Este mismo `traceId` se inyecta en la cabecera de respuesta HTTP y se propaga en llamadas subsecuentes entre servicios (por ejemplo, del coordinador al auth en `/heartbeat`).
2. **Propagación en Mensajes WebSocket y Mesh:** Los mensajes de replicación y sincronización crítica (`write_propagate`, `write_ack`, `request_sync`, `election`, `vote`, `new_leader`, `room_replicate`, `player_rebalance`, `player_transfer_complete`, `intent_replicate`) incluyen el campo `traceId`. Si un mensaje no trae `traceId`, el protocolo lo procesa normalmente garantizando retrocompatibilidad.
3. **Buffer Circular en Memoria:** Cada instancia mantiene en memoria un buffer circular de capacidad fija (500 entradas) con la estructura `{ traceId, service, id, event, at, durationMs, detail }`. Los datos sensibles (contraseñas, hashes, tokens JWT, tickets de sesión) son saneados y censurados automáticamente antes de almacenarse.
4. **Agregación Descentralizada y Ordenamiento:** Cuando el usuario consulta un `traceId` en el dashboard, el cliente consulta el endpoint `GET /traces/:traceId` en todos los nodos conocidos en paralelo. El cliente reúne todas las entradas obtenidas, las consolida en un único arreglo y las ordena cronológicamente por su timestamp `at`. De este modo, sin necesidad de una base de datos centralizada de auditoría, se visualiza la historia completa del flujo de datos a través de los nodos del sistema distribuido.
