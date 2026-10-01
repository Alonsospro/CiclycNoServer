// Explicit one-time import from a verified local backup. Never imports automatically.
require('dotenv').config({ quiet: true });
const fs = require('fs'), path = require('path');
const { createHash } = require('crypto');
const Store = require('../src/services/driveStateStore');

(async () => {
  const source = process.argv[2];
  if (!source) throw new Error('Uso: node scripts/migrate-drive-state.js <carpeta-de-respaldo-verificada>');
  const root = path.resolve(source);
  if (!fs.statSync(root).isDirectory()) throw new Error('El respaldo debe ser una carpeta.');
  const changes = new Map();
  for (const dir of ['inventories', 'justifications', 'history', 'audit', 'trash', 'sync']) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full).sort()) {
      const key = `${dir}/${name}`;
      if (Store.validPath(key)) changes.set(key, JSON.parse(fs.readFileSync(path.join(full, name), 'utf8')));
    }
  }
  for (const key of ['users.json', 'deleted_snapshots.json']) {
    if (fs.existsSync(path.join(root, key))) changes.set(key, JSON.parse(fs.readFileSync(path.join(root, key), 'utf8')));
  }
  if (!changes.size) throw new Error('El respaldo no contiene documentos de estado.');
  const store = new Store();
  const snapshot = await store.snapshot();
  const operation = 'migration:' + createHash('sha256').update(JSON.stringify([...changes])).digest('hex');
  // A populated store needs an explicit reviewed merge, not an automatic overwrite.
  if (Object.keys(snapshot).length) throw new Error('Drive ya contiene estado. No se sobrescribió ningún documento.');
  await store.commit(snapshot, changes, operation);
  const confirmed = await store.snapshot();
  for (const [key, value] of changes) {
    if (JSON.stringify(confirmed[key]?.data) !== JSON.stringify(value)) throw new Error('No se confirmó la importación completa.');
  }
  console.log(`Importación confirmada: ${changes.size} documentos. Respaldo original conservado.`);
})().catch(error => { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; });
