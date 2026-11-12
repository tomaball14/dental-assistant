import { send, authorize, fail } from '../lib/http.js';
import { buildBrief } from '../lib/brief.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!authorize(req, res)) return;
  try {
    send(res, 200, { blocks: [], ...(await buildBrief(2)) });
  } catch (e) { fail(res, e); }
}
