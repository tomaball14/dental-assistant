import { timingSafeEqual } from 'node:crypto';
import { isLive } from './service.js';

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  const isText = typeof body === 'string';
  res.setHeader('Content-Type', headers['Content-Type'] || (isText ? 'text/plain; charset=utf-8' : 'application/json'));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(isText ? body : JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return parse(req.body, req.headers['content-type']);
    if (Buffer.isBuffer(req.body)) return parse(req.body.toString('utf8'), req.headers['content-type']);
    return req.body || {};
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new Error('Body too large');
    chunks.push(c);
  }
  return parse(Buffer.concat(chunks).toString('utf8'), req.headers['content-type']);
}

function parse(text, type = '') {
  if (!text) return {};
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return {}; }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

// Staff access code. Required in live mode; optional for the demo.
export function authorize(req, res) {
  const code = process.env.APP_ACCESS_CODE;
  if (!code) {
    if (isLive()) {
      send(res, 503, { error: 'APP_ACCESS_CODE must be set before using live patient data.' });
      return false;
    }
    return true;
  }
  const given = req.headers['x-access-code'] || '';
  if (!safeEqual(given, code)) {
    send(res, 401, { error: 'Access code required' });
    return false;
  }
  return true;
}

// Errors go to the client generically; details stay out of logs (may contain PHI).
export function fail(res, e) {
  console.error('request failed:', e?.name || 'Error');
  send(res, 500, { error: e?.message?.startsWith('DATA_MODE=live') ? e.message : 'Something went wrong. Try again.' });
}
