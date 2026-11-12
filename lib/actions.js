// Things the assistant can DO, always behind a one-tap confirmation.
// A proposed action travels to the browser as a signed token, so the server
// stays stateless and nobody can alter the recipient or text in between
// (the editable text is re-checked against the patient on confirm).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isLive, getPatient } from './service.js';
import { money } from './benefits.js';

const secret = () => process.env.ACTION_SECRET || process.env.APP_ACCESS_CODE || 'demo-only-secret';
const b64 = (s) => Buffer.from(s).toString('base64url');

export function signAction(payload, ttlMinutes = 30) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMinutes * 60000 }));
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAction(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return p.exp > Date.now() ? p : null;
}

const practice = () => process.env.PRACTICE_NAME || 'Danville Dental Care';
const officePhone = () => (process.env.OFFICE_PHONE ? ` Questions? Call us at ${process.env.OFFICE_PHONE}.` : '');

// Ready-to-send patient texts. Kept short and free of clinical jargon.
export const TEMPLATES = {
  estimate: ({ firstName, est }) =>
    `Hi ${firstName}, this is ${practice()}. For your upcoming visit, your estimated cost is ${money(est.totals.patient)} after insurance (insurance est. ${money(est.totals.insurance)}). This is an estimate; your plan makes the final decision.${officePhone()}`,
  new_card: ({ firstName }) =>
    `Hi ${firstName}, this is ${practice()}. We couldn't verify your dental insurance for your upcoming visit. Could you reply with a photo of the front and back of your current insurance card?${officePhone()}`,
  self_pay: ({ firstName, est }) =>
    `Hi ${firstName}, this is ${practice()}. We don't have dental insurance on file for you. If you have coverage, reply with a photo of your card. Otherwise your visit is estimated at ${money(est.totals.patient)}.${officePhone()}`,
};

export const KIND_LABEL = { estimate: 'estimate', new_card: 'insurance card request', self_pay: 'self-pay notice' };

export function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 4 ? `•••${d.slice(-4)}` : 'no phone on file';
}

// Build a confirm card for the chat.
export function proposeText(patient, kind, text) {
  return {
    type: 'confirm',
    title: `Text ${patient.firstName} the ${KIND_LABEL[kind] || 'message'}`,
    to: `${patient.name || `${patient.firstName} ${patient.lastName}`} at ${maskPhone(patient.phone)}`,
    text,
    token: signAction({ kind, patientId: patient.id }),
  };
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!r.ok) throw new Error('Text could not be sent');
}

// Execute a confirmed action. Returns a chat reply.
export async function confirmAction(token, editedText) {
  const a = verifyAction(token);
  if (!a) return { reply: 'That request expired. Ask me again and I\'ll redo it.' };
  const patient = await getPatient(a.patientId);
  if (!patient) return { reply: 'I couldn\'t find that patient anymore.' };
  const text = String(editedText || '').trim().slice(0, 640);
  if (!text) return { reply: 'The message was empty, so nothing was sent.' };

  const canSend = isLive() && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_FROM_NUMBER && patient.phone;
  if (!canSend) {
    return {
      reply: `Done (demo): this would have gone to ${patient.firstName} at ${maskPhone(patient.phone)}. Real texts start once texting is connected.`,
      done: true,
    };
  }
  await sendSms(patient.phone, text);
  return { reply: `Sent to ${patient.firstName} (${maskPhone(patient.phone)}).`, done: true };
}
