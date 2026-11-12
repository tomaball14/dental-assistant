import { send } from '../lib/http.js';
import { route } from '../lib/handler.js';
import { ask } from '../lib/assistant.js';

export default route(['POST'], async (req, res, { message, history, context }) => {
  send(res, 200, await ask(message, Array.isArray(history) ? history : [], context || {}));
});
