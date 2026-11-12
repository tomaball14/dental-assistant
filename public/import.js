// Reads a schedule export from the practice software (built for Eaglesoft, works
// with most CSV/Excel exports) entirely in the browser, and turns it into
// appointments + patients. Shared with the server tests, so: no DOM, no Node APIs.

// ---------- CSV ----------
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  const delim = sniffDelimiter(s);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((v) => v.trim())).filter((r) => r.some((v) => v !== ''));
}

function sniffDelimiter(s) {
  const head = s.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  for (const ch of head) if (ch in counts) counts[ch]++;
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n ? best : ',';
}

// ---------- columns ----------
const norm = (h) => String(h || '').toLowerCase().replace(/[#]/g, ' number ').replace(/[^a-z0-9]+/g, ' ').trim();

// Order matters: specific fields claim their columns before generic ones.
export const FIELDS = [
  ['subscriberDob', 'Subscriber birth date', ['subscriber birth date', 'subscriber dob', 'insured dob', 'insured birth date', 'policy holder dob', 'subscriber birthdate']],
  ['dob', 'Patient birth date', ['birth date', 'birthdate', 'dob', 'date of birth', 'birthday', 'patient birth date', 'patient dob']],
  ['payerId', 'Payer ID', ['payer id', 'payor id', 'payerid', 'payorid', 'electronic payer id', 'claim payer id', 'eligibility payer id', 'edi payer id', 'payer number']],
  ['memberId', 'Member / subscriber ID', ['subscriber id', 'member id', 'ins id', 'insurance id', 'insured id', 'subscriber number', 'id number', 'member number', 'policy number', 'sub id', 'subscriber id number', 'subscriber ssn id']],
  ['subscriber', 'Subscriber name', ['subscriber', 'subscriber name', 'insured', 'insured name', 'policy holder', 'policyholder', 'primary subscriber', 'responsible party']],
  ['relationship', 'Relationship to subscriber', ['relationship', 'relation', 'relation to subscriber', 'rel', 'relationship to insured', 'relationship to subscriber']],
  ['carrier', 'Insurance company', ['primary insurance', 'insurance', 'carrier', 'primary carrier', 'insurance company', 'ins company', 'prim ins', 'primary ins', 'dental insurance', 'insurance name', 'carrier name', 'ins carrier', 'primary insurance carrier', 'employer insurance']],
  ['firstName', 'First name', ['first name', 'first', 'patient first name', 'fname', 'given name']],
  ['lastName', 'Last name', ['last name', 'last', 'patient last name', 'lname', 'surname']],
  ['name', 'Patient name', ['patient', 'patient name', 'name', 'pt name', 'patient full name', 'full name']],
  ['date', 'Appointment date', ['date', 'appt date', 'appointment date', 'sched date', 'scheduled date', 'appt dt', 'day', 'service date', 'date scheduled']],
  ['time', 'Appointment time', ['time', 'appt time', 'appointment time', 'start time', 'start', 'begin time', 'scheduled time']],
  ['provider', 'Provider', ['provider', 'prov', 'doctor', 'dr', 'provider name', 'primary provider', 'scheduled provider']],
  ['codes', 'Procedures', ['procedures', 'procedure', 'procedure codes', 'procedure code', 'ada code', 'ada codes', 'codes', 'code', 'services', 'scheduled procedures', 'service code', 'treatment', 'scheduled services', 'appt procedures', 'description', 'reason']],
  ['tooth', 'Tooth', ['tooth', 'teeth', 'th', 'tooth number', 'tooth number number', 'tooth no']],
  ['fee', 'Fee', ['fee', 'amount', 'charge', 'fee amount', 'procedure fee', 'ucr', 'standard fee', 'office fee', 'scheduled fee']],
  ['phone', 'Cell phone', ['cell', 'cell phone', 'mobile', 'mobile phone', 'wireless', 'text', 'cell number', 'phone', 'home phone', 'phone number', 'primary phone']],
];
export const FIELD_LABEL = Object.fromEntries(FIELDS.map(([k, label]) => [k, label]));

export function detectColumns(headers) {
  const h = headers.map(norm);
  const map = {};
  const used = new Set();
  // Pass 1: exact names. Pass 2: a header that contains a synonym ("Primary Insurance Carrier Name").
  for (const exact of [true, false]) {
    for (const [field, , syns] of FIELDS) {
      if (map[field] != null) continue;
      for (const syn of syns) {
        const i = h.findIndex((x, idx) => !used.has(idx) && x && (exact ? x === syn : syn.length > 3 && (` ${x} `).includes(` ${syn} `)));
        if (i >= 0) { map[field] = i; used.add(i); break; }
      }
    }
  }
  return map;
}

// Exports often start with a report title; find the row that looks like headers.
export function findHeaderRow(rows) {
  let best = { index: 0, score: 0 };
  rows.slice(0, 25).forEach((r, index) => {
    const score = Object.keys(detectColumns(r)).length;
    if (score > best.score) best = { index, score };
  });
  return best.score >= 2 ? best.index : -1;
}

// ---------- values ----------
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

export function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += y > 50 ? 1900 : 2000;
    return `${y}-${pad(m[1])}-${pad(m[2])}`;
  }
  m = s.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 60000) { // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return null;
}

