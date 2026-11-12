'use strict';

// Taller 7: el coordinador habla con el líder aunque tenga en AUTH_URLS réplicas o auths caídos.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthClient, parseAuthUrls } = require('../auth-client');

const silent = { info() {} };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const html = (status) => ({ status, ok: false, json: async () => { throw new SyntaxError('no es JSON'); } });
const notLeader = (leaderUrl) => json(503, { ok: false, code: 'NOT_LEADER', error: 'not_leader', leaderUrl });

function client(handler, urls = ['http://a.test', 'http://b.test', 'http://c.test']) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    const answer = await handler(url, options);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { auth: createAuthClient({ urls, fetchImpl, log: silent }), calls };
}

test('parseAuthUrls: lista, compatibilidad con AUTH_URL y URLs inválidas', () => {
  assert.deepEqual(parseAuthUrls('http://a:1/, http://b:2', 'http://x'), ['http://a:1', 'http://b:2']);
  assert.deepEqual(parseAuthUrls('', 'https://auth.ngrok.app/'), ['https://auth.ngrok.app']);
  assert.deepEqual(parseAuthUrls(undefined, undefined), ['http://localhost:4000']);
  assert.equal(parseAuthUrls('http://a,ftp://b'), null);
  assert.equal(parseAuthUrls('http://user:pw@a'), null);
});

test('heartbeat a una réplica: sigue leaderUrl y se queda con el líder', async () => {
  const { auth, calls } = client((url) =>
    url.startsWith('http://c.test') ? json(200, { ok: true }) : notLeader('http://c.test')
  );
  const first = await auth.request('/heartbeat', { method: 'POST' });
  assert.equal(first.response.status, 200);
  assert.deepEqual(calls, ['http://a.test/heartbeat', 'http://c.test/heartbeat']);
  assert.equal(auth.currentUrl, 'http://c.test');

  calls.length = 0;
  await auth.request('/peers?coordinatorId=coord-1');
  assert.deepEqual(calls, ['http://c.test/peers?coordinatorId=coord-1'], 'va directo al líder');
});

test('si el líder deja de responder recorre otra vez la lista y sigue al nuevo líder', async () => {
  let leader = 'http://a.test';
  const { auth, calls } = client((url) => {
    if (url.startsWith('http://a.test') && leader !== 'http://a.test') return new Error('ECONNREFUSED');
    return url.startsWith(leader) ? json(200, { ok: true }) : notLeader(leader);
  });
  await auth.request('/heartbeat');
  assert.equal(auth.currentUrl, 'http://a.test');

  leader = 'http://b.test'; // a se cae y b gana la elección
  calls.length = 0;
  const answer = await auth.request('/heartbeat');
  assert.equal(answer.response.status, 200);
  assert.deepEqual(calls, ['http://a.test/heartbeat', 'http://b.test/heartbeat']);
  assert.equal(auth.currentUrl, 'http://b.test');
});

test('no_leader (elección en curso): devuelve la respuesta sin bloquear', async () => {
  const { auth, calls } = client(() => json(503, { ok: false, code: 'NO_LEADER', error: 'no_leader' }));
  const answer = await auth.request('/heartbeat');
  assert.equal(answer.payload.error, 'no_leader');
  assert.equal(calls.length, 1);
});

test('la página de error de ngrok (no JSON) cuenta como auth caído', async () => {
  const { auth, calls } = client((url) =>
    url.startsWith('http://a.test') ? html(404) : json(200, { ok: true })
  );
  const answer = await auth.request('/heartbeat');
  assert.equal(answer.response.status, 200);
  assert.deepEqual(calls, ['http://a.test/heartbeat', 'http://b.test/heartbeat']);
});

test('errores del auth (p. ej. 401 por secreto incorrecto) no se reintentan en otros auths', async () => {
  const { auth, calls } = client(() => json(401, { ok: false, code: 'INVALID_COORDINATOR_SECRET' }));
  const answer = await auth.request('/heartbeat');
  assert.equal(answer.response.status, 401);
  assert.equal(calls.length, 1);
});

test('si ningún auth responde lanza error', async () => {
  const { auth, calls } = client(() => new Error('ECONNREFUSED'));
  await assert.rejects(auth.request('/heartbeat'), /Ningún auth/);
  assert.equal(calls.length, 3);
});
