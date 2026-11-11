'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const commonSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'common.js'),
  'utf8'
);

function createCommonHarness(fetch) {
  const sandbox = {
    window: {
      APP_CONFIG: {
        AUTH_URL: 'https://auth.example',
        COORDINATOR_WS_URL: 'wss://coordinator.example'
      }
    },
    fetch,
    URL,
    Map,
    AbortController,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(commonSource, sandbox);
  return sandbox;
}

test('consulta y une jugadores de todos los coordinadores activos', async () => {
  const requests = [];
  const responses = new Map([
    ['https://auth.example/coordinators', {
      ok: true,
      coordinators: [
        { coordinatorId: 'coord-a', coordinatorName: 'Norte', publicUrl: 'wss://a.example', live: true },
        { coordinatorId: 'coord-b', coordinatorName: 'Sur', publicUrl: 'ws://b.example', live: true },
        { coordinatorId: 'coord-offline', publicUrl: 'wss://offline.example', live: false }
      ]
    }],
    ['https://a.example/players', {
      ok: true,
      players: [{ userId: '1', username: 'uno', coordinatorId: 'coord-a' }]
    }],
    ['http://b.example/players', {
      ok: true,
      players: [{ userId: '2', username: 'dos' }]
    }]
  ]);
  const common = createCommonHarness(async (url, options) => {
    requests.push({ url, options });
    const body = responses.get(url);
    if (!body) throw new Error('URL inesperada');
    return { ok: true, json: async () => body };
  });

  const result = await common.requestGlobalPlayers();
  const merged = common.mergePlayerLists(
    ...result.coordinators.map((coordinator) => coordinator.players),
    [{ userId: 1, username: 'uno actualizado' }]
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(merged)),
    [
      {
        userId: '1',
        username: 'uno actualizado',
        coordinatorId: 'coord-a',
        coordinatorName: 'Norte'
      },
      {
        userId: '2',
        username: 'dos',
        coordinatorId: 'coord-b',
        coordinatorName: 'Sur'
      }
    ]
  );
  assert.deepEqual(requests.map((request) => request.url), [
    'https://auth.example/coordinators',
    'https://a.example/players',
    'http://b.example/players'
  ]);
  assert.equal(requests[1].options.headers['ngrok-skip-browser-warning'], 'true');
  assert.equal(requests[1].options.signal instanceof AbortSignal, true);
});

test('marca coordinadores inaccesibles para advertir que la lista puede estar incompleta', async () => {
  const common = createCommonHarness(async (url) => {
    if (url === 'https://auth.example/coordinators') {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          coordinators: [
            { coordinatorId: 'coord-a', coordinatorName: 'Norte', publicUrl: 'wss://a.example', live: true }
          ]
        })
      };
    }
    throw new Error('Coordinador inaccesible');
  });

  const result = await common.requestGlobalPlayers();
  assert.equal(result.ok, true);
  assert.equal(result.coordinators[0].ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.coordinators[0].players)), []);
});
