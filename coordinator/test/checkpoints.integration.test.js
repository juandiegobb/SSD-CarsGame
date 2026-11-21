'use strict';

// Checkpoints de verdad (SPEC §14.4) con un coordinador real:
//   1. ir y venir sobre la meta NO suma vueltas;
//   2. un "piloto automático" que sigue la pista pasa los checkpoints en orden y al cruzar
//      la meta suma 1 vuelta (y el contador de checkpoints vuelve a 0).

const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');
const { startCoordinator, connectPlayer, startRace, waitUntil } = require('../test-support/harness');

const sign = (value) => (Math.abs(value) < 4 ? 0 : value > 0 ? 1 : -1);

// Punto de la pista a "distance" del inicio, corrido 28 px hacia el carril de la izquierda
// (el carro estacionado está en el de la derecha, a +24 px: así no chocan).
function laneAt(track, distance) {
  const point = RaceTracks.pointAtDistance(track, distance);
  return { x: point.x + point.tangent.y * 28, y: point.y - point.tangent.x * 28 };
}

function myPosition(player) {
  return player.last('state')?.players.find((p) => p.userId === player.userId);
}

async function driveTo(player, target, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const me = myPosition(player);
    if (me && Math.hypot(target.x - me.x, target.y - me.y) < 8) break;
    if (me) player.send({ type: 'intent', intent: { dir: { x: sign(target.x - me.x), y: sign(target.y - me.y) } } });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  player.send({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
}

test('la vuelta solo cuenta si se pasó por todos los checkpoints en orden', async (t) => {
  const coordinator = await startCoordinator('coord-checkpoints');
  // La sala necesita al menos 2 jugadores para iniciar; el segundo se queda quieto
  const driver = await connectPlayer(coordinator.port, '1');
  const parked = await connectPlayer(coordinator.port, '2');
  t.after(async () => {
    driver.close();
    parked.close();
    await coordinator.stop();
  });
  const firstState = await startRace([driver, parked]);
  const track = RaceTracks.tracks[firstState.race.level - 1];
  const length = RaceTracks.trackLength(track);
  const race = () => driver.last('state').race;

  // 1. Trampa: cruzar la meta hacia adelante, volver atrás y cruzarla otra vez
  await driveTo(driver, laneAt(track, 30));
  await driveTo(driver, laneAt(track, -30));
  await driveTo(driver, laneAt(track, 30));
  assert.equal(race().laps['1'], 0, 'cruzar la meta sin dar la vuelta no suma');
  assert.equal(race().checkpoints['1'], 0, 'no pasó por ningún checkpoint');

  // 2. Vuelta completa siguiendo la pista: los checkpoints suben 1, 2, 3, 4 y luego la vuelta
  const seen = new Set();
  for (let distance = 60; distance < length; distance += 40) {
    await driveTo(driver, laneAt(track, distance), 2500);
    seen.add(race().checkpoints['1']);
  }
  await driveTo(driver, laneAt(track, length + 60), 2500); // cruzar la meta
  await waitUntil(() => race().laps['1'] === 1, 'que cuente la vuelta', 3000);
  assert.equal(race().checkpoints['1'], 0, 'al completar la vuelta los checkpoints vuelven a 0');
  for (let passed = 1; passed <= RaceTracks.checkpointPositions(track).length; passed += 1) {
    assert.ok(seen.has(passed), `pasó por el checkpoint ${passed} (vistos: ${[...seen].join(', ')})`);
  }
});
