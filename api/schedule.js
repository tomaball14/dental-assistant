import { send } from '../lib/http.js';
import { route } from '../lib/handler.js';
import { schedule } from '../lib/service.js';

export default route(['GET', 'POST'], async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const days = Math.min(7, Math.max(1, Number(url.searchParams.get('days')) || 2));
  send(res, 200, { appointments: await schedule(days) });
});
