// Upload / clear the practice's own schedule export.
//   GET    -> where data is kept ("server" on an office computer, else "browser") and what's loaded
//   POST   -> { imported } a parsed export (schedule or fee schedule) from the browser
//   DELETE -> forget it
import { send } from '../lib/http.js';
import { route } from '../lib/handler.js';
import { current, sanitize, saveLocal, clearLocal, storageMode, merge, summary, hostedRealDataAllowed } from '../lib/practice-data.js';

export default route(['GET', 'POST', 'DELETE'], async (req, res, body) => {
  const mode = storageMode();
  if (req.method === 'GET') {
    return send(res, 200, { mode, loaded: summary(current()), hostedRealDataAllowed: mode === 'server' || hostedRealDataAllowed() });
  }
  if (mode !== 'server') {
    return send(res, 200, { mode, note: 'On this version the data stays in your browser tab and is sent with each question.' });
  }
  if (req.method === 'DELETE') {
    await clearLocal();
    return send(res, 200, { mode, loaded: null });
  }
  const incoming = body.imported?.kind === 'fees'
    ? { kind: 'fees', fees: sanitize({ appointments: [], patients: [], fees: body.imported.fees }).fees }
    : sanitize(body.imported);
  if (!incoming) return send(res, 400, { error: 'That file didn\'t contain a schedule I could read.' });
  const merged = sanitize(merge(current(), incoming)) || incoming;
  await saveLocal(merged);
  send(res, 200, { mode, loaded: summary(merged) });
});
