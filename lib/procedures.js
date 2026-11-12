// Plain-English treatment → CDT codes, so nobody at the front desk has to know
// that a molar root canal is D3330.
//   "root canal, buildup and crown on 30"  → D3330 #30, D2950 #30, D2740 #30
//   "cleaning and x-rays"                    → D1110, D0274
//   "2 surface filling on 14"                → D2392 #14

import { normalizeCode } from './cdt.js';

const ANTERIOR = new Set([6, 7, 8, 9, 10, 11, 22, 23, 24, 25, 26, 27]);
const PREMOLAR = new Set([4, 5, 12, 13, 20, 21, 28, 29]);

const rootCanal = (t) => (t && ANTERIOR.has(t) ? 'D3310' : t && PREMOLAR.has(t) ? 'D3320' : 'D3330');
const filling = (t, seg) => {
  if (t && ANTERIOR.has(t)) return 'D2330';
  if (/\b(3|three)[- ]?surface|\bmod\b/.test(seg)) return 'D2393';
  if (/\b(2|two)[- ]?surface|\b(mo|do)\b/.test(seg)) return 'D2392';
  if (/amalgam|silver/.test(seg)) return 'D2140';
  return 'D2391';
};

// Order matters: the more specific phrase is matched (and removed) first.
// Codes that aren't about one tooth (exams, X-rays, cleanings, dentures...).
const WHOLE_MOUTH = /^D(0|1|4341|4342|4910|5110|5120|9230)/;

const RULES = [
  [/implant crown|crown on (the |an )?implant/, () => ['D6065']],
  [/\bimplant\b/, () => ['D6010', 'D6065']],
  [/wisdom|impacted/, () => ['D7240']],
  [/surgical (extraction|ext)/, () => ['D7210']],
  [/extract|pull(ed)?\b|\bext\b/, () => ['D7140']],
  [/deep clean|scaling|\bsrp\b|root planing/, () => ['D4341']],
  [/perio(dontal)? maint/, () => ['D4910']],
  [/root canal|\brct\b|endo\b/, (t) => [rootCanal(t)]],
  [/post( and|&)? core|\bpost\b/, () => ['D2954']],
  [/build ?up|core/, () => ['D2950']],
  [/\bpfm\b|porcelain[- ]fused/, () => ['D2750']],
  [/crown|\bcap\b/, () => ['D2740']],
  [/bridge/, () => ['D6240']],
  [/lower denture/, () => ['D5120']],
  [/denture/, () => ['D5110']],
  [/filling|composite|resin|amalgam|cavity/, (t, seg) => [filling(t, seg)]],
  [/new patient exam|comprehensive exam|\bnp exam/, () => ['D0150']],
  [/emergency|limited exam|toothache/, () => ['D0140']],
  [/full[- ]mouth x|\bfmx\b/, () => ['D0210']],
  [/pano/, () => ['D0330']],
  [/x-?rays?|bitewings?|\bbwx?\b/, () => ['D0274']],
  [/child cleaning|kid'?s? cleaning/, () => ['D1120']],
  [/cleaning|prophy|hygiene/, () => ['D1110']],
  [/fluoride/, () => ['D1206']],
  [/sealant/, () => ['D1351']],
  [/\bexam|check ?up|recall/, () => ['D0120']],
  [/nitrous|laughing gas/, () => ['D9230']],
];

const TOOTH = /(?:#\s*|\btooth\s+(?:number\s+|#)?|\bon\s+(?:#\s*)?|\bnumber\s+)(\d{1,2})\b/i;

function toothIn(seg) {
  const m = seg.match(TOOTH);
  const n = m ? Number(m[1]) : null;
  return n && n >= 1 && n <= 32 ? n : null;
}

export function parseTreatment(text) {
  const src = String(text || '').toLowerCase();
  const out = [];

  // Explicit CDT codes always win.
  for (const m of src.matchAll(/\bd\d{4}\b/g)) {
    const code = normalizeCode(m[0]);
    if (code) out.push({ code, tooth: null });
  }

  const segments = src.split(/,|;|\+|\band\b|\bplus\b|\bthen\b|\bwith\b/).map((s) => s.trim()).filter(Boolean);
  const teeth = [...new Set(segments.map(toothIn).filter(Boolean))];

  for (const seg0 of segments) {
    let seg = seg0.replace(/\bd\d{4}\b/g, ' ');
    const tooth = toothIn(seg0) ?? (teeth.length === 1 ? teeth[0] : null);
    const qty = Number((seg.match(/\b(\d)\s*(?:quads?|quadrants?|x)\b/) || [])[1])
      || (/full mouth deep|all four quad/.test(seg) ? 4 : 1);
    for (const [re, fn] of RULES) {
      if (re.test(seg)) {
        const codes = fn(tooth, seg);
        const n = codes[0] === 'D4341' ? Math.min(qty, 4) : 1;
        for (let i = 0; i < n; i++) codes.forEach((code) => out.push({ code, tooth: WHOLE_MOUTH.test(code) ? null : tooth }));
        seg = seg.replace(re, ' ');
      }
    }
  }
  return out;
}

// For the conversational answers: "root canal, buildup and crown on #30".
export function describe(lines) {
  const names = lines.map((l) => l.name.toLowerCase().replace(/,.*$/, ''));
  const teeth = [...new Set(lines.map((l) => l.tooth).filter(Boolean))];
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || 'that treatment';
  return teeth.length === 1 ? `${list} on #${teeth[0]}` : list;
}
