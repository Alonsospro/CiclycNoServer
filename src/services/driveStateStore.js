const { createHash, randomUUID } = require('crypto');
const PersistenceError = require('./persistenceError');

class DriveStateStore {
  constructor({ url = process.env.DRIVE_STATE_URL, token = process.env.DRIVE_STATE_TOKEN, fetcher = (...args) => fetch(...args) } = {}) {
    this.url = url;
    this.token = token;
    this.fetcher = fetcher;
  }

  async request(action, payload = {}) {
    if (!this.url || !this.token) throw new PersistenceError('Configure DRIVE_STATE_URL y DRIVE_STATE_TOKEN.', 'DRIVE_STATE_CONFIG');
    let result;
    try {
      const response = await this.fetcher(this.url, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, action, token: this.token }),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      result = await response.json();
    } catch (_) {
      throw new PersistenceError('Drive no confirmó el estado. Reintente con la misma operación.', 'DRIVE_STATE_UNAVAILABLE');
    }
    if (result?.success !== true) {
      throw new PersistenceError(result?.error || 'Drive no confirmó el guardado.', result?.code || 'DRIVE_STATE_UNAVAILABLE',
        ['STATE_CONFLICT', 'OPERATION_MISMATCH'].includes(result?.code) ? 409 : 503);
    }
    return result;
  }

  async snapshot() {
    const result = await this.request('stateSnapshot');
    if (!result.documents || typeof result.documents !== 'object' || Array.isArray(result.documents)) {
      throw new PersistenceError('Respuesta de estado inválida.', 'DRIVE_STATE_INVALID');
    }
    for (const [key, entry] of Object.entries(result.documents)) {
      if (!DriveStateStore.validPath(key) || !entry || !Number.isInteger(entry.version) || entry.version < 1 || !Object.hasOwn(entry, 'data')) {
        throw new PersistenceError('Documento remoto inválido.', 'DRIVE_STATE_INVALID');
      }
    }
    return result.documents;
  }

  async commit(documents, changes, operationId = randomUUID()) {
    const entries = [...changes].map(([key, data]) => {
      if (!DriveStateStore.validPath(key)) throw new PersistenceError('Ruta de estado inválida.', 'DRIVE_STATE_INVALID');
      return { key, data, expectedVersion: documents[key]?.version || 0 };
    });
    if (!entries.length) return { versions: {} };
    // Reuse this payload and ID after an ambiguous acknowledgement.
    const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    return this.request('stateCommit', { changes: entries, operationId, fingerprint });
  }

  static validPath(key) {
    return /^(users|deleted_snapshots)\.json$/.test(key) ||
      /^(inventories|justifications|history|audit|trash|sync)\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.json$/.test(key);
  }
}

module.exports = DriveStateStore;
