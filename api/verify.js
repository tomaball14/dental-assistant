import { send, authorize, fail, readBody } from '../lib/http.js';
import { verify, findPatients } from '../lib/service.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!authorize(req, res)) return;
  try {
    const { patientId, name } = await readBody(req);
    if (patientId) return send(res, 200, await verify(String(patientId)));
    if (name) {
      const matches = await findPatients(String(name));
      return send(res, 200, { matches: matches.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` })) });
    }
    send(res, 400, { error: 'patientId or name required' });
  } catch (e) { fail(res, e); }
}
