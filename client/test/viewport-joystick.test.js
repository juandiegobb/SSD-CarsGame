'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lobbyPath = path.join(__dirname, '..', 'public', 'lobby.html');
const stylePath = path.join(__dirname, '..', 'public', 'style.css');
const gamePath = path.join(__dirname, '..', 'public', 'game.js');

test('lobby.html includes virtual joystick and orientation hint', () => {
  const content = fs.readFileSync(lobbyPath, 'utf8');
  assert.ok(content.includes('id="virtual-joystick"'), 'Must include virtual-joystick element');
  assert.ok(content.includes('class="joystick-base"'), 'Must include joystick-base');
  assert.ok(content.includes('class="joystick-stick"'), 'Must include joystick-stick');
  assert.ok(content.includes('id="orientation-hint"'), 'Must include orientation-hint');
  assert.ok(content.includes('joystick: document.getElementById("virtual-joystick")'), 'Must pass joystick to createGame');
});

test('style.css has compact viewport, 100dvh room layout and responsive mobile landscape rules', () => {
  const css = fs.readFileSync(stylePath, 'utf8');
  assert.ok(css.includes('.racing-page.room-active'), 'Defines room-active styles');
  assert.ok(css.includes('overflow: hidden'), 'Prevents vertical overflow in room view');
  assert.ok(css.includes('.virtual-joystick'), 'Defines virtual joystick styles');
  assert.ok(css.includes('.orientation-hint'), 'Defines orientation hint styles');
  assert.ok(css.includes('(orientation: landscape)'), 'Includes landscape media queries');
  assert.ok(css.includes('(orientation: portrait)'), 'Includes portrait media queries');
});

test('game.js implements virtual joystick direction mapping and pointer capture', () => {
  const js = fs.readFileSync(gamePath, 'utf8');
  assert.ok(js.includes('joystickStick'), 'Handles joystick stick element');
  assert.ok(js.includes('resetJoystick'), 'Implements resetJoystick');
  assert.ok(js.includes('updateJoystickPosition'), 'Implements updateJoystickPosition');
  assert.ok(js.includes('setPointerCapture'), 'Uses setPointerCapture for smooth dragging');
});
