# Desplegar por túnel con ngrok (proyecto final)

El sistema completo son **7 servicios** y cada uno necesita **un túnel** HTTPS:

| Servicio | Puerto local | Variable en `deploy.env` |
|---|---:|---|
| auth-a | 4001 | `AUTH_A_URL` |
| auth-b | 4002 | `AUTH_B_URL` |
| auth-c | 4003 | `AUTH_C_URL` |
| coord-1 (Norte) | 5001 | `COORD_1_URL` |
| coord-2 (Centro) | 5002 | `COORD_2_URL` |
| coord-3 (Sur) | 5003 | `COORD_3_URL` |
| cliente | 3000 | `CLIENT_URL` |

No hacen falta túneles aparte para los mesh. El mesh de los auths (`/auth-mesh`) y el de los coordinadores (`/mesh`) se atienden también en el puerto HTTP de cada servicio, así que viajan por el mismo túnel con `wss://`.

## 1. Instalar y autenticar ngrok (cada PC)

```powershell
ngrok version
ngrok config add-authtoken <TU_AUTHTOKEN>
```

El authtoken se escribe **solo en tu terminal**. Nunca va en el repositorio, en un `.env`, en `deploy.env`, en `ngrok.local.yml`, en capturas ni en logs.

## 2. Repartir los túneles entre PCs

Una cuenta gratuita de ngrok admite pocos endpoints a la vez. Por eso cada integrante abre los túneles de los servicios que corren en **su** PC, con **su** cuenta:

| PC | Servicios | Comando |
|---|---|---|
| PC 1 | auth-a, coord-1, cliente | `.\start-all.ps1 -Mode Tunnel -Only auth-a,coord-1,client` |
| PC 2 | auth-b, coord-2 | `.\start-all.ps1 -Mode Tunnel -Only auth-b,coord-2` |
| PC 3 | auth-c, coord-3 | `.\start-all.ps1 -Mode Tunnel -Only auth-c,coord-3` |

Si una cuenta admite los 7 endpoints, todo puede correr en una sola PC con `.\start-all.ps1 -Mode Tunnel`.

En cada PC:

```powershell
Copy-Item .\ngrok.example.yml .\ngrok.local.yml
# Deja solo los endpoints de tu PC y pon en "url" el dominio que te dio ngrok
ngrok config check --config .\ngrok.local.yml
ngrok start --all --config .\ngrok.local.yml
```

`ngrok.local.yml` no se sube a git.

## 3. `deploy.env`: las URLs de todos

```powershell
Copy-Item .\deploy.env.example .\deploy.env
```

Ahí van las 7 URLs `https://` (las que muestra ngrok en `Forwarding`). **Todas las PCs usan el mismo `deploy.env`**: compártanlo por privado; no se sube a git. Solo lleva URLs, ningún secreto.

Con ese archivo, `start-all.ps1 -Mode Tunnel` arma solo la configuración de cada servicio:

- **Auths:** `PUBLIC_URL`, `PEER_URL` (`wss://`), `AUTH_PEERS` con las URLs de los otros dos, y `CORS_ORIGINS` con la URL del cliente.
- **Coordinadores:** `PUBLIC_URL` y `PEER_URL` (`wss://`), `AUTH_URLS` con los 3 auths y `CLIENT_ORIGINS` con la URL del cliente.
- **Cliente:** `AUTH_URLS` con los 3 auths. Quien entra por `http://localhost:3000` sigue usando los auths locales; quien entra por la URL de ngrok usa los túneles.

## 4. Secretos

`JWT_SECRET`, `COORDINATOR_SHARED_SECRET` y `GOOGLE_CLIENT_ID` deben ser **iguales en todas las PCs**, en `auth-service/.env` y `coordinator/.env`. Se comparten por privado, nunca por el repositorio.

Para el login con Google, agrega la URL del cliente (`CLIENT_URL`) como origen autorizado en Google Cloud Console.

## 5. Comprobar

1. `https://<AUTH_X_URL>/status` en los 3 auths: un `leader`, dos `replica` y `connectedPeers` con los otros dos.
2. `https://<AUTH_lider>/coordinators`: los 3 coordinadores con `live: true`.
3. Abrir `CLIENT_URL`: el lobby muestra `Auth: auth-x (líder)` y el coordinador asignado.

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| Página de advertencia de ngrok en vez de JSON | El cliente y los servicios ya mandan `ngrok-skip-browser-warning`; si lo abres a mano en el navegador, dale "Visit Site" una vez |
| Los auths no eligen líder | Algún túnel de auth no está abierto, o las URLs de `deploy.env` no son iguales en todas las PCs |
| El coordinador no aparece en `/coordinators` | `COORDINATOR_SHARED_SECRET` distinto entre PCs |
| `ERR_NGROK_3200` / 404 de ngrok | El servicio de ese túnel no está corriendo en esa PC |
| Login con Google falla por túnel | Falta `CLIENT_URL` como origen autorizado en Google Cloud |
