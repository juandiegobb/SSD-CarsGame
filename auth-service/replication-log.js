// Taller 7: registro numerado de escrituras (replication log).
// Cada cambio en la tabla users (registrar, registrar con Google, actualizar foto) queda
// anotado con un número de secuencia (seq) 1, 2, 3… en el orden en que lo hizo el líder.
// Las réplicas aplican esas mismas entradas en el mismo orden, con los mismos userId,
// y así todas las bases quedan iguales. lastAppliedSeq = el último seq aplicado.

const OPS = new Set(['register', 'register_google', 'update_picture']);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS replication_log (
    seq        INTEGER PRIMARY KEY,
    term       INTEGER NOT NULL,
    op         TEXT NOT NULL,
    data       TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS replication_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// node:sqlite no trae un helper de transacciones: BEGIN/COMMIT a mano, ROLLBACK si algo falla
function runInTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function userRowToData(op, row) {
  if (op === 'register') {
    return {
      userId: Number(row.id),
      username: row.username,
      provider: 'local',
      password_hash: row.password_hash,
      created_at: row.created_at
    };
  }
  return {
    userId: Number(row.id),
    username: row.username,
    provider: 'google',
    google_sub: row.google_sub,
    email: row.email,
    picture_url: row.picture_url || null,
    created_at: row.created_at
  };
}

function createReplicationLog(db) {
  db.exec(SCHEMA_SQL);

  const stmts = {
    lastSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM replication_log'),
    insertEntry: db.prepare('INSERT INTO replication_log (seq, term, op, data) VALUES (?, ?, ?, ?)'),
    entriesSince: db.prepare('SELECT seq, term, op, data FROM replication_log WHERE seq > ? ORDER BY seq LIMIT ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    getMeta: db.prepare('SELECT value FROM replication_meta WHERE key = ?'),
    setMeta: db.prepare(
      'INSERT INTO replication_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    allUsers: db.prepare('SELECT * FROM users ORDER BY id'),
    // Las réplicas insertan con el MISMO id que asignó el líder
    applyRegister: db.prepare(
      "INSERT INTO users (id, username, provider, password_hash, created_at) VALUES (?, ?, 'local', ?, ?)"
    ),
    applyRegisterGoogle: db.prepare(
      "INSERT INTO users (id, username, provider, google_sub, email, picture_url, created_at) VALUES (?, ?, 'google', ?, ?, ?, ?)"
    ),
    applyUpdatePicture: db.prepare('UPDATE users SET picture_url = ? WHERE id = ?'),
    termAt: db.prepare('SELECT term FROM replication_log WHERE seq = ?'),
    entriesAfter: db.prepare('SELECT seq, op, data FROM replication_log WHERE seq > ? ORDER BY seq DESC'),
    deleteEntriesAfter: db.prepare('DELETE FROM replication_log WHERE seq > ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?')
  };

  const listeners = [];

  function lastAppliedSeq() {
    return Number(stmts.lastSeq.get().seq);
  }

  function usersCount() {
    return Number(stmts.countUsers.get().n);
  }

  function getMeta(key, fallback = null) {
    const row = stmts.getMeta.get(key);
    return row ? row.value : fallback;
  }

  function setMeta(key, value) {
    stmts.setMeta.run(key, String(value));
  }

  // term guardado en disco: un auth que se reinicia recuerda en qué term iba
  function currentTerm() {
    return Number(getMeta('current_term', '0'));
  }

  function appendEntry(term, op, data) {
    const seq = lastAppliedSeq() + 1;
    stmts.insertEntry.run(seq, term, op, JSON.stringify(data));
    return { seq, term, op, data };
  }

  // Base anterior al Taller 7: los usuarios existentes no tienen entrada en el log.
  // Se anotan una vez (term 0) para que una réplica nueva los reciba al sincronizar.
  function backfillExistingUsers() {
    if (lastAppliedSeq() > 0) return 0;
    const rows = stmts.allUsers.all();
    if (!rows.length) return 0;
    runInTransaction(db, () => {
      for (const row of rows) {
        const op = row.provider === 'google' ? 'register_google' : 'register';
        appendEntry(0, op, userRowToData(op, row));
      }
    });
    return rows.length;
  }

  // LÍDER: hace la escritura local y la anota en el log en la MISMA transacción.
  // writeFn modifica users y devuelve los datos de la entrada (o null si no hubo cambio).
  // Si la escritura falla (p. ej. UNIQUE), no queda nada anotado y el error sigue su camino.
  function recordLocalWrite(op, writeFn) {
    if (!OPS.has(op)) throw new Error(`Operación de replicación desconocida: ${op}`);
    const entry = runInTransaction(db, () => {
      const data = writeFn();
      if (!data) return null;
      return appendEntry(currentTerm(), op, data);
    });
    if (entry) for (const listener of listeners) listener(entry);
    return entry;
  }

  // Los datos de una entrada a partir de la fila ya guardada (para recordLocalWrite)
  function dataForUser(op, userId) {
    const row = stmts.userById.get(userId);
    if (!row) throw new Error(`Usuario ${userId} no encontrado al anotar ${op}.`);
    return op === 'update_picture'
      ? { userId: Number(row.id), picture_url: row.picture_url || null }
      : userRowToData(op, row);
  }

  function applyOp(op, data) {
    if (!data || !Number.isSafeInteger(data.userId) || data.userId <= 0) {
      throw new Error('Entrada sin userId válido.');
    }
    if (op === 'register') {
      stmts.applyRegister.run(data.userId, data.username, data.password_hash, data.created_at || null);
    } else if (op === 'register_google') {
      stmts.applyRegisterGoogle.run(
        data.userId, data.username, data.google_sub, data.email, data.picture_url || null, data.created_at || null
      );
    } else if (op === 'update_picture') {
      stmts.applyUpdatePicture.run(data.picture_url || null, data.userId);
    } else {
      throw new Error(`Operación de replicación desconocida: ${op}`);
    }
  }

  // RÉPLICA: aplica una entrada que mandó el líder. Solo en orden estricto:
  //   'applied'   → se aplicó (seq === lastAppliedSeq + 1)
  //   'duplicate' → ya estaba aplicada; se ignora
  //   'gap'       → falta alguna anterior; hay que pedir request_sync
  function applyEntry(entry) {
    const seq = Number(entry && entry.seq);
    if (!Number.isSafeInteger(seq) || seq <= 0 || !OPS.has(entry.op)) {
      throw new Error('Entrada de replicación inválida.');
    }
    const last = lastAppliedSeq();
    if (seq <= last) return 'duplicate';
    if (seq !== last + 1) return 'gap';
    const term = Number.isSafeInteger(Number(entry.term)) ? Number(entry.term) : currentTerm();
    runInTransaction(db, () => {
      applyOp(entry.op, entry.data);
      stmts.insertEntry.run(seq, term, entry.op, JSON.stringify(entry.data));
    });
    return 'applied';
  }

  // Para sync_response: todo lo posterior a fromSeq (por tandas, para no armar mensajes enormes)
  function entriesSince(fromSeq, limit = 500) {
    return stmts.entriesSince.all(Math.max(0, Number(fromSeq) || 0), limit).map((row) => ({
      seq: Number(row.seq),
      term: Number(row.term),
      op: row.op,
      data: JSON.parse(row.data)
    }));
  }

  // term con el que se escribió la entrada seq (null si no existe; 0 para seq 0)
  function termAt(seq) {
    if (seq === 0) return 0;
    const row = stmts.termAt.get(seq);
    return row ? Number(row.term) : null;
  }

  // Auth que vuelve con escrituras que el líder actual NO tiene (las hizo siendo líder,
  // justo antes de caerse, y ninguna réplica las confirmó): se descartan para que su
  // base quede igual a la del líder. Se borran las entradas > seq y los usuarios que
  // esas entradas crearon. (Un cambio de foto descartado no se puede deshacer: la foto
  // se corrige en el siguiente ingreso con Google.) Devuelve cuántas entradas se borraron.
  function truncateAfter(seq) {
    const keep = Math.max(0, Number(seq) || 0);
    return runInTransaction(db, () => {
      const removed = stmts.entriesAfter.all(keep);
      for (const row of removed) {
        if (row.op === 'register' || row.op === 'register_google') {
          const data = JSON.parse(row.data);
          if (Number.isSafeInteger(data.userId)) stmts.deleteUser.run(data.userId);
        }
      }
      stmts.deleteEntriesAfter.run(keep);
      return removed.length;
    });
  }

  // replication.js se engancha aquí para mandar write_propagate al resto de auths
  function onLocalWrite(listener) {
    listeners.push(listener);
  }

  return {
    lastAppliedSeq,
    usersCount,
    currentTerm,
    getMeta,
    setMeta,
    backfillExistingUsers,
    recordLocalWrite,
    dataForUser,
    applyEntry,
    entriesSince,
    termAt,
    truncateAfter,
    onLocalWrite
  };
}

module.exports = { createReplicationLog, runInTransaction, OPS };
