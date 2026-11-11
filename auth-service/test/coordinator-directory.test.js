'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCoordinatorEndpointConflict } = require('../coordinator-directory');

test('allows heartbeat refresh when a coordinator keeps its endpoints', () => {
  const coordinator = {
    publicUrl: 'wss://client-a.example',
    peerUrl: 'wss://mesh-a.example'
  };

  assert.equal(hasCoordinatorEndpointConflict(coordinator, coordinator), false);
  assert.equal(hasCoordinatorEndpointConflict(undefined, coordinator), false);
});

test('detects an ID collision when another process announces different endpoints', () => {
  const existing = {
    publicUrl: 'wss://client-a.example',
    peerUrl: 'wss://mesh-a.example'
  };

  assert.equal(hasCoordinatorEndpointConflict(existing, {
    publicUrl: 'wss://client-b.example',
    peerUrl: 'wss://mesh-b.example'
  }), true);
});
