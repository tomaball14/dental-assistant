import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/cdt.js';
import { parseEligibility, summarize, flags } from '../lib/benefits.js';
import { estimate } from '../lib/estimate.js';
import { schedule, estimateFor, verify } from '../lib/service.js';
import { ask } from '../lib/assistant.js';
import { validTwilioSignature } from '../api/sms.js';
import { createHmac } from 'node:crypto';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.DATA_MODE;

test('classifies CDT codes', () => {
  assert.equal(classify('D1110').class, 'preventive');
  assert.equal(classify('2740').class, 'major');
  assert.equal(classify('d2391').class, 'basic');
  assert.equal(classify('D3330').class, 'basic');
  assert.equal(classify('D8080').class, 'ortho');
  assert.equal(classify('X99'), null);
});

const plan = {
  planStatus: [{ statusCode: '1' }],
  benefitsInformation: [
    { code: '1', serviceTypeCodes: ['35'] },
    { code: 'C', serviceTypeCodes: ['35'], timeQualifierCode: '23', benefitAmount: '50', inPlanNetworkIndicatorCode: 'Y' },
    { code: 'C', serviceTypeCodes: ['35'], timeQualifierCode: '29', benefitAmount: '50', inPlanNetworkIndicatorCode: 'Y' },
    { code: 'C', serviceTypeCodes: ['35'], timeQualifierCode: '29', benefitAmount: '100', inPlanNetworkIndicatorCode: 'N' },
    { code: 'F', serviceTypeCodes: ['35'], timeQualifierCode: '23', benefitAmount: '1500', inPlanNetworkIndicatorCode: 'Y' },
    { code: 'F', serviceTypeCodes: ['35'], timeQualifierCode: '29', benefitAmount: '1000', inPlanNetworkIndicatorCode: 'Y' },
    { code: 'A', serviceTypeCodes: ['41'], benefitPercent: '0', inPlanNetworkIndicatorCode: 'Y' },
    { code: 'A', serviceTypeCodes: ['25'], benefitPercent: '0.2', inPlanNetworkIndicatorCode: 'Y' },
    { code: 'A', serviceTypeCodes: ['36'], benefitPercent: '0.5', inPlanNetworkIndicatorCode: 'Y' },
    { code: 'A', serviceTypeCodes: ['36'], benefitPercent: '0.7', inPlanNetworkIndicatorCode: 'N' },
  ],
};

test('parses a 271 preferring in-network rows', () => {
  const b = parseEligibility(plan);
  assert.equal(b.active, true);
  assert.equal(b.deductible.remaining, 5000);
  assert.equal(b.annualMax.amount, 150000);
  assert.equal(b.annualMax.remaining, 100000);
  assert.equal(b.coverage.preventive, 1);
  assert.equal(b.coverage.basic, 0.8);
  assert.equal(b.coverage.major, 0.5);
  assert.equal(b.coverageSource.major, 'payer');
  assert.match(summarize(b), /Active · \$1,000 max left · \$50 deductible left · 100\/80\/50/);
});

test('detects inactive coverage and payer errors', () => {
  assert.equal(parseEligibility({ benefitsInformation: [{ code: '6', serviceTypeCodes: ['35'] }] }).active, false);
  const e = parseEligibility({ errors: [{ description: 'Invalid Member ID' }] });
  assert.ok(flags(e).includes('check_failed'));
});

test('estimate applies deductible, percentage and max in order', () => {
  const b = parseEligibility(plan);
  const e = estimate([{ code: 'D1110', fee: 11000 }, { code: 'D2391', fee: 18500 }, { code: 'D2740', fee: 125000 }], b);
  // Cleaning: no deductible, 100% -> ins 110
  assert.equal(e.lines[0].insurance, 11000);
  // Filling: $50 deductible, then 80% of $135 = $108
  assert.equal(e.lines[1].deductible, 5000);
  assert.equal(e.lines[1].insurance, 10800);
  // Crown: 50% of $1250 = $625, but only $1000 - 110 - 108 = $782 max left -> $625 fits
  assert.equal(e.lines[2].insurance, 62500);
  assert.equal(e.totals.patient, 11000 + 18500 + 125000 - 11000 - 10800 - 62500);
  assert.equal(e.maxRemainingAfter, 100000 - 11000 - 10800 - 62500);
});

test('estimate caps at the annual max and warns', () => {
  const b = parseEligibility({ ...plan, benefitsInformation: plan.benefitsInformation.map((r) => r.code === 'F' && r.timeQualifierCode === '29' ? { ...r, benefitAmount: '100' } : r) });
  const e = estimate([{ code: 'D2740', fee: 125000 }], b);
  assert.equal(e.lines[0].insurance, 10000);
  assert.ok(e.warnings.some((w) => /maximum runs out/.test(w)));
});

test('no insurance means full fee', () => {
  const e = estimate([{ code: 'D0150', fee: 11000 }], null);
  assert.equal(e.totals.patient, 11000);
});

test('demo schedule flags the right patients', async () => {
  const s = await schedule(2);
  assert.equal(s.length, 6);
  const by = Object.fromEntries(s.map((a) => [a.patient.name, a]));
  assert.ok(by['Devon Price'].flags.includes('inactive'));
  assert.ok(by['Tom Whitfield'].flags.includes('check_failed'));
  assert.ok(by['Rosa Jennings'].flags.includes('low_max'));
  assert.ok(by['Ellen Okafor'].flags.includes('no_insurance'));
  assert.deepEqual(by['Linda Marsh'].flags, []);
  assert.equal(by['Linda Marsh'].estimate.patient, 0);
});

test('demo crown estimate for Marcus Hale', async () => {
  const r = await estimateFor('p2', ['D2740', 'D2950']);
  // $50 deductible on crown, 50% of $1200 = $600; buildup 50% of $300 = $150
  assert.equal(r.estimate.totals.insurance, 60000 + 15000);
  assert.equal(r.estimate.totals.patient, 155000 - 75000);
});

test('verify unknown patient', async () => {
  const v = await verify('nope');
  assert.deepEqual(v.flags, ['not_found']);
});

test('keyword assistant answers without an API key', async () => {
  assert.match(await ask('Who needs attention tomorrow?'), /need attention/);
  assert.match(await ask('Is Marcus Hale covered for a crown?'), /Marcus Hale/);
  assert.match(await ask('Estimate D3330 for Rosa Jennings'), /Est\. patient total/);
});

test('Twilio signature check', () => {
  const url = 'https://example.com/api/sms';
  const params = { Body: 'hi', From: '+15555550100' };
  const sig = createHmac('sha1', 'tok').update(url + 'Bodyhi' + 'From+15555550100').digest('base64');
  assert.equal(validTwilioSignature(url, params, sig, 'tok'), true);
  assert.equal(validTwilioSignature(url, params, sig, 'other'), false);
});
