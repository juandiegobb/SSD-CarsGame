'use strict';

// Objetos en la pista: turbo y aceite (SPEC §14.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');
const { createItems, pickupItems, refreshItems, speedFactor, RESPAWN_MS } = require('../race-items');

const R = 20;

test('cada pista tiene 6 objetos sobre el asfalto, lejos de la parrilla de salida', () => {
  for (const track of RaceTracks.tracks) {
    const items = createItems(RaceTracks, track);
    assert.equal(items.length, 6);
    assert.deepEqual([...new Set(items.map((item) => item.type))].sort(), ['aceite', 'turbo']);
    const grid = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => RaceTracks.spawnAtStart(track, index));
    for (const item of items) {
      assert.ok(RaceTracks.isOnRoad(track, item.x, item.y, 12), `${track.name}: ${item.id} fuera de la pista`);
      for (const spot of grid) {
        assert.ok(Math.hypot(item.x - spot.x, item.y - spot.y) > R + 12 + 10, `${track.name}: ${item.id} debajo de la parrilla`);
      }
    }
  }
});

test('pasar encima de un objeto lo recoge: desaparece y da el efecto', () => {
  const race = { items: [{ id: 'turbo-1', type: 'turbo', x: 100, y: 100, active: true, respawnAt: null }], effects: {} };
  const picked = pickupItems(race, [{ userId: '7', x: 110, y: 105 }], R, 1000);
  assert.deepEqual(picked, [{ itemId: 'turbo-1', userId: '7', type: 'turbo' }]);
  assert.equal(race.items[0].active, false);
  assert.equal(race.items[0].respawnAt, 1000 + RESPAWN_MS);
  assert.deepEqual(race.effects['7'], { type: 'turbo', until: 3000 });
});

test('un objeto inactivo no se puede recoger y un carro lejos no lo toca', () => {
  const race = { items: [{ id: 'a', type: 'aceite', x: 100, y: 100, active: false, respawnAt: 9000 }], effects: {} };
  assert.deepEqual(pickupItems(race, [{ userId: '7', x: 100, y: 100 }], R, 1000), []);
  race.items[0].active = true;
  assert.deepEqual(pickupItems(race, [{ userId: '7', x: 140, y: 100 }], R, 1000), []);
});

test('el objeto reaparece a los 5 s y el efecto se acaba solo', () => {
  const race = {
    items: [{ id: 'a', type: 'aceite', x: 0, y: 0, active: false, respawnAt: 6000 }],
    effects: { 7: { type: 'aceite', until: 2500 } }
  };
  assert.equal(refreshItems(race, 2000), false);
  assert.equal(refreshItems(race, 3000), true, 'el efecto venció');
  assert.deepEqual(race.effects, {});
  assert.equal(refreshItems(race, 6000), true, 'el objeto volvió');
  assert.equal(race.items[0].active, true);
});

test('turbo acelera y aceite frena mientras dura el efecto', () => {
  const race = { effects: { 7: { type: 'turbo', until: 2000 }, 9: { type: 'aceite', until: 2000 } } };
  assert.equal(speedFactor(race, '7', 1000), 1.6);
  assert.equal(speedFactor(race, '9', 1000), 0.5);
  assert.equal(speedFactor(race, '7', 2000), 1, 'ya venció');
  assert.equal(speedFactor(race, '5', 1000), 1, 'sin efecto');
});
