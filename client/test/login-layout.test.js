'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylePath = path.join(__dirname, '..', 'public', 'style.css');
const login3dPath = path.join(__dirname, '..', 'public', 'login-3d.js');

test('login layout isolates 3D showcase canvas and prevents infinite resize loop', () => {
  const css = fs.readFileSync(stylePath, 'utf8');
  assert.ok(css.includes('.showcase-canvas-container canvas'), 'Targets showcase canvas');
  assert.ok(css.includes('position: absolute'), 'Canvas must be absolutely positioned to break DOM resize loops');
  assert.ok(css.includes('overflow: hidden'), 'Containers must overflow: hidden to avoid pushing grid tracks down');

  const js = fs.readFileSync(login3dPath, 'utf8');
  assert.ok(js.includes('renderer.setSize(width, height, false)'), 'Passes false to setSize to avoid inline style mutations');
  assert.ok(js.includes('Math.abs(w - width) < 2'), 'Protects against micro-resize oscillations');
});
