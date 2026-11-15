const test = require('node:test');
const assert = require('node:assert/strict');
const { loadClusterConfig, ClusterConfigError } = require('../cluster-config');

test('sin configuración se comporta como auth único (Talleres 4-6)', () => {
  const config = loadClusterConfig({});
  assert.equal(config.authId, 'auth-4000');
  assert.equal(config.port, 4000);
  assert.equal(config.peerPort, 4100);
  assert.equal(config.publicUrl, 'http://localhost:4000');
  assert.equal(config.peerUrl, 'ws://localhost:4100');
  assert.deepEqual(config.peers, []);
  assert.equal(config.majority, 1);
  assert.equal(config.readLagTolerance, 10);
  assert.equal(config.replicationAckTimeoutMs, 2000);
});

test('lee un grupo de 3 auths y calcula la mayoría', () => {
  const config = loadClusterConfig({
    AUTH_ID: 'auth-b',
    PORT: '4002',
    PEER_PORT: '4102',
    PUBLIC_URL: 'https://auth-b.ejemplo.dev/',
    AUTH_PEERS: 'auth-c=ws://localhost:4103, auth-a=ws://localhost:4101|http://localhost:4001/',
    READ_LAG_TOLERANCE: '5'
  });
  assert.equal(config.authId, 'auth-b');
  assert.equal(config.publicUrl, 'https://auth-b.ejemplo.dev');
  assert.deepEqual(config.peers.map((peer) => peer.authId), ['auth-a', 'auth-c']);
  assert.equal(config.peers[0].publicUrl, 'http://localhost:4001');
  assert.equal(config.peers[1].publicUrl, null);
  assert.equal(config.clusterSize, 3);
  assert.equal(config.majority, 2);
  assert.equal(config.readLagTolerance, 5);
});

test('rechaza configuraciones inválidas con un mensaje claro', () => {
  const bad = [
    { AUTH_ID: 'auth a' },
    { PORT: '4001', PEER_PORT: '4001' },
    { PUBLIC_URL: 'ftp://localhost:4001' },
    { PUBLIC_URL: 'http://localhost:4001/ruta' },
    { AUTH_PEERS: 'auth-b' },
    { AUTH_PEERS: 'auth-b=http://localhost:4102' },
    { AUTH_PEERS: 'auth-b=ws://localhost:4102|ws://localhost:4002' },
    { AUTH_PEERS: 'auth-b=ws://localhost:4102|http://a|http://b' },
    { AUTH_ID: 'auth-a', AUTH_PEERS: 'auth-a=ws://localhost:4101' },
    { AUTH_PEERS: 'auth-b=ws://localhost:4102,auth-b=ws://localhost:4103' },
    { READ_LAG_TOLERANCE: '-1' }
  ];
  for (const env of bad) {
    assert.throws(() => loadClusterConfig(env), ClusterConfigError, JSON.stringify(env));
  }
});
