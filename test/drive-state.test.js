const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { createHash } = require('crypto');
const express = require('express');
const Store = require('../src/services/driveStateStore');
const config = require('../src/config');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nibol-drive-state-'));
config.baseDataDir = temp;
config.referencePhotosDir = path.join(temp, 'references');
const storage = require('../src/services/storagePath');
const token = 'private-test-token-with-at-least-32-characters';
let files, properties, context, store, failWrite, failNetwork, failAtWrite;

beforeEach(() => {
  files = new Map(); properties = new Map([['DRIVE_STATE_TOKEN', token], ['DRIVE_STATE_FOLDER_ID', 'private-folder']]);
  failWrite = false; failNetwork = false; failAtWrite = -1;
  const createFile = (name, text) => {
    if (failWrite || files.size === failAtWrite) throw new Error('Drive write failed');
    const id = 'f' + files.size;
    const file = { getId: () => id, getBlob: () => ({ getDataAsString: () => text }) };
    files.set(id, file); return file;
  };
  context = vm.createContext({ console: { error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, hasLock: () => true, releaseLock() {} }) },
    DriveApp: { getFileById: id => files.get(id), getFolderById: () => ({ createFile }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, text) => [...createHash('sha256').update(text).digest()],
      newBlob: text => ({ getBytes: () => Buffer.from(text) }), getUuid: () => require('crypto').randomUUID() },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gas/StateStore.gs'), 'utf8'), context);
  store = new Store({ url: 'https://script.google.com/state', token, fetcher: async (_, options) => {
    if (failNetwork) throw new Error('Offline');
    return { ok: true, json: async () => context.doPost({ postData: { contents: options.body } }) };
  } });
  storage.remoteEnabled = true; storage.remoteStore = store;
  storage.clearMemory();
});
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('Drive state survives loss of all local memory and files', async () => {
  await storage.withRemoteRequest(async () => {
    storage.writeJson(storage.resolveFilePath('inventories/I.json'), { id: 'I', count: 0 });
    await storage.flushRemote('create-I');
  });
  storage.clearMemory();
  await storage.withRemoteRequest(async () => {
    assert.equal(storage.readJson(storage.resolveFilePath('inventories/I.json')).count, 0);
    assert.deepEqual(storage.listFiles(storage.getInventoriesDirectory()), ['I.json']);
    assert.equal(fs.existsSync(storage.resolveFilePath('inventories/I.json')), false);
  });
});

test('stale edits fail without overwriting a confirmed count', async () => {
  await store.commit({}, new Map([['inventories/I.json', { count: 1 }]]), 'seed');
  const first = await store.snapshot(), second = await store.snapshot();
  await store.commit(first, new Map([['inventories/I.json', { count: 2 }]]), 'first');
  await assert.rejects(store.commit(second, new Map([['inventories/I.json', { count: 3 }]]), 'second'), e => e.code === 'STATE_CONFLICT' && e.status === 409);
  assert.equal((await store.snapshot())['inventories/I.json'].data.count, 2);
});

test('distinct inventories can commit from simultaneous snapshots', async () => {
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => store.snapshot()));
  await Promise.all(snapshots.map((snapshot, i) => store.commit(snapshot, new Map([[`inventories/I${i}.json`, { count: i }]]), `operator-${i}`)));
  assert.equal(Object.keys(await store.snapshot()).length, 20);
});

test('lost acknowledgement repeats the transaction exactly once', async () => {
  const snapshot = await store.snapshot(), changes = new Map([['inventories/I.json', { count: 5 }]]);
  const one = await store.commit(snapshot, changes, 'same-operation');
  const two = await store.commit(snapshot, changes, 'same-operation');
  assert.equal(two.duplicate, true);
  assert.equal(one.versions['inventories/I.json'], two.versions['inventories/I.json']);
  await assert.rejects(store.commit(snapshot, new Map([['inventories/I.json', { count: 6 }]]), 'same-operation'), e => e.code === 'OPERATION_MISMATCH');
});

test('a failed transaction publishes neither its inventory nor audit document', async () => {
  await store.commit({}, new Map([['inventories/I.json', { count: 1 }]]), 'seed');
  const snapshot = await store.snapshot();
  // Both document files exist, but writing the new manifest fails.
  failAtWrite = files.size + 2;
  await assert.rejects(store.commit(snapshot, new Map([['inventories/I.json', { count: 2 }], ['audit/log.json', [{ action: 'COUNT' }]]]), 'failed'));
  failAtWrite = -1;
  const confirmed = await store.snapshot();
  assert.equal(confirmed['inventories/I.json'].data.count, 1);
  assert.equal(confirmed['audit/log.json'], undefined);
});

