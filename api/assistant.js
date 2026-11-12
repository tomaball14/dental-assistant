import { send, authorize, fail, readBody } from '../lib/http.js';
import { ask } from '../lib/assistant.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!authorize(req, res)) return;
  try {
    const { message, history, context } = await readBody(req);
    send(res, 200, await ask(message, Array.isArray(history) ? history : [], context || {}));
  } catch (e) { fail(res, e); }
}
