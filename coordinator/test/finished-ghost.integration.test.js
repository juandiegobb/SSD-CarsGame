'use strict';

// Carros que ya terminaron (SPEC §14.4): el que completa las vueltas se estaciona pasando
// la meta, contra el borde (en su orden de llegada), y pasa a ser "fantasma": no choca con
// nadie. Así no tapa la meta y los demás pueden terminar el nivel.

const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');
const { startCoordinator, connectPlayer, startRace, waitUntil, driveLap, positionOf } = require('../test-support/harness');

const PLAYER_RADIUS = 20;

test('un carro que ya terminó se estaciona fuera de la meta y no bloquea a nadie', async (t) => {
  const coordinator = await startCoordinator('coord-fantasma', { RACE_LAPS_PER_LEVEL: '1' });
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
  const length = RaceTracks.trackLength(track);

  // El 1 termina y se estaciona pasando la meta (puesto 1 → carril izquierdo), no en medio
  await driveLap(first, track, 0);
  await waitUntil(() => raceOf().results.some((result) => result.userId === '1'), 'que el 1 termine');
  const spot = RaceTracks.parkingSpot(track, 0);
  await waitUntil(() => {
    const me = positionOf(first);
    return me && Math.hypot(me.x - spot.x, me.y - spot.y) < 1;
  }, 'que el 1 se estacione pasando la meta');
  const finishLine = RaceTracks.pointAtDistance(track, 0);
  const parked = positionOf(first);
  assert.ok(Math.hypot(parked.x - finishLine.x, parked.y - finishLine.y) > 2 * PLAYER_RADIUS,
    'el carro que terminó ya no está en medio de la meta');

  // El 2 va por el carril del estacionamiento: su última meta es justo donde está el 1.
  // Como el 1 es fantasma, lo atraviesa y termina.
  await driveLap(second, track, -34);
  await waitUntil(() => raceOf().level === 2, 'que el 2 también termine y empiece el nivel 2', 5000);
  const previous = raceOf().previousResults;
  assert.deepEqual(previous.results.map((result) => result.userId), ['1', '2']);
});
