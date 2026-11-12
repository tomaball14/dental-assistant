// Turns an X12 271 eligibility response (Stedi JSON shape) into the handful of
// numbers a front desk actually needs.

import { STC_CLASS, STC_GENERAL_DENTAL, CLASSES, DEFAULT_COVERAGE } from './cdt.js';

const toCents = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const toPct = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n; // payers send "0.2" or occasionally "20"
};

// Prefer in-network, individual-level rows; fall back to anything.
function rank(b) {
  let score = 0;
  if (b.inPlanNetworkIndicatorCode === 'Y') score += 4;
  else if (b.inPlanNetworkIndicatorCode === 'W' || !b.inPlanNetworkIndicatorCode) score += 2;
  if (!b.coverageLevelCode || b.coverageLevelCode === 'IND') score += 2;
  return score;
}
function best(rows) {
  return rows.length ? [...rows].sort((a, b) => rank(b) - rank(a))[0] : null;
}

const isYear = (q) => q === '23' || q === '24' || q === '25'; // calendar / service / policy year
const isRemaining = (q) => q === '29';
const isLifetime = (q) => q === '32' || q === '33';

export function parseEligibility(resp) {
  const rows = Array.isArray(resp?.benefitsInformation) ? resp.benefitsInformation : [];
  const stcs = (b) => (Array.isArray(b.serviceTypeCodes) ? b.serviceTypeCodes : []);
  const touchesDental = (b) =>
    stcs(b).length === 0 || stcs(b).some((c) => c === STC_GENERAL_DENTAL || c === '30' || STC_CLASS[c]);

  const out = {
    active: null,
    payer: resp?.payer?.name || null,
    planName: resp?.planInformation?.groupDescription || resp?.planInformation?.planDescription || null,
    memberId: resp?.subscriber?.memberId || null,
    planBegin: resp?.planDateInformation?.planBegin || resp?.planDateInformation?.eligibilityBegin || null,
    deductible: { amount: null, remaining: null },
    annualMax: { amount: null, remaining: null },
    orthoMax: { amount: null, remaining: null },
    coverage: {}, // class -> share insurance pays (0..1)
    coverageSource: {}, // class -> 'payer' | 'default'
    notes: [],
    errors: [],
  };

  // Active / inactive
  const planStatus = Array.isArray(resp?.planStatus) ? resp.planStatus : [];
  if (planStatus.some((s) => s.statusCode === '1')) out.active = true;
  if (rows.some((b) => b.code === '1' && touchesDental(b))) out.active = true;
  if (out.active === null && (rows.some((b) => b.code === '6') || planStatus.some((s) => s.statusCode === '6'))) {
    out.active = false;
  }

  // Payer-reported errors (bad member ID, subscriber not found, etc.)
  for (const e of Array.isArray(resp?.errors) ? resp.errors : []) {
    out.errors.push(e.description || e.code || 'Payer returned an error');
  }

  // Deductible (code C)
  const ded = rows.filter((b) => b.code === 'C' && touchesDental(b));
  out.deductible.amount = toCents(best(ded.filter((b) => isYear(b.timeQualifierCode)))?.benefitAmount);
  out.deductible.remaining = toCents(best(ded.filter((b) => isRemaining(b.timeQualifierCode)))?.benefitAmount);

  // Annual / ortho maximums (code F = limitations)
  const lim = rows.filter((b) => b.code === 'F');
  const isOrtho = (b) => stcs(b).includes('38');
  const general = lim.filter((b) => !isOrtho(b) && touchesDental(b));
  out.annualMax.amount = toCents(best(general.filter((b) => isYear(b.timeQualifierCode)))?.benefitAmount);
  out.annualMax.remaining = toCents(best(general.filter((b) => isRemaining(b.timeQualifierCode)))?.benefitAmount);
  const ortho = lim.filter(isOrtho);
  out.orthoMax.amount = toCents(best(ortho.filter((b) => isLifetime(b.timeQualifierCode) || isYear(b.timeQualifierCode)))?.benefitAmount);
  out.orthoMax.remaining = toCents(best(ortho.filter((b) => isRemaining(b.timeQualifierCode)))?.benefitAmount);

  // Co-insurance (code A): benefitPercent is the PATIENT's share.
  const coins = rows.filter((b) => b.code === 'A' && b.benefitPercent != null);
  const general35 = best(coins.filter((b) => stcs(b).includes(STC_GENERAL_DENTAL)));
  for (const cls of CLASSES) {
    const row = best(coins.filter((b) => stcs(b).some((c) => STC_CLASS[c] === cls)));
    const pick = row || general35;
    const patientShare = pick ? toPct(pick.benefitPercent) : null;
    if (patientShare != null) {
      out.coverage[cls] = Math.max(0, Math.min(1, 1 - patientShare));
      out.coverageSource[cls] = 'payer';
    } else {
      out.coverage[cls] = cls === 'ortho' && out.orthoMax.amount == null ? 0 : DEFAULT_COVERAGE[cls];
      out.coverageSource[cls] = 'default';
    }
  }

  // Frequency limits, waiting periods, missing-tooth clauses come back as free text.
  for (const b of rows) {
    for (const a of Array.isArray(b.additionalInformation) ? b.additionalInformation : []) {
      if (a?.description && out.notes.length < 12) out.notes.push(a.description.slice(0, 160));
    }
  }

  return out;
}

const money = (c) => (c == null ? '?' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);

// One-line status the schedule and the texting assistant both use.
export function summarize(b) {
  if (!b) return 'Not checked';
  if (b.errors?.length) return `Check failed: ${b.errors[0]}`;
  if (b.active === false) return 'Coverage INACTIVE';
  if (b.active !== true) return 'Coverage status unclear, call payer';
  const parts = ['Active'];
  if (b.annualMax.remaining != null) parts.push(`${money(b.annualMax.remaining)} max left`);
  if (b.deductible.remaining != null) parts.push(b.deductible.remaining > 0 ? `${money(b.deductible.remaining)} deductible left` : 'deductible met');
  const pct = (c) => `${Math.round((b.coverage[c] ?? 0) * 100)}`;
  parts.push(`${pct('preventive')}/${pct('basic')}/${pct('major')}`);
  return parts.join(' · ');
}

// Flags a front desk should act on before the patient sits down.
export function flags(b) {
  const f = [];
  if (!b) return ['not_checked'];
  if (b.errors?.length) f.push('check_failed');
  if (b.active === false) f.push('inactive');
  if (b.active == null && !b.errors?.length) f.push('unclear');
  if (b.annualMax.remaining != null && b.annualMax.remaining <= 20000) f.push('low_max');
  if (b.active === true && ['preventive', 'basic', 'major'].some((c) => b.coverageSource[c] === 'default')) f.push('assumed_percentages');
  return f;
}

export { money };
