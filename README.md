# Dental Front Desk Assistant

An AI front-desk assistant for dental offices. Version 0.1 covers the most expensive daily task, which is insurance:

- **Schedule with live coverage.** Upcoming appointments come from the PMS through NexHealth. Each patient's dental eligibility is checked in real time through Stedi (X12 270/271). Each appointment gets a status line (active, inactive, max left, deductible left, coverage percentages), flags for problems, and an estimated patient portion.
- **Patient estimates.** You enter CDT codes and get a line-by-line estimate. The engine applies the remaining deductible, the coverage percentage for the procedure's class, and the remaining annual max, in treatment order. It also writes a ready-to-send text for the patient.
- **Ask / text the assistant.** Staff ask questions like "Is Marcus Hale covered for a crown Thursday?" in the web app or by SMS. Claude answers using tools over the schedule, eligibility, and estimate data.

It runs as plain Node on Vercel with no dependencies.

## Run it

```bash
npm test          # unit + demo end-to-end tests
npm run dev       # http://localhost:3000, fictional demo practice
```

With no environment variables set, the app runs in **demo mode** with six fictional patients. They cover the main scenarios: active, deductible not met, low max, inactive, self-pay, and bad member ID.

## Going live (checklist)

1. **Sign BAAs first.** The data is PHI, so you need a Business Associate Agreement with every vendor that touches it before you switch to live data: Vercel (requires a plan with HIPAA support), Stedi, NexHealth, Anthropic (for the assistant), and Twilio (for SMS).
2. Set the environment variables in Vercel (see `.env.example`): `DATA_MODE=live`, `APP_ACCESS_CODE`, `PROVIDER_NPI`, `NEXHEALTH_*`, `STEDI_API_KEY`, and `FEE_SCHEDULE_JSON` if the PMS doesn't send fees.
3. **Verify the NexHealth field mapping** against the first live install. `lib/nexhealth.js` normalizes `appointments`, `patients` and `insurance_coverages` defensively. Confirm the payer ID, member ID, subscriber and procedure-fee fields on a real response and adjust them in that file.
4. Spot-check 10 to 20 real estimates against the EOBs before trusting the numbers with patients.

## Texting (Twilio)

Set `TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL` (for example `https://your-app.vercel.app`), and `ALLOWED_SMS_NUMBERS` (staff phones in E.164 format, comma-separated). Then point the Twilio number's incoming-message webhook to `POST {PUBLIC_BASE_URL}/api/sms`. Requests are verified with Twilio's signature, and only numbers on the list get answers.

## Layout

```
api/            Vercel functions: schedule, verify, estimate, assistant, sms, health
lib/cdt.js      CDT code → benefit class, X12 dental service type codes
lib/benefits.js 271 response → active / deductible / max / percentages / flags
lib/estimate.js Patient estimate engine (integer cents)
lib/service.js  Shared operations; demo vs live data
lib/nexhealth.js, lib/stedi.js   Live data adapters
lib/assistant.js Claude tool-use loop + keyword fallback
public/         Web app (single page)
```

## Safety notes

- Live mode refuses to serve data unless `APP_ACCESS_CODE` is set.
- Errors returned to clients are generic, and logs never include request bodies or PHI.
- Eligibility results are cached per warm function for 10 minutes to avoid duplicate clearinghouse charges.
- Estimates are labeled as estimates everywhere. The payer makes the final determination.
