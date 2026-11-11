'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planRebalance } = require('../rebalance');

function playerMap(assignments) {
  return new Map(assignments.map(([userId, home]) => [userId, { home }]));
}

test('distribuye jugadores entre cualquier cantidad de coordinadores', () => {
  const players = playerMap([
    ['u1', 'coord-a'], ['u2', 'coord-a'], ['u3', 'coord-a'],
    ['u4', 'coord-a'], ['u5', 'coord-a'], ['u6', 'coord-a'],
    ['u7', 'coord-a'], ['u8', 'coord-a'], ['u9', 'coord-a']
  ]);

  const plan = planRebalance(players, ['coord-a', 'coord-b', 'coord-c']);
  const resultingCounts = new Map([['coord-a', 9], ['coord-b', 0], ['coord-c', 0]]);
  for (const move of plan) {
    resultingCounts.set(move.sourceId, resultingCounts.get(move.sourceId) - 1);
    resultingCounts.set(move.targetId, resultingCounts.get(move.targetId) + 1);
  }

  assert.deepEqual([...resultingCounts.values()].sort(), [3, 3, 3]);
});

test('conserva una diferencia máxima de un jugador con dos coordinadores', () => {
  const players = playerMap([
    ['u1', 'coord-a'], ['u2', 'coord-a'], ['u3', 'coord-a'],
    ['u4', 'coord-a'], ['u5', 'coord-a']
  ]);

  assert.equal(planRebalance(players, ['coord-a', 'coord-b']).length, 2);
});

test('reparte entre cinco coordinadores sin asumir un número fijo de instancias', () => {
  const players = playerMap(Array.from({ length: 20 }, (_, index) =>
    [`u${index + 1}`, 'coord-a']));

  const plan = planRebalance(
    players,
    ['coord-a', 'coord-b', 'coord-c', 'coord-d', 'coord-e']
  );
  const resultingCounts = new Map([
    ['coord-a', 20], ['coord-b', 0], ['coord-c', 0], ['coord-d', 0], ['coord-e', 0]
  ]);
  for (const move of plan) {
    resultingCounts.set(move.sourceId, resultingCounts.get(move.sourceId) - 1);
    resultingCounts.set(move.targetId, resultingCounts.get(move.targetId) + 1);
  }

  assert.deepEqual([...resultingCounts.values()].sort(), [4, 4, 4, 4, 4]);
});

test('cuenta los traslados pendientes en el destino para evitar duplicarlos', () => {
  const players = playerMap([
    ['u1', 'coord-a'], ['u2', 'coord-a'], ['u3', 'coord-a'], ['u4', 'coord-a']
  ]);
  const pending = new Map([['u1', 'coord-b']]);

  assert.deepEqual(planRebalance(players, ['coord-a', 'coord-b'], pending), [
    { userId: 'u2', sourceId: 'coord-a', targetId: 'coord-b' }
  ]);
});
