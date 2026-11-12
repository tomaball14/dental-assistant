// Fictional practice data so the app works end to end before NexHealth and
// Stedi credentials are added. Nothing here is a real patient.

export const FEES = {
  D0120: 6500, D0140: 8500, D0150: 11000, D0210: 15000, D0220: 3500, D0274: 7500, D0330: 13000,
  D1110: 11000, D1120: 8000, D1206: 4500, D1351: 5500,
  D2140: 15000, D2150: 19000, D2330: 17000, D2391: 18500, D2392: 23500, D2393: 28000,
  D2740: 125000, D2750: 115000, D2950: 30000, D2954: 38000,
  D3310: 85000, D3320: 98000, D3330: 120000,
  D4341: 26000, D4342: 19000, D4910: 16000,
  D5110: 165000, D5120: 165000, D6010: 225000, D6065: 150000, D6240: 110000,
  D7140: 19000, D7210: 32000, D7240: 52000, D9110: 12000, D9230: 7500,
};

const PATIENTS = [
  { id: 'p1', firstName: 'Linda', lastName: 'Marsh', dob: '1968-04-12', phone: '+15555550101',
    insurance: { payerId: 'DEMO-DELTA', payerName: 'Demo Dental PPO', memberId: 'DM100201' } },
  { id: 'p2', firstName: 'Marcus', lastName: 'Hale', dob: '1985-09-30', phone: '+15555550102',
    insurance: { payerId: 'DEMO-MET', payerName: 'Demo Mutual Dental', memberId: 'MM778812' } },
  { id: 'p3', firstName: 'Rosa', lastName: 'Jennings', dob: '1957-01-22', phone: '+15555550103',
    insurance: { payerId: 'DEMO-CIG', payerName: 'Demo National Dental', memberId: 'NA552190' } },
  { id: 'p4', firstName: 'Devon', lastName: 'Price', dob: '1992-11-05', phone: '+15555550104',
    insurance: { payerId: 'DEMO-GUARD', payerName: 'Demo Guardian Plan', memberId: 'GP009914' } },
  { id: 'p5', firstName: 'Ellen', lastName: 'Okafor', dob: '1979-06-17', phone: '+15555550105', insurance: null },
  { id: 'p6', firstName: 'Tom', lastName: 'Whitfield', dob: '1964-02-09', phone: '+15555550106',
    insurance: { payerId: 'DEMO-UHC', payerName: 'Demo United Dental', memberId: 'BADID' } },
];

// Stedi-shaped 271 responses, one per scenario.
const bi = (code, stc, extra = {}) => ({ code, serviceTypeCodes: stc, inPlanNetworkIndicatorCode: 'Y', coverageLevelCode: 'IND', ...extra });
function healthyPlan({ maxYear, maxLeft, dedYear, dedLeft, pct = { prev: '0', basic: '0.2', major: '0.5' }, payer }) {
  return {
    payer: { name: payer },
    planStatus: [{ statusCode: '1', status: 'Active Coverage', serviceTypeCodes: ['35'] }],
    benefitsInformation: [
      bi('1', ['35']),
      bi('C', ['35'], { timeQualifierCode: '23', benefitAmount: String(dedYear) }),
      bi('C', ['35'], { timeQualifierCode: '29', benefitAmount: String(dedLeft) }),
      bi('F', ['35'], { timeQualifierCode: '23', benefitAmount: String(maxYear) }),
      bi('F', ['35'], { timeQualifierCode: '29', benefitAmount: String(maxLeft) }),
      bi('A', ['23', '41'], { benefitPercent: pct.prev }),
      bi('A', ['25', '26', '24', '40'], { benefitPercent: pct.basic }),
      bi('A', ['36', '39'], { benefitPercent: pct.major }),
      bi('D', ['41'], { additionalInformation: [{ description: 'Prophylaxis limited to 2 per calendar year' }] }),
      bi('D', ['36'], { additionalInformation: [{ description: 'Crowns: 1 per tooth every 5 years' }] }),
    ],
  };
}

const ELIGIBILITY = {
  p1: healthyPlan({ payer: 'Demo Dental PPO', maxYear: 1500, maxLeft: 1240, dedYear: 50, dedLeft: 0 }),
  p2: healthyPlan({ payer: 'Demo Mutual Dental', maxYear: 2000, maxLeft: 2000, dedYear: 50, dedLeft: 50 }),
  p3: healthyPlan({ payer: 'Demo National Dental', maxYear: 1000, maxLeft: 135, dedYear: 75, dedLeft: 0 }),
  p4: {
    payer: { name: 'Demo Guardian Plan' },
    planStatus: [{ statusCode: '6', status: 'Inactive', serviceTypeCodes: ['35'] }],
    benefitsInformation: [bi('6', ['35'])],
  },
  p6: { payer: { name: 'Demo United Dental' }, benefitsInformation: [], errors: [{ code: '72', description: 'Invalid/Missing Subscriber/Insured ID' }] },
};

// Appointments over the next two days (practice local time, Eastern).
function day(offset) {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const APPTS = [
  { id: 'a1', patientId: 'p1', dayOffset: 1, time: '09:00', provider: 'Dr. Toma', procedures: ['D0120', 'D1110', 'D0274'] },
  { id: 'a2', patientId: 'p2', dayOffset: 1, time: '10:00', provider: 'Dr. Toma', procedures: ['D2740', 'D2950'], tooth: '19' },
  { id: 'a3', patientId: 'p3', dayOffset: 1, time: '11:30', provider: 'Dr. Toma', procedures: ['D3330', 'D2950', 'D2750'], tooth: '30' },
  { id: 'a4', patientId: 'p4', dayOffset: 1, time: '14:00', provider: 'Hygiene', procedures: ['D1110', 'D0120'] },
  { id: 'a5', patientId: 'p5', dayOffset: 2, time: '09:30', provider: 'Dr. Toma', procedures: ['D0150', 'D0210'] },
  { id: 'a6', patientId: 'p6', dayOffset: 2, time: '13:00', provider: 'Dr. Toma', procedures: ['D7210'], tooth: '32' },
];

export const demo = {
  async listAppointments(days = 2) {
    return APPTS.filter((a) => a.dayOffset <= days).map((a) => ({
      id: a.id,
      date: day(a.dayOffset),
      time: a.time,
      provider: a.provider,
      patientId: a.patientId,
      procedures: a.procedures.map((code) => ({ code, fee: FEES[code] ?? 0, tooth: a.tooth || null })),
    }));
  },
  async getPatient(id) {
    return PATIENTS.find((p) => p.id === id) || null;
  },
  async findPatients(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    return PATIENTS.filter((p) => `${p.firstName} ${p.lastName}`.toLowerCase().includes(q) || p.lastName.toLowerCase() === q);
  },
  async checkEligibility(patient) {
    return ELIGIBILITY[patient.id] || null;
  },
  fee(code) {
    return FEES[code] ?? null;
  },
};
