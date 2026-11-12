// The assistant. Every answer has the same shape so the chat can render it:
//   { reply, blocks: [estimate | confirm cards], actions: [quick-reply buttons], context }
// `context` (last patient + treatment) comes back on the next message, so
// "what about a crown instead?" and "send it to her" just work.
//
// With ANTHROPIC_API_KEY, Claude drives the conversation through tools.
// Without it, a rule-based understanding handles the common front-desk asks.

import { schedule, verify, findPatients, estimateFor, getPatient, nextAppointment } from './service.js';
import { money } from './benefits.js';
import { parseTreatment, describe } from './procedures.js';
import { buildBrief, scheduleText, dayLabel, timeLabel } from './brief.js';
import { TEMPLATES, proposeText } from './actions.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

// ---------------------------------------------------------------------------
// Shared building blocks (used by both the Claude path and the rule path)
// ---------------------------------------------------------------------------

function estimateBlock(r) {
  return {
    type: 'estimate',
    patient: r.patient?.name,
    status: r.summary,
    lines: r.estimate.lines.map((l) => ({ name: l.name, tooth: l.tooth, fee: l.fee, insurance: l.insurance, patient: l.patient })),
    totals: r.estimate.totals,
    notes: r.estimate.warnings.slice(0, 2),
  };
}

function coverageSentence(v) {
  const first = v.patient?.firstName || 'They';
  const b = v.benefits;
  if (!v.patient) return 'I couldn\'t find that patient.';
  if (!v.patient.hasInsurance) return `${first} has no insurance on file, so they're self-pay.`;
  if (v.flags?.includes('not_checked')) return `${first} has ${v.patient.payer || 'insurance'} on file, but I can't check it yet. Real-time checks start once an eligibility service (Stedi) is connected.`;
  if (b?.errors?.length) return `I couldn't verify ${first}'s insurance: the payer says "${b.errors[0]}". Usually that's a new plan or a typo in the chart.`;
  if (b?.active === false) return `${first}'s ${v.patient.payer || 'insurance'} is no longer active. Unless they have a new plan, they'd pay the full fee.`;
  if (b?.active !== true) return `${first}'s payer didn't give a clear answer. A quick call to ${v.patient.payer || 'the insurance'} is the safest bet.`;
  const parts = [`Yes, ${first} is covered by ${v.patient.payer || 'their plan'}.`];
  const facts = [];
  if (b.annualMax.remaining != null) facts.push(`${money(b.annualMax.remaining)} left on the annual max`);
  if (b.deductible.remaining != null) facts.push(b.deductible.remaining > 0 ? `${money(b.deductible.remaining)} deductible still to meet` : 'deductible already met');
  if (facts.length) parts.push(`${facts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()));
  const pct = (c) => Math.round((b.coverage[c] ?? 0) * 100);
  parts.push(`The plan pays ${pct('preventive')}% for cleanings and exams, ${pct('basic')}% for fillings and root canals, ${pct('major')}% for crowns.`);
  if (b.notes?.length) parts.push(`Note: ${b.notes.slice(0, 2).join('; ')}.`);
  return parts.join(' ');
}

function estimateSentence(r, askedCovered = false, visit = '') {
  const first = r.patient?.firstName || 'The patient';
  const e = r.estimate;
  const what = describe(e.lines) + (visit ? ` (${visit})` : '');
  const b = r.benefits;
  const missing = e.lines.filter((l) => l.feeMissing);
  if (missing.length) {
    const names = describe(missing);
    return `I don't have your office fee for the ${names} yet. Tell me the fee (like "crown $1,250") or upload your Eaglesoft fee schedule and I'll price it for ${first}.`;
  }
  if (!r.patient?.hasInsurance) return `${first} has no insurance on file, so the ${what} would be the full ${money(e.totals.fee)}.`;
  if (r.flags?.includes('not_checked')) return `The ${what} for ${first} is ${money(e.totals.fee)} at full fee. I can't take insurance off yet because coverage isn't checked until an eligibility service is connected.`;
  if (b?.errors?.length || b?.active !== true) {
    const why = b?.active === false ? 'coverage is inactive' : 'I couldn\'t verify their insurance';
    return `Heads up: ${first}'s ${why}, so the ${what} would be the full ${money(e.totals.fee)} unless we get a working plan.`;
  }
  const s = [];
  if (askedCovered) s.push(`Yes, ${first} is covered.`);
  s.push(`For the ${what}, ${first} would pay about ${money(e.totals.patient)} out of pocket, and insurance should cover ${money(e.totals.insurance)}.`);
  const ded = e.lines.reduce((t, l) => t + (l.deductible || 0), 0);
  if (ded > 0) s.push(`That includes ${money(ded)} toward the deductible.`);
  if (e.warnings.some((w) => /maximum/.test(w))) s.push(`Their annual max runs out partway through, which is why it's higher than usual.`);
  return s.join(' ');
}

