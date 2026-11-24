'use strict';

// Carros que ya terminaron (SPEC §14.4): el que completa las vueltas queda quieto justo
// después de la meta. Si siguiera chocando, taparía la meta y los demás no podrían
// terminar el nivel. Desde que termina pasa a ser "fantasma": no choca con nadie.

const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');
const { startCoordinator, connectPlayer, startRace, waitUntil, driveLap, positionOf } = require('../test-support/harness');

const PLAYER_RADIUS = 20;

test('un carro que ya terminó no bloquea la meta: el siguiente pasa por encima y termina', async (t) => {
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

  // El 1 termina y se queda parado justo pasando la meta, en el centro de la pista
  await driveLap(first, track, 0);
  await waitUntil(() => raceOf().results.some((result) => result.userId === '1'), 'que el 1 termine');
  const stopped = positionOf(first);
  const finishLine = RaceTracks.pointAtDistance(track, 0);
  assert.ok(Math.hypot(stopped.x - finishLine.x, stopped.y - finishLine.y) < 4 * PLAYER_RADIUS,
    'el 1 quedó parado encima de la meta');

  // El 2 hace la vuelta por el MISMO carril: tiene que cruzar la meta justo donde está el 1
  await driveLap(second, track, 0);
  await waitUntil(() => raceOf().level === 2, 'que el 2 también termine y empiece el nivel 2', 5000);
  const previous = raceOf().previousResults;
  assert.deepEqual(previous.results.map((result) => result.userId), ['1', '2']);
});
