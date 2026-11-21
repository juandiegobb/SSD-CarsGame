'use strict';

// Checkpoints de verdad (SPEC §14.4) con un coordinador real:
//   1. ir y venir sobre la meta NO suma vueltas;
//   2. un "piloto automático" que sigue la pista pasa los checkpoints en orden y al cruzar
//      la meta suma 1 vuelta (y el contador de checkpoints vuelve a 0).

const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');
const { startCoordinator, connectPlayer, startRace, waitUntil, laneAt, driveTo, driveLap } = require('../test-support/harness');

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
  const race = () => driver.last('state').race;

  // 1. Trampa: cruzar la meta hacia adelante, volver atrás y cruzarla otra vez
  await driveTo(driver, laneAt(track, 30));
  await driveTo(driver, laneAt(track, -30));
  await driveTo(driver, laneAt(track, 30));
  assert.equal(race().laps['1'], 0, 'cruzar la meta sin dar la vuelta no suma');
  assert.equal(race().checkpoints['1'], 0, 'no pasó por ningún checkpoint');

  // 2. Vuelta completa siguiendo la pista: los checkpoints suben 1, 2, 3, 4 y luego la vuelta
  const seen = new Set();
  await driveLap(driver, track, -28, () => seen.add(race().checkpoints['1']));
  await waitUntil(() => race().laps['1'] === 1, 'que cuente la vuelta', 3000);
  assert.equal(race().checkpoints['1'], 0, 'al completar la vuelta los checkpoints vuelven a 0');
  for (let passed = 1; passed <= RaceTracks.checkpointPositions(track).length; passed += 1) {
    assert.ok(seen.has(passed), `pasó por el checkpoint ${passed} (vistos: ${[...seen].join(', ')})`);
  }
});
