'use strict';

// Taller 7: replicación y elección con un "mesh" de mentira en memoria (sin red),
// para probar las reglas de SPEC §13.6–13.9 de forma rápida y repetible.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createReplicationLog } = require('../replication-log');
const { createClusterState } = require('../cluster-state');
const { createReplication } = require('../replication');
const { createElection } = require('../election');

const silent = { info() {}, error() {} };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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

// Bus en memoria: cada nodo tiene un objeto con la misma interfaz que auth-mesh.js
function createBus() {
  const nodes = new Map();
  const links = new Set(); // "a|b" ordenado
  const key = (a, b) => [a, b].sort().join('|');

  function meshFor(authId) {
    const handlers = new Map();
    const up = [];
    const down = [];
    const mesh = {
      on(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
      deliver(type, msg, from) {
        for (const fn of handlers.get(type) || []) fn(msg, from);
      },
      send(to, msg) {
        if (!links.has(key(authId, to))) return false;
        const copy = JSON.parse(JSON.stringify(msg));
        setImmediate(() => links.has(key(authId, to)) && nodes.get(to).mesh.deliver(copy.type, copy, authId));
        return true;
      },
      broadcast(msg) {
        let sent = 0;
        for (const other of nodes.keys()) if (other !== authId && mesh.send(other, msg)) sent += 1;
        return sent;
      },
      connectedPeers: () => [...nodes.keys()].filter((other) => other !== authId && links.has(key(authId, other))),
      onPeerUp: (fn) => up.push(fn),
      onPeerDown: (fn) => down.push(fn),
      up,
      down
    };
    return mesh;
  }

  function addNode(authId, peerIds) {
    const db = newDb();
    const replicationLog = createReplicationLog(db);
    const config = {
      authId,
      publicUrl: `http://${authId}`,
      peerUrl: `ws://${authId}`,
      peers: peerIds.map((id) => ({ authId: id, peerUrl: `ws://${id}`, publicUrl: `http://${id}` })),
      clusterSize: peerIds.length + 1,
      majority: Math.floor((peerIds.length + 1) / 2) + 1,
      readLagTolerance: 10,
      replicationAckTimeoutMs: 200
    };
    const clusterState = createClusterState({ config, replicationLog });
    clusterState.startAsReplica();
    const mesh = meshFor(authId);
    const replication = createReplication({ config, mesh, clusterState, replicationLog, log: silent });
    const election = createElection({
      config, mesh, clusterState, replicationLog, log: silent, random: () => 0
    });
    const node = { authId, db, replicationLog, clusterState, mesh, replication, election };
    nodes.set(authId, node);
    return node;
  }

  function connect(a, b) {
    links.add(key(a, b));
    for (const [from, to] of [[a, b], [b, a]]) {
      const hello = { type: 'hello', ...nodes.get(from).replication.hello() };
      setImmediate(() => nodes.get(to).mesh.deliver('hello', hello, from));
      nodes.get(to).mesh.up.forEach((fn) => fn(from));
    }
  }

  function disconnect(a, b) {
    links.delete(key(a, b));
    nodes.get(a).mesh.down.forEach((fn) => fn(b));
    nodes.get(b).mesh.down.forEach((fn) => fn(a));
  }

  function isolate(id) {
    for (const other of nodes.keys()) if (other !== id && links.has(key(id, other))) disconnect(id, other);
  }

  return { nodes, addNode, connect, disconnect, isolate };
}

function cluster3() {
  const bus = createBus();
  const ids = ['auth-a', 'auth-b', 'auth-c'];
  for (const id of ids) bus.addNode(id, ids.filter((other) => other !== id));
  bus.connect('auth-a', 'auth-b');
  bus.connect('auth-a', 'auth-c');
  bus.connect('auth-b', 'auth-c');
  return bus;
}

function register(node, username) {
  return node.replicationLog.recordLocalWrite('register', () => {
    const info = node.db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', 'h')").run(username);
    return node.replicationLog.dataForUser('register', Number(info.lastInsertRowid));
  });
}

const usernames = (node) => node.db.prepare('SELECT id, username FROM users ORDER BY id').all()
  .map((row) => `${row.id}:${row.username}`);

test('elección: el primero en postularse gana con 2 de 3 votos y avisa con new_leader', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  // auth-a se postula (como si llevara 6 s sin líder)
  a.clusterState.becomeCandidate();
  a.mesh.broadcast({ type: 'election', candidate: 'auth-a', term: a.clusterState.getTerm(), lastSeq: 0 });
  // los votos llegan al election de auth-a
  await settle();
  await settle();
  assert.equal(a.clusterState.getRole(), 'leader');
  assert.equal(bus.nodes.get('auth-b').clusterState.describe().leaderId, 'auth-a');
  assert.equal(bus.nodes.get('auth-c').clusterState.describe().leaderId, 'auth-a');
});

