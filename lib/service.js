// The operations every surface (web UI, chat, SMS) shares. Data comes from, in
// order: an uploaded practice export, live NexHealth (DATA_MODE=live), or the
// demo practice. Eligibility comes from Stedi when configured.

import { demo } from './demo.js';
import { nexhealth } from './nexhealth.js';
import { stedi } from './stedi.js';
import { parseEligibility, summarize, flags } from './benefits.js';
import { estimate } from './estimate.js';
import { normalizeCode } from './cdt.js';
import { current, uploadSource } from './practice-data.js';

// "Live" = real patient data is in play (connected, office computer, or uploaded).
export const isLive = () => process.env.DATA_MODE === 'live' || Boolean(process.env.LOCAL_DATA_DIR)
  || Boolean(current() && current().source !== 'sample');

// Without a clearinghouse key we can still show the schedule; coverage just isn't checked.
const notConfigured = { async checkEligibility() { return { notConfigured: true }; } };
const sampleElig = { async checkEligibility(p) { return demo.samplePlan(p.id); } };
const sourceCache = new WeakMap();

function sources() {
  const data = current();
  if (data) {
    if (!sourceCache.has(data)) sourceCache.set(data, uploadSource(data));
    const elig = data.source === 'sample' ? sampleElig : stedi.configured() ? stedi : notConfigured;
    return { pms: sourceCache.get(data), elig };
  }
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

// The patient's next scheduled visit (used for "send her the estimate for this visit").
export async function nextAppointment(patientId, days = 14) {
  const { pms } = sources();
  const appts = await pms.listAppointments(days);
  return appts
    .filter((a) => a.patientId === patientId)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0] || null;
}

export async function verify(patientOrId) {
  const { elig } = sources();
  const patient = typeof patientOrId === 'string' ? await getPatient(patientOrId) : patientOrId;
  if (!patient) return { patient: null, benefits: null, summary: 'Patient not found', flags: ['not_found'] };
  if (!patient.insurance) {
    return { patient: publicPatient(patient), benefits: null, summary: 'No insurance on file (self-pay)', flags: ['no_insurance'] };
  }
  const key = `${current()?.source || 'pms'}|${patient.id}|${patient.insurance.payerId}|${patient.insurance.memberId}`;
  const hit = eligCache.get(key);
  let raw;
  if (hit && Date.now() - hit.at < TTL) raw = hit.raw;
  else {
    raw = await elig.checkEligibility(patient);
    if (!raw?.notConfigured) eligCache.set(key, { at: Date.now(), raw });
  }
  if (raw?.notConfigured) {
    return { patient: publicPatient(patient), benefits: null, summary: 'Insurance on file, not checked yet', flags: ['not_checked'] };
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
      const est = estimate(fillFees(a.procedures), v?.benefits && v.patient?.hasInsurance ? v.benefits : null, { notChecked: v?.flags?.includes('not_checked') });
      return {
        ...a, patient: v?.patient, summary: v?.summary, flags: v?.flags || [],
        maxLeft: v?.benefits?.annualMax?.remaining ?? null, estimate: est.totals,
      };
    });
}

export async function estimateFor(patientId, procedures) {
  const v = await verify(patientId);
  const procs = fillFees(procedures.map((p) => (typeof p === 'string' ? { code: p } : p)));
  const est = estimate(procs, v.patient?.hasInsurance ? v.benefits : null, { notChecked: v.flags.includes('not_checked') });
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
  const data = current();
  if (data?.fees?.[code] != null) return data.fees[code];
  // Live mode: office fee schedule from FEE_SCHEDULE_JSON (e.g. {"D2740":1250}) in dollars.
  if (process.env.FEE_SCHEDULE_JSON) {
    try {
      const f = JSON.parse(process.env.FEE_SCHEDULE_JSON)[code];
      if (f != null) return Math.round(Number(f) * 100);
    } catch { /* ignore bad JSON */ }
  }
  return isLive() || data ? null : demo.fee(code);
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
