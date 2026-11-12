// Every API route goes through here: method check, body parsing, attaching the
// practice's uploaded data to the request, then the access-code check.

import { send, authorize, fail, readBody } from './http.js';
import { runWith, sanitize, loadLocal, storageMode, hostedRealDataAllowed } from './practice-data.js';

export function route(methods, fn) {
  return async function handler(req, res) {
    if (!methods.includes(req.method)) return send(res, 405, { error: `${methods.join('/')} only` });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      let data = null;
      if (storageMode() === 'server') data = await loadLocal();
      else if (body.practiceData) {
        data = sanitize(body.practiceData);
        if (data && data.source !== 'sample' && !hostedRealDataAllowed()) {
          return send(res, 403, { error: 'Real patient data can\'t be used on this hosted version yet. Run the office-computer version, or turn on hosting once the HIPAA agreement is signed.', code: 'hosted_phi_blocked' });
        }
      }
      return await runWith(data, async () => {
        if (!authorize(req, res)) return;
        return fn(req, res, body);
      });
    } catch (e) { fail(res, e); }
  };
}
