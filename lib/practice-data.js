// Your own practice's schedule, from an uploaded Eaglesoft export.
//
// Two ways it can live:
//  - Office computer (LOCAL_DATA_DIR set): saved to a file on that computer, so
//    every phone on the office Wi-Fi sees the same schedule.
//  - Browser: kept in the browser tab and sent along with each request. Only
//    allowed on a hosted deploy once its HIPAA agreement is in place.
//
// The data is attached to the current request with AsyncLocalStorage, so the
// rest of the app reads it through the normal service functions.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeCode } from './cdt.js';
import { parseTreatment } from './procedures.js';

const als = new AsyncLocalStorage();
export const current = () => als.getStore() || null;
export const runWith = (data, fn) => als.run(data, fn);

const localDir = () => process.env.LOCAL_DATA_DIR || null;
const file = () => join(localDir(), 'practice-data.json');
export const storageMode = () => (localDir() ? 'server' : 'browser');

export function hostedRealDataAllowed() {
  return !process.env.VERCEL || process.env.HIPAA_HOSTING_OK === 'true';
}

const str = (v, n = 80) => (v == null ? null : String(v).slice(0, n).trim() || null);

// Never trust the shape of what arrives: clamp sizes, normalize codes, and turn
// free-text treatment ("crown on 19") into codes.
export function sanitize(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.appointments) || !Array.isArray(d.patients)) return null;
  const payerMap = (() => { try { return JSON.parse(process.env.PAYER_MAP_JSON || '{}'); } catch { return {}; } })();
  const patients = d.patients.slice(0, 1000).map((p) => {
    const ins = p.insurance && typeof p.insurance === 'object' ? p.insurance : null;
    const payerName = str(ins?.payerName);
    return {
      id: str(p.id, 40),
      firstName: str(p.firstName, 40) || '',
      lastName: str(p.lastName, 40) || '',
      dob: str(p.dob, 10),
      phone: str(p.phone, 20),
      insurance: ins ? {
        payerName,
        payerId: str(ins.payerId, 20) || (payerName && (payerMap[payerName] || payerMap[payerName.toLowerCase()])) || null,
        memberId: str(ins.memberId, 40),
        relationship: str(ins.relationship, 20),
        subscriber: ins.subscriber ? { firstName: str(ins.subscriber.firstName, 40), lastName: str(ins.subscriber.lastName, 40), dob: str(ins.subscriber.dob, 10) } : null,
      } : null,
    };
  }).filter((p) => p.id);
  const ids = new Set(patients.map((p) => p.id));
  const appointments = d.appointments.slice(0, 2000).filter((a) => ids.has(a.patientId)).map((a) => {
    const procs = (Array.isArray(a.procedures) ? a.procedures : []).slice(0, 30)
      .map((p) => ({ code: normalizeCode(p.code), tooth: str(p.tooth, 3), fee: Number.isFinite(p.fee) ? Math.round(p.fee) : null }))
      .filter((p) => p.code);
    if (!procs.length && a.treatmentText) {
      parseTreatment(String(a.treatmentText).slice(0, 300)).forEach((p) => procs.push({ code: p.code, tooth: p.tooth ? String(p.tooth) : null, fee: null }));
    }
    return { id: str(a.id, 40), date: str(a.date, 10), time: str(a.time, 5) || '', provider: str(a.provider, 40) || '', patientId: a.patientId, procedures: procs };
  });
  const fees = {};
  for (const [k, v] of Object.entries(d.fees && typeof d.fees === 'object' ? d.fees : {})) {
    const code = normalizeCode(k);
    if (code && Number.isFinite(v)) fees[code] = Math.round(v);
  }
  return {
    source: d.source === 'sample' ? 'sample' : 'upload',
    fileName: str(d.fileName, 120),
    importedAt: str(d.importedAt, 30),
    patients,
    appointments,
    fees,
  };
}

// ---------- office-computer storage ----------
export async function loadLocal() {
  if (!localDir()) return null;
  try { return sanitize(JSON.parse(await readFile(file(), 'utf8'))); } catch { return null; }
}
export async function saveLocal(data) {
  await mkdir(localDir(), { recursive: true });
  await writeFile(file(), JSON.stringify(data), { mode: 0o600 });
}
export async function clearLocal() {
  if (localDir()) await rm(file(), { force: true });
}

// Merge a newly imported piece: a schedule replaces the schedule, a fee
// schedule replaces fees, each keeps the other.
export function merge(existing, incoming) {
  if (!incoming) return existing;
  if (incoming.kind === 'fees') return { ...(existing || { source: 'upload', patients: [], appointments: [] }), fees: incoming.fees };
  return { ...incoming, fees: { ...(existing?.fees || {}), ...(incoming.fees || {}) } };
}

// ---------- the uploaded schedule as a data source ----------
const tz = () => process.env.PRACTICE_TIMEZONE || 'America/New_York';
const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: tz() });

export function uploadSource(data) {
  const byId = new Map(data.patients.map((p) => [p.id, p]));
  return {
    async listAppointments(days = 2) {
      const today = ymd(new Date());
      const last = ymd(new Date(Date.now() + days * 86400000));
      return data.appointments
        .filter((a) => a.date >= today && a.date <= last)
        .map((a) => ({ ...a, procedures: a.procedures.map((p) => ({ ...p })) }));
    },
    async getPatient(id) {
      const p = byId.get(id);
      return p ? { ...p } : null;
    },
    async findPatients(query) {
      const parts = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return [];
      return data.patients.filter((p) => {
        const words = `${p.firstName} ${p.lastName}`.toLowerCase().split(' ');
        return parts.every((part) => words.some((w) => w.startsWith(part)));
      });
    },
  };
}

export function summary(data) {
  if (!data) return null;
  const dates = data.appointments.map((a) => a.date).sort();
  return {
    source: data.source,
    fileName: data.fileName,
    importedAt: data.importedAt,
    appointments: data.appointments.length,
    patients: data.patients.length,
    dateFrom: dates[0] || null,
    dateTo: dates.at(-1) || null,
    fees: Object.keys(data.fees || {}).length,
  };
}
