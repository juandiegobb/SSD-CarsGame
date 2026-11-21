'use strict';

// El atajo "node index.js 4001" arma la configuración de cada auth sin URLs escritas en el código.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveNodeProfile } = require('../node-profiles');

test('sin URLs en el .env usa localhost para los 3 auths', () => {
  const profile = resolveNodeProfile('4002', {});
  assert.deepEqual(profile, {
    AUTH_ID: 'auth-b',
    PORT: '4002',
    PEER_PORT: '4102',
    DB_PATH: 'users-auth-b.db',
    PUBLIC_URL: 'http://localhost:4002',
    PEER_URL: 'ws://localhost:4102',
    AUTH_PEERS: 'auth-a=ws://localhost:4101|http://localhost:4001,auth-c=ws://localhost:4103|http://localhost:4003'
  });
});

test('acepta el puerto, la letra o el authId', () => {
  for (const arg of ['4001', 'a', 'A', 'auth-a']) {
    assert.equal(resolveNodeProfile(arg, {}).AUTH_ID, 'auth-a');
  }
  assert.equal(resolveNodeProfile('5000', {}), null);
  assert.equal(resolveNodeProfile('', {}), null);
});

test('con túnel https el mesh va por el mismo túnel con wss', () => {
  const env = {
    AUTH_A_URL: 'https://a.ngrok-free.dev/',
    AUTH_B_URL: 'https://b.ngrok-free.dev',
    AUTH_C_URL: 'https://c.ngrok-free.dev'
  };
  const profile = resolveNodeProfile('auth-a', env);
  assert.equal(profile.PUBLIC_URL, 'https://a.ngrok-free.dev');
  assert.equal(profile.PEER_URL, 'wss://a.ngrok-free.dev');
  assert.equal(
    profile.AUTH_PEERS,
    'auth-b=wss://b.ngrok-free.dev|https://b.ngrok-free.dev,auth-c=wss://c.ngrok-free.dev|https://c.ngrok-free.dev'
  );
});

test('AUTH_X_PEER_URL permite un túnel aparte para el mesh', () => {
  const profile = resolveNodeProfile('c', {
    AUTH_C_URL: 'https://c.ngrok-free.dev',
    AUTH_C_PEER_URL: 'wss://c-mesh.ngrok-free.dev'
  });
  assert.equal(profile.PEER_URL, 'wss://c-mesh.ngrok-free.dev');
});
