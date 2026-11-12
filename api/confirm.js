import { send } from '../lib/http.js';
import { route } from '../lib/handler.js';
import { confirmAction } from '../lib/actions.js';

// Staff tapped "Send" on a draft the assistant proposed.
export default route(['POST'], async (req, res, { token, text }) => {
  send(res, 200, await confirmAction(token, text));
});
