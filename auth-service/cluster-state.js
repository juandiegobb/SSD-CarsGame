// Taller 7: estado de este auth dentro del grupo replicado.
//   role      → 'leader' | 'replica' | 'candidate' (candidate solo durante una elección)
//   term      → número de "mandato". Sube en cada elección; se guarda en disco.
//   leader    → quién es el líder según este nodo ({ authId, publicUrl } o null)
//   leaderSeq → último lastSeq que anunció el líder (para saber qué tan atrasados estamos)
//   peers     → lo que se sabe de los otros auths (URLs, rol, si hay conexión)
//
// Hasta que exista la elección (turno de Juan Diego), el líder inicial es PROVISIONAL:
// el auth con el ID más bajo del grupo, igual que la regla del ID menor del mesh.

const ROLES = new Set(['leader', 'replica', 'candidate']);

function createClusterState({ config, replicationLog }) {
  const peers = new Map(); // authId → { authId, peerUrl, publicUrl, role, connected }
  for (const peer of config.peers) {
    peers.set(peer.authId, { ...peer, role: null, connected: false });
  }

  let role = 'replica';
  let leaderId = null;
  let leaderSeq = 0;
  let lastLeaderContactAt = 0;
  const listeners = [];

  function notify(reason) {
    const snapshot = describe();
    for (const listener of listeners) listener(snapshot, reason);
  }

  function getTerm() {
    return replicationLog.currentTerm();
  }

  function setTerm(term) {
    if (!Number.isSafeInteger(term) || term < 0) throw new Error(`term inválido: ${term}`);
    replicationLog.setMeta('current_term', term);
  }

  function urlOf(authId) {
    if (!authId) return null;
    if (authId === config.authId) return config.publicUrl;
    return peers.get(authId)?.publicUrl || null;
  }

  function getLeader() {
    return leaderId ? { authId: leaderId, publicUrl: urlOf(leaderId) } : null;
  }

  function becomeLeader(term = getTerm()) {
    setTerm(term);
    role = 'leader';
    leaderId = config.authId;
    leaderSeq = replicationLog.lastAppliedSeq();
    lastLeaderContactAt = Date.now();
    notify('leader');
  }

  function becomeReplica(newLeaderId = null, term = getTerm()) {
    setTerm(term);
    role = 'replica';
    leaderId = newLeaderId && newLeaderId !== config.authId ? newLeaderId : null;
    if (leaderId) lastLeaderContactAt = Date.now();
    notify('replica');
  }

  // Elección (Juan Diego): sube el term, se vota a sí mismo y queda sin líder conocido
  function becomeCandidate() {
    const term = getTerm() + 1;
    setTerm(term);
    replicationLog.setMeta('voted_for', `${term}:${config.authId}`);
    role = 'candidate';
    leaderId = null;
    notify('candidate');
    return term;
  }

  // Un voto por term: devuelve true si se puede votar por candidateId en ese term
  function grantVote(term, candidateId) {
    if (term < getTerm()) return false;
    if (term > getTerm()) observeTerm(term);
    const voted = replicationLog.getMeta('voted_for', '');
    const [votedTerm, votedFor] = voted.split(':');
    if (Number(votedTerm) === term && votedFor && votedFor !== candidateId) return false;
    replicationLog.setMeta('voted_for', `${term}:${candidateId}`);
    return true;
  }

  // Cualquier mensaje con un term mayor: se adopta y este nodo vuelve a réplica
  function observeTerm(term, fromLeaderId = null) {
    if (!Number.isSafeInteger(term) || term <= getTerm()) return false;
    setTerm(term);
    role = 'replica';
    leaderId = fromLeaderId && fromLeaderId !== config.authId ? fromLeaderId : null;
    notify('term');
    return true;
  }

  // Heartbeat del líder (Juan Diego lo llama al recibir { type: 'heartbeat' })
  function noteLeaderContact(fromLeaderId, lastSeq) {
    if (fromLeaderId && fromLeaderId !== config.authId) leaderId = fromLeaderId;
    if (Number.isSafeInteger(lastSeq) && lastSeq >= 0) leaderSeq = lastSeq;
    lastLeaderContactAt = Date.now();
  }

  function msSinceLeaderContact() {
    return lastLeaderContactAt ? Date.now() - lastLeaderContactAt : Infinity;
  }

  // Cuántas escrituras le faltan a este nodo respecto al líder
  function lagBehindLeader() {
    if (role === 'leader') return 0;
    return Math.max(0, leaderSeq - replicationLog.lastAppliedSeq());
  }

  // ¿Puede este nodo responder una lectura (login) y emitir un token?
  //   líder → siempre
  //   réplica/candidato → solo si va como mucho `tolerance` escrituras detrás del líder.
  // Si va más atrás podría decir "credenciales inválidas" a un usuario nuevo que aún no conoce.
  function canServeReads(tolerance = config.readLagTolerance) {
    if (role === 'leader') return true;
    return lagBehindLeader() <= tolerance;
  }

  // Lo que el mesh va aprendiendo de cada peer (hello, heartbeat, conexión/desconexión)
  function updatePeer(authId, info) {
    if (!authId || authId === config.authId) return;
    const current = peers.get(authId) || { authId, peerUrl: null, publicUrl: null, role: null, connected: false };
    const next = { ...current };
    if (typeof info.peerUrl === 'string') next.peerUrl = info.peerUrl;
    if (typeof info.publicUrl === 'string') next.publicUrl = info.publicUrl;
    if (info.role === null || ROLES.has(info.role)) next.role = info.role;
    if (typeof info.connected === 'boolean') next.connected = info.connected;
    peers.set(authId, next);
  }

  function listPeers() {
    return [...peers.values()].sort((a, b) => (a.authId < b.authId ? -1 : a.authId > b.authId ? 1 : 0));
  }

  // Líder provisional: el ID más bajo entre este auth y los de AUTH_PEERS
  function startWithProvisionalLeader() {
    const lowest = [config.authId, ...peers.keys()].sort()[0];
    if (lowest === config.authId) {
      becomeLeader(Math.max(getTerm(), 1));
    } else {
      becomeReplica(lowest);
      leaderSeq = replicationLog.lastAppliedSeq(); // hasta oír al líder, no nos consideramos atrasados
    }
  }

  function describe() {
    const leader = getLeader();
    return {
      authId: config.authId,
      role,
      term: getTerm(),
      leaderId: leader ? leader.authId : null,
      leaderUrl: leader ? leader.publicUrl : null,
      lastAppliedSeq: replicationLog.lastAppliedSeq(),
      leaderSeq: role === 'leader' ? replicationLog.lastAppliedSeq() : leaderSeq
    };
  }

  return {
    getRole: () => role,
    isLeader: () => role === 'leader',
    getTerm,
    getLeader,
    becomeLeader,
    becomeReplica,
    becomeCandidate,
    grantVote,
    observeTerm,
    noteLeaderContact,
    msSinceLeaderContact,
    lagBehindLeader,
    canServeReads,
    updatePeer,
    listPeers,
    startWithProvisionalLeader,
    describe,
    onChange: (listener) => listeners.push(listener)
  };
}

module.exports = { createClusterState };
