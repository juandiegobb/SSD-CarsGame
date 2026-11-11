const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createReplicationLog } = require('../replication-log');
const { createClusterState } = require('../cluster-state');
const { loadClusterConfig } = require('../cluster-config');

function setup(authId, port) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, password_hash TEXT, google_sub TEXT, email TEXT, picture_url TEXT, created_at TEXT)');
  const all = {
    'auth-a': 'ws://localhost:4101|http://localhost:4001',
    'auth-b': 'ws://localhost:4102|http://localhost:4002',
    'auth-c': 'ws://localhost:4103|http://localhost:4003'
  };
  const config = loadClusterConfig({
    AUTH_ID: authId,
    PORT: String(port),
    AUTH_PEERS: Object.entries(all).filter(([id]) => id !== authId).map(([id, urls]) => `${id}=${urls}`).join(',')
  });
  const replicationLog = createReplicationLog(db);
  return { state: createClusterState({ config, replicationLog }), replicationLog };
}

test('líder provisional: el auth de ID más bajo; los demás son réplicas que conocen su URL', () => {
  const a = setup('auth-a', 4001).state;
  const b = setup('auth-b', 4002).state;
  a.startWithProvisionalLeader();
  b.startWithProvisionalLeader();
  assert.equal(a.getRole(), 'leader');
  assert.equal(a.getTerm(), 1);
  assert.deepEqual(a.getLeader(), { authId: 'auth-a', publicUrl: 'http://localhost:4001' });
  assert.equal(b.getRole(), 'replica');
  assert.deepEqual(b.getLeader(), { authId: 'auth-a', publicUrl: 'http://localhost:4001' });
});

test('el atraso se mide contra el último lastSeq que anunció el líder', () => {
  const { state, replicationLog } = setup('auth-b', 4002);
  state.startWithProvisionalLeader();
  assert.equal(state.lagBehindLeader(), 0);
  state.noteLeaderContact('auth-a', 12);
  assert.equal(state.lagBehindLeader(), 12 - replicationLog.lastAppliedSeq());
  assert.ok(state.msSinceLeaderContact() < 1000);
});

test('candidatura: sube el term, se vota a sí mismo y no conoce líder', () => {
  const { state } = setup('auth-b', 4002);
  state.startWithProvisionalLeader();
  const term = state.becomeCandidate();
  assert.equal(term, 1);
  assert.equal(state.getRole(), 'candidate');
  assert.equal(state.getLeader(), null);
  assert.equal(state.grantVote(term, 'auth-c'), false, 'ya votó por sí mismo en este term');
});

test('un solo voto por term y nunca por un term viejo', () => {
  const { state } = setup('auth-c', 4003);
  state.startWithProvisionalLeader();
  assert.equal(state.grantVote(4, 'auth-b'), true);
  assert.equal(state.getTerm(), 4);
  assert.equal(state.grantVote(4, 'auth-b'), true, 'repetir el mismo voto es válido');
  assert.equal(state.grantVote(4, 'auth-a'), false, 'segundo candidato en el mismo term');
  assert.equal(state.grantVote(3, 'auth-a'), false, 'term viejo');
  assert.equal(state.grantVote(5, 'auth-a'), true, 'term nuevo, voto nuevo');
});

test('un term mayor hace que un líder vuelva a réplica', () => {
  const { state } = setup('auth-a', 4001);
  state.startWithProvisionalLeader();
  assert.equal(state.observeTerm(1), false);
  assert.equal(state.observeTerm(3, 'auth-b'), true);
  assert.equal(state.getRole(), 'replica');
  assert.equal(state.getTerm(), 3);
  assert.equal(state.getLeader().authId, 'auth-b');
});

test('el mesh puede actualizar lo que se sabe de cada peer', () => {
  const { state } = setup('auth-a', 4001);
  state.updatePeer('auth-b', { role: 'replica', connected: true, publicUrl: 'https://b.ngrok.app' });
  const b = state.listPeers().find((peer) => peer.authId === 'auth-b');
  assert.equal(b.connected, true);
  assert.equal(b.role, 'replica');
  assert.equal(b.publicUrl, 'https://b.ngrok.app');
});
