// The texting assistant. With ANTHROPIC_API_KEY set it uses Claude with tools
// over the schedule / eligibility / estimate operations. Without a key it falls
// back to simple keyword handling so the demo still answers.

import { schedule, verify, findPatients, estimateFor } from './service.js';
import { money } from './benefits.js';
import { normalizeCode, classify } from './cdt.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const SYSTEM = `You are the front-desk assistant for ${process.env.PRACTICE_NAME || 'a dental practice'}.
Staff text you short questions about upcoming patients, insurance coverage and cost estimates.
Rules:
- Always use the tools for patient, schedule, coverage and money facts. Never guess numbers.
- Answer in 1-4 short lines suitable for a text message. No markdown headers or tables.
- Money is given to you in cents; show dollars.
- If coverage is inactive, unclear, or a check failed, say so first and suggest calling the payer.
- If a name matches several patients, list them briefly and ask which one.
- Estimates are estimates; the plan makes the final determination.
- You only discuss this practice's scheduling, insurance and estimates.`;

const TOOLS = [
  {
    name: 'get_schedule',
    description: 'Upcoming appointments with an insurance status line and estimated patient portion for each.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 7, description: 'Days ahead, default 2' } } },
  },
  {
    name: 'find_patient',
    description: 'Find patients by name. Returns ids to use with the other tools.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'check_coverage',
    description: 'Real-time eligibility and benefits for a patient: active status, deductible and annual max remaining, coverage percentages, frequency notes.',
    input_schema: { type: 'object', properties: { patient_id: { type: 'string' } }, required: ['patient_id'] },
  },
  {
    name: 'estimate_treatment',
    description: 'Patient cost estimate for CDT procedure codes (e.g. D2740 crown, D2950 buildup, D3330 molar root canal).',
    input_schema: {
      type: 'object',
      properties: {
        patient_id: { type: 'string' },
        codes: { type: 'array', items: { type: 'string' } },
      },
      required: ['patient_id', 'codes'],
    },
  },
];

async function runTool(name, input) {
  switch (name) {
    case 'get_schedule':
      return (await schedule(input.days || 2)).map((a) => ({
        date: a.date, time: a.time, patient: a.patient?.name, patient_id: a.patientId,
        procedures: a.procedures.map((p) => p.code), coverage: a.summary, flags: a.flags,
        est_patient_cents: a.estimate.patient,
      }));
    case 'find_patient':
      return (await findPatients(input.name)).map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` }));
    case 'check_coverage': {
      const v = await verify(String(input.patient_id));
      return { patient: v.patient?.name, payer: v.patient?.payer, summary: v.summary, flags: v.flags, benefits: v.benefits };
    }
    case 'estimate_treatment': {
      const r = await estimateFor(String(input.patient_id), input.codes || []);
      return { patient: r.patient?.name, coverage: r.summary, estimate: r.estimate };
    }
    default:
      return { error: 'unknown tool' };
  }
}

async function callClaude(messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system: SYSTEM, tools: TOOLS, messages }),
  });
  if (!r.ok) throw new Error(`Claude API error ${r.status}`);
  return r.json();
}

export async function ask(question, history = []) {
  const q = String(question || '').slice(0, 1000).trim();
  if (!q) return 'Ask me about tomorrow\'s schedule, a patient\'s coverage, or an estimate.';
  if (!process.env.ANTHROPIC_API_KEY) return fallback(q);

  const messages = [
    ...history.slice(-6).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
    { role: 'user', content: q },
  ];
  for (let i = 0; i < 6; i++) {
    const resp = await callClaude(messages);
    messages.push({ role: 'assistant', content: resp.content });
    const uses = resp.content.filter((c) => c.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !uses.length) {
      return resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || 'No answer.';
    }
    const results = [];
    for (const u of uses) {
      let out;
      try { out = await runTool(u.name, u.input || {}); }
      catch (e) { out = { error: e.message }; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'That took too many steps. Try a more specific question.';
}

// ---------- keyword fallback (no API key) ----------

async function fallback(q) {
  const lower = q.toLowerCase();
  const codes = [...q.matchAll(/\bD?\d{4}\b/gi)].map((m) => normalizeCode(m[0])).filter((c) => c && classify(c));
  if (/\bcrown\b/.test(lower) && !codes.length) codes.push('D2740');
  if (/root canal/.test(lower) && !codes.length) codes.push('D3330');
  if (/clean/.test(lower) && !codes.length) codes.push('D1110');

  // Try to find a patient name in the question.
  const words = q.replace(/[^a-zA-Z' ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && /^[A-Z]/.test(w));
  let patient = null;
  for (const w of words) {
    const m = await findPatients(w);
    if (m.length === 1) { patient = m[0]; break; }
  }

  if (patient && codes.length) {
    const r = await estimateFor(patient.id, codes);
    const lines = r.estimate.lines.map((l) => `${l.code} ${l.name}: pt ${money(l.patient)}`);
    return [`${r.patient.name}: ${r.summary}`, ...lines, `Est. patient total ${money(r.estimate.totals.patient)}, insurance ${money(r.estimate.totals.insurance)}.`, ...r.estimate.warnings.slice(0, 1)].join('\n');
  }
  if (patient) {
    const v = await verify(patient.id);
    return `${v.patient.name}${v.patient.payer ? ` (${v.patient.payer})` : ''}: ${v.summary}`;
  }
  if (/schedule|tomorrow|today|who.*(coming|in)|flag|problem/.test(lower)) {
    const s = await schedule(2);
    const flagged = s.filter((a) => a.flags.some((f) => f !== 'assumed_percentages'));
    const head = flagged.length ? `${flagged.length} of ${s.length} upcoming appointments need attention:` : `All ${s.length} upcoming appointments look clear.`;
    return [head, ...flagged.map((a) => `${a.date} ${a.time} ${a.patient?.name}: ${a.summary}`)].join('\n');
  }
  return 'Try: "Who needs attention tomorrow?", "Is Marcus Hale covered?", or "Estimate D2740 for Rosa Jennings". (Add ANTHROPIC_API_KEY for full conversational answers.)';
}
