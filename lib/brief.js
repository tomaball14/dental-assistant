// The message the assistant opens with: what needs attention before patients
// arrive, each problem with a one-tap fix.

import { schedule } from './service.js';
import { money } from './benefits.js';

const TZ = () => process.env.PRACTICE_TIMEZONE || 'America/New_York';

export function dayLabel(dateStr, now = new Date()) {
  const today = now.toLocaleDateString('en-CA', { timeZone: TZ() });
  const tomorrow = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: TZ() });
  if (dateStr === today) return 'today';
  if (dateStr === tomorrow) return 'tomorrow';
  return new Date(`${dateStr}T12:00`).toLocaleDateString('en-US', { weekday: 'long' });
}

const timeLabel = (t) => {
  const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}${m[2] === '00' ? '' : `:${m[2]}`}${h < 12 ? 'am' : 'pm'}`;
};

// Turn one flagged appointment into a sentence + the button that fixes it.
function problem(a) {
  const first = a.patient?.firstName || 'Patient';
  const when = `${dayLabel(a.date)} ${timeLabel(a.time)}`;
  const f = a.flags;
  if (f.includes('inactive')) {
    return { line: `${first} (${when}): coverage is inactive.`, action: { label: `Ask ${first} for a new card`, prompt: `Text ${a.patient.name} asking for a new insurance card` } };
  }
  if (f.includes('check_failed')) {
    return { line: `${first} (${when}): the payer rejected the member ID.`, action: { label: `Ask ${first} for a new card`, prompt: `Text ${a.patient.name} asking for a new insurance card` } };
  }
  if (f.includes('no_insurance')) {
    return { line: `${first} (${when}): no insurance on file, about ${money(a.estimate.patient)} self-pay.`, action: { label: `Text ${first} about self-pay`, prompt: `Text ${a.patient.name} the self-pay notice` } };
  }
  if (f.includes('low_max')) {
    return { line: `${first} (${when}): only ${money(a.maxLeft)} of insurance left this year, so the visit is about ${money(a.estimate.patient)} out of pocket.`, action: { label: `Send ${first} the estimate`, prompt: `Send ${a.patient.name} the estimate for this visit` } };
  }
  if (f.includes('unclear')) {
    return { line: `${first} (${when}): the payer response was unclear; worth a quick call.`, action: { label: `What do I ask the payer?`, prompt: `What should I ask ${a.patient.name}'s insurance on the phone?` } };
  }
  return null;
}

export async function buildBrief(days = 2) {
  const appts = await schedule(days);
  if (!appts.length) {
    return { reply: 'Nothing on the schedule for the next couple of days. Ask me anything about a patient or a treatment cost.', actions: [], context: {} };
  }
  const problems = appts.map((a) => ({ a, p: problem(a) })).filter((x) => x.p);
  const clear = appts.length - problems.length;
  const bigBills = appts.filter((a) => !problems.some((x) => x.a === a) && a.estimate.patient >= 30000);

  const firstDay = dayLabel(appts[0].date);
  const lines = [];
  lines.push(problems.length
    ? `${appts.length} patients coming in, starting ${firstDay}. ${problems.length} need${problems.length === 1 ? 's' : ''} attention:`
    : `${appts.length} patients coming in, starting ${firstDay}. Insurance checks out for everyone.`);
  problems.forEach(({ p }) => lines.push(`• ${p.line}`));
  if (bigBills.length) {
    lines.push('');
    lines.push(`Heads up on cost: ${bigBills.map((a) => `${a.patient.firstName} will owe about ${money(a.estimate.patient)}`).join('; ')}.`);
  }
  if (problems.length && clear) lines.push('', `The other ${clear} are verified and good to go.`);

  const actions = problems.map(({ p }) => p.action);
  bigBills.slice(0, 2).forEach((a) => actions.push({ label: `Send ${a.patient.firstName} the estimate`, prompt: `Send ${a.patient.name} the estimate for this visit` }));
  actions.push({ label: 'Show full schedule', prompt: 'Show me the full schedule' });

  return { reply: lines.join('\n'), actions: dedupe(actions).slice(0, 5), context: {} };
}

function dedupe(actions) {
  const seen = new Set();
  return actions.filter((a) => (seen.has(a.label) ? false : seen.add(a.label)));
}

export function scheduleText(appts) {
  let day = null;
  const out = [];
  for (const a of appts) {
    if (a.date !== day) {
      day = a.date;
      const label = dayLabel(a.date);
      out.push(`${out.length ? '\n' : ''}${label[0].toUpperCase()}${label.slice(1)}:`);
    }
    const mark = a.flags.some((f) => f !== 'assumed_percentages') ? '⚠️' : '✓';
    out.push(`${mark} ${timeLabel(a.time)} ${a.patient?.name || 'Unknown'}, owes ~${money(a.estimate.patient)}`);
  }
  return out.join('\n');
}

export { timeLabel };
