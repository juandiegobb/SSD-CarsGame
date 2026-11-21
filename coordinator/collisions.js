'use strict';

// Proyecto final (SPEC §14.4): choques entre carros. Dos carros de la misma sala nunca
// se superponen: sus centros quedan a 2 * radio como mínimo.
//
// Se hace en dos pasos dentro del game loop:
//   1. limitMove: al mover un carro, se le quita la parte del movimiento que lo mete
//      dentro de otro (puede deslizarse por el costado, pero no atravesarlo).
//   2. separateOverlaps: si aun así quedan dos carros encimados (llegaron a la vez, o la
//      posición replicada de un carro remoto llegó encima de otro), se empujan para
//      separarlos, mitad y mitad, sin sacarlos de la pista.
//
// Todo es matemática pura (sin estado) para poder probarlo aparte del coordinador.

const EPSILON = 1e-6;

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Dirección fija para separar dos carros en exactamente el mismo punto (caso raro, pero
// sin esto la normal sería 0/0). Depende de los ids para que todos los coordinadores
// separen igual.
function fallbackNormal(idA, idB) {
  return String(idA) < String(idB) ? { x: -1, y: 0 } : { x: 1, y: 0 };
}

// from: posición actual del carro; to: adonde quiere llegar este tick.
// others: [{ x, y }] los demás carros de la sala. Devuelve la posición permitida.
function limitMove(from, to, others, radius) {
  const minDistance = radius * 2;
  let delta = { x: to.x - from.x, y: to.y - from.y };

  for (const other of others) {
    const candidate = { x: from.x + delta.x, y: from.y + delta.y };
    if (distance(candidate, other) >= minDistance) continue;

    // Normal que apunta desde el otro carro hacia este
    const away = { x: from.x - other.x, y: from.y - other.y };
    const length = Math.hypot(away.x, away.y);
    if (length < EPSILON) continue; // ya estaban encimados: lo arregla separateOverlaps
    const normal = { x: away.x / length, y: away.y / length };

    // Si el movimiento va hacia el otro carro, se quita esa componente (queda deslizar)
    const towards = delta.x * normal.x + delta.y * normal.y;
    if (towards < 0) {
      delta = { x: delta.x - towards * normal.x, y: delta.y - towards * normal.y };
    }
  }

  const result = { x: from.x + delta.x, y: from.y + delta.y };
  // Si después de deslizar sigue tocando a alguien, no se mueve este tick
  if (others.some((other) => distance(result, other) < minDistance - EPSILON) &&
      !others.some((other) => distance(from, other) < minDistance - EPSILON)) {
    return { x: from.x, y: from.y };
  }
  return result;
}

// cars: [{ id, x, y }] (se modifican en el lugar). canPlace(x, y) dice si un punto es
// válido (dentro de la pista). Devuelve cuántos pares se separaron.
function separateOverlaps(cars, radius, canPlace = () => true, passes = 3) {
  const minDistance = radius * 2;
  let separated = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;
    for (let i = 0; i < cars.length; i += 1) {
      for (let j = i + 1; j < cars.length; j += 1) {
        const a = cars[i];
        const b = cars[j];
        const gap = distance(a, b);
        if (gap >= minDistance - EPSILON) continue;

        let normal;
        if (gap < EPSILON) {
          normal = fallbackNormal(a.id, b.id);
        } else {
          normal = { x: (a.x - b.x) / gap, y: (a.y - b.y) / gap };
        }
        const overlap = minDistance - gap;
        const half = overlap / 2;
        const aTarget = { x: a.x + normal.x * half, y: a.y + normal.y * half };
        const bTarget = { x: b.x - normal.x * half, y: b.y - normal.y * half };
        const aOk = canPlace(aTarget.x, aTarget.y);
        const bOk = canPlace(bTarget.x, bTarget.y);

        if (aOk && bOk) {
          Object.assign(a, aTarget);
          Object.assign(b, bTarget);
        } else if (aOk) {
          // b está contra el borde de la pista: a se aparta todo
          const aFull = { x: a.x + normal.x * overlap, y: a.y + normal.y * overlap };
          if (canPlace(aFull.x, aFull.y)) Object.assign(a, aFull); else continue;
        } else if (bOk) {
          const bFull = { x: b.x - normal.x * overlap, y: b.y - normal.y * overlap };
          if (canPlace(bFull.x, bFull.y)) Object.assign(b, bFull); else continue;
        } else {
          continue;
        }
        separated += 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return separated;
}

module.exports = { limitMove, separateOverlaps };
