'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboardPath = path.join(__dirname, '..', 'public', 'dashboard.html');

test('dashboard.html exists and is valid vanilla HTML without frameworks', () => {
  assert.ok(fs.existsSync(dashboardPath), 'dashboard.html must exist in client/public/');
  const content = fs.readFileSync(dashboardPath, 'utf8');

  // Verify no frontend frameworks are included
  assert.ok(!content.includes('react'), 'No React framework');
  assert.ok(!content.includes('vue'), 'No Vue framework');
  assert.ok(!content.includes('angular'), 'No Angular framework');
  assert.ok(!content.includes('jquery'), 'No jQuery');

  // Verify scripts
  assert.ok(content.includes('/config.js'), 'Loads config.js');
  assert.ok(content.includes('/common.js'), 'Loads common.js');
  assert.ok(content.includes('/style.css'), 'Loads style.css');

  // Verify required sections and metrics fields
  assert.ok(content.includes('trace-timeline'), 'Includes timeline for distributed traces');
  assert.ok(content.includes('trace-input'), 'Includes trace search input');
  assert.ok(content.includes('auth-cluster-heading'), 'Includes Auth cluster section');
  assert.ok(content.includes('coord-cluster-heading'), 'Includes Coordinator cluster section');

  // Verify safety: does not use innerHTML for rendering trace or metrics
  assert.ok(!content.includes('.innerHTML ='), 'Must use textContent and createElement instead of innerHTML');
});
