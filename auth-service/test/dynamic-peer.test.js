'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { WebSocket } = require('ws');
const { createReplicationLog } = require('../replication-log');
const { createClusterState } = require('../cluster-state');
const { createAuthMesh, MESH_PATH, SECRET_HEADER } = require('../auth-mesh');
const { createReplication } = require('../replication');
const { createElection } = require('../election');

const SECRET = 'test-auth-mesh-secret-32-characters!';
const silent = { info() {}, error() {} };

function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('local','google')),
      password_hash TEXT,
      google_sub TEXT UNIQUE,
      email TEXT,
      picture_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
  return db;
}

async function waitUntil(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timeout esperando: ${label}`);
}

async function createBareNode(authId) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    authId,
    server,
    port,
    publicUrl: `http://127.0.0.1:${port}`,
    peerUrl: `ws://127.0.0.1:${port}`
  };
}

async function finishNode(bare, peers) {
  const db = newDb();
  const replicationLog = createReplicationLog(db);
  const config = {
    authId: bare.authId,
    port: bare.port,
    peerPort: bare.port,
    publicUrl: bare.publicUrl,
    peerUrl: bare.peerUrl,
    peers,
    clusterSize: peers.length + 1,
    majority: Math.floor((peers.length + 1) / 2) + 1,
    readLagTolerance: 10,
    replicationAckTimeoutMs: 500,
    allowSingleNodeLeadership: false
  };
  const clusterState = createClusterState({ config, replicationLog });
  clusterState.startAsReplica();

  let replication = null;
  const mesh = createAuthMesh({
    config,
    secret: SECRET,
    getHello: () => replication.hello(),
    log: silent,
    pingIntervalMs: 500,
    deadAfterMs: 2500,
    reconnectMs: 200
  });
  replication = createReplication({
    config,
    mesh,
    clusterState,
    replicationLog,
    log: silent,
    heartbeatIntervalMs: 250,
    syncRetryMs: 120
  });
  const election = createElection({
    config,
    mesh,
    clusterState,
    replicationLog,
    log: silent,
    leaderTimeoutMs: 900,
    jitterMs: 80,
    electionTimeoutMs: 500,
    checkEveryMs: 60
  });
  await mesh.start(bare.server);
  replication.start();
  election.start();
  return {
    ...bare,
    db,
    mesh,
    clusterState,
    replicationLog,
    replication,
    election,
    async stop() {
      election.stop();
      replication.stop();
      await mesh.stop();
      await new Promise((resolve) => bare.server.close(resolve));
      db.close();
    }
  };
}

test('un 4to auth desconocido en AUTH_PEERS puede unirse al mesh en caliente, descubrir peers y replicar', async (t) => {
  const nodes = [];
  t.after(async () => {
    for (const node of nodes) await node.stop().catch(() => {});
  });

  const bareA = await createBareNode('auth-a');
  const bareB = await createBareNode('auth-b');
  const bareC = await createBareNode('auth-c');

  const nodeA = await finishNode(bareA, [
    { authId: 'auth-b', peerUrl: bareB.peerUrl, publicUrl: bareB.publicUrl },
    { authId: 'auth-c', peerUrl: bareC.peerUrl, publicUrl: bareC.publicUrl }
  ]);
  const nodeB = await finishNode(bareB, [
    { authId: 'auth-a', peerUrl: bareA.peerUrl, publicUrl: bareA.publicUrl },
    { authId: 'auth-c', peerUrl: bareC.peerUrl, publicUrl: bareC.publicUrl }
  ]);
  const nodeC = await finishNode(bareC, [
    { authId: 'auth-a', peerUrl: bareA.peerUrl, publicUrl: bareA.publicUrl },
    { authId: 'auth-b', peerUrl: bareB.peerUrl, publicUrl: bareB.publicUrl }
  ]);
  nodes.push(nodeA, nodeB, nodeC);

  await waitUntil(() => [nodeA, nodeB, nodeC].some((n) => n.clusterState.isLeader()), 'líder inicial en clúster de 3');
  const initialLeader = [nodeA, nodeB, nodeC].find((n) => n.clusterState.isLeader());

  // El líder registra 2 usuarios y los replica a las otras 2 réplicas
  const insert = initialLeader.db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', 'hash')");
  for (const username of ['alice', 'bob']) {
    const entry = initialLeader.replicationLog.recordLocalWrite('register', () => {
      const info = insert.run(username);
      return initialLeader.replicationLog.dataForUser('register', Number(info.lastInsertRowid));
    });
    assert.equal(await initialLeader.replication.waitForAck(entry.seq), true);
  }
  await waitUntil(() => [nodeA, nodeB, nodeC].every((n) => n.replicationLog.usersCount() === 2), 'sincronización en clúster de 3');

  // Un socket con secreto incorrecto sigue siendo rechazado
  await new Promise((resolve, reject) => {
    const badWs = new WebSocket(`${nodeA.peerUrl}${MESH_PATH}`, {
      headers: { [SECRET_HEADER]: 'secreto-invalido-12345' }
    });
    badWs.once('unexpected-response', (_req, res) => {
      assert.equal(res.statusCode, 401);
      resolve();
    });
    badWs.once('open', () => {
      badWs.close();
      reject(new Error('No debió aceptar secreto inválido'));
    });
  });

  // Ahora llega auth-d conociendo SOLO a auth-b (no hace falta conocer a todos)
  const bareD = await createBareNode('auth-d');
  const nodeD = await finishNode(bareD, [
    { authId: 'auth-b', peerUrl: nodeB.peerUrl, publicUrl: nodeB.publicUrl }
  ]);
  nodes.push(nodeD);

  // Debe conectarse a los 3 nodos (descubriendo auth-a y auth-c por gossip) y replicar los 2 usuarios
  await waitUntil(() => nodeD.mesh.connectedPeers().length === 3, 'auth-d conectado a los 3 peers');
  await waitUntil(() =>
    nodeA.mesh.connectedPeers().includes('auth-d') &&
    nodeB.mesh.connectedPeers().includes('auth-d') &&
    nodeC.mesh.connectedPeers().includes('auth-d'),
  'todos los nodos ven a auth-d');
  await waitUntil(() => nodeD.replicationLog.usersCount() === 2, 'auth-d sincroniza usuarios');

  // El quórum se actualiza dinámicamente a 4 nodos (mayoría = 3)
  assert.equal(nodeA.clusterState.clusterSize(), 4);
  assert.equal(nodeA.clusterState.majority(), 3);
  assert.equal(nodeD.clusterState.clusterSize(), 4);
  assert.equal(nodeD.clusterState.majority(), 3);

  // Si cae el líder actual, los 3 sobrevivientes (3 >= mayoría 3) eligen un nuevo líder
  await initialLeader.stop();
  const survivors = [nodeA, nodeB, nodeC, nodeD].filter((n) => n !== initialLeader);
  await waitUntil(() => survivors.some((n) => n.clusterState.isLeader()), 'nuevo líder tras caída con 4 nodos');
});
