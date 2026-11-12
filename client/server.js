const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");

const app = express();
const publicDirectory = path.join(__dirname, "public");

function publicServiceUrl(value, fallback, protocols) {
  const url = new URL(value || fallback);
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new Error("URL de servicio inválida.");
  }
  url.search = "";
  url.hash = "";
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// Taller 7: lista de auths separada por comas (AUTH_URLS). Si no existe se usa AUTH_URL
// (talleres anteriores) como lista de un elemento, y si tampoco existe, la lista por defecto.
const DEFAULT_LOCAL_AUTH_URLS = "http://localhost:4001,http://localhost:4002,http://localhost:4003,http://localhost:4000";

function publicServiceUrlList(listValue, singleValue, defaultList, protocols) {
  const split = (value) => (value || "").split(",").map((item) => item.trim()).filter(Boolean);
  let values = split(listValue);
  if (values.length === 0 && singleValue) values = [singleValue];
  if (values.length === 0) values = split(defaultList);
  const urls = [];
  for (const value of values) {
    const url = publicServiceUrl(value, value, protocols);
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

app.get("/config.js", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");

  let currentAuth;
  let currentWs;

  try {
    if (isLocal) {
      currentAuth = publicServiceUrlList(process.env.LOCAL_AUTH_URLS, process.env.LOCAL_AUTH_URL, DEFAULT_LOCAL_AUTH_URLS, ["http:", "https:"]);
      currentWs = publicServiceUrl(process.env.LOCAL_COORDINATOR_WS_URL, "ws://localhost:5000", ["ws:", "wss:"]);
    } else {
      currentAuth = publicServiceUrlList(process.env.AUTH_URLS, process.env.AUTH_URL, DEFAULT_LOCAL_AUTH_URLS, ["http:", "https:"]);
      currentWs = publicServiceUrl(process.env.COORDINATOR_WS_URL, "ws://localhost:5000", ["ws:", "wss:"]);
    }
  } catch {
    console.error("[client] No se pudo generar la configuración pública: URL de servicio inválida.");
    return res.status(500).type("text/plain").send("Configuración del cliente no disponible.");
  }

  console.log(`[config.js] Configuración solicitada (${isLocal ? "MODO LOCAL" : "MODO NGROK"}, ${currentAuth.length} auth(s)).`);

  // Taller 5: el Client ID de Google es público (va en el botón del navegador), no es un secreto.
  const googleClientId = process.env.GOOGLE_CLIENT_ID || "";

  res
    .type("application/javascript")
    .set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
    .send(`window.APP_CONFIG = ${JSON.stringify({ AUTH_URL: currentAuth[0], AUTH_URLS: currentAuth, COORDINATOR_WS_URL: currentWs, GOOGLE_CLIENT_ID: googleClientId })};\n`);
});

app.get("/", (req, res) => {
  res.redirect(302, "/login.html");
});

app.get("/tracks.js", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "shared", "tracks.js"));
});

app.use(express.static(publicDirectory));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("[client] Error al servir una respuesta pública.");
  return res.status(500).type("text/plain").send("No se pudo completar la solicitud.");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Cliente web escuchando en http://localhost:${port}`);
  console.log(`  - Soporte automático: Local (localhost:3000 -> auths 4001-4003 / 5000) y ngrok (túnel público)`);
});
