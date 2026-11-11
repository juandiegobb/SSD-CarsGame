const test = require('node:test');
const assert = require('node:assert/strict');
const RaceTracks = require('../../shared/tracks');

function distanceBetween(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function trackLength(track) {
  return track.points.reduce((length, point, index) =>
    length + distanceBetween(point, track.points[(index + 1) % track.points.length]), 0);
}

test('define cuatro circuitos distintos y válidos', () => {
  assert.equal(RaceTracks.tracks.length, 4);
  assert.equal(new Set(RaceTracks.tracks.map((track) => track.name)).size, 4);

  for (const track of RaceTracks.tracks) {
    assert.ok(track.points.length > 100);
    for (const point of track.points) {
      assert.ok(point.x >= 0 && point.x <= RaceTracks.WORLD_WIDTH);
      assert.ok(point.y >= 0 && point.y <= RaceTracks.WORLD_HEIGHT);
    }
  }
});

test('todos los puestos de salida están sobre el asfalto y detrás de la meta', () => {
  for (const track of RaceTracks.tracks) {
    for (let index = 0; index < 8; index += 1) {
      const spawn = RaceTracks.spawnAtStart(track, index);
      assert.ok(RaceTracks.isOnRoad(track, spawn.x, spawn.y), `${track.name}: puesto ${index + 1}`);
    }
    assert.equal(
      RaceTracks.crossesFinish(track, RaceTracks.pointAtDistance(track, -10), RaceTracks.pointAtDistance(track, 10)),
      true,
      `${track.name}: cruce de meta hacia adelante`
    );
    assert.equal(
      RaceTracks.crossesFinish(track, RaceTracks.pointAtDistance(track, 10), RaceTracks.pointAtDistance(track, -10)),
      false,
      `${track.name}: no contar el cruce en reversa`
    );
  }
});

test('cada circuito registra una sola meta por vuelta completa', () => {
  for (const track of RaceTracks.tracks) {
    const length = trackLength(track);
    const samples = Math.ceil(length / 8);
    let crossings = 0;
    let previous = RaceTracks.pointAtDistance(track, -1);

    for (let index = 1; index <= samples; index += 1) {
      const current = RaceTracks.pointAtDistance(track, -1 + length * index / samples);
      if (RaceTracks.crossesFinish(track, previous, current)) crossings += 1;
      previous = current;
    }

    assert.equal(crossings, 1, track.name);
  }
});
