// CDT code → benefit class, plus the X12 271 dental service type codes (STCs)
// that payers use for each class.

export const CLASSES = ['preventive', 'basic', 'major', 'ortho'];

// Typical plan design when the payer response doesn't say otherwise.
// Values are the share the INSURANCE pays.
export const DEFAULT_COVERAGE = { preventive: 1.0, basic: 0.8, major: 0.5, ortho: 0.5 };

// Classes the deductible usually applies to.
export const DEDUCTIBLE_APPLIES = { preventive: false, basic: true, major: true, ortho: false };

// X12 service type code → class.
export const STC_CLASS = {
  '23': 'preventive', // diagnostic dental
  '41': 'preventive', // routine (preventive) dental
  '25': 'basic',      // restorative
  '26': 'basic',      // endodontics
  '24': 'basic',      // periodontics
  '40': 'basic',      // oral surgery
  '28': 'basic',      // adjunctive dental services
  '36': 'major',      // dental crowns
  '39': 'major',      // prosthodontics
  '27': 'major',      // maxillofacial prosthetics
  '38': 'ortho',      // orthodontics
};
export const STC_GENERAL_DENTAL = '35';

const RANGES = [
  [0, 999, 'preventive', 'Diagnostic'],
  [1000, 1999, 'preventive', 'Preventive'],
  [2000, 2699, 'basic', 'Restorative'],
  [2700, 2799, 'major', 'Crowns'],
  [2800, 2999, 'basic', 'Restorative'],
  [3000, 3999, 'basic', 'Endodontics'],
  [4000, 4999, 'basic', 'Periodontics'],
  [5000, 5899, 'major', 'Removable prosthodontics'],
  [5900, 5999, 'major', 'Maxillofacial prosthetics'],
  [6000, 6199, 'major', 'Implants'],
  [6200, 6999, 'major', 'Fixed prosthodontics'],
  [7000, 7999, 'basic', 'Oral surgery'],
  [8000, 8999, 'ortho', 'Orthodontics'],
  [9000, 9999, 'basic', 'Adjunctive'],
];

// Short plain-language names for the codes front desks see most.
export const CODE_NAMES = {
  D0120: 'Periodic exam',
  D0140: 'Limited exam',
  D0150: 'Comprehensive exam',
  D0210: 'Full-mouth X-rays',
  D0220: 'Periapical X-ray',
  D0274: 'Bitewings (4)',
  D0330: 'Panoramic X-ray',
  D1110: 'Adult cleaning',
  D1120: 'Child cleaning',
  D1206: 'Fluoride varnish',
  D1351: 'Sealant',
  D2140: 'Amalgam filling, 1 surface',
  D2150: 'Amalgam filling, 2 surfaces',
  D2330: 'Resin filling, front, 1 surface',
  D2391: 'Resin filling, back, 1 surface',
  D2392: 'Resin filling, back, 2 surfaces',
  D2393: 'Resin filling, back, 3 surfaces',
  D2740: 'Porcelain crown',
  D2750: 'Porcelain-fused-to-metal crown',
  D2950: 'Core buildup',
  D2954: 'Post and core',
  D3310: 'Root canal, front tooth',
  D3320: 'Root canal, premolar',
  D3330: 'Root canal, molar',
  D4341: 'Deep cleaning, per quadrant (4+ teeth)',
  D4342: 'Deep cleaning, per quadrant (1-3 teeth)',
  D4910: 'Periodontal maintenance',
  D5110: 'Complete upper denture',
  D5120: 'Complete lower denture',
  D6010: 'Implant body',
  D6065: 'Implant crown',
  D6240: 'Bridge pontic',
  D7140: 'Simple extraction',
  D7210: 'Surgical extraction',
  D7240: 'Impacted tooth removal',
  D9110: 'Palliative (emergency) treatment',
  D9230: 'Nitrous oxide',
};

export function normalizeCode(code) {
  const m = String(code || '').trim().toUpperCase().match(/^D?(\d{4})$/);
  return m ? `D${m[1]}` : null;
}

// Codes most plans pay at the major level even though they sit in basic ranges.
const MAJOR_OVERRIDES = [[2950, 2957], [2960, 2962], [2980, 2983]];

export function classify(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  const n = Number(c.slice(1));
  if (MAJOR_OVERRIDES.some(([lo, hi]) => n >= lo && n <= hi)) {
    return { code: c, class: 'major', category: 'Crowns and buildups', name: CODE_NAMES[c] || 'Buildup / restoration' };
  }
  const r = RANGES.find(([lo, hi]) => n >= lo && n <= hi);
  return r ? { code: c, class: r[2], category: r[3], name: CODE_NAMES[c] || r[3] } : null;
}
