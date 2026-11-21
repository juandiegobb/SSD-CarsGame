'use strict';

// Choques entre carros (SPEC §14.4): dos carros de la misma sala nunca se superponen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { limitMove, separateOverlaps } = require('../collisions');
const RaceTracks = require('../../shared/tracks');

const R = 20; // PLAYER_RADIUS
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('un carro no puede avanzar dentro de otro: se queda tocándolo', () => {
  const other = { x: 100, y: 100 };
  const from = { x: 50, y: 100 };          // a 50 px, va de frente hacia el otro
  const to = { x: 75, y: 100 };            // quedaría a 25 px (encima)
  const result = limitMove(from, to, [other], R);
  assert.ok(gap(result, other) >= 2 * R - 1e-6, `quedó a ${gap(result, other)} px`);
});

test('si va en diagonal, se desliza por el costado en vez de frenar en seco', () => {
  const other = { x: 100, y: 100 };
  const from = { x: 60, y: 100 };          // a 40 px: ya se tocan
  const to = { x: 70, y: 110 };            // empuja hacia el otro y hacia abajo
  const result = limitMove(from, to, [other], R);
  assert.equal(result.x, 60, 'no avanza hacia el otro');
  assert.equal(result.y, 110, 'sí se desliza hacia abajo');
});

test('alejarse de otro carro siempre está permitido', () => {
  const other = { x: 100, y: 100 };
  const from = { x: 60, y: 100 };
  const to = { x: 40, y: 100 };
  assert.deepEqual(limitMove(from, to, [other], R), to);
});

test('dos carros encimados se separan a 2 radios, mitad y mitad', () => {
  const cars = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 110, y: 100 }];
  assert.equal(separateOverlaps(cars, R), 1);
  assert.ok(gap(cars[0], cars[1]) >= 2 * R - 1e-6);
  assert.equal(cars[0].x + cars[1].x, 210, 'se mueven lo mismo cada uno');
});

test('dos carros en el mismo punto se separan igual en todos los coordinadores', () => {
  const one = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 100, y: 100 }];
  const two = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 100, y: 100 }];
  separateOverlaps(one, R);
  separateOverlaps(two, R);
  assert.deepEqual(one, two);
  assert.ok(gap(one[0], one[1]) >= 2 * R - 1e-6);
});

test('si un carro está contra el borde de la pista, el otro se aparta todo', () => {
  const cars = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 120, y: 100 }];
  const canPlace = (x) => x <= 100; // nada a la derecha de x=100... salvo donde ya está b
  separateOverlaps(cars, R, (x, y) => canPlace(x) || (x === 120 && y === 100));
  assert.ok(gap(cars[0], cars[1]) >= 2 * R - 1e-6);
  assert.equal(cars[1].x, 120, 'b no se movió');
});

test('la parrilla de salida no pone dos carros encimados (8 puestos, 4 pistas)', () => {
  for (const track of RaceTracks.tracks) {
    const grid = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => RaceTracks.spawnAtStart(track, index));
    for (let i = 0; i < grid.length; i += 1) {
      for (let j = i + 1; j < grid.length; j += 1) {
        assert.ok(gap(grid[i], grid[j]) >= 2 * R, `${track.name}: puestos ${i + 1} y ${j + 1} a ${gap(grid[i], grid[j]).toFixed(1)} px`);
      }
    }
  }
});
