# Exponer servicios con ngrok

La demo base publica Auth, Client y tres procesos Coordinator mediante cinco
endpoints HTTP(S) independientes. ngrok termina HTTPS y también transporta
WebSocket sobre el mismo endpoint del coordinador para los clientes. Si los
coordinadores se ejecutan en equipos distintos, el mesh también necesita una
ruta WSS accesible a cada listener `PEER_PORT`, preferiblemente mediante VPN o
red privada. No expongas el listener peer al Internet abierto: WSS cifra el
tráfico, pero el protocolo mesh actual no autentica a cada coordinador entrante.

## Requisitos

- Node.js y dependencias instaladas para `auth-service`, `client` y
  `coordinator`.
- ngrok Agent v3 instalado desde la
  [página oficial para Windows](https://ngrok.com/download/windows).
- Una cuenta ngrok con capacidad para mantener **cinco endpoints online a la
  vez** y cinco URLs/dominios distintos utilizables.

Según la [tabla oficial de precios](https://ngrok.com/pricing), Free y Hobbyist
permiten hasta tres endpoints online; no bastan para este objetivo. El plan
Pay-as-you-go indica endpoints online ilimitados, pero el uso de endpoints
activos puede generar cargos por hora. La cuenta también debe permitir asignar
cinco dominios distintos. Revisa precios y límites actuales antes de iniciar;
ngrok puede cambiarlos.

## 1. Instalar y autenticar ngrok

Verifica la CLI:

```powershell
ngrok version
ngrok config check
```

Configura el authtoken desde tu propio terminal. Pégalo solo en el prompt o
comando local y **no** lo guardes en este repositorio, archivos `.env`,
configuración versionada, capturas ni logs:

```powershell
ngrok config add-authtoken <TU_AUTHTOKEN>
```

ngrok conserva las credenciales en su configuración de usuario, fuera del
repositorio. El proyecto no necesita conocer ni leer el authtoken.

## 2. Preparar cinco túneles

La plantilla versionada [`../ngrok.example.yml`](../ngrok.example.yml) usa
formato de configuración v3 y define los upstreams:

| Endpoint | Puerto local | Uso |
|---|---:|---|
| `auth` | 4000 | API de autenticación y directorio |
| `client` | 3000 | Sitio web |
| `coordinator-1` | 5001 | HTTP, tickets y WebSocket del coordinador 1 |
| `coordinator-2` | 5002 | HTTP, tickets y WebSocket del coordinador 2 |
| `coordinator-3` | 5003 | HTTP, tickets y WebSocket del coordinador 3 |

Copia la plantilla a un archivo local ignorado por Git:

```powershell
Copy-Item .\ngrok.example.yml .\ngrok.local.yml
```

En cada endpoint de `ngrok.local.yml`, añade un campo `url` con **el dominio
distinto que hayas asignado a ese servicio en tu cuenta**. Usa las URLs HTTPS
que realmente muestra ngrok o tu dashboard; no copies URLs de ejemplo ni
reutilices el mismo dominio. El archivo queda excluido de Git.
Asigna o reserva los dominios en el dashboard de ngrok antes de iniciar el
grupo; al arrancar, la CLI también muestra la URL pública de cada endpoint en
sus líneas `Forwarding`.

```yaml
endpoints:
  - name: auth
    url: https://<DOMINIO-REAL-DE-AUTH>
    upstream:
      url: 4000
  - name: client
    url: https://<DOMINIO-REAL-DEL-CLIENT>
    upstream:
      url: 3000
  - name: coordinator-1
    url: https://<DOMINIO-REAL-DEL-COORDINADOR-1>
    upstream:
      url: 5001
  - name: coordinator-2
    url: https://<DOMINIO-REAL-DEL-COORDINADOR-2>
    upstream:
      url: 5002
  - name: coordinator-3
    url: https://<DOMINIO-REAL-DEL-COORDINADOR-3>
    upstream:
      url: 5003
```

El fragmento ilustra dónde colocar las URLs, no es una configuración ejecutable
hasta reemplazar cada marcador por una URL asignada. Si tu cuenta no permite
cinco endpoints o cinco dominios distintos, no hay una configuración local
que evite ese límite: usa un plan que lo permita o reduce la demostración a los
servicios que admite la cuenta.

Valida el archivo local y luego inicia los cinco endpoints:

```powershell
ngrok config check --config .\ngrok.local.yml
ngrok start --all --config .\ngrok.local.yml
```

La configuración v3 usa `endpoints` y `upstream.url`; el endpoint HTTP del
coordinador también soporta el upgrade WebSocket de `/connect`. Los tres
coordinadores en este flujo corren en el mismo equipo y se comunican por sus
listeners `PEER_PORT` locales (`6001`–`6003`); esos puertos no se exponen a los
navegadores ni requieren túneles adicionales. Para equipos distintos, cada
coordinador debe tener además una URL WSS que reenvíe al `PEER_PORT` de ese
equipo, o una conexión por red privada/firewall. La URL peer se comparte entre
coordinadores por el directorio de Auth.

## 3. Variables de entorno

Usa las URLs de tu cuenta únicamente en los `.env` locales. No cambies los
valores de los `.env.example` por dominios reales.

### Auth

En `auth-service/.env`, configura el origen exacto del Client público y
mantén el secreto compartido que ya usa el servicio:

```dotenv
CORS_ORIGINS=http://localhost:3000,https://<DOMINIO-REAL-DEL-CLIENT>
```

`COORDINATOR_SHARED_SECRET` debe coincidir con el valor usado por los
coordinadores. No se imprime ni se envía al Client.

### Client

En `client/.env`:

```dotenv
PORT=3000
AUTH_URL=https://<DOMINIO-REAL-DE-AUTH>
COORDINATOR_WS_URL=wss://<DOMINIO-REAL-DEL-COORDINADOR-1>
```

El navegador usa `AUTH_URL` para registro, login y selección de coordinador.
Cuando Auth devuelve un coordinador, el Client conecta a su `PUBLIC_URL`;
`COORDINATOR_WS_URL` es el fallback del coordinador único para una versión
antigua de Auth. La página pública es HTTPS, por lo que la URL WebSocket debe
ser `wss://`, no `ws://`.

### Coordinadores

En `coordinator/.env`, configura la URL pública del Auth y los orígenes web
permitidos:

```dotenv
AUTH_URL=https://<DOMINIO-REAL-DE-AUTH>
CLIENT_ORIGINS=http://localhost:3000,https://<DOMINIO-REAL-DEL-CLIENT>
```

Con `start-coordinators.ps1`, pasa la URL WebSocket de cada endpoint público mediante
`-PublicUrls`; el script asigna una a cada instancia como `PUBLIC_URL`:

```powershell
$publicCoordinatorUrls = @(
  "wss://<DOMINIO-REAL-DEL-COORDINADOR-1>",
  "wss://<DOMINIO-REAL-DEL-COORDINADOR-2>",
  "wss://<DOMINIO-REAL-DEL-COORDINADOR-3>"
)
.\coordinator\start-coordinators.ps1 -PublicUrls $publicCoordinatorUrls
```

Para más instancias locales usa `-Count`; por ejemplo,
`.\coordinator\start-coordinators.ps1 -Count 5`. Si omites `-PublicUrls`, el
script anuncia `ws://localhost` para cada proceso, URLs que no sirven para
clientes remotos.

`PEER_PORT` es el listener del mesh y `PEER_URL` es la dirección que el
directorio devuelve a los otros coordinadores. En esta guía los tres procesos
comparten equipo, por lo que `ws://localhost:6001`–`:6003` son alcanzables sin
túnel. Si los coordinadores se ejecutan en equipos distintos, cada `PEER_URL`
debe ser accesible desde los demás y el tráfico peer requiere una ruta de red
propia; no uses las URLs locales de esta guía en ese despliegue. En ese caso,
configura en el `.env` de cada equipo una `PUBLIC_URL` WSS que reenvíe a su
`PORT` y una `PEER_URL` WSS distinta que reenvíe a su `PEER_PORT`. El Auth
selecciona la `PUBLIC_URL` para los clientes y entrega `PEER_URL` al mesh.
Alternativamente, configura `-PeerUrls` junto con `-PublicUrls` al iniciar
varios procesos en una sola máquina.

ngrok requiere un endpoint por listener peer además de los endpoints de cliente
cuando no hay una VPN/red privada. Por ejemplo, tres coordinadores remotos
necesitan tres rutas públicas extra para `PEER_PORT`; revisa los límites y
costos de la cuenta y restringe cada endpoint con controles de acceso de red.
Nunca publiques una URL `ws://` sin cifrar ni dejes el listener peer accesible
sin restricciones desde Internet.

Reinicia los servicios después de modificar sus `.env`. El script de
coordinadores lee `AUTH_URL` y `COORDINATOR_SHARED_SECRET` desde su entorno o
`coordinator/.env`, y exige un `PUBLIC_URL` distinto para cada proceso al
usar ngrok. En equipos distintos, cada instancia debe tener un
`COORDINATOR_ID` único, además de `JWT_SECRET` y `COORDINATOR_SHARED_SECRET`
idénticos a los de Auth.

## 4. Iniciar servicios locales

Abre terminales en la raíz y ejecuta:

```powershell
npm start --prefix auth-service
npm start --prefix client
```

Inicia los túneles con `ngrok start --all` desde otra terminal. Después, en
una terminal adicional, inicia los tres coordinadores con las tres URLs
`wss://` mostradas/asignadas por ngrok:

```powershell
.\coordinator\start-coordinators.ps1 -PublicUrls $publicCoordinatorUrls
```

En la práctica, prepara primero las URLs asignadas en el dashboard y
`ngrok.local.yml`; el orden de arranque de los túneles y upstreams puede
intercambiarse. Una respuesta 502 antes de que arranque el upstream es
temporal.

## 5. Verificar los cinco servicios

Comprueba primero los servicios locales:

```powershell
Invoke-RestMethod http://localhost:4000/health
Invoke-RestMethod http://localhost:5001/health
Invoke-RestMethod http://localhost:5002/health
Invoke-RestMethod http://localhost:5003/health
Invoke-WebRequest http://localhost:3000/
```

Luego usa las URLs HTTPS reales que ngrok muestra:

```powershell
Invoke-RestMethod https://<DOMINIO-REAL-DE-AUTH>/health
Invoke-WebRequest https://<DOMINIO-REAL-DEL-CLIENT>/
Invoke-RestMethod https://<DOMINIO-REAL-DEL-COORDINADOR-1>/health
Invoke-RestMethod https://<DOMINIO-REAL-DEL-COORDINADOR-2>/health
Invoke-RestMethod https://<DOMINIO-REAL-DEL-COORDINADOR-3>/health
```

En Auth, `GET /coordinators` debe mostrar los tres IDs como vigentes. Desde el
Client público, registra/inicia sesión y verifica que el navegador se conecte
al coordinador seleccionado usando `wss://`. Estas son instrucciones; no se
han iniciado túneles ni probado conexiones externas como parte de esta tarea.

## 6. Diagnóstico y seguridad

- **Endpoint limitado por el plan:** Free y Hobbyist permiten tres endpoints
  online según la tabla de precios enlazada arriba; cinco requieren una cuenta
  que permita esa cantidad simultánea. Revisa también el costo por endpoint
  activo y la disponibilidad de dominios.
- **URL o dominio duplicado:** cada uno de los cinco endpoints requiere un
  destino público inequívoco; asigna cinco URLs distintas.
- **502 / `ERR_NGROK`:** comprueba que el servicio está activo en el puerto
  correcto y que el `upstream.url` coincide con la tabla.
- **CORS o preflight:** incluye el origen HTTPS exacto del Client en
  `CORS_ORIGINS` y `CLIENT_ORIGINS`; reinicia Auth y coordinadores.
- **Mixed content:** usa `https://` para Auth y `wss://` para Coordinator
  cuando el Client se sirve por HTTPS.
- **Ticket o WebSocket rechazado:** usa el `PUBLIC_URL` correspondiente a cada
  instancia, revisa que Auth y Coordinator compartan `JWT_SECRET`, y solicita
  un ticket nuevo. No copies el JWT ni el ticket a URLs, logs o capturas.
- **Credenciales:** el authtoken queda en la configuración privada de ngrok;
  `ngrok.local.yml` y los `.env` reales están ignorados por Git. No muestres
  `COORDINATOR_SHARED_SECRET`, `JWT_SECRET`, tokens ni tickets.
- **Intersticial de ngrok:** las peticiones `fetch` del Client ya envían
  `ngrok-skip-browser-warning: true`.

Auth devuelve las URLs públicas para los clientes y cada instancia descubre
las otras mediante `GET /peers`. El mesh usa conexiones WebSocket separadas en
`PEER_PORT`; la entrada del coordinador es por `PORT` y no se comparte con los
navegadores. Los peers replican jugadores, movimiento, extras y salas mientras
sus conexiones sigan vivas.
