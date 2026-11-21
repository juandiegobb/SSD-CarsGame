'use strict';

// Resultados de la carrera (SPEC §14.4). Funciones puras, sin estado del coordinador:
//   - recordFinish: al completar las vueltas, el jugador entra en race.results con su
//     puesto y su tiempo del nivel (desde el verde del semáforo).
//   - closeLevel: al terminar un nivel, suma los tiempos del nivel a los totales.
//   - buildStandings: clasificación general por tiempo total (menor primero = ganador).

function recordFinish(race, userId, username, now, countdownMs) {
  if (!Array.isArray(race.results)) race.results = [];
  if (race.results.some((result) => result.userId === userId)) return null;
  const startedAt = Number.isFinite(race.startedAt) ? race.startedAt : race.countdownStartedAt + countdownMs;
  const result = {
    userId,
    username: String(username || userId).toLowerCase(),
    position: race.results.length + 1,
    timeMs: Math.max(0, Math.round(now - startedAt))
  };
  race.results.push(result);
  return result;
}

// Solo suman quienes siguen en la sala (si alguien se fue, su tiempo no cuenta).
function closeLevel(race, members) {
  const totals = { ...(race.totals || {}) };
  for (const result of race.results || []) {
    if (members.has(result.userId)) totals[result.userId] = (totals[result.userId] || 0) + result.timeMs;
  }
  return totals;
}

// Empate en el tiempo total: se ordena por userId para que todos los coordinadores
// muestren el mismo podio.
function buildStandings(members, totals, nameOf) {
  return [...members]
    .filter((userId) => Number.isFinite(totals[userId]))
    .sort((a, b) => totals[a] - totals[b] || String(a).localeCompare(String(b)))
    .map((userId, index) => ({
      userId,
      username: String(nameOf(userId) || userId).toLowerCase(),
      position: index + 1,
      totalMs: totals[userId]
    }));
}

module.exports = { recordFinish, closeLevel, buildStandings };
