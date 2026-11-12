import { send } from '../lib/http.js';
import { route } from '../lib/handler.js';
import { verify, findPatients } from '../lib/service.js';

export default route(['POST'], async (req, res, { patientId, name }) => {
  if (patientId) return send(res, 200, await verify(String(patientId)));
  if (name) {
    const matches = await findPatients(String(name));
    return send(res, 200, { matches: matches.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` })) });
  }
  send(res, 400, { error: 'patientId or name required' });
});
