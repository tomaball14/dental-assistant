// Twilio inbound SMS webhook: staff text the assistant, it texts back.
// Point the Twilio number's "A message comes in" webhook at
//   https://<your-domain>/api/sms   (HTTP POST)

import { createHmac, timingSafeEqual } from 'node:crypto';
import { send, readBody } from '../lib/http.js';
import { ask } from '../lib/assistant.js';

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const twiml = (msg) => `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${xml(msg)}</Message>` : ''}</Response>`;

export function validTwilioSignature(url, params, signature, token) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, 'POST only');
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return send(res, 503, 'SMS not configured');

  const params = await readBody(req);
  const url = `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/api/sms`;
  if (!validTwilioSignature(url, params, req.headers['x-twilio-signature'], token)) {
    return send(res, 403, 'Invalid signature');
  }

  // Only staff phones listed in ALLOWED_SMS_NUMBERS (comma-separated, E.164) get answers.
  const allowed = (process.env.ALLOWED_SMS_NUMBERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(params.From)) {
    return send(res, 200, twiml(''), { 'Content-Type': 'text/xml' });
  }

  let reply;
  try {
    const r = await ask(params.Body || '');
    reply = r.reply;
    if (r.blocks.some((b) => b.type === 'confirm')) reply += '\n\nOpen the app to review and send that text.';
  } catch { reply = 'Sorry, I could not answer that right now.'; }
  send(res, 200, twiml(reply.slice(0, 1500)), { 'Content-Type': 'text/xml' });
}
