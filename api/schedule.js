import { send, authorize, fail } from '../lib/http.js';
import { schedule } from '../lib/service.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (!authorize(req, res)) return;
  try {
    const url = new URL(req.url, 'http://x');
    const days = Math.min(7, Math.max(1, Number(url.searchParams.get('days')) || 2));
    send(res, 200, { appointments: await schedule(days) });
  } catch (e) { fail(res, e); }
}