// Which treatment do we mean? What they typed, else what we were just talking
// about, else what's on the patient's next appointment.
async function resolveTreatment(text, patientId, ctx) {
  const typed = parseTreatment(text);
  const fee = String(text).match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  if (typed.length === 1 && fee) typed[0].fee = Math.round(Number(fee[1].replace(/,/g, '')) * 100);
  if (typed.length) return { procedures: typed, source: 'typed' };
  if (ctx?.patientId === patientId && ctx?.procedures?.length) return { procedures: ctx.procedures, source: 'context' };
  const appt = await nextAppointment(patientId);
  if (appt) return { procedures: appt.procedures.map((p) => ({ code: p.code, tooth: p.tooth, fee: p.fee })), source: 'appointment', appt };
  return { procedures: [], source: 'none' };
}

async function draftText(patientId, kind, procedures) {
  const raw = await getPatient(patientId);
  if (!raw) return null;
  const r = procedures?.length ? await estimateFor(patientId, procedures) : null;
  const text = TEMPLATES[kind]({ firstName: raw.firstName, est: r?.estimate || { totals: { patient: 0, insurance: 0 } } });
  return proposeText(raw, kind, text);
}

const ctxFor = (patientId, procedures) => ({ patientId, procedures: (procedures || []).map((p) => ({ code: p.code, tooth: p.tooth || null })) });

// ---------------------------------------------------------------------------
// Rule-based understanding (no API key needed)
// ---------------------------------------------------------------------------

const STOP = new Set(('the and for with what how much does did can could would should will her his their them they she him '
  + 'tomorrow today send text message estimate cost owe afford covered coverage insurance crown root canal filling cleaning '
  + 'exam visit this that about show full schedule who need needs attention check please also instead price new card ask '
  + 'yes yeah sure ok okay thanks thank you next week appointment patient patients plan pay pays paid get give tell me our').split(' '));

