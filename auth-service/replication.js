'use strict';

// Taller 7: replicación single-writer sobre el mesh de auths.
//
//   LÍDER                                  RÉPLICA
//   heartbeat cada 2 s ─────────────────►  "el líder vive y va en lastSeq N"
//   escritura local → write_propagate ──►  aplica si seq === lastAppliedSeq + 1
//                    ◄── write_ack ──────  "ya tengo hasta seq"
//   (Opción B: el líder responde al cliente cuando llega 1 write_ack, máx. 2 s)
//                    ◄── request_sync ───  "me falta desde fromSeq" (hueco o recién llegado)
//   sync_response ──────────────────────►  aplica las entradas en orden
//
// Un auth que vuelve con escrituras que el líder no tiene (las hizo justo antes de caerse
// y nadie las confirmó) las descarta: el líder le responde truncateTo y la réplica borra
// lo que sobra antes de seguir sincronizando.

const SYNC_BATCH = 500;

function createReplication({
  config,
  mesh,
  clusterState,
  replicationLog,
  log = console,
  heartbeatIntervalMs = 2000,
  syncRetryMs = 1000
}) {
  const ackedSeq = new Map(); // authId → último seq confirmado por esa réplica
  const waiters = []; // { seq, resolve, timer }
  let heartbeatTimer = null;
  let lastSyncRequestAt = 0;

  const me = () => config.authId;
  const myTerm = () => clusterState.getTerm();
  const lastSeq = () => replicationLog.lastAppliedSeq();

  function hello() {
    const state = clusterState.describe();
    return {
      authId: me(),
      role: state.role,
      term: state.term,
      publicUrl: config.publicUrl,
      peerUrl: config.peerUrl,
      lastSeq: lastSeq(),
      lastTerm: replicationLog.termAt(lastSeq())
    };
  }

  function heartbeatMessage() {
    return { type: 'heartbeat', authId: me(), term: myTerm(), lastSeq: lastSeq(), lastTerm: replicationLog.termAt(lastSeq()) };
  }

  function isInt(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  // ---------------------------------------------------------------- líder
  function sendHeartbeats() {
    if (clusterState.isLeader()) mesh.broadcast(heartbeatMessage());
  }

  function startHeartbeats() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(sendHeartbeats, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  // Cada escritura local del líder se manda a todas las réplicas conectadas
  replicationLog.onLocalWrite((entry) => {
    if (!clusterState.isLeader()) return;
    mesh.broadcast({ type: 'write_propagate', term: entry.term, seq: entry.seq, op: entry.op, data: entry.data });
  });

  function resolveWaiters() {
    const best = Math.max(0, ...ackedSeq.values());
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].seq <= best) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(true);
        waiters.splice(i, 1);
      }
    }
  }

  // Opción B: espera el write_ack de al menos UNA réplica (o el timeout).
  // Devuelve true si alguien confirmó, false si no.
  function waitForAck(seq, timeoutMs = config.replicationAckTimeoutMs) {
    if (config.clusterSize === 1) return Promise.resolve(true); // auth solo: no hay a quién esperar
    if (Math.max(0, ...ackedSeq.values()) >= seq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { seq, resolve };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        log.error(`[replication] Ninguna réplica confirmó seq ${seq} en ${timeoutMs} ms.`);
        resolve(false);
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  mesh.on('write_ack', (msg, from) => {
    if (!clusterState.isLeader() || !isInt(msg.seq) || msg.authId !== from) return;
    if (msg.seq > lastSeq()) return; // no puede confirmar algo que el líder no tiene
    ackedSeq.set(from, Math.max(ackedSeq.get(from) || 0, msg.seq));
    resolveWaiters();
  });

  mesh.on('request_sync', (msg, from) => {
    if (!clusterState.isLeader() || !isInt(msg.fromSeq)) return;
    const mine = lastSeq();
    // La réplica tiene escrituras que el líder no tiene, o una entrada distinta en fromSeq
    if (msg.fromSeq > mine) {
      mesh.send(from, { type: 'sync_response', entries: [], truncateTo: mine });
      return;
    }
    if (msg.fromSeq > 0 && msg.fromTerm !== undefined && replicationLog.termAt(msg.fromSeq) !== msg.fromTerm) {
      mesh.send(from, { type: 'sync_response', entries: [], truncateTo: msg.fromSeq - 1 });
      return;
    }
    const entries = replicationLog.entriesSince(msg.fromSeq, SYNC_BATCH);
    mesh.send(from, { type: 'sync_response', entries, lastSeq: mine });
    if (entries.length) log.info(`[replication] sync_response a ${from}: ${entries.length} entrada(s) desde seq ${msg.fromSeq + 1}.`);
  });

  // ---------------------------------------------------------------- réplica
  function requestSync(to, force = false) {
    const now = Date.now();
    if (!force && now - lastSyncRequestAt < syncRetryMs) return;
    lastSyncRequestAt = now;
    const fromSeq = lastSeq();
    mesh.send(to, { type: 'request_sync', fromSeq, fromTerm: replicationLog.termAt(fromSeq) });
  }

  function ack(to) {
    mesh.send(to, { type: 'write_ack', authId: me(), seq: lastSeq() });
  }

  // ¿Este mensaje viene del líder que reconocemos? Si trae un term mayor, lo adoptamos.
  function acceptLeader(from, term) {
    if (!isInt(term) || term < myTerm()) return false;
    const state = clusterState.describe();
    if (state.role === 'leader' && term === myTerm()) {
      // Dos líderes con el mismo term no deberían existir; por si acaso cede el de ID mayor
      if (me() < from) return false;
    }
    if (term > myTerm() || state.role !== 'replica' || state.leaderId !== from) {
      clusterState.becomeReplica(from, term);
    }
    clusterState.updatePeer(from, { role: 'leader' });
    return true;
  }

  // Compara lo que tiene esta réplica con lo que anuncia el líder y pide sync si no coincide
  function checkAgainstLeader(from, leaderLastSeq, leaderLastTerm) {
    const mine = lastSeq();
    if (leaderLastSeq !== mine) return requestSync(from);
    if (isInt(leaderLastTerm) && replicationLog.termAt(mine) !== leaderLastTerm) requestSync(from);
  }

  mesh.on('heartbeat', (msg, from) => {
    if (msg.authId !== from || !isInt(msg.lastSeq)) return;
    if (!acceptLeader(from, msg.term)) return;
    clusterState.noteLeaderContact(from, msg.lastSeq);
    checkAgainstLeader(from, msg.lastSeq, msg.lastTerm);
  });

  mesh.on('write_propagate', (msg, from) => {
    if (!isInt(msg.seq) || msg.seq === 0 || typeof msg.op !== 'string' ||
        !msg.data || typeof msg.data !== 'object' || Array.isArray(msg.data)) return;
    if (!acceptLeader(from, msg.term)) return;
    clusterState.noteLeaderContact(from, Math.max(clusterState.describe().leaderSeq, msg.seq));

    let result;
    try {
      result = replicationLog.applyEntry({ seq: msg.seq, term: msg.term, op: msg.op, data: msg.data });
    } catch (err) {
      log.error(`[replication] No se pudo aplicar seq ${msg.seq} de ${from}: ${err.message}. Se pide sync.`);
      return requestSync(from, true);
    }
    if (result === 'gap') {
      log.info(`[replication] Hueco: llegó seq ${msg.seq} y voy en ${lastSeq()}. Pido request_sync.`);
      return requestSync(from, true);
    }
    if (result === 'duplicate' && replicationLog.termAt(msg.seq) !== msg.term) {
      return requestSync(from, true); // tengo otra entrada en ese seq: hay que corregir
    }
    if (result === 'applied') log.info(`[replication] Aplicado seq ${msg.seq} (${msg.op}) de ${from}.`);
    ack(from);
  });

  mesh.on('sync_response', (msg, from) => {
    const state = clusterState.describe();
    if (state.role === 'leader' || (state.leaderId && state.leaderId !== from)) return;
    if (!Array.isArray(msg.entries)) return;

    if (isInt(msg.truncateTo)) {
      const removed = replicationLog.truncateAfter(msg.truncateTo);
      if (removed) log.info(`[replication] Descartadas ${removed} escritura(s) que el líder ${from} no tiene (quedo en seq ${lastSeq()}).`);
      return requestSync(from, true);
    }

    let applied = 0;
    for (const entry of msg.entries) {
      let result;
      try {
        result = replicationLog.applyEntry(entry);
      } catch (err) {
        log.error(`[replication] Entrada inválida en sync_response de ${from}: ${err.message}`);
        break;
      }
      if (result === 'gap') break;
      if (result === 'applied') applied += 1;
    }
    if (applied) {
      log.info(`[replication] Sync con ${from}: ${applied} entrada(s) aplicadas, lastAppliedSeq ${lastSeq()}, usuarios ${replicationLog.usersCount()}.`);
      ack(from);
    }
    // Si el líder tenía más de una tanda, se pide la siguiente
    if (msg.entries.length >= SYNC_BATCH || (isInt(msg.lastSeq) && msg.lastSeq > lastSeq() && applied)) {
      requestSync(from, true);
    }
  });

  // ---------------------------------------------------------------- hello (ambos)
  mesh.on('hello', (msg, from) => {
    clusterState.updatePeer(from, {
      publicUrl: typeof msg.publicUrl === 'string' ? msg.publicUrl : undefined,
      peerUrl: typeof msg.peerUrl === 'string' ? msg.peerUrl : undefined,
      role: ['leader', 'replica', 'candidate'].includes(msg.role) ? msg.role : null,
      connected: true
    });
    if (!isInt(msg.term)) return;

    if (msg.role === 'leader' && acceptLeader(from, msg.term)) {
      // Auth que (re)entra y se encuentra con un líder: queda como réplica y se pone al día
      if (isInt(msg.lastSeq)) {
        clusterState.noteLeaderContact(from, msg.lastSeq);
        checkAgainstLeader(from, msg.lastSeq, msg.lastTerm);
      }
      return;
    }
    if (msg.term > myTerm()) clusterState.observeTerm(msg.term);
    // Si somos líder, el recién llegado se entera de inmediato (sin esperar 2 s)
    if (clusterState.isLeader()) mesh.send(from, heartbeatMessage());
  });

  mesh.onPeerDown((authId) => {
    clusterState.updatePeer(authId, { connected: false });
    ackedSeq.delete(authId);
  });

  // Al ganar una elección: heartbeat inmediato para que todos lo sepan ya
  clusterState.onChange((state, reason) => {
    if (reason === 'leader') {
      ackedSeq.clear();
      sendHeartbeats();
    }
  });

  return {
    hello,
    start: startHeartbeats,
    stop() {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    },
    waitForAck,
    sendHeartbeats
  };
}

module.exports = { createReplication, SYNC_BATCH };
