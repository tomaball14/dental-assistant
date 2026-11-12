import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, buildPracticeData, sampleExport, detectColumns, parseDate, parseTime, extractCodes } from '../public/import.js';
import { runWith, sanitize, merge } from '../lib/practice-data.js';
import { ask } from '../lib/assistant.js';
import { route } from '../lib/handler.js';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.STEDI_API_KEY;

test('value parsing', () => {
  assert.equal(parseDate('11/12/2026'), '2026-11-12');
  assert.equal(parseDate('Thursday, November 12, 2026'), '2026-11-12');
  assert.equal(parseDate('02391'), null);
  assert.equal(parseTime('9:30 AM'), '09:30');
  assert.equal(parseTime('2p'), '14:00');
  assert.deepEqual(extractCodes('02740, D2950 / 1110 2026'), ['D2740', 'D2950', 'D1110']);
});

test('column detection prefers specific fields', () => {
  const m = detectColumns(['Patient Name', 'Birth Date', 'Appt Date', 'Subscriber ID', 'Primary Insurance Carrier Name', 'Payer ID']);
  assert.equal(m.name, 0); assert.equal(m.dob, 1); assert.equal(m.date, 2);
  assert.equal(m.memberId, 3); assert.equal(m.carrier, 4); assert.equal(m.payerId, 5);
});

test('report-style export: title rows, date lines, continuation rows, repeated headers', () => {
  const csv = 'Daily Schedule\nPatient,Time,ADA Codes,Ins Company,Subscriber #,Payor ID\nNovember 12, 2026\n"Smith, Jane",8:00a,"01110, 00120",Delta Dental,123,DDVA1\n,,02391,,,\nPatient,Time,ADA Codes,Ins Company,Subscriber #,Payor ID\n"November 13, 2026"\n"Doe, John",10:00a,crown on 19,None,,\n';
  const r = buildPracticeData(parseCSV(csv));
  assert.equal(r.report.appointments, 2);
  assert.deepEqual(r.data.appointments[0].procedures.map((p) => p.code), ['D1110', 'D0120', 'D2391']);
  assert.equal(r.data.patients[1].insurance, null);
  const clean = sanitize(r.data);
  assert.deepEqual(clean.appointments[1].procedures, [{ code: 'D2740', tooth: '19', fee: null }]);
});

test('fee schedule file', () => {
  const r = buildPracticeData(parseCSV('Procedure Code,Description,Fee\nD1110,Prophy,$110.00\n02740,Crown,1250'));
  assert.equal(r.kind, 'fees');
  assert.deepEqual(r.fees, { D1110: 11000, D2740: 125000 });
  const merged = merge({ source: 'upload', patients: [], appointments: [] }, { kind: 'fees', fees: r.fees });
  assert.equal(merged.fees.D2740, 125000);
});

test('uploaded schedule drives the assistant; unchecked insurance is honest', async () => {
  const real = sanitize(buildPracticeData(parseCSV(sampleExport().replaceAll('Sample', 'Smith')), { source: 'upload' }).data);
  await runWith(real, async () => {
    const b = await ask('');
    assert.match(b.reply, /isn't checked yet/);
    assert.match((await ask('is jordan covered')).reply, /can't check it yet/);
    assert.match((await ask('crown on 3 for casey')).reply, /don't have your office fee/);
    assert.match((await ask('crown on 3 for casey $1,250')).reply, /full \$1,250/);
  });
});

test('hosted deploy refuses real patient data but allows the sample', async () => {
  process.env.VERCEL = '1';
  const handler = route(['POST'], async (req, res) => { res.statusCode = 200; res.end('ok'); });
  const call = async (practiceData) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handler({ method: 'POST', headers: {}, body: { practiceData } }, res);
    return res.statusCode;
  };
  const sample = buildPracticeData(parseCSV(sampleExport()), { source: 'sample' }).data;
  assert.equal(await call(sample), 200);
  assert.equal(await call({ ...sample, source: 'upload' }), 403);
  process.env.HIPAA_HOSTING_OK = 'true';
  process.env.APP_ACCESS_CODE = '';
  delete process.env.VERCEL; delete process.env.HIPAA_HOSTING_OK;
});
