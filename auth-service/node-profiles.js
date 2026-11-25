'use strict';

// Atajo para levantar uno de los 3 auths sin escribir todas sus variables:
//   node index.js 4001   (o: a, auth-a, npm run start:4001)
//
// Las URLs NO van escritas en el código: salen del .env.
//   AUTH_A_URL / AUTH_B_URL / AUTH_C_URL         URL pública HTTP de cada auth
//                                                (por defecto http://localhost:4001..4003)
//   AUTH_A_PEER_URL / AUTH_B_PEER_URL / ...      URL del mesh (opcional)
// Si no se da la URL del mesh: en local es ws://localhost:410X; si la URL pública es
// https:// (túnel ngrok) el mesh va por el mismo túnel con wss:// (el auth también
// acepta /auth-mesh en su puerto HTTP).
//
// El perfil elegido gana sobre lo que tenga el .env para ESE auth (AUTH_ID, puertos,
// DB_PATH, URLs, AUTH_PEERS): si pides el 4002, arrancas como auth-b aunque el .env
// tenga los datos de auth-a.

const NODES = [
  { key: 'A', authId: 'auth-a', port: 4001, peerPort: 4101 },
  { key: 'B', authId: 'auth-b', port: 4002, peerPort: 4102 },
  { key: 'C', authId: 'auth-c', port: 4003, peerPort: 4103 }
];

// Perfil opcional para un 4.º auth (auth-d / 4004) que se suma al grupo en vivo.
// No se incluye en NODES para que auth-a/b/c mantengan su quórum inicial de 3 nodos.
const EXTRA_NODES = [
  { key: 'D', authId: 'auth-d', port: 4004, peerPort: 4104 }
];

function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function urlsOf(node, env) {
  const publicUrl = trimUrl(env[`AUTH_${node.key}_URL`]) || `http://localhost:${node.port}`;
  let peerUrl = trimUrl(env[`AUTH_${node.key}_PEER_URL`]);
  if (!peerUrl) {
    peerUrl = publicUrl.startsWith('https://')
      ? publicUrl.replace(/^https:/, 'wss:')
      : `ws://localhost:${node.peerPort}`;
  }
  return { publicUrl, peerUrl };
}

function findNode(arg) {
  const clean = String(arg || '').trim().toLowerCase();
  if (!clean) return null;
  const matcher = (node) =>
    clean === String(node.port) ||
    clean === node.authId ||
    clean === node.key.toLowerCase();
  return NODES.find(matcher) || EXTRA_NODES.find(matcher) || null;
}

// Devuelve las variables que hay que poner para ese auth, o null si el argumento
// no es uno de los 3 perfiles (entonces index.js lo trata como un puerto suelto).
function resolveNodeProfile(arg, env = process.env) {
  const node = findNode(arg);
  if (!node) return null;
  const own = urlsOf(node, env);
  const peers = NODES
    .filter((other) => other !== node)
    .map((other) => {
      const urls = urlsOf(other, env);
      return `${other.authId}=${urls.peerUrl}|${urls.publicUrl}`;
    })
    .join(',');
  return {
    AUTH_ID: node.authId,
    PORT: String(node.port),
    PEER_PORT: String(node.peerPort),
    DB_PATH: `users-${node.authId}.db`,
    PUBLIC_URL: own.publicUrl,
    PEER_URL: own.peerUrl,
    AUTH_PEERS: peers
  };
}

module.exports = { resolveNodeProfile, NODES };
