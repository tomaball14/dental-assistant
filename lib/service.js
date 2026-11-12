// The operations every surface (web UI, chat, SMS) shares. Picks live
// NexHealth + Stedi when DATA_MODE=live, otherwise the demo practice.

import { demo } from './demo.js';
import { nexhealth } from './nexhealth.js';
import { stedi } from './stedi.js';
import { parseEligibility, summarize, flags } from './benefits.js';
import { estimate } from './estimate.js';
import { normalizeCode } from './cdt.js';

export const isLive = () => process.env.DATA_MODE === 'live';

function sources() {
  if (!isLive()) return { pms: demo, elig: demo };
  if (!nexhealth.configured()) throw new Error('DATA_MODE=live but NexHealth env vars are missing');
  if (!stedi.configured()) throw new Error('DATA_MODE=live but STEDI_API_KEY / PROVIDER_NPI are missing');
  return { pms: nexhealth, elig: stedi };
}

// Cache eligibility per patient for the life of a warm function (10 min) so the
// schedule and the assistant don't re-bill the clearinghouse for the same check.
const eligCache = new Map();
const TTL = 10 * 60 * 1000;

export async function getPatient(id) {
  const { pms } = sources();
  return pms.getPatient(id);
}

export async function findPatients(query) {
  const { pms } = sources();
  return pms.findPatients(query);
}

export async function verify(patientOrId) {
  const { elig } = sources();
  const patient = typeof patientOrId === 'string' ? await getPatient(patientOrId) : patientOrId;
  if (!patient) return { patient: null, benefits: null, summary: 'Patient not found', flags: ['not_found'] };
  if (!patient.insurance) {
    return { patient: publicPatient(patient), benefits: null, summary: 'No insurance on file (self-pay)', flags: ['no_insurance'] };
  }
  const hit = eligCache.get(patient.id);
  let raw;
  if (hit && Date.now() - hit.at < TTL) raw = hit.raw;
  else {
    raw = await elig.checkEligibility(patient);
    eligCache.set(patient.id, { at: Date.now(), raw });
  }
  const benefits = raw ? parseEligibility(raw) : null;
  return {
    patient: publicPatient(patient),
    benefits,
    summary: summarize(benefits),
    flags: flags(benefits),
    checkedAt: new Date().toISOString(),
  };
}

export async function schedule(days = 2) {
  const { pms } = sources();
  const appts = await pms.listAppointments(days);
  // Check each patient once, a few at a time to stay under payer rate limits.
  const ids = [...new Set(appts.map((a) => a.patientId))];
  const results = new Map();
  for (let i = 0; i < ids.length; i += 4) {
    const batch = ids.slice(i, i + 4);
    const done = await Promise.all(batch.map(async (id) => {
      try { return [id, await verify(id)]; }
      catch (e) { return [id, { patient: null, benefits: null, summary: `Check failed: ${e.message}`, flags: ['check_failed'] }]; }
    }));
    done.forEach(([id, v]) => results.set(id, v));
  }
  return appts
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map((a) => {
      const v = results.get(a.patientId);
      const est = estimate(fillFees(a.procedures), v?.benefits && v.patient?.hasInsurance ? v.benefits : null);
      return { ...a, patient: v?.patient, summary: v?.summary, flags: v?.flags || [], estimate: est.totals };
    });
}

export async function estimateFor(patientId, procedures) {
  const v = await verify(patientId);
  const procs = fillFees(procedures.map((p) => (typeof p === 'string' ? { code: p } : p)));
  const est = estimate(procs, v.patient?.hasInsurance ? v.benefits : null);
  return { ...v, estimate: est };
}

function fillFees(procs) {
  return procs.map((p) => {
    const code = normalizeCode(p.code) || p.code;
    const fee = p.fee != null && Number.isFinite(Number(p.fee)) ? Math.round(Number(p.fee)) : feeFor(code);
    return { ...p, code, fee: fee ?? 0, feeMissing: fee == null };
  });
}

function feeFor(code) {
  // Live mode: office fee schedule from FEE_SCHEDULE_JSON (e.g. {"D2740":1250}) in dollars.
  if (process.env.FEE_SCHEDULE_JSON) {
    try {
      const f = JSON.parse(process.env.FEE_SCHEDULE_JSON)[code];
      if (f != null) return Math.round(Number(f) * 100);
    } catch { /* ignore bad JSON */ }
  }
  return isLive() ? null : demo.fee(code);
}

// Only what the UI and assistant need; never member IDs or full DOB in lists.
function publicPatient(p) {
  return {
    id: p.id,
    name: `${p.firstName} ${p.lastName}`.trim(),
    firstName: p.firstName,
    payer: p.insurance?.payerName || null,
    hasInsurance: Boolean(p.insurance),
  };
}
