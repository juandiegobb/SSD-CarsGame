'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const spectatorPath = path.join(__dirname, '..', 'public', 'spectator.html');

test('spectator.html exists and has an exit button without frontend frameworks', () => {
  assert.ok(fs.existsSync(spectatorPath), 'spectator.html must exist in client/public/');
  const content = fs.readFileSync(spectatorPath, 'utf8');

  // Verify no frontend frameworks are included
  assert.ok(!content.includes('react'), 'No React framework');
  assert.ok(!content.includes('vue'), 'No Vue framework');
  assert.ok(!content.includes('angular'), 'No Angular framework');
  assert.ok(!content.includes('jquery'), 'No jQuery');

  // Verify scripts
  assert.ok(content.includes('/config.js'), 'Loads config.js');
  assert.ok(content.includes('/common.js'), 'Loads common.js');
  assert.ok(content.includes('/style.css'), 'Loads style.css');

  // Verify exit button and unwatch controls
  assert.ok(content.includes('id="exit-spectator-button"'), 'Includes exit spectator button');
  assert.ok(content.includes('Salir del modo espectador'), 'Has descriptive Spanish label for exiting');
  assert.ok(content.includes('unwatch-button'), 'Includes unwatch button to stop watching a room');

  // Verify intentional socket cleanup and navigation on exit
  assert.ok(content.includes('intentionallyClosed = true'), 'Marks intentional close on exit');
  assert.ok(content.includes('socket.close'), 'Closes websocket cleanly on exit');
  assert.ok(content.includes('/lobby.html'), 'Redirects to lobby if token present');
});
