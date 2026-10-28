const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");

const app = express();
const publicDirectory = path.join(__dirname, "public");
	app.get("/config.js", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");

  let currentAuth;
  let currentWs;

  if (isLocal) {
    currentAuth = process.env.LOCAL_AUTH_URL || "http://localhost:4000";
    currentWs = process.env.LOCAL_COORDINATOR_WS_URL || "ws://localhost:5000";
  } else {
    currentAuth = process.env.AUTH_URL || "http://localhost:4000";
    currentWs = process.env.COORDINATOR_WS_URL || "ws://localhost:5000";
  }

  console.log(`[config.js] Solicitado desde '${host || req.ip}' (${isLocal ? "MODO LOCAL" : "MODO NGROK"}):`);
  console.log(`  AUTH_URL: ${currentAuth}`);
  console.log(`  COORDINATOR_WS_URL: ${currentWs}`);

  // Taller 5: el Client ID de Google es público (va en el botón del navegador), no es un secreto.
  const googleClientId = process.env.GOOGLE_CLIENT_ID || "";

  res
    .type("application/javascript")
    .set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
    .send(`window.APP_CONFIG = ${JSON.stringify({ AUTH_URL: currentAuth, COORDINATOR_WS_URL: currentWs, GOOGLE_CLIENT_ID: googleClientId })};\n`);
 });

app.get("/", (req, res) => {
  res.redirect(302, "/login.html");
});

app.use(express.static(publicDirectory));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Cliente web escuchando en http://localhost:${port}`);
  console.log(`  - Soporte automático: Local (localhost:3000 -> 4000/5000) y ngrok (túnel público)`);
});
