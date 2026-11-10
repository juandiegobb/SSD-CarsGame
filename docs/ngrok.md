# Despliegue local con ngrok

Esta guía publica los tres servicios locales con tres endpoints ngrok distintos. No
incluyas el authtoken, secretos ni URLs públicas reales en archivos del repositorio.

## Prerrequisitos

- Instala ngrok para Windows desde Microsoft Store o
  [la página oficial de descargas](https://ngrok.com/download/windows).
- Inicia sesión en ngrok y configura el authtoken en tu equipo, sin compartirlo:

  ```powershell
  ngrok config add-authtoken <TU_AUTHTOKEN>
  ngrok version
  ngrok config check
  ```

- Instala las dependencias de cada servicio (`npm install` desde sus carpetas).
- En `auth-service/.env` y `coordinator/.env`, configura la misma `JWT_SECRET`.
- Arranca un servicio por terminal, desde la raíz del repositorio:

  ```powershell
  npm start --prefix auth-service
  npm start --prefix coordinator
  npm start --prefix client
  ```

- Comprueba la disponibilidad local antes de abrir túneles:

  ```powershell
  Invoke-WebRequest http://localhost:4000/health
  Invoke-WebRequest http://localhost:5000/health
  Invoke-WebRequest http://localhost:3000/
  ```

  La ruta `/` del cliente redirige a `/login.html`.

## Abrir los túneles

La sintaxis verificada con ngrok Agent `3.39.9-msix-stable` es `ngrok http
[address:port] [--url URL]`; se puede consultar con `ngrok http --help`.
Ejecuta cada comando en una terminal separada y asígnale un dominio distinto
disponible en tu cuenta:

```powershell
ngrok http 4000 --url https://<dominio-auth-asignado>
ngrok http 5000 --url https://<dominio-coordinador-asignado>
ngrok http 3000 --url https://<dominio-cliente-asignado>
```

Asocia cada URL HTTPS publicada al servicio correspondiente:

| Servicio | Puerto local | URL pública que se debe configurar |
|---|---:|---|
| Auth | 4000 | `https://<dominio-auth-asignado>` |
| Coordinador | 5000 | `https://<dominio-coordinador-asignado>` |
| Cliente | 3000 | `https://<dominio-cliente-asignado>` |

Las tres URLs deben ser **distintas**. Si la cuenta o el plan no permite
asignar tres dominios distintos, revisa en el dashboard de ngrok los dominios
disponibles. Según la [página oficial de planes de ngrok](https://ngrok.com/pricing),
el plan Free incluye tres endpoints online y un dominio de desarrollo; por eso
el límite observado puede ser de dominios, no de sesiones simultáneas. Considera
un plan con varios dominios ngrok o dominios propios que puedas asignar a los
endpoints. No reutilices una URL para varios puertos: los clientes no tendrían
tres destinos inequívocos.

## Variables de entorno para URLs públicas

Después de confirmar las tres URLs asignadas, actualiza los `.env` locales.
No agregues barra al final de las URLs:

```dotenv
# client/.env
PORT=3000
AUTH_URL=https://<dominio-auth-asignado>
COORDINATOR_WS_URL=wss://<dominio-coordinador-asignado>
```

```dotenv
# auth-service/.env
CORS_ORIGINS=http://localhost:3000,https://<dominio-cliente-asignado>
```

`coordinator/.env` normalmente no requiere cambios: conserva `PORT` y la misma
`JWT_SECRET` que Auth. Reinicia Auth, Coordinador y Cliente para cargar sus
respectivos `.env`. En el navegador, recarga el cliente y comprueba
`/config.js`; el cliente debe mostrar `AUTH_URL` con `https://` y
`COORDINATOR_WS_URL` con `wss://`.

## Pruebas públicas

Usa las URLs reales solo en la terminal, Thunder Client y el navegador; no las
pegues en archivos versionados:

```powershell
Invoke-RestMethod https://<dominio-auth-asignado>/health
Invoke-RestMethod https://<dominio-coordinador-asignado>/health
Invoke-WebRequest https://<dominio-cliente-asignado>/
```

En `coordinator/.env`, configura `CLIENT_ORIGINS=https://<dominio-cliente-asignado>`
(separado por coma si también conservas `http://localhost:3000`) y reinicia el
coordinador. Desde la URL pública del cliente, registra un usuario, inicia sesión y confirma
que el lobby conecta por `wss://`. Repite la prueba con un segundo navegador o
dispositivo y confirma que las listas se actualizan en ambos sin recargar.
Thunder Client debe probar `POST /register` y `POST /login` contra la URL
pública de Auth. Para probar el endpoint WebSocket público, solicita un ticket
efímero por HTTPS y conéctate usando subprotocolos:

```powershell
$login = Invoke-RestMethod -Method Post https://<dominio-auth-asignado>/login -ContentType "application/json" -Body '{"username":"alice","password":"<CONTRASEÑA>"}'
$ticket = (Invoke-RestMethod -Method Post https://<dominio-coordinador-asignado>/ws-ticket -Headers @{ Authorization = "Bearer $($login.token)"; "ngrok-skip-browser-warning" = "true" }).ticket
wscat -c "wss://<dominio-coordinador-asignado>/connect" -s carsgame.v1 -s "auth.$ticket"
```

El JWT viaja solo en el header HTTPS `Authorization`; no lo pongas en una URL
ni en mensajes WebSocket. El ticket es una credencial temporal: dura hasta 15
segundos y se consume una vez. Configura proxies y herramientas de inspección
para no registrar el header `Authorization` ni `Sec-WebSocket-Protocol`. No
guardes ni publiques el JWT ni el ticket.

## Diagnóstico

- **CORS o preflight fallido:** agrega el origen HTTPS exacto del cliente a
  `CORS_ORIGINS` en `auth-service/.env` y `CLIENT_ORIGINS` en
  `coordinator/.env`, y reinicia ambos servicios. Auth debe permitir
  `Content-Type` y `ngrok-skip-browser-warning`; el coordinador debe permitir
  `Authorization` y `ngrok-skip-browser-warning` en `POST /ws-ticket`.
- **Mixed content o WebSocket bloqueado:** con una página HTTPS usa `https://`
  para Auth y `wss://` para el Coordinador; no uses `http://` ni `ws://`.
- **Intersticial de ngrok:** el cliente añade
  `ngrok-skip-browser-warning: true` a sus peticiones HTTP.
- **Cierre 4001 al conectar:** solicita un ticket nuevo; comprueba que Auth y
  Coordinador tengan la misma `JWT_SECRET` y que el JWT no esté vencido.
- **Credencial visible en un proxy:** aunque el JWT no está en la URL, puede
  aparecer en `Authorization` al solicitar el ticket y el ticket en
  `Sec-WebSocket-Protocol`. No registres esos headers en proxies o herramientas
  de inspección ni compartas capturas del handshake. El ticket dura 15 segundos
  y se consume una vez.
- **502 o ERR_NGROK:** confirma que el servicio local está escuchando en el
  puerto correspondiente y que ngrok apunta a ese puerto.
- **Una misma URL pública para varios túneles:** no configures esa URL en los
  `.env`; revisa las asignaciones de dominios/endpoints del plan de ngrok antes
  de continuar.

## Verificación de esta fase

En la ejecución local de Fase 4, los tres comandos `ngrok http 4000`,
`ngrok http 5000` y `ngrok http 3000` iniciaron, pero cada inspector local
reportó la misma URL pública para un upstream distinto. Se detuvieron las tres
sesiones para no dejar una URL ambigua apuntando a servicios diferentes. Por
esto aún no se completaron las pruebas públicas de Auth, Coordinador, lobby,
CORS, `wscat`, ni registro/login por ngrok. Se deben repetir cuando la cuenta
disponga de tres URLs distintas.

En el plan gratuito, las URLs asignadas pueden cambiar al reiniciar los
túneles. Si cambian, actualiza `client/.env` y `auth-service/.env`, reinicia
los tres servicios y vuelve a probar el flujo antes de la sustentación. Mantén
los tres túneles activos durante la demostración.
