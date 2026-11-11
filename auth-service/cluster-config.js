// Taller 7: configuración de un auth-service dentro de un grupo replicado.
// Lee y valida las variables del .env. Si no se configura nada, se comporta como un
// auth único (Talleres 4-6): sin peers, y su ID se deriva del puerto.

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class ClusterConfigError extends Error {}

function parsePort(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ClusterConfigError(`${name} debe ser un puerto entre 1 y 65535.`);
  }
  return port;
}

function parsePositiveInt(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new ClusterConfigError(`${name} debe ser un entero mayor o igual a 0.`);
  }
  return number;
}

// URL sin credenciales, ruta, query ni fragmento (igual que las URLs de los coordinadores)
function parseBaseUrl(name, value, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ClusterConfigError(`${name} no es una URL válida.`);
  }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new ClusterConfigError(`${name} debe usar ${protocols.join(' o ')} sin ruta, credenciales, query ni fragmento.`);
  }
  return url.origin;
}

// AUTH_PEERS=auth-b=ws://localhost:4102|http://localhost:4002,auth-c=ws://localhost:4103|http://localhost:4003
// La parte después de "|" (URL pública HTTP del peer) es opcional: sirve para responder
// leaderUrl antes de que el mesh confirme las URLs con el hello.
function parseAuthPeers(value, selfId) {
  if (!value || !value.trim()) return [];
  const peers = [];
  const seen = new Set();
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const separator = item.indexOf('=');
    if (separator <= 0) {
      throw new ClusterConfigError(`AUTH_PEERS: "${item}" debe tener la forma authId=ws://host:puerto (|http://host:puerto opcional).`);
    }
    const authId = item.slice(0, separator).trim();
    const [rawPeerUrl, rawPublicUrl, ...extra] = item.slice(separator + 1).split('|').map((part) => part.trim());
    if (extra.length) {
      throw new ClusterConfigError(`AUTH_PEERS (${authId}): usa un solo "|" entre la URL del mesh y la URL pública.`);
    }
    const peerUrl = parseBaseUrl(`AUTH_PEERS (${authId})`, rawPeerUrl, ['ws:', 'wss:']);
    const publicUrl = rawPublicUrl
      ? parseBaseUrl(`AUTH_PEERS (${authId}, URL pública)`, rawPublicUrl, ['http:', 'https:'])
      : null;
    if (!ID_PATTERN.test(authId)) {
      throw new ClusterConfigError(`AUTH_PEERS: el ID "${authId}" solo puede tener letras, números, guion y guion bajo.`);
    }
    if (authId === selfId) {
      throw new ClusterConfigError(`AUTH_PEERS no debe incluir a este mismo auth (${selfId}).`);
    }
    if (seen.has(authId)) {
      throw new ClusterConfigError(`AUTH_PEERS repite el ID ${authId}.`);
    }
    seen.add(authId);
    peers.push({ authId, peerUrl, publicUrl });
  }
  return peers.sort((a, b) => (a.authId < b.authId ? -1 : a.authId > b.authId ? 1 : 0));
}

function loadClusterConfig(env = process.env) {
  const port = parsePort('PORT', env.PORT, 4000);
  const authId = (env.AUTH_ID || `auth-${port}`).trim();
  if (!ID_PATTERN.test(authId)) {
    throw new ClusterConfigError('AUTH_ID debe tener de 1 a 64 caracteres: letras, números, guion o guion bajo.');
  }

  const peerPort = parsePort('PEER_PORT', env.PEER_PORT, port + 100);
  if (peerPort === port) {
    throw new ClusterConfigError('PEER_PORT debe ser distinto de PORT.');
  }

  const publicUrl = parseBaseUrl('PUBLIC_URL', env.PUBLIC_URL || `http://localhost:${port}`, ['http:', 'https:']);
  const peerUrl = parseBaseUrl('PEER_URL', env.PEER_URL || `ws://localhost:${peerPort}`, ['ws:', 'wss:']);
  const peers = parseAuthPeers(env.AUTH_PEERS, authId);

  return {
    authId,
    port,
    publicUrl,
    peerPort,
    peerUrl,
    peers,
    // Mayoría para ganar una elección: con 3 auths son 2 (contándose a sí mismo)
    clusterSize: peers.length + 1,
    majority: Math.floor((peers.length + 1) / 2) + 1,
    readLagTolerance: parsePositiveInt('READ_LAG_TOLERANCE', env.READ_LAG_TOLERANCE, 10),
    replicationAckTimeoutMs: parsePositiveInt('REPLICATION_ACK_TIMEOUT_MS', env.REPLICATION_ACK_TIMEOUT_MS, 2000)
  };
}

module.exports = { loadClusterConfig, parseAuthPeers, ClusterConfigError };
