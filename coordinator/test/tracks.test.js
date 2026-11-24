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

test('los 8 puestos de estacionamiento están sobre el asfalto, pasando la meta y sin tocarse', () => {
  for (const track of RaceTracks.tracks) {
    const finish = RaceTracks.pointAtDistance(track, 0);
    const spots = [];
    for (let index = 0; index < 8; index += 1) {
      const spot = RaceTracks.parkingSpot(track, index);
      assert.ok(RaceTracks.isOnRoad(track, spot.x, spot.y), `${track.name}: estacionamiento ${index + 1}`);
      // Pasando la meta (hacia adelante) y no en medio de ella
      const ahead = (spot.x - finish.x) * finish.tangent.x + (spot.y - finish.y) * finish.tangent.y;
      assert.ok(ahead > 0, `${track.name}: estacionamiento ${index + 1} está después de la meta`);
      assert.ok(distanceBetween(spot, finish) > 40, `${track.name}: estacionamiento ${index + 1} no tapa la meta`);
      spots.push(spot);
    }
    for (let a = 0; a < spots.length; a += 1) {
      for (let b = a + 1; b < spots.length; b += 1) {
        assert.ok(distanceBetween(spots[a], spots[b]) >= 44, `${track.name}: estacionamientos ${a + 1} y ${b + 1}`);
      }
    }
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

test('cada pista tiene sus checkpoints sobre el asfalto y lejos de los otros tramos', () => {
  for (const track of RaceTracks.tracks) {
    const gates = RaceTracks.checkpointPositions(track);
    assert.ok(gates.length >= 3, `${track.name}: tiene ${gates.length} checkpoints`);
    const length = RaceTracks.trackLength(track);
    gates.forEach((gate, index) => {
      assert.ok(RaceTracks.isOnRoad(track, gate.x, gate.y), `${track.name}: checkpoint ${index + 1} fuera de la pista`);
      assert.equal(RaceTracks.reachesCheckpoint(track, index, gate.x, gate.y), true);
      // Un carro en otro tramo del circuito (más de 250 px de recorrido antes o después)
      // no puede activar este checkpoint: por ejemplo, en el cruce del "ocho".
      const fraction = (track.checkpoints || [0.15, 0.4, 0.6, 0.85])[index];
      for (let distance = 0; distance < length; distance += 5) {
        let along = Math.abs(distance - fraction * length);
        along = Math.min(along, length - along);
        if (along < 250) continue;
        const point = RaceTracks.pointAtDistance(track, distance);
        assert.equal(
          RaceTracks.reachesCheckpoint(track, index, point.x, point.y),
          false,
          `${track.name}: el checkpoint ${index + 1} se activa desde otro tramo (recorrido ${distance})`
        );
      }
    });
  }
});
