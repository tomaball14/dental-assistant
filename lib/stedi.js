// Real-time dental eligibility (X12 270/271) through Stedi's clearinghouse.

const URL_ELIG = process.env.STEDI_ELIGIBILITY_URL
  || 'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3';

const ymd = (d) => (d ? String(d).replaceAll('-', '').slice(0, 8) : undefined);

export const stedi = {
  configured() {
    return Boolean(process.env.STEDI_API_KEY && process.env.PROVIDER_NPI);
  },

  // patient: normalized patient with .insurance from NexHealth
  async checkEligibility(patient) {
    const ins = patient.insurance;
    if (!ins?.payerId || !ins?.memberId) {
      return { benefitsInformation: [], errors: [{ description: ins?.payerId ? 'Missing member ID' : 'Missing payer ID for this insurance company' }] };
    }
    const isDependent = Boolean(ins.subscriber && ins.relationship && !/self/i.test(ins.relationship));
    const sub = isDependent
      ? ins.subscriber
      : { firstName: patient.firstName, lastName: patient.lastName, dob: patient.dob };

    const body = {
      controlNumber: String(Math.floor(100000000 + Math.random() * 899999999)),
      tradingPartnerServiceId: ins.payerId,
      provider: { organizationName: process.env.PRACTICE_NAME || undefined, npi: process.env.PROVIDER_NPI },
      subscriber: { memberId: ins.memberId, firstName: sub.firstName, lastName: sub.lastName, dateOfBirth: ymd(sub.dob) },
      encounter: { serviceTypeCodes: ['35'] }, // 35 = dental care
    };
    if (isDependent) {
      body.dependents = [{ firstName: patient.firstName, lastName: patient.lastName, dateOfBirth: ymd(patient.dob) }];
    }

    const r = await fetch(URL_ELIG, {
      method: 'POST',
      headers: { Authorization: process.env.STEDI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j?.errors) {
      return { benefitsInformation: [], errors: [{ description: `Clearinghouse error (${r.status})` }] };
    }
    return j;
  },
};
