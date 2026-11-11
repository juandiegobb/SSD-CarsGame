const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createReplicationLog } = require('../replication-log');

// Misma tabla users que auth-service/index.js
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (provider = 'local'  AND password_hash IS NOT NULL AND google_sub IS NULL) OR
        (provider = 'google' AND password_hash IS NULL AND google_sub IS NOT NULL AND email IS NOT NULL)
      )
    )`);
  return db;
}

function registerLocal(db, log, username) {
  return log.recordLocalWrite('register', () => {
    const info = db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', '$2b$10$hash')").run(username);
    return log.dataForUser('register', Number(info.lastInsertRowid));
  });
}

test('cada escritura del líder recibe el siguiente seq', () => {
  const db = newDb();
  const log = createReplicationLog(db);
  assert.equal(log.lastAppliedSeq(), 0);
  assert.equal(registerLocal(db, log, 'alice').seq, 1);
  assert.equal(registerLocal(db, log, 'bob').seq, 2);
  assert.equal(log.lastAppliedSeq(), 2);
  assert.equal(log.usersCount(), 2);
});

test('si la escritura falla no queda nada anotado', () => {
  const db = newDb();
  const log = createReplicationLog(db);
  registerLocal(db, log, 'alice');
  assert.throws(() => registerLocal(db, log, 'alice'), /UNIQUE/);
  assert.equal(log.lastAppliedSeq(), 1);
  assert.equal(log.usersCount(), 1);
});

test('una réplica que aplica las mismas entradas queda idéntica (mismos userId)', () => {
  const leaderDb = newDb();
  const leader = createReplicationLog(leaderDb);
  registerLocal(leaderDb, leader, 'alice');
  leader.recordLocalWrite('register_google', () => {
    const info = leaderDb.prepare(
      "INSERT INTO users (username, provider, google_sub, email, picture_url) VALUES ('bob_google', 'google', 'sub-1', 'bob@gmail.com', NULL)"
    ).run();
    return leader.dataForUser('register_google', Number(info.lastInsertRowid));
  });
  leader.recordLocalWrite('update_picture', () => {
    leaderDb.prepare("UPDATE users SET picture_url = 'https://lh3.googleusercontent.com/a/x' WHERE id = 2").run();
    return leader.dataForUser('update_picture', 2);
  });

  const replicaDb = newDb();
  const replica = createReplicationLog(replicaDb);
  for (const entry of leader.entriesSince(0)) {
    assert.equal(replica.applyEntry(entry), 'applied');
  }
  const rows = (db) => db.prepare('SELECT id, username, provider, google_sub, picture_url FROM users ORDER BY id').all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows(replicaDb), rows(leaderDb));
  assert.equal(replica.lastAppliedSeq(), 3);
});

test('applyEntry ignora duplicados y detecta huecos', () => {
  const leaderDb = newDb();
  const leader = createReplicationLog(leaderDb);
  registerLocal(leaderDb, leader, 'a1');
  registerLocal(leaderDb, leader, 'a2');
  registerLocal(leaderDb, leader, 'a3');
  const [e1, e2, e3] = leader.entriesSince(0);

  const replica = createReplicationLog(newDb());
  assert.equal(replica.applyEntry(e1), 'applied');
  assert.equal(replica.applyEntry(e1), 'duplicate');
  assert.equal(replica.applyEntry(e3), 'gap');
  assert.equal(replica.lastAppliedSeq(), 1);
  assert.equal(replica.applyEntry(e2), 'applied');
  assert.equal(replica.applyEntry(e3), 'applied');
  assert.deepEqual(replica.entriesSince(1).map((entry) => entry.seq), [2, 3]);
});

test('una base anterior al Taller 7 anota a sus usuarios una sola vez', () => {
  const db = newDb();
  db.prepare("INSERT INTO users (username, provider, password_hash) VALUES ('viejo', 'local', 'h')").run();
  db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES ('gviejo', 'google', 's', 'g@x.com')").run();
  const log = createReplicationLog(db);
  assert.equal(log.backfillExistingUsers(), 2);
  assert.equal(log.backfillExistingUsers(), 0);
  assert.deepEqual(log.entriesSince(0).map((entry) => entry.op), ['register', 'register_google']);
});

test('el term se guarda en replication_meta', () => {
  const log = createReplicationLog(newDb());
  assert.equal(log.currentTerm(), 0);
  log.setMeta('current_term', 4);
  assert.equal(log.currentTerm(), 4);
});
