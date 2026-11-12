import { send, authorize, fail, readBody } from '../lib/http.js';
import { estimateFor } from '../lib/service.js';
import { estimateText } from '../lib/estimate.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!authorize(req, res)) return;
  try {
    const { patientId, procedures } = await readBody(req);
    if (!patientId || !Array.isArray(procedures) || !procedures.length) {
      return send(res, 400, { error: 'patientId and procedures[] required' });
    }
    // Fees from the UI arrive in dollars.
    const procs = procedures.slice(0, 30).map((p) => (typeof p === 'string'
      ? { code: p }
      : { code: p.code, tooth: p.tooth || null, fee: p.fee === '' || p.fee == null ? null : Math.round(Number(p.fee) * 100) }));
    const r = await estimateFor(String(patientId), procs);
    send(res, 200, { ...r, patientText: estimateText(r.estimate, r.patient?.firstName) });
  } catch (e) { fail(res, e); }
}
