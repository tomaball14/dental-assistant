// The message the assistant opens with: what needs attention before patients
// arrive, each problem with a one-tap fix.

import { schedule } from './service.js';
import { money } from './benefits.js';
import { current, summary } from './practice-data.js';

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
    return { line: `${first}, ${when}: coverage is inactive.`, action: { label: `Ask ${first} for a new card`, prompt: `Text ${a.patient.name} asking for a new insurance card` } };
  }
  if (f.includes('check_failed')) {
    return { line: `${first}, ${when}: member ID was rejected.`, action: { label: `Ask ${first} for a new card`, prompt: `Text ${a.patient.name} asking for a new insurance card` } };
  }
  if (f.includes('no_insurance')) {
    return { line: `${first}, ${when}: no insurance, about ${money(a.estimate.patient)} self-pay.`, action: { label: `Text ${first} about self-pay`, prompt: `Text ${a.patient.name} the self-pay notice` } };
  }
  if (f.includes('low_max')) {
    return { line: `${first}, ${when}: only ${money(a.maxLeft)} of insurance left, will owe about ${money(a.estimate.patient)}.`, action: { label: `Send ${first} the estimate`, prompt: `Send ${a.patient.name} the estimate for this visit` } };
  }
  if (f.includes('unclear')) {
    return { line: `${first}, ${when}: unclear payer answer, worth a call.`, action: { label: `What do I ask the payer?`, prompt: `What should I ask ${a.patient.name}'s insurance on the phone?` } };
  }
  return null;
}

export async function buildBrief(days = 2) {
  const appts = await schedule(days);
  const data = current();
  if (!appts.length) {
    const info = summary(data);
    if (info?.appointments) {
      const range = info.dateFrom === info.dateTo ? fmtDate(info.dateFrom) : `${fmtDate(info.dateFrom)} to ${fmtDate(info.dateTo)}`;
      return {
        reply: `Your upload covers ${range}, and none of those appointments are today or later. Export the next day's schedule from Eaglesoft and send it here.`,
        actions: [{ label: 'How do I export it?', prompt: 'How do I export my schedule from Eaglesoft?' }],
        context: {},
      };
    }
    return { reply: 'Nothing on the schedule for the next couple of days. Ask me anything about a patient or a treatment cost.', actions: [], context: {} };
  }

  // Without a clearinghouse connected, say so once instead of flagging everyone.
  const unchecked = appts.filter((a) => a.flags.includes('not_checked'));
  const problems = appts.map((a) => ({ a, p: problem(a) })).filter((x) => x.p);
  const clear = appts.length - problems.length - unchecked.length;
  const bigBills = appts.filter((a) => !problems.some((x) => x.a === a) && !a.flags.includes('not_checked') && a.estimate.patient >= 30000);

  const firstDay = dayLabel(appts[0].date);
  const lines = [];
  lines.push(problems.length
    ? `${appts.length} patients from ${firstDay} on. ${problems.length} need${problems.length === 1 ? 's' : ''} attention:`
    : unchecked.length ? `${appts.length} patients from ${firstDay} on.` : `${appts.length} patients from ${firstDay} on. Insurance checks out for everyone.`);
  problems.forEach(({ p }) => lines.push(`• ${p.line}`));
  if (unchecked.length) {
    lines.push(`${unchecked.length === appts.length ? 'Insurance' : `Insurance for ${unchecked.length} of them`} isn't checked yet, because no eligibility service is connected. Costs show full fees until then.`);
  }
  if (bigBills.length) {
    lines.push('');
    lines.push(`Big bill: ${bigBills.map((a) => `${a.patient.firstName} owes about ${money(a.estimate.patient)}`).join(', ')}.`);
  }
  if (problems.length && clear > 0) lines.push(`Everyone else is verified.`);

  const actions = problems.map(({ p }) => p.action);
  bigBills.slice(0, 2).forEach((a) => actions.push({ label: `Send ${a.patient.firstName} the estimate`, prompt: `Send ${a.patient.name} the estimate for this visit` }));
  actions.push({ label: 'Show full schedule', prompt: 'Show me the full schedule' });

  return { reply: lines.join('\n'), actions: dedupe(actions).slice(0, 5), context: {} };
}

const fmtDate = (d) => (d ? new Date(`${d}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?');

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
    const mark = a.flags.some((f) => !['assumed_percentages', 'not_checked'].includes(f)) ? '⚠️' : a.flags.includes('not_checked') ? '○' : '✓';
    out.push(`${mark} ${timeLabel(a.time)} ${a.patient?.name || 'Unknown'}, owes ~${money(a.estimate.patient)}`);
  }
  return out.join('\n');
}

export { timeLabel };