export function parseTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  const s = String(v).trim().toLowerCase();
  if (/^0?\.\d+$/.test(s)) { // Excel fraction of a day
    const mins = Math.round(Number(s) * 1440);
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  }
  let m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m?\.?\b/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === 'p') h += 12;
    return `${pad(h)}:${m[2] || '00'}`;
  }
  m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) return `${pad(m[1])}:${m[2]}`;
  m = s.match(/^(\d{1,2})(\d{2})$/);
  if (m && Number(m[1]) < 24) return `${pad(m[1])}:${m[2]}`;
  return null;
}

// "D2740", "2740", and Eaglesoft's older 5-digit "02740" all become D2740.
export function extractCodes(v) {
  const out = [];
  for (const m of String(v || '').toUpperCase().matchAll(/\b(?:D(\d{4})|0(\d{4})|(\d{4}))\b/g)) {
    if (m[1] || m[2]) out.push(`D${m[1] || m[2]}`);
    else if (!/^(19|20)\d{2}$/.test(m[3])) out.push(`D${m[3]}`); // a bare 4-digit year isn't a code
  }
  return out;
}

export function parseMoney(v) {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n * 100) : null;
}

export function splitName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) return { firstName: '', lastName: '' };
  if (s.includes(',')) {
    const [last, rest] = s.split(',', 2).map((x) => x.trim());
    return { firstName: (rest || '').split(' ')[0], lastName: last };
  }
  const parts = s.split(' ');
  return { firstName: parts[0], lastName: parts.length > 1 ? parts[parts.length - 1] : '' };
}

