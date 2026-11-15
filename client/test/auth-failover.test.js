'use strict';

// Taller 7: el cliente recibe AUTH_URLS y debe sobrevivir a réplicas, caídas y elecciones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const commonSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'common.js'),
  'utf8'
);

function createHarness(handler, config = {}) {
  const calls = [];
  const storage = new Map();
  const sandbox = {
    window: {
      APP_CONFIG: {
        AUTH_URL: 'http://a.test',
        AUTH_URLS: ['http://a.test', 'http://b.test', 'http://c.test'],
        COORDINATOR_WS_URL: 'ws://coord.test',
        ...config
      },
      sessionStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value))
      }
    },
    fetch: async (url, options) => {
      calls.push(url);
      const answer = await handler(url, options, calls.length);
      if (answer instanceof Error) throw answer;
      return { status: answer.status, ok: answer.status < 400, json: async () => answer.body };
    },
    console: { info() {}, warn() {}, log() {}, error() {} },
    URL,
    Map,
    Set,
    AbortController,
    setTimeout: (fn) => setTimeout(fn, 0), // sin esperas reales en las pruebas
    clearTimeout
  };
  vm.runInNewContext(commonSource, sandbox);
  return { common: sandbox, calls, storage };
}

const okLogin = { status: 200, body: { ok: true, message: 'ok', token: 't', username: 'ana' } };
const notLeader = (leaderUrl) => ({
  status: 503,
  body: { ok: false, code: 'NOT_LEADER', message: 'réplica', hint: 'líder', error: 'not_leader', leaderUrl }
});
const noLeader = { status: 503, body: { ok: false, code: 'NO_LEADER', message: 'elección', hint: 'espera', error: 'no_leader' } };

test('si el primer auth no responde, prueba el siguiente y lo recuerda', async () => {
  const { common, calls, storage } = createHarness((url) =>
    url.startsWith('http://a.test') ? new Error('ECONNREFUSED') : okLogin
  );
  const result = await common.apiPost('/login', { username: 'ana', password: 'x' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['http://a.test/login', 'http://b.test/login']);
  assert.equal(storage.get('authLastGoodUrl'), 'http://b.test');

  calls.length = 0;
  await common.apiPost('/login', { username: 'ana', password: 'x' });
  assert.deepEqual(calls, ['http://b.test/login'], 'la siguiente petición empieza por el que funcionó');
});

test('503 not_leader: repite la misma petición en leaderUrl', async () => {
  const { common, calls } = createHarness((url) =>
    url.startsWith('http://c.test') ? { status: 201, body: { ok: true, message: 'creado' } } : notLeader('http://c.test')
  );
  const result = await common.apiPost('/register', { username: 'bob', password: 'x' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['http://a.test/register', 'http://c.test/register']);
});

test('leaderUrl fuera de la lista (p. ej. ngrok) también se sigue', async () => {
  const { common, calls } = createHarness((url) =>
    url.startsWith('https://leader.ngrok.test') ? okLogin : notLeader('https://leader.ngrok.test/')
  );
  const result = await common.apiPost('/register', { username: 'bob', password: 'x' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['http://a.test/register', 'https://leader.ngrok.test/register']);
});

test('503 no_leader: espera y reintenta hasta que haya líder', async () => {
  let round = 0;
  const { common } = createHarness((url) => {
    if (url.startsWith('http://a.test')) round += 1;
    return round < 3 ? noLeader : okLogin;
  });
  const result = await common.apiPost('/register', { username: 'bob', password: 'x' });
  assert.equal(result.ok, true);
  assert.equal(round, 3);
});

test('5xx sin formato del auth (p. ej. 502 de ngrok) pasa al siguiente', async () => {
  const { common, calls } = createHarness((url) =>
    url.startsWith('http://a.test') ? { status: 502, body: null } : okLogin
  );
  const result = await common.apiPost('/login', { username: 'ana', password: 'x' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['http://a.test/login', 'http://b.test/login']);
});

test('replication_timeout es respuesta definitiva: no se repite la escritura en otro auth', async () => {
  const { common, calls } = createHarness(() => ({
    status: 503,
    body: { ok: false, code: 'REPLICATION_TIMEOUT', message: 'sin confirmar', hint: 'reintenta', error: 'replication_timeout' }
  }));
  const result = await common.apiPost('/register', { username: 'bob', password: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.payload.code, 'REPLICATION_TIMEOUT');
  assert.deepEqual(calls, ['http://a.test/register']);
});

test('si ningún auth responde devuelve networkError', async () => {
  const { common, calls } = createHarness(() => new Error('ECONNREFUSED'));
  const result = await common.apiPost('/login', { username: 'ana', password: 'x' });
  assert.equal(result.networkError, true);
  assert.equal(calls.length, 3);
});

test('compatibilidad: solo AUTH_URL funciona como lista de un elemento', async () => {
  const { common, calls } = createHarness(() => okLogin, { AUTH_URLS: undefined, AUTH_URL: 'http://solo.test' });
  const result = await common.apiPost('/login', { username: 'ana', password: 'x' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['http://solo.test/login']);
});

test('requestAuthStatus dice qué auth atiende y cambia si ese auth se cae', async () => {
  let aDown = false;
  const { common } = createHarness((url) => {
    if (url.startsWith('http://a.test')) {
      return aDown ? new Error('ECONNREFUSED') : { status: 200, body: { authId: 'auth-a', role: 'leader', term: 1 } };
    }
    return { status: 200, body: { authId: 'auth-b', role: 'replica', term: 1 } };
  });
  const first = await common.requestAuthStatus();
  assert.equal(first.authId, 'auth-a');
  assert.equal(common.authRoleLabel(first.role), 'líder');

  aDown = true;
  const second = await common.requestAuthStatus();
  assert.equal(second.authId, 'auth-b');
  assert.equal(common.authRoleLabel(second.role), 'réplica');
});
