const storage = require('../services/storagePath');

module.exports = function driveStateMiddleware(req, res, next) {
  if (!storage.remoteEnabled || req.path === '/health') return next();
  storage.withRemoteRequest(() => {
    const end = res.end.bind(res);
    let finishing = false;
    res.end = function (chunk, encoding, callback) {
      if (finishing) return res;
      finishing = true;
      let failed = res.statusCode >= 400;
      if (typeof chunk === 'string' && String(res.getHeader('Content-Type')).includes('application/json')) {
        try { failed ||= JSON.parse(chunk).success === false; } catch (_) {}
      }
      const commit = failed ? Promise.resolve() : storage.flushRemote();
      commit.then(() => end(chunk, encoding, callback)).catch(error => {
        if (res.headersSent) return res.destroy(error);
        res.statusCode = error.status || 503;
        res.removeHeader('Content-Length');
        res.removeHeader('ETag');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        end(JSON.stringify({ success: false, code: error.code || 'PERSISTENCE_UNAVAILABLE', message: error.message }));
      });
      return res;
    };
    next();
  }).catch(error => {
    res.status(error.status || 503).json({ success: false, code: error.code || 'PERSISTENCE_UNAVAILABLE', message: error.message });
  });
};