const title = (s) => String(s || '').toLowerCase().replace(/(^|[\s'-])\S/g, (c) => c.toUpperCase());

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---------- build ----------
// rows: array of arrays (header row included). mapping: optional override {field: columnIndex}.
export function buildPracticeData(rows, { mapping, fileName = '', source = 'upload' } = {}) {
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) {
    return { error: 'I couldn\'t find column headings in that file. Export the report as a spreadsheet (CSV or Excel) with headings like Patient, Date, Time and Procedures.' };
  }
  const headers = rows[headerIndex];
  const map = mapping || detectColumns(headers);
  const col = (r, f) => (map[f] != null ? r[map[f]] ?? '' : '');

  // A file of codes + fees and no patients is a fee schedule.
  if (map.codes != null && map.fee != null && map.name == null && map.lastName == null) {
    const fees = {};
    for (const r of rows.slice(headerIndex + 1)) {
      const [code] = extractCodes(col(r, 'codes'));
      const fee = parseMoney(col(r, 'fee'));
      if (code && fee != null) fees[code] = fee;
    }
    return { kind: 'fees', fees, headers, mapping: map, report: { fees: Object.keys(fees).length } };
  }

  const patients = new Map();
  const appts = new Map();
  let carryDate = null;
  let lastAppt = null;
  const report = { rows: 0, skipped: 0 };

  for (const r of rows.slice(headerIndex + 1)) {
    // Report-style exports put the date on its own line ("Thursday, November 12, 2026").
    const filled = r.filter((v) => v !== '');
    const joined = filled.join(', ');
    if (filled.length <= 3 && /[a-z]{3}|\d[/-]\d/i.test(filled[0] || '') && parseDate(joined)) { carryDate = parseDate(joined); continue; }
    if (norm(r.join(' ')) === norm(headers.join(' '))) continue; // repeated header on each page

    let { firstName, lastName } = map.name != null ? splitName(col(r, 'name')) : { firstName: col(r, 'firstName'), lastName: col(r, 'lastName') };
    const date = parseDate(col(r, 'date')) || carryDate;
    const codes = extractCodes(col(r, 'codes'));

    // Row-per-procedure exports leave the patient blank on continuation rows:
    // those procedures belong to the appointment just above.
    if (!firstName && !lastName) {
      if (lastAppt && codes.length) {
        const tooth = col(r, 'tooth').replace(/[^\d]/g, '') || null;
        const fee = parseMoney(col(r, 'fee'));
        codes.forEach((code) => lastAppt.procedures.push({ code, tooth, fee: codes.length === 1 ? fee : null }));
      } else report.skipped++;
      continue;
    }
    if (!date) { report.skipped++; continue; }
    report.rows++;

    const dob = parseDate(col(r, 'dob'));
    const pid = `u${hash(`${lastName}|${firstName}|${dob || ''}`.toLowerCase())}`;
    if (!patients.has(pid)) {
      const carrier = col(r, 'carrier');
      const memberId = col(r, 'memberId');
      const sub = splitName(col(r, 'subscriber'));
      const noIns = !carrier && !memberId || /^(none|self ?pay|cash|no insurance|n\/a)$/i.test(carrier);
      patients.set(pid, {
        id: pid,
        firstName: title(firstName),
        lastName: title(lastName),
        dob,
        phone: col(r, 'phone').replace(/[^\d+]/g, '') || null,
        insurance: noIns ? null : {
          payerName: carrier || null,
          payerId: col(r, 'payerId') || null,
          memberId: memberId || null,
          relationship: col(r, 'relationship') || null,
          subscriber: sub.lastName ? { firstName: title(sub.firstName), lastName: title(sub.lastName), dob: parseDate(col(r, 'subscriberDob')) } : null,
        },
      });
    }

    const time = parseTime(col(r, 'time')) || '';
    const key = `${pid}|${date}|${time}`;
    if (!appts.has(key)) {
      appts.set(key, { id: `a${hash(key)}`, date, time, provider: col(r, 'provider'), patientId: pid, procedures: [], treatmentText: '' });
    }
    const a = appts.get(key);
    lastAppt = a;
    const tooth = col(r, 'tooth').replace(/[^\d]/g, '') || null;
    const fee = parseMoney(col(r, 'fee'));
    codes.forEach((code) => a.procedures.push({ code, tooth, fee: codes.length === 1 ? fee : null }));
    if (!codes.length && col(r, 'codes')) a.treatmentText = [a.treatmentText, col(r, 'codes')].filter(Boolean).join(', ');
  }

  const appointments = [...appts.values()];
  const pts = [...patients.values()];
  const dates = appointments.map((a) => a.date).sort();
  return {
    kind: 'schedule',
    headers,
    mapping: map,
    data: { version: 1, source, fileName, importedAt: new Date().toISOString(), appointments, patients: pts },
    report: {
      ...report,
      appointments: appointments.length,
      patients: pts.length,
      dateFrom: dates[0] || null,
      dateTo: dates.at(-1) || null,
      insured: pts.filter((p) => p.insurance).length,
      missingPayerId: pts.filter((p) => p.insurance && !p.insurance.payerId).length,
      missingMemberId: pts.filter((p) => p.insurance && !p.insurance.memberId).length,
      noProcedures: appointments.filter((a) => !a.procedures.length && !a.treatmentText).length,
      missingFields: ['date', 'codes', 'carrier', 'memberId', 'payerId', 'dob', 'phone'].filter((f) => map[f] == null && !(f === 'date' && dates.length)),
    },
  };
}

// A fake Eaglesoft-style export dated tomorrow, to try the flow without real data.
export function sampleExport(today = new Date()) {
  const d = new Date(today.getTime() + 86400000);
  const md = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  return [
    'Appointment List',
    `Printed ${today.toLocaleDateString('en-US')}`,
    '',
    'Patient Name,Birth Date,Appt Date,Time,Provider,Procedure Code,Tooth,Fee,Primary Insurance,Payer ID,Subscriber ID,Cell Phone',
    `"Sample, Alex",03/14/1980,${md},8:00 AM,DDS,D0120,,65.00,Sample Dental PPO,SAMPLE1,SAMP001,5555550201`,
    `"Sample, Alex",03/14/1980,${md},8:00 AM,DDS,D1110,,110.00,Sample Dental PPO,SAMPLE1,SAMP001,5555550201`,
    `"Test, Jordan",07/02/1975,${md},9:30 AM,DDS,D2740,14,1250.00,Sample Dental PPO,SAMPLE1,SAMP002,5555550202`,
    `"Test, Jordan",07/02/1975,${md},9:30 AM,DDS,D2950,14,300.00,Sample Dental PPO,SAMPLE1,SAMP002,5555550202`,
    `"Demo, Casey",11/20/1990,${md},1:00 PM,DDS,D0150,,110.00,,,,5555550203`,
  ].join('\n');
}
