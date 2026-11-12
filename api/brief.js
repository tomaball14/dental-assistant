import { send } from '../lib/http.js';
import { route } from '../lib/handler.js';
import { buildBrief } from '../lib/brief.js';

export default route(['GET', 'POST'], async (req, res) => {
  send(res, 200, { blocks: [], ...(await buildBrief(2)) });
});
