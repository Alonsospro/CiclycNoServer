require('dotenv').config({ quiet: true });
const Store = require('../src/services/driveStateStore');

(async () => {
  const documents = await new Store().snapshot();
  const active = Object.values(documents).filter(entry => entry.data !== null).length;
  console.log(`Drive conectado: ${active} documentos activos. No se modificaron datos.`);
})().catch(error => { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; });
