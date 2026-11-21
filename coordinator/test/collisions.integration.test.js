'use strict';

// Choques de verdad (SPEC §14.4): un coordinador real, dos carros en la misma carrera que
// aceleran uno contra el otro. En ningún `state` que mande el servidor quedan encimados.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startCoordinator, connectPlayer, startRace } = require('../test-support/harness');

const PLAYER_RADIUS = 20;

test('dos carros que aceleran uno contra el otro nunca quedan encimados', async (t) => {
  const coordinator = await startCoordinator('coord-choques');
  const players = [await connectPlayer(coordinator.port, '1'), await connectPlayer(coordinator.port, '2')];
  t.after(async () => {
    for (const player of players) player.close();
    await coordinator.stop();
  });
  const [host, guest] = players;
  const firstState = await startRace(players);

  // Cada uno acelera hacia el otro durante 2 s
  const positionsOf = (state) => Object.fromEntries(state.players.map((p) => [p.userId, p]));
  const start = positionsOf(firstState);
  const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
  const towards = (from, to) => ({ x: sign(to.x - from.x), y: sign(to.y - from.y) });
  const statesBefore = host.messages.length;
  const push = setInterval(() => {
    host.send({ type: 'intent', intent: { dir: towards(start['1'], start['2']) } });
    guest.send({ type: 'intent', intent: { dir: towards(start['2'], start['1']) } });
  }, 50);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  clearInterval(push);

  const states = host.messages.slice(statesBefore).filter((message) => message.type === 'state');
  assert.ok(states.length > 20, `llegaron ${states.length} estados`);
  let closest = Infinity;
  for (const state of states) {
    const positions = positionsOf(state);
    if (!positions['1'] || !positions['2']) continue;
    closest = Math.min(closest, Math.hypot(positions['1'].x - positions['2'].x, positions['1'].y - positions['2'].y));
  }
  // El servidor redondea las posiciones a 0,1 px
  assert.ok(closest >= 2 * PLAYER_RADIUS - 0.5, `los carros quedaron a ${closest.toFixed(1)} px (mínimo ${2 * PLAYER_RADIUS})`);
  const end = positionsOf(states.at(-1));
  const moved = Math.hypot(end['1'].x - start['1'].x, end['1'].y - start['1'].y);
  assert.ok(moved > 0, 'el carro sí se movió (no quedó congelado)');
});
