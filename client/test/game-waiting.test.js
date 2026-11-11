'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const gameSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'game.js'),
  'utf8'
);
const raceTracks = require(path.join(__dirname, '..', '..', 'shared', 'tracks.js'));

function createGameHarness() {
  const drawingCalls = [];
  const context = new Proxy({
    measureText: (text) => ({ width: String(text).length * 8 }),
    setTransform() {},
    save() {},
    restore() {}
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => drawingCalls.push({ name: key, args });
    }
  });
  const frames = [];
  const listeners = new Map();
  const canvas = {
    width: 800,
    height: 600,
    style: {},
    parentElement: { clientWidth: 1200, clientHeight: 480 },
    getContext: () => context
  };
  const window = {
    RaceTracks: raceTracks,
    devicePixelRatio: 1,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener() {}
  };
  const sandbox = {
    window,
    document: { createElement: () => ({ getContext: () => context }) },
    performance: { now: () => 1000 },
    requestAnimationFrame: (callback) => frames.push(callback),
    Date,
    Map,
    Math,
    Set
  };
  vm.runInNewContext(gameSource, sandbox);

  const sentMessages = [];
  const game = window.createGame({
    canvas,
    controls: null,
    send: (message) => sentMessages.push(message)
  });
  game.onWelcome({
    world: { width: 800, height: 600, playerRadius: 20, tickRate: 20 },
    you: { userId: '1' }
  });
  game.onState({
    race: {
      level: 1,
      phase: 'waiting',
      countdownStartedAt: null,
      serverTime: Date.now(),
      laps: {}
    },
    players: [
      { userId: '1', username: 'uno', x: 100, y: 100, provider: 'local', extras: {} },
      { userId: '2', username: 'dos', x: 200, y: 100, provider: 'local', extras: {} }
    ]
  });

  return { canvas, drawingCalls, frames, game, listeners, sentMessages };
}

test('muestra los carros en la sala de espera sin dibujar la pista ni moverlos', () => {
  const harness = createGameHarness();
  harness.frames.shift()();

  assert.equal(harness.canvas.width, 1200);
  assert.equal(
    harness.drawingCalls.some((call) => call.name === 'lineTo'),
    false,
    'el circuito no se debe dibujar antes de iniciar'
  );
  assert.equal(
    harness.drawingCalls.filter((call) => call.name === 'fillText').length >= 4,
    true,
    'se dibuja el mensaje de espera y el nombre de cada participante'
  );

  harness.listeners.get('keydown')({
    code: 'ArrowUp',
    target: null,
    preventDefault() {}
  });
  assert.equal(harness.sentMessages.some((message) => message.type === 'intent'), false);

  harness.game.stop();
});

test('muestra la pista y habilita el movimiento al comenzar la cuenta regresiva', () => {
  const harness = createGameHarness();
  harness.game.onRaceUpdate({
    level: 1,
    phase: 'countdown',
    countdownStartedAt: Date.now(),
    serverTime: Date.now(),
    laps: {}
  });
  harness.frames.shift()();

  assert.equal(harness.canvas.width, 800);
  assert.equal(harness.drawingCalls.some((call) => call.name === 'lineTo'), true);

  harness.game.onRaceUpdate({
    level: 1,
    phase: 'racing',
    countdownStartedAt: Date.now(),
    serverTime: Date.now(),
    laps: {}
  });
  harness.listeners.get('keydown')({
    code: 'ArrowUp',
    target: null,
    preventDefault() {}
  });
  const movement = harness.sentMessages[harness.sentMessages.length - 1];
  assert.equal(movement.type, 'intent');
  assert.equal(movement.intent.dir.x, 0);
  assert.equal(movement.intent.dir.y, -1);

  harness.game.stop();
});