test('deletion retains a remote version and rejects stale recreation', async () => {
  await store.commit({}, new Map([['inventories/I.json', { count: 1 }]]), 'seed');
  const snapshot = await store.snapshot();
  await store.commit(snapshot, new Map([['inventories/I.json', null]]), 'delete');
  assert.equal((await store.snapshot())['inventories/I.json'].data, null);
  await assert.rejects(store.commit(snapshot, new Map([['inventories/I.json', { count: 1 }]]), 'resurrect'), e => e.code === 'STATE_CONFLICT');
});

test('remote state refuses unauthenticated access and unsafe paths', async () => {
  store.token = 'wrong';
  await assert.rejects(store.snapshot(), e => e.code === 'STATE_UNAUTHORIZED');
  await assert.rejects(store.commit({}, new Map([['../users.json', []]]), 'unsafe'), e => e.code === 'DRIVE_STATE_INVALID');
});

test('Drive failure never acknowledges an HTTP save or falls back to disk', async () => {
  const app = express();
  app.use('/api', require('../src/middlewares/driveStateMiddleware'));
  app.post('/api/save', (req, res) => {
    storage.writeJson(storage.resolveFilePath('inventories/I.json'), { count: 1 });
    failWrite = true;
    res.json({ success: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/save`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
    assert.equal(fs.existsSync(storage.resolveFilePath('inventories/I.json')), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('outbox is saved in Drive before Sheets receives a count', async () => {
  const gas = require('../src/services/gasService');
  const original = gas.upsertCountToGAS;
  gas.upsertCountToGAS = async () => {
    const snapshot = await store.snapshot();
    assert.equal(snapshot['inventories/I.json'].data.count, 7);
    assert.equal(snapshot[storage.queuePath('I')].data.jobs.length, 1);
    throw new Error('Sheets offline');
  };
  try {
    await storage.withRemoteRequest(async () => {
      const result = await storage.runDurable(async () => {
        storage.writeJson(storage.resolveFilePath('inventories/I.json'), { count: 7 });
        storage.deferSync('upsertCountToGAS', ['CICLICO', { stockFisico: 7 }]);
        return { success: true };
      }, { scope: 'I', operationId: 'count-7', fingerprint: '7' });
      assert.equal(result.syncPending, true);
    });
    storage.clearMemory();
    assert.equal((await store.snapshot())[storage.queuePath('I')].data.jobs.length, 1);
  } finally { gas.upsertCountToGAS = original; }
});

test('a network failure refuses remote reads instead of serving packaged inventories', async () => {
  failNetwork = true;
  await assert.rejects(storage.withRemoteRequest(() => {}), e => e.code === 'DRIVE_STATE_UNAVAILABLE');
});

test('remote user changes replace instance caches on the next request', async () => {
  const auth = require('../src/services/authService');
  await store.commit({}, new Map([['users.json', [{ id: 'U', username: 'operator', active: true }]]]), 'seed-users');
  await storage.withRemoteRequest(async () => {
    assert.equal(auth.getUsersList()[0].active, true);
    auth.saveUsersList([{ id: 'U', username: 'operator', active: false }]);
    await storage.flushRemote('disable-user');
  });
  await storage.withRemoteRequest(() => assert.equal(auth.getUsersList()[0].active, false));
});

test('HTTP success waits for the Drive acknowledgement', async () => {
  const original = store.commit.bind(store);
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  store.commit = async (...args) => { started(); await blocked; return original(...args); };
  const app = express();
  app.use('/api', require('../src/middlewares/driveStateMiddleware'));
  app.post('/api/save', (req, res) => {
    storage.writeJson(storage.resolveFilePath('inventories/I.json'), { count: 0 });
    res.json({ success: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let acknowledged = false;
  try {
    const responsePromise = fetch(`http://127.0.0.1:${server.address().port}/api/save`, { method: 'POST' }).then(response => { acknowledged = true; return response; });
    await entered;
    assert.equal(acknowledged, false);
    release();
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    assert.equal((await store.snapshot())['inventories/I.json'].data.count, 0);
  } finally { release(); await new Promise(resolve => server.close(resolve)); }
});
