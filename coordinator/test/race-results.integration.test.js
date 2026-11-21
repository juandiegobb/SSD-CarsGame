'use strict';

// Resultados de verdad (SPEC §14.4) con un coordinador real y carreras de 1 vuelta:
// dos pilotos automáticos terminan el nivel 1 (cada uno por su carril); el servidor da puestos y tiempos, suma los
// totales y arranca el nivel 2 conservándolos.

const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');
const { startCoordinator, connectPlayer, startRace, waitUntil, driveLap } = require('../test-support/harness');

test('al terminar un nivel hay orden de llegada, tiempos y totales', async (t) => {
  const coordinator = await startCoordinator('coord-resultados', { RACE_LAPS_PER_LEVEL: '1' });
  const first = await connectPlayer(coordinator.port, '1');
  const second = await connectPlayer(coordinator.port, '2');
  t.after(async () => {
    first.close();
    second.close();
    await coordinator.stop();
  });
  const state = await startRace([first, second]);
  const track = RaceTracks.tracks[state.race.level - 1];
  const raceOf = () => first.last('state').race;

  // El 1 va por el carril izquierdo y el 2 por el derecho (el 2 sale un poco después)
  const lapOne = driveLap(first, track, -28);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const lapTwo = driveLap(second, track, 28);
  await Promise.all([lapOne, lapTwo]);

  await waitUntil(() => raceOf().level === 2, 'que empiece el nivel 2', 5000);
  const race = raceOf();
  assert.equal(race.phase, 'countdown');
  assert.deepEqual(race.results, [], 'el nivel 2 empieza sin resultados');
  assert.ok(race.totals['1'] > 0 && race.totals['2'] > 0, `totales: ${JSON.stringify(race.totals)}`);

  // Durante el semáforo del nivel 2 se ve el orden de llegada del nivel 1: puestos 1 y 2,
  // ordenados por tiempo, y los totales son esos mismos tiempos
  const previous = race.previousResults;
  assert.equal(previous.level, 1);
  assert.deepEqual(previous.results.map((result) => result.position), [1, 2]);
  assert.deepEqual(previous.results.map((result) => result.userId).sort(), ['1', '2']);
  assert.ok(previous.results[0].timeMs <= previous.results[1].timeMs, 'el 1.º tiene el menor tiempo');
  for (const result of previous.results) {
    assert.equal(race.totals[result.userId], result.timeMs);
  }
});
