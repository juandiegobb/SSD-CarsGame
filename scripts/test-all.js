'use strict';

// npm test (en la raíz): corre las pruebas de auth-service, coordinator y client, una
// carpeta después de otra, y muestra un resumen. Con SKIP_DOTENV=1 ningún servicio lee
// su .env local, así las pruebas dan lo mismo en cualquier PC.
//
//   npm test                      -> los 3 servicios
//   npm test -- auth-service      -> solo los que nombres

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const all = ['auth-service', 'coordinator', 'client'];
const requested = process.argv.slice(2);
const services = requested.length > 0 ? requested : all;

const unknown = services.filter((name) => !all.includes(name));
if (unknown.length > 0) {
  console.error(`Servicio desconocido: ${unknown.join(', ')}. Válidos: ${all.join(', ')}`);
  process.exit(2);
}

const results = [];
for (const service of services) {
  const cwd = path.join(root, service);
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    console.error(`\n✗ ${service}: falta node_modules. Corre "npm install" dentro de ${service}.`);
    results.push({ service, ok: false, summary: 'sin node_modules' });
    continue;
  }
  console.log(`\n=== Pruebas de ${service} ===`);
  const run = spawnSync(process.execPath, ['--test'], {
    cwd,
    env: { ...process.env, SKIP_DOTENV: '1', NODE_NO_WARNINGS: '1' },
    encoding: 'utf8'
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(output);
  const pass = output.match(/^# pass (\d+)/m)?.[1] ?? '?';
  const fail = output.match(/^# fail (\d+)/m)?.[1] ?? '?';
  results.push({ service, ok: run.status === 0, summary: `${pass} pasan, ${fail} fallan` });
}

console.log('\n=== Resumen ===');
for (const { service, ok, summary } of results) {
  console.log(`${ok ? '✓' : '✗'} ${service.padEnd(13)} ${summary}`);
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
