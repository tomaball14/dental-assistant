// Patient cost estimate: walks the treatment plan in order, applying the
// remaining deductible, the class percentage, and the remaining annual max.
// All money is integer cents.

import { classify, DEDUCTIBLE_APPLIES } from './cdt.js';
import { money } from './benefits.js';

export function estimate(procedures, benefits, { notChecked = false } = {}) {
  const warnings = [];
  const lines = [];
  let dedLeft = benefits?.deductible?.remaining ?? benefits?.deductible?.amount ?? 0;
  let maxLeft = benefits?.annualMax?.remaining ?? benefits?.annualMax?.amount ?? null; // null = unknown/unlimited
  let orthoLeft = benefits?.orthoMax?.remaining ?? benefits?.orthoMax?.amount ?? 0;
  const covered = benefits && benefits.active === true && !(benefits.errors?.length);

  if (!benefits) warnings.push(notChecked ? 'Insurance hasn\'t been checked yet, so this shows the full fee.' : 'No insurance on file. Estimate shows full fee.');
  else if (benefits.active === false) warnings.push('Coverage is inactive. Patient is responsible for the full fee.');
  else if (!covered) warnings.push('Coverage could not be confirmed. Estimate assumes no insurance payment.');
  if (covered && benefits.annualMax?.remaining == null && benefits.annualMax?.amount == null) {
    warnings.push('Payer did not report an annual maximum. Insurance amounts may be overstated.');
  }
  if (covered && ['preventive', 'basic', 'major'].some((c) => benefits.coverageSource?.[c] === 'default')) {
    warnings.push('Some coverage percentages were not in the payer response and use typical plan values (100/80/50).');
  }

  for (const p of procedures) {
    if (p.feeMissing) warnings.push(`No office fee for ${p.code}. Upload your fee schedule or enter the fee.`);
    const info = classify(p.code);
    const fee = Math.max(0, Math.round(Number(p.fee) || 0));
    if (!info) {
      warnings.push(`Unrecognized code "${p.code}". Counted as patient responsibility.`);
      lines.push({ code: String(p.code), name: 'Unknown', class: null, fee, deductible: 0, insurance: 0, patient: fee, tooth: p.tooth || null });
      continue;
    }
    let ins = 0;
    let dedApplied = 0;
    if (covered) {
      const pct = benefits.coverage?.[info.class] ?? 0;
      let base = fee;
      if (DEDUCTIBLE_APPLIES[info.class] && dedLeft > 0) {
        dedApplied = Math.min(dedLeft, base);
        dedLeft -= dedApplied;
        base -= dedApplied;
      }
      ins = Math.round(base * pct);
      if (info.class === 'ortho') {
        ins = Math.min(ins, orthoLeft);
        orthoLeft -= ins;
      } else if (maxLeft != null) {
        if (ins > maxLeft) warnings.push(maxLeft > 0 ? `Annual maximum runs out at ${info.code}; later procedures are full fee.` : 'Annual maximum is used up; procedures are full fee.');
        ins = Math.min(ins, maxLeft);
        maxLeft -= ins;
      }
    }
    lines.push({
      code: info.code, name: info.name, class: info.class, tooth: p.tooth || null,
      fee, deductible: dedApplied, insurance: ins, patient: fee - ins, feeMissing: Boolean(p.feeMissing),
    });
  }

  const total = (k) => lines.reduce((s, l) => s + l[k], 0);
  return {
    lines,
    totals: { fee: total('fee'), insurance: total('insurance'), patient: total('patient') },
    maxRemainingAfter: maxLeft,
    warnings: [...new Set(warnings)].filter((w, _, all) => !(w.startsWith('Annual maximum is used up') && all.some((x) => x.startsWith('Annual maximum runs out')))),
    disclaimer: 'Estimate only, based on the eligibility response and office fees. Final payment is determined by the insurance company when the claim is processed.',
  };
}

// Plain-language version for a text message to the patient.
export function estimateText(est, patientFirstName) {
  const head = patientFirstName ? `Hi ${patientFirstName}, here is your estimate:` : 'Your estimate:';
  const body = est.lines.map((l) => `${l.name}${l.tooth ? ` (#${l.tooth})` : ''}: ${money(l.patient)}`).join('\n');
  return `${head}\n${body}\nEstimated total you pay: ${money(est.totals.patient)}\n(Insurance est. ${money(est.totals.insurance)}.) This is an estimate; your plan makes the final determination.`;
}
