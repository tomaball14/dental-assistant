// NexHealth Synchronizer API client: appointments, patients and insurance
// records pulled from the practice's PMS (Eaglesoft, Open Dental, Dentrix).
//
// Field names are normalized defensively. Confirm them against a real response
// from the first live install (see README, "Going live").

const BASE = process.env.NEXHEALTH_BASE_URL || 'https://nexhealth.info';
const VERSION = process.env.NEXHEALTH_API_VERSION || 'v3.0.0';

let cached = { token: null, exp: 0 };

async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`${BASE}/authenticates`, {
    method: 'POST',
    headers: { Authorization: process.env.NEXHEALTH_API_KEY, 'Nex-Api-Version': VERSION, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`NexHealth auth failed (${r.status})`);
  const j = await r.json();
  const t = j?.data?.token;
  if (!t) throw new Error('NexHealth auth returned no token');
  cached = { token: t, exp: Date.now() + 55 * 60 * 1000 }; // tokens last 1 hour
  return t;
}

async function get(path, params = {}) {
  const url = new URL(path, BASE);
  const scope = { subdomain: process.env.NEXHEALTH_SUBDOMAIN, location_id: process.env.NEXHEALTH_LOCATION_ID };
  for (const [k, v] of Object.entries({ ...scope, ...params })) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, x));
    else url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${await token()}`, 'Nex-Api-Version': VERSION, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`NexHealth ${path} failed (${r.status})`);
  const j = await r.json();
  return j?.data;
}

const list = (d, key) => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);
const dateOnly = (s) => (s ? String(s).slice(0, 10) : null);

function normPatient(p) {
  if (!p) return null;
  return {
    id: String(p.id),
    firstName: p.first_name || p.bio?.first_name || '',
    lastName: p.last_name || p.bio?.last_name || '',
    dob: dateOnly(p.bio?.date_of_birth || p.date_of_birth),
    phone: p.bio?.cell_phone_number || p.bio?.phone_number || p.phone_number || null,
    insurance: undefined, // loaded lazily
  };
}

function normCoverage(c) {
  if (!c) return null;
  const plan = c.insurance_plan || c.plan || {};
  return {
    payerId: plan.payer_id || c.payer_id || null,
    payerName: plan.name || plan.carrier_name || c.payer_name || null,
    memberId: c.subscriber_num || c.member_id || c.subscription_id || c.subscriber_id || null,
    // The subscriber can differ from the patient (e.g. a spouse's plan).
    subscriber: c.subscriber
      ? { firstName: c.subscriber.first_name, lastName: c.subscriber.last_name, dob: dateOnly(c.subscriber.date_of_birth) }
      : null,
    relationship: c.relationship || c.subscriber_relationship || null,
  };
}

export const nexhealth = {
  configured() {
    return Boolean(process.env.NEXHEALTH_API_KEY && process.env.NEXHEALTH_SUBDOMAIN && process.env.NEXHEALTH_LOCATION_ID);
  },

  async listAppointments(days = 2) {
    const start = new Date();
    const end = new Date(start.getTime() + (days + 1) * 86400000);
    const data = await get('/appointments', {
      start: start.toISOString(),
      end: end.toISOString(),
      per_page: 200,
      include: ['patient', 'procedures'],
    });
    return list(data, 'appointments')
      .filter((a) => !a.cancelled && !a.deleted)
      .map((a) => ({
        id: String(a.id),
        date: dateOnly(a.start_time),
        time: a.start_time ? new Date(a.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: process.env.PRACTICE_TIMEZONE || 'America/New_York' }) : '',
        provider: a.provider_name || a.provider?.name || '',
        patientId: String(a.patient_id || a.patient?.id),
        procedures: list(a.procedures, 'procedures').map((p) => ({
          code: p.code || p.procedure_code,
          fee: p.fee?.amount != null ? Math.round(Number(p.fee.amount) * 100) : p.fee != null ? Math.round(Number(p.fee) * 100) : null,
          tooth: p.tooth || null,
        })),
      }));
  },

  async getPatient(id) {
    const p = normPatient(await get(`/patients/${encodeURIComponent(id)}`));
    if (!p) return null;
    const cov = list(await get('/insurance_coverages', { patient_id: id }), 'insurance_coverages');
    p.insurance = normCoverage(cov.find((c) => (c.priority ?? 1) === 1 || c.is_primary) || cov[0]) || null;
    return p;
  },

  async findPatients(query) {
    const data = await get('/patients', { name: query, per_page: 10 });
    return list(data, 'patients').map(normPatient);
  },
};
