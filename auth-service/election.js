'use strict';

// Taller 7: elección de líder entre auths (SPEC §13.9).
//
// 1. Detección: una réplica que lleva 6 s sin heartbeat del líder espera además un
//    tiempo al azar (0–1,5 s) para que dos réplicas no se postulen a la vez.
// 2. Candidatura: pasa a candidate, term + 1, se vota a sí misma y manda election.
// 3. Voto: un solo voto por term, y solo si candidate.lastSeq >= mi lastAppliedSeq
//    (así nunca gana alguien con datos más viejos).
// 4. Ganador: con mayoría (2 de 3 contándose) pasa a leader y manda new_leader.
// 5. Sin mayoría en 3 s → nueva elección con term + 1.
// 6. Cualquier mensaje con un term mayor hace que el auth lo adopte y vuelva a replica.
//
// Extra: un auth que no ve a suficientes peers para ganar (está aislado) NO se postula.
// Así no infla su term mientras está solo y, al volver, no tumba al líder que sí existe.

function createElection({
  config,
  mesh,
  clusterState,
  replicationLog,
  log = console,
  leaderTimeoutMs = 6000,
  jitterMs = 1500,
  electionTimeoutMs = 3000,
  checkEveryMs = 250,
  random = Math.random
}) {
  let timer = null;
  let startedAt = Date.now();
  let lastVoteGrantedAt = 0;
  let electionStartedAt = 0;
  let votes = new Set();
  let jitter = random() * jitterMs;
  let warnedNoQuorum = false;

  const me = () => config.authId;
  const myTerm = () => clusterState.getTerm();
  const lastSeq = () => replicationLog.lastAppliedSeq();
  const isInt = (value) => Number.isSafeInteger(value) && value >= 0;

  // Tiempo sin noticias del líder (el arranque y un voto dado cuentan como "noticia")
  function quietFor(now) {
    const sinceStart = now - startedAt;
    const sinceVote = lastVoteGrantedAt ? now - lastVoteGrantedAt : Infinity;
    return Math.min(clusterState.msSinceLeaderContact(), sinceStart, sinceVote);
  }

  function becomeLeader(term) {
    clusterState.becomeLeader(term);
    votes = new Set();
    log.info(`[election] ${me()} ganó la elección del term ${term}: ahora es LÍDER.`);
    mesh.broadcast({ type: 'new_leader', leader: me(), term });
  }

  function startElection() {
    const reachable = mesh.connectedPeers().length + 1;
    if (reachable < config.majority) {
      if (!warnedNoQuorum) {
        log.info(`[election] Sin líder, pero solo veo ${reachable} de ${config.clusterSize} auths: no me postulo (hace falta mayoría ${config.majority}).`);
        warnedNoQuorum = true;
      }
      return;
    }
    warnedNoQuorum = false;
    const term = clusterState.becomeCandidate(); // term + 1 y voto propio
    votes = new Set([me()]);
    electionStartedAt = Date.now();
    jitter = random() * jitterMs;
    log.info(`[election] ${me()} se postula en el term ${term} (lastSeq ${lastSeq()}).`);
    if (votes.size >= config.majority) return becomeLeader(term);
    mesh.broadcast({ type: 'election', candidate: me(), term, lastSeq: lastSeq() });
  }

  function tick() {
    const now = Date.now();
    const role = clusterState.getRole();
    if (role === 'leader') return;
    if (role === 'candidate') {
      if (now - electionStartedAt >= electionTimeoutMs + jitter) {
        log.info(`[election] Sin mayoría en el term ${myTerm()}: nueva elección.`);
        startElection();
      }
      return;
    }
    if (quietFor(now) >= leaderTimeoutMs + jitter) {
      const leader = clusterState.describe().leaderId;
      if (leader) log.info(`[election] ${leaderTimeoutMs / 1000} s sin heartbeat del líder ${leader}.`);
      startElection();
    }
  }

  mesh.on('election', (msg, from) => {
    if (msg.candidate !== from || !isInt(msg.term) || !isInt(msg.lastSeq)) return;
    if (msg.term > myTerm()) clusterState.observeTerm(msg.term); // vuelve a réplica sin líder
    const upToDate = msg.lastSeq >= lastSeq();
    const granted = msg.term === myTerm() && upToDate && clusterState.grantVote(msg.term, from);
    if (granted) lastVoteGrantedAt = Date.now();
    log.info(`[election] Voto ${granted ? 'A FAVOR' : 'en contra'} de ${from} (term ${msg.term}, su lastSeq ${msg.lastSeq}, el mío ${lastSeq()}).`);
    mesh.send(from, { type: 'vote', voter: me(), term: msg.term, voteGranted: granted });
  });

  mesh.on('vote', (msg, from) => {
    if (msg.voter !== from || !isInt(msg.term)) return;
    if (msg.term > myTerm()) {
      clusterState.observeTerm(msg.term);
      return;
    }
    if (clusterState.getRole() !== 'candidate' || msg.term !== myTerm() || msg.voteGranted !== true) return;
    votes.add(from);
    if (votes.size >= config.majority) becomeLeader(msg.term);
  });

  mesh.on('new_leader', (msg, from) => {
    if (msg.leader !== from || !isInt(msg.term) || msg.term < myTerm()) return;
    if (clusterState.isLeader() && msg.term === myTerm() && me() < from) return;
    clusterState.becomeReplica(from, msg.term);
    clusterState.noteLeaderContact(from);
    clusterState.updatePeer(from, { role: 'leader' });
    log.info(`[election] Nuevo líder: ${from} (term ${msg.term}).`);
  });

  return {
    start() {
      startedAt = Date.now();
      if (timer) return;
      timer = setInterval(tick, checkEveryMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    tick
  };
}

module.exports = { createElection };
