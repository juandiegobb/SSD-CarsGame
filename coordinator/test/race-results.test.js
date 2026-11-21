'use strict';

// Orden de llegada, tiempos y ganador (SPEC §14.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordFinish, closeLevel, buildStandings } = require('../race-results');

const COUNTDOWN = 6000;

test('cada piloto que llega recibe su puesto y su tiempo desde el verde', () => {
  const race = { startedAt: 10_000, countdownStartedAt: 4_000, results: [] };
  recordFinish(race, '7', 'Ana', 52_300, COUNTDOWN);
  recordFinish(race, '9', 'bob', 55_000, COUNTDOWN);
  assert.deepEqual(race.results, [
    { userId: '7', username: 'ana', position: 1, timeMs: 42_300 },
    { userId: '9', username: 'bob', position: 2, timeMs: 45_000 }
  ]);
});

test('llegar dos veces no duplica el resultado', () => {
  const race = { startedAt: 0, results: [] };
  recordFinish(race, '7', 'ana', 1000, COUNTDOWN);
  assert.equal(recordFinish(race, '7', 'ana', 2000, COUNTDOWN), null);
  assert.equal(race.results.length, 1);
});

test('sin startedAt (coordinador viejo) se cuenta desde el fin del semáforo', () => {
  const race = { countdownStartedAt: 1000, results: [] };
  recordFinish(race, '7', 'ana', 10_000, COUNTDOWN);
  assert.equal(race.results[0].timeMs, 3000);
});

test('los tiempos de cada nivel se suman, y quien se fue de la sala no cuenta', () => {
  const race = {
    totals: { 7: 40_000, 9: 39_000 },
    results: [
      { userId: '7', position: 1, timeMs: 30_000 },
      { userId: '9', position: 2, timeMs: 33_000 },
      { userId: '5', position: 3, timeMs: 20_000 }
    ]
  };
  assert.deepEqual(closeLevel(race, new Set(['7', '9'])), { 7: 70_000, 9: 72_000 });
});

test('la clasificación general ordena por tiempo total y el primero es el ganador', () => {
  const names = { 7: 'ana', 9: 'bob', 3: 'caro' };
  const standings = buildStandings(new Set(['7', '9', '3']), { 7: 70_000, 9: 65_000, 3: 70_000 }, (id) => names[id]);
  assert.deepEqual(standings.map((s) => [s.position, s.username, s.totalMs]), [
    [1, 'bob', 65_000],
    [2, 'caro', 70_000], // empate con ana: desempata el userId, igual en todos los coordinadores
    [3, 'ana', 70_000]
  ]);
});
