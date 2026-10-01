/** Deploy this as a SEPARATE Apps Script web app, executing as the owner.
 * Script properties: DRIVE_STATE_FOLDER_ID, DRIVE_STATE_TOKEN (32+ characters).
 * Never grant public sharing to the state folder or place the token in HTML.
 */
function doPost(e) {
  let lock;
  try {
    const body = JSON.parse(e && e.postData && e.postData.contents || '{}');
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('DRIVE_STATE_TOKEN');
    if (!token || token.length < 32 || !stateTokenEqual_(token, String(body.token || ''))) {
      return stateJson_({ success: false, code: 'STATE_UNAUTHORIZED', error: 'Acceso al estado denegado.' });
    }
    const folderId = props.getProperty('DRIVE_STATE_FOLDER_ID');
    if (!folderId) throw new Error('Configure DRIVE_STATE_FOLDER_ID.');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return stateJson_({ success: false, code: 'STATE_BUSY', error: 'Estado ocupado. Reintente.' });
    const pointerKey = 'STATE_HEAD_' + folderId;
    const head = props.getProperty(pointerKey);
    const manifest = head ? JSON.parse(DriveApp.getFileById(head).getBlob().getDataAsString())
      : { schema: 1, documents: {}, receipts: [] };
    if (manifest.schema !== 1) throw new Error('Versión de estado incompatible.');
    if (body.action === 'stateSnapshot') {
      const documents = {};
      let bytes = 0;
      Object.keys(manifest.documents).forEach(key => {
        const entry = manifest.documents[key];
        if (!statePathValid_(key)) throw new Error('Ruta almacenada inválida.');
        let data = null;
        if (entry.fileId) {
          const text = DriveApp.getFileById(entry.fileId).getBlob().getDataAsString();
          bytes += Utilities.newBlob(text).getBytes().length;
          if (bytes > 8 * 1024 * 1024) throw new Error('El estado excede 8 MB; requiere lectura por inventario.');
          data = JSON.parse(text);
        }
        // Tombstones retain their version so stale clients cannot recreate deletes.
        documents[key] = { version: entry.version, data };
      });
      return stateJson_({ success: true, documents });
    }
    if (body.action !== 'stateCommit') throw new Error('Acción de estado inválida.');
    if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 500 ||
      !/^[a-zA-Z0-9_:.-]{1,180}$/.test(body.operationId || '')) throw new Error('Transacción inválida.');
    const fingerprint = stateHash_(JSON.stringify(body.changes));
    if (body.fingerprint !== fingerprint) throw new Error('Huella de transacción inválida.');
    const previous = manifest.receipts.find(r => r.id === body.operationId);
    if (previous) {
      return stateJson_(previous.fingerprint === fingerprint ? { success: true, duplicate: true, versions: previous.versions }
        : { success: false, code: 'OPERATION_MISMATCH', error: 'La operación ya tiene otros datos.' });
    }
    const seen = {};
    for (const change of body.changes) {
      if (!statePathValid_(change.key) || seen[change.key] || !Object.prototype.hasOwnProperty.call(change, 'data') ||
        !Number.isInteger(change.expectedVersion) || change.expectedVersion < 0) throw new Error('Documento de transacción inválido.');
      seen[change.key] = true;
      if ((manifest.documents[change.key] && manifest.documents[change.key].version || 0) !== change.expectedVersion) {
        return stateJson_({ success: false, code: 'STATE_CONFLICT', error: 'Otro operador modificó el estado. Actualice y reintente.' });
      }
    }
    if (Utilities.newBlob(JSON.stringify(body.changes)).getBytes().length > 8 * 1024 * 1024) throw new Error('Transacción demasiado grande.');
    const folder = DriveApp.getFolderById(folderId);
    const versions = {};
    body.changes.forEach(change => {
      const version = change.expectedVersion + 1;
      const file = change.data === null ? null : folder.createFile(
        stateHash_(change.key) + '-' + Utilities.getUuid() + '.json', JSON.stringify(change.data), 'application/json');
      manifest.documents[change.key] = { version, fileId: file && file.getId() };
      versions[change.key] = version;
    });
    manifest.receipts.push({ id: body.operationId, fingerprint, versions });
    manifest.receipts = manifest.receipts.slice(-128);
    manifest.previousHead = head;
    manifest.savedAt = new Date().toISOString();
    const file = folder.createFile('manifest-' + Utilities.getUuid() + '.json', JSON.stringify(manifest), 'application/json');
    // Publish only after EVERY new document exists. A failed publish leaves the
    // prior state intact; unreferenced files are retained for later maintenance.
    props.setProperty(pointerKey, file.getId());
    return stateJson_({ success: true, versions });
  } catch (error) {
    console.error(error);
    return stateJson_({ success: false, code: 'STATE_UNAVAILABLE', error: 'No se pudo confirmar el estado en Drive.' });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function statePathValid_(key) {
  return /^(users|deleted_snapshots)\.json$/.test(key) ||
    /^(inventories|justifications|history|audit|trash|sync)\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.json$/.test(key);
}
function stateHash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function stateTokenEqual_(a, b) {
  const x = stateHash_(a), y = stateHash_(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
function stateJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