async function patientFromText(text) {
  const words = String(text).toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/)
    .map((w) => w.replace(/'s$/, '')).filter((w) => w.length >= 3 && !STOP.has(w));
  // Try "first last" pairs first, then single words.
  for (let i = 0; i < words.length - 1; i++) {
    const m = await findPatients(`${words[i]} ${words[i + 1]}`);
    if (m.length === 1) return { patient: m[0] };
  }
  for (const w of words) {
    const m = await findPatients(w);
    if (m.length === 1) return { patient: m[0] };
    if (m.length > 1) return { ambiguous: m };
  }
  return {};
}

async function ruleAnswer(q, ctx = {}) {
  const t = q.toLowerCase();
  const found = await patientFromText(q);

  if (found.ambiguous) {
    return {
      reply: `I found a few people by that name. Which one?`,
      actions: found.ambiguous.slice(0, 4).map((p) => ({ label: `${p.firstName} ${p.lastName}`, prompt: q.replace(/\b\w+\b/, `${p.firstName} ${p.lastName}`) })),
    };
  }

  const pronoun = /\b(she|her|he|him|his|they|them|their|it|that|this|same|instead)\b/.test(t);
  const procsTyped = parseTreatment(q);
  const followUp = pronoun || procsTyped.length > 0 || /cost|owe|estimate|how much|send|text|covered|coverage/.test(t);
  const patientId = found.patient?.id || (followUp ? ctx.patientId : null);

  // Full schedule
  if (!found.patient && /full schedule|whole schedule|show (me )?the schedule|who('s| is) (coming|in)|list (the )?patients/.test(t)) {
    const appts = await schedule(2);
    return { reply: scheduleText(appts) || 'Nothing on the schedule.', actions: [{ label: 'What needs attention?', prompt: 'What needs attention?' }] };
  }

  // How to get data in
  if (/export|eaglesoft|upload|import|my (own )?(data|schedule|patients)/.test(t) && !found.patient) {
    return {
      reply: [
        'To use your real schedule:',
        '1. In Eaglesoft, run an appointment list report for tomorrow (or the next few days).',
        '2. Include these columns if the report offers them: patient name, birth date, appointment date and time, procedure codes, tooth, fee, primary insurance, payer ID, subscriber ID, cell phone.',
        '3. Save or export it as Excel or CSV.',
        '4. Tap the paperclip here and pick the file.',
        'Menu names differ a bit between Eaglesoft versions. If a column doesn\'t come through, I\'ll show you what I matched and you can fix it. You can also upload your fee schedule the same way.',
      ].join('\n'),
      actions: [{ label: 'Try a sample export', prompt: '__sample__' }],
    };
  }

  // Briefing
  if (!found.patient && /attention|problem|issue|brief|anything|heads up|morning|tomorrow|today|flag/.test(t)) {
    return buildBrief(2);
  }

  // Payer phone script
  if (patientId && /(ask|call).*(insurance|payer)|payer.*(call|phone)|what should i ask/.test(t)) {
    const v = await verify(patientId);
    return {
      reply: `When you call ${v.patient?.payer || 'the payer'} about ${v.patient?.firstName}, ask:\n1. Is the plan active, and since when?\n2. Annual max and how much is left?\n3. Deductible and how much is met?\n4. Percentages for preventive, basic and major?\n5. Frequency limits (cleanings, X-rays, crowns) and the last dates used?\n6. Any waiting periods or missing-tooth clause?\nGet the rep's name and a call reference number.`,
      context: ctxFor(patientId, ctx.procedures),
    };
  }

  // Send / text something
  if (/\b(send|text|message)\b/.test(t) && patientId) {
    const kind = /card|new insurance|insurance card/.test(t) ? 'new_card' : /self.?pay/.test(t) ? 'self_pay' : 'estimate';
    const { procedures } = kind === 'new_card' ? { procedures: [] } : await resolveTreatment(procsTyped.length ? q : '', patientId, ctx);
    const card = await draftText(patientId, kind, procedures);
    if (!card) return { reply: 'I couldn\'t find that patient.' };
    return {
      reply: 'Here\'s the text. Edit it if you like, then tap Send.',
      blocks: [card],
      context: ctxFor(patientId, procedures),
    };
  }

  // Cost / estimate
  const wantsCost = /cost|owe|afford|estimate|how much|price|pay for|out of pocket/.test(t);
  if (patientId && (procsTyped.length || wantsCost)) {
    const { procedures, source, appt } = await resolveTreatment(q, patientId, ctx);
    if (!procedures.length) {
      return { reply: 'What treatment should I price out? For example: "crown on 19" or "cleaning and X-rays".', context: ctxFor(patientId, []) };
    }
    const r = await estimateFor(patientId, procedures);
    const visit = source === 'appointment' && appt ? `${dayLabel(appt.date)} at ${timeLabel(appt.time)}` : '';
    return {
      reply: estimateSentence(r, /covered|coverage/.test(t), visit),
      blocks: [estimateBlock(r)],
      actions: [
        { label: `Text ${r.patient.firstName} this estimate`, prompt: `Send ${r.patient.name} this estimate` },
        { label: 'Full coverage details', prompt: `What does ${r.patient.name}'s plan cover?` },
      ],
      context: ctxFor(patientId, procedures),
    };
  }

  // Coverage
  if (patientId) {
    const v = await verify(patientId);
    const appt = await nextAppointment(patientId);
    const actions = [];
    if (v.flags.includes('inactive') || v.flags.includes('check_failed')) actions.push({ label: `Ask ${v.patient.firstName} for a new card`, prompt: `Text ${v.patient.name} asking for a new insurance card` });
    if (appt) actions.push({ label: `Cost of ${dayLabel(appt.date)}'s visit`, prompt: `How much will ${v.patient.name} owe for the next visit?` });
    actions.push({ label: 'Price a crown', prompt: `What would a crown cost ${v.patient.name}?` });
    return { reply: coverageSentence(v), actions, context: ctxFor(patientId, appt?.procedures || []) };
  }

  if (procsTyped.length) {
    const appts = await schedule(2);
    return {
      reply: 'Who\'s it for? I\'ll price it against their plan.',
      actions: [...new Map(appts.map((a) => [a.patientId, a])).values()].slice(0, 4)
        .map((a) => ({ label: a.patient.name, prompt: `${q} for ${a.patient.name}` })),
    };
  }

  return {
    reply: 'I can check anyone\'s insurance, tell you what a treatment will cost them, and text them the estimate. Try one of these:',
    actions: [
      { label: 'What needs attention?', prompt: 'What needs attention?' },
      { label: 'Is Marcus covered for a crown?', prompt: 'Is Marcus Hale covered for a crown?' },
      { label: 'Show the schedule', prompt: 'Show me the full schedule' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Claude path
// ---------------------------------------------------------------------------

const SYSTEM = () => `You are the front-desk assistant for ${process.env.PRACTICE_NAME || 'a dental practice'}. Staff talk to you like a sharp coworker, often by text.

How to answer:
- Lead with the answer in plain English. 1-3 short sentences. No headers, no tables, no bullet lists unless listing several patients.
- Say procedures by name ("crown on #19"), never CDT codes unless staff use them first.
- Always use tools for patient, coverage, schedule and money facts. Never estimate numbers yourself.
- Money from tools is in cents; say dollars, rounded to the dollar.
- If coverage is inactive or couldn't be verified, say that first and offer to text the patient for a new card.
- After pricing a treatment, offer to text the patient the estimate.
- To text a patient, call propose_text. That shows staff a card to review; NEVER say a message was sent.
- End every answer by calling suggest_replies with 2-3 likely next taps.
- Stay on scheduling, insurance, costs and patient messages for this practice.`;

const TOOLS = [
  { name: 'get_briefing', description: 'What needs attention for upcoming patients: inactive coverage, failed checks, self-pay, low annual max, large bills.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_schedule', description: 'Upcoming appointments with coverage status and estimated patient cost.', input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 7 } } } },
  { name: 'find_patient', description: 'Find patients by name. Returns ids.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'check_coverage', description: 'Real-time eligibility: active status, annual max and deductible remaining, coverage percentages, frequency notes.', input_schema: { type: 'object', properties: { patient_id: { type: 'string' } }, required: ['patient_id'] } },
  {
    name: 'estimate_treatment',
    description: 'Patient out-of-pocket estimate. Pass the treatment in plain English (e.g. "root canal, buildup and crown on 30"); leave it empty to use the patient\'s next scheduled visit. The staff see an estimate card.',
    input_schema: { type: 'object', properties: { patient_id: { type: 'string' }, treatment: { type: 'string' } }, required: ['patient_id'] },
  },
  {
    name: 'propose_text',
    description: 'Draft a text to a patient for staff to review and send. kind: estimate (cost of treatment), new_card (ask for a current insurance card), self_pay (no insurance on file).',
    input_schema: { type: 'object', properties: { patient_id: { type: 'string' }, kind: { type: 'string', enum: ['estimate', 'new_card', 'self_pay'] }, treatment: { type: 'string', description: 'For estimates; empty = next visit' } }, required: ['patient_id', 'kind'] },
  },
  {
    name: 'suggest_replies',
    description: 'Quick-reply buttons shown under your answer. Each prompt is what gets sent when tapped.',
    input_schema: { type: 'object', properties: { options: { type: 'array', maxItems: 3, items: { type: 'object', properties: { label: { type: 'string' }, prompt: { type: 'string' } }, required: ['label', 'prompt'] } } }, required: ['options'] },
  },
];

async function claudeAnswer(q, history, ctx) {
  const out = { blocks: [], actions: [], context: { ...ctx } };
  const touch = (patientId, procedures) => { out.context = ctxFor(patientId, procedures ?? (out.context.patientId === patientId ? out.context.procedures : [])); };

  async function run(name, input) {
    switch (name) {
      case 'get_briefing': { const b = await buildBrief(2); return { briefing: b.reply }; }
      case 'get_schedule':
        return (await schedule(input.days || 2)).map((a) => ({
          day: dayLabel(a.date), time: timeLabel(a.time), patient: a.patient?.name, patient_id: a.patientId,
          coverage: a.summary, needs_attention: a.flags.some((f) => f !== 'assumed_percentages'), est_patient_cents: a.estimate.patient,
        }));
      case 'find_patient':
        return (await findPatients(input.name)).map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` }));
      case 'check_coverage': {
        const v = await verify(String(input.patient_id));
        touch(String(input.patient_id));
        return { patient: v.patient?.name, payer: v.patient?.payer, summary: v.summary, plain_english: coverageSentence(v), flags: v.flags };
      }
      case 'estimate_treatment': {
        const id = String(input.patient_id);
        const { procedures, appt } = await resolveTreatment(input.treatment || '', id, out.context);
        if (!procedures.length) return { error: 'No treatment given and no upcoming visit found. Ask staff what to price.' };
        const r = await estimateFor(id, procedures);
        out.blocks.push(estimateBlock(r));
        touch(id, procedures);
        return {
          patient: r.patient?.name, coverage: r.summary, visit: appt ? `${dayLabel(appt.date)} ${timeLabel(appt.time)}` : null,
          treatment: describe(r.estimate.lines), patient_pays_cents: r.estimate.totals.patient, insurance_pays_cents: r.estimate.totals.insurance,
          warnings: r.estimate.warnings, card_shown: true,
        };
      }
      case 'propose_text': {
        const id = String(input.patient_id);
        const { procedures } = input.kind === 'new_card' ? { procedures: [] } : await resolveTreatment(input.treatment || '', id, out.context);
        const card = await draftText(id, input.kind, procedures);
        if (!card) return { error: 'patient not found' };
        out.blocks.push(card);
        touch(id, procedures);
        return { status: 'Draft shown to staff. It is NOT sent until they tap Send.', text: card.text };
      }
      case 'suggest_replies':
        out.actions = (input.options || []).slice(0, 3).filter((o) => o?.label && o?.prompt);
        return { ok: true };
      default:
        return { error: 'unknown tool' };
    }
  }

  const contextNote = ctx.patientId ? `\n\n(Context: the conversation is currently about patient_id ${ctx.patientId}.)` : '';
  const messages = [
    ...history.slice(-8).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
    { role: 'user', content: q + contextNote },
  ];
  // The API needs alternating turns starting with the user.
  while (messages.length && messages[0].role !== 'user') messages.shift();

  for (let i = 0; i < 8; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM(), tools: TOOLS, messages }),
    });
    if (!r.ok) throw new Error(`Claude API error ${r.status}`);
    const resp = await r.json();
    messages.push({ role: 'assistant', content: resp.content });
    const uses = resp.content.filter((c) => c.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !uses.length) {
      out.reply = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      return out;
    }
    const results = [];
    for (const u of uses) {
      let res;
      try { res = await run(u.name, u.input || {}); } catch (e) { res = { error: e.message }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(res).slice(0, 12000) });
    }
    messages.push({ role: 'user', content: results });
  }
  out.reply = out.reply || 'Here\'s what I found.';
  return out;
}

// ---------------------------------------------------------------------------

export async function ask(question, history = [], context = {}) {
  const q = String(question || '').slice(0, 1000).trim();
  const ctx = context && typeof context === 'object' ? context : {};
  if (!q) return { blocks: [], ...(await buildBrief(2)) };
  let res;
  if (process.env.ANTHROPIC_API_KEY) {
    try { res = await claudeAnswer(q, Array.isArray(history) ? history : [], ctx); }
    catch { res = await ruleAnswer(q, ctx); }
  } else {
    res = await ruleAnswer(q, ctx);
  }
  return { reply: res.reply || '', blocks: res.blocks || [], actions: res.actions || [], context: res.context || ctx };
}
