'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('rechaza heartbeats de otro proceso que reutiliza ID con endpoints distintos', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-heartbeat-test-'));
  const port = await unusedPort();
  const previousEnvironment = {
    PORT: process.env.PORT,
    DB_PATH: process.env.DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
    COORDINATOR_SHARED_SECRET: process.env.COORDINATOR_SHARED_SECRET
  };
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: path.join(tempDirectory, 'users.db'),
    JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
    COORDINATOR_SHARED_SECRET: 'test-coordinator-secret'
  });

  const service = require('../index');
  t.after(async () => {
    if (service.server.listening) {
      await new Promise((resolve) => service.server.close(resolve));
    }
    service.db.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  if (!service.server.listening) {
    await new Promise((resolve) => service.server.once('listening', resolve));
  }

  async function sendHeartbeat(publicUrl, peerUrl) {
    return fetch(`http://127.0.0.1:${port}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-coordinator-secret': 'test-coordinator-secret'
      },
      body: JSON.stringify({
        coordinatorId: 'coord-a',
        coordinatorName: 'Norte',
        publicUrl,
        peerUrl,
        connectedPlayers: 0,
        uptime: 1
      })
    });
  }

  const first = await sendHeartbeat('wss://client-a.example', 'wss://mesh-a.example');
  assert.equal(first.status, 200);

  const conflict = await sendHeartbeat('wss://client-b.example', 'wss://mesh-b.example');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'COORDINATOR_ID_CONFLICT');

  const directoryResponse = await fetch(`http://127.0.0.1:${port}/coordinators`);
  const directory = await directoryResponse.json();
  assert.equal(directory.coordinators.length, 1);
  assert.equal(directory.coordinators[0].publicUrl, 'wss://client-a.example');
});