test('voto: un solo voto por term y nunca a un candidato con datos más viejos', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  const b = bus.nodes.get('auth-b');
  const c = bus.nodes.get('auth-c');
  register(c, 'solo-en-c'); // c tiene una escritura que a no tiene (escrita a mano para la prueba)

  const votes = [];
  a.mesh.on('vote', (msg) => votes.push(msg));
  a.clusterState.becomeCandidate();
  a.mesh.broadcast({ type: 'election', candidate: 'auth-a', term: 1, lastSeq: 0 });
  await settle();
  const byVoter = Object.fromEntries(votes.map((vote) => [vote.voter, vote.voteGranted]));
  assert.equal(byVoter['auth-b'], true, 'b tiene lastSeq 0: vota a favor');
  assert.equal(byVoter['auth-c'], false, 'c va más adelante (lastSeq 1): vota en contra');

  // b ya votó por a en el term 1: no puede votar por c en el mismo term
  assert.equal(b.clusterState.grantVote(1, 'auth-c'), false);
});

test('opción B: el líder recibe write_ack y las réplicas quedan iguales', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  a.clusterState.becomeLeader(1);
  a.replication.sendHeartbeats();
  await settle();

  const entry = register(a, 'alice');
  assert.equal(await a.replication.waitForAck(entry.seq), true);
  await settle();
  for (const id of ['auth-b', 'auth-c']) {
    assert.deepEqual(usernames(bus.nodes.get(id)), ['1:alice']);
    assert.equal(bus.nodes.get(id).replicationLog.lastAppliedSeq(), 1);
  }
});

test('opción B: sin réplicas conectadas el líder espera y devuelve false (replication_timeout)', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  a.clusterState.becomeLeader(1);
  bus.isolate('auth-a');
  const entry = register(a, 'alice');
  const started = Date.now();
  assert.equal(await a.replication.waitForAck(entry.seq), false);
  assert.ok(Date.now() - started >= 190);
});

test('réplica que vuelve atrasada pide request_sync y se pone al día', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  a.clusterState.becomeLeader(1);
  bus.isolate('auth-c');
  register(a, 'alice');
  register(a, 'bob');
  await settle();
  assert.equal(bus.nodes.get('auth-c').replicationLog.lastAppliedSeq(), 0);

  bus.connect('auth-a', 'auth-c'); // vuelve: en el hello ve al líder y pide sync
  await settle();
  await settle();
  const c = bus.nodes.get('auth-c');
  assert.deepEqual(usernames(c), ['1:alice', '2:bob']);
  assert.equal(c.clusterState.describe().leaderId, 'auth-a');
  assert.equal(c.clusterState.getRole(), 'replica');
});

test('hueco en write_propagate: la réplica no aplica fuera de orden y pide sync', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  const b = bus.nodes.get('auth-b');
  a.clusterState.becomeLeader(1);
  bus.disconnect('auth-a', 'auth-b');
  register(a, 'alice'); // b no lo recibe
  bus.connect('auth-a', 'auth-b');
  // el hello ya dispara sync; además llega una escritura nueva
  register(a, 'bob');
  await settle();
  await settle();
  assert.deepEqual(usernames(b), ['1:alice', '2:bob']);
});

test('ex-líder que vuelve con una escritura no confirmada la descarta y copia la del nuevo líder', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  const b = bus.nodes.get('auth-b');
  a.clusterState.becomeLeader(1);
  register(a, 'alice');
  await settle();

  // a se queda solo, escribe carol (nadie la confirma) y "se cae"
  bus.isolate('auth-a');
  register(a, 'carol');
  a.clusterState.becomeReplica(null, 1);

  // b gana el term 2 y registra dave en el mismo seq 2
  b.clusterState.becomeLeader(2);
  register(b, 'dave');
  await settle();

  // a vuelve
  bus.connect('auth-a', 'auth-b');
  bus.connect('auth-a', 'auth-c');
  for (let i = 0; i < 6; i += 1) await settle();

  assert.equal(a.clusterState.getRole(), 'replica');
  assert.equal(a.clusterState.describe().leaderId, 'auth-b');
  assert.deepEqual(usernames(a), ['1:alice', '2:dave'], 'carol se descartó y dave quedó con el mismo userId');
  assert.deepEqual(usernames(b), ['1:alice', '2:dave']);
});

test('un término mayor en cualquier mensaje hace que el líder vuelva a réplica', async () => {
  const bus = cluster3();
  await settle();
  const a = bus.nodes.get('auth-a');
  a.clusterState.becomeLeader(1);
  bus.nodes.get('auth-b').mesh.send('auth-a', { type: 'election', candidate: 'auth-b', term: 5, lastSeq: 0 });
  await settle();
  assert.equal(a.clusterState.getRole(), 'replica');
  assert.equal(a.clusterState.getTerm(), 5);
});

test('auth aislado no se postula (no infla su term)', async () => {
  const bus = cluster3();
  await settle();
  const c = bus.nodes.get('auth-c');
  bus.isolate('auth-c');
  const election = createElection({
    config: { authId: 'auth-c', clusterSize: 3, majority: 2 },
    mesh: c.mesh,
    clusterState: c.clusterState,
    replicationLog: c.replicationLog,
    log: silent,
    leaderTimeoutMs: 0,
    jitterMs: 0
  });
  const before = c.clusterState.getTerm();
  election.tick();
  assert.equal(c.clusterState.getTerm(), before);
  assert.equal(c.clusterState.getRole(), 'replica');
});
