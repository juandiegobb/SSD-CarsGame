'use strict';

// Objetos de verdad (SPEC §14.4) con un coordinador real: un piloto automático pasa por
// encima del primer turbo; el servidor lo recoge, le da el efecto, el carro va más rápido
// y a los 5 s el turbo vuelve a aparecer.

const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');
const { startCoordinator, connectPlayer, startRace, waitUntil, driveTo, positionOf } = require('../test-support/harness');

test('pasar por un turbo lo recoge, acelera el carro y el turbo reaparece', async (t) => {
  const coordinator = await startCoordinator('coord-objetos');
  const driver = await connectPlayer(coordinator.port, '1');
  const parked = await connectPlayer(coordinator.port, '2');
  t.after(async () => {
    driver.close();
    parked.close();
    await coordinator.stop();
  });
  const state = await startRace([driver, parked]);
  const race = () => driver.last('state').race;
  const turbo = state.race.items.find((item) => item.type === 'turbo');
  assert.ok(turbo && turbo.active, 'hay un turbo activo al empezar');

  // Ir hasta el turbo
  await driveTo(driver, { x: turbo.x, y: turbo.y }, 6000);
  await waitUntil(() => race().effects['1']?.type === 'turbo', 'recibir el turbo', 2000);
  assert.equal(race().items.find((item) => item.id === turbo.id).active, false, 'el turbo desapareció');

  // Con turbo el carro avanza más rápido que la velocidad normal (200 px/s)
  const before = positionOf(driver);
  const startedAt = Date.now();
  driver.send({ type: 'intent', intent: { dir: { x: 1, y: 0 } } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  driver.send({ type: 'intent', intent: { dir: { x: 0, y: 0 } } });
  const after = positionOf(driver);
  const speed = Math.hypot(after.x - before.x, after.y - before.y) / ((Date.now() - startedAt) / 1000);
  assert.ok(speed > 230, `con turbo iba a ${speed.toFixed(0)} px/s`);

  // A los 5 s el turbo vuelve a estar activo y el efecto ya terminó
  await waitUntil(() => race().items.find((item) => item.id === turbo.id).active, 'que reaparezca el turbo', 7000);
  assert.equal(race().effects['1'], undefined, 'el efecto ya terminó');
});
