'use strict';

function planRebalance(players, coordinatorIds, inFlight = new Map()) {
  const ids = [...new Set(coordinatorIds)].sort();
  const counts = new Map(ids.map((coordinatorId) => [coordinatorId, 0]));
  const candidates = new Map(ids.map((coordinatorId) => [coordinatorId, []]));

  for (const [userId, player] of players) {
    const assignedCoordinator = inFlight.get(userId) || player.home;
    if (!counts.has(assignedCoordinator)) continue;
    counts.set(assignedCoordinator, counts.get(assignedCoordinator) + 1);
    if (!inFlight.has(userId) && candidates.has(player.home)) {
      candidates.get(player.home).push(userId);
    }
  }

  for (const [coordId, userIds] of candidates) {
    // Prioriza migrar primero a jugadores en el lobby; si todos están en sala, permite migrar jugadores en sala conservando su estado
    userIds.sort((a, b) => {
      const aInRoom = Boolean(players.get(a)?.roomId);
      const bInRoom = Boolean(players.get(b)?.roomId);
      if (aInRoom !== bInRoom) return aInRoom ? 1 : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  const plan = [];
  while (ids.length > 1) {
    const sourceId = ids.reduce((highest, coordinatorId) =>
      counts.get(coordinatorId) > counts.get(highest) ? coordinatorId : highest);
    const targetId = ids.reduce((lowest, coordinatorId) =>
      counts.get(coordinatorId) < counts.get(lowest) ? coordinatorId : lowest);

    if (counts.get(sourceId) - counts.get(targetId) <= 1) break;

    const userId = candidates.get(sourceId).shift();
    if (userId === undefined) break;

    plan.push({ userId, sourceId, targetId });
    counts.set(sourceId, counts.get(sourceId) - 1);
    counts.set(targetId, counts.get(targetId) + 1);
  }

  return plan;
}

module.exports = { planRebalance };
