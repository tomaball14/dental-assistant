import { send, authorize, fail, readBody } from '../lib/http.js';
import { confirmAction } from '../lib/actions.js';

// Staff tapped "Send" on a draft the assistant proposed.
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!authorize(req, res)) return;
  try {
    const { token, text } = await readBody(req);
    send(res, 200, await confirmAction(token, text));
  } catch (e) { fail(res, e); }
}
