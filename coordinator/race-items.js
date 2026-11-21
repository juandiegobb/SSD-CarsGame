'use strict';

// Objetos en la pista (SPEC §14.4): turbo y aceite.
//
//   - Cada pista tiene 6 objetos fijos repartidos por el circuito, alternando turbo y
//     aceite y alternando el costado de la pista (se pueden esquivar).
//   - El coordinador PROPIETARIO de la sala los recoge: si un carro pasa encima de un
//     objeto activo, el objeto desaparece por 5 s y el carro recibe el efecto.
//   - El efecto cambia la velocidad del carro por un rato: turbo x1,6 durante 2 s,
//     aceite x0,5 durante 1,5 s. Lo aplica cualquier coordinador que mueva al carro,
//     leyendo race.effects (replicado con la carrera).
//
// Funciones puras para poder probarlas sin el coordinador.

const ITEM_RADIUS = 12;
const RESPAWN_MS = 5000;
const EFFECTS = {
  turbo: { speedFactor: 1.6, durationMs: 2000 },
  aceite: { speedFactor: 0.5, durationMs: 1500 }
};
// Solo en el primer 2/3 de la vuelta: el último tramo antes de la meta es la parrilla de
// salida (hasta 8 carros x 48 px) y no debe haber objetos debajo de los carros al arrancar.
const ITEM_SPOTS = [
  { fraction: 0.06, type: 'turbo', lane: -22 },
  { fraction: 0.18, type: 'aceite', lane: 22 },
  { fraction: 0.3, type: 'turbo', lane: 22 },
  { fraction: 0.42, type: 'aceite', lane: -22 },
  { fraction: 0.54, type: 'turbo', lane: -22 },
  { fraction: 0.66, type: 'aceite', lane: 22 }
];

// tracks: el módulo shared/tracks.js (se recibe para no depender de rutas aquí)
function createItems(tracks, track) {
  const length = tracks.trackLength(track);
  return ITEM_SPOTS.map((spot, index) => {
    // Una pista puede mover sus objetos (track.itemFractions), p. ej. el "ocho" por su cruce
    const fraction = track.itemFractions?.[index] ?? spot.fraction;
    const point = tracks.pointAtDistance(track, fraction * length);
    return {
      id: `${spot.type}-${index + 1}`,
      type: spot.type,
      x: Math.round((point.x - point.tangent.y * spot.lane) * 10) / 10,
      y: Math.round((point.y + point.tangent.x * spot.lane) * 10) / 10,
      active: true,
      respawnAt: null
    };
  });
}

// cars: [{ userId, x, y }] de la sala. Devuelve los objetos recogidos en este tick.
function pickupItems(race, cars, playerRadius, now) {
  const picked = [];
  if (!Array.isArray(race.items)) return picked;
  if (!race.effects) race.effects = {};
  for (const item of race.items) {
    if (!item.active) continue;
    const car = cars.find((candidate) =>
      Math.hypot(candidate.x - item.x, candidate.y - item.y) <= playerRadius + ITEM_RADIUS);
    if (!car) continue;
    item.active = false;
    item.respawnAt = now + RESPAWN_MS;
    race.effects[car.userId] = { type: item.type, until: now + EFFECTS[item.type].durationMs };
    picked.push({ itemId: item.id, userId: car.userId, type: item.type });
  }
  return picked;
}

// Vuelve a poner los objetos cuyo tiempo de espera ya pasó y borra los efectos vencidos.
// Devuelve true si algo cambió (para avisar a los clientes).
function refreshItems(race, now) {
  let changed = false;
  for (const item of race.items || []) {
    if (!item.active && Number.isFinite(item.respawnAt) && now >= item.respawnAt) {
      item.active = true;
      item.respawnAt = null;
      changed = true;
    }
  }
  for (const [userId, effect] of Object.entries(race.effects || {})) {
    if (!effect || now >= effect.until) {
      delete race.effects[userId];
      changed = true;
    }
  }
  return changed;
}

// Multiplicador de velocidad del carro ahora (1 si no tiene efecto activo).
function speedFactor(race, userId, now) {
  const effect = race?.effects?.[userId];
  if (!effect || !EFFECTS[effect.type] || now >= effect.until) return 1;
  return EFFECTS[effect.type].speedFactor;
}

module.exports = { createItems, pickupItems, refreshItems, speedFactor, ITEM_RADIUS, RESPAWN_MS, EFFECTS };
