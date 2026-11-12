# Dental Front Desk Assistant

A texting-style AI assistant for the dental front desk. There are no dashboards or forms. Staff just talk to it.

- **It speaks first.** Opening the app gives a briefing on who's coming in and what needs fixing (inactive coverage, a rejected member ID, self-pay patients, low annual max, big bills), with a one-tap fix for each.
- **Plain English in, answers out.** Staff type "Is Marcus covered for a crown?" or "root canal and crown on 30 for Rosa" and get the answer, plus a card showing what the patient will pay. Nobody needs to know CDT codes.
- **It remembers the thread.** Follow-ups like "send it to her" or "what about a PFM instead?" work.
- **It drafts patient texts; staff tap Send.** The assistant writes estimates, insurance-card requests, and self-pay notices, but nothing goes out until a person taps Send.

Under the hood: NexHealth (practice software data), Stedi (real-time 270/271 eligibility), a tested estimate engine, and Claude for conversation. Without an Anthropic key it falls back to built-in rules, so the demo works with no keys at all.

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

For sending patient texts from the app, also set `TWILIO_ACCOUNT_SID` and `TWILIO_FROM_NUMBER`. For staff texting the assistant, set `TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL` (for example `https://your-app.vercel.app`), and `ALLOWED_SMS_NUMBERS` (staff phones in E.164 format, comma-separated). Then point the Twilio number's incoming-message webhook to `POST {PUBLIC_BASE_URL}/api/sms`. Requests are verified with Twilio's signature, and only numbers on the list get answers.

## Layout

```
public/index.html  The chat (the whole app)
api/            Vercel functions: assistant, brief, confirm, sms, health (+ schedule, verify, estimate for integrations)
lib/assistant.js   Conversation: Claude tool loop + rule-based fallback, shared reply shape
lib/brief.js       Opening briefing and schedule summary
lib/procedures.js  Plain English → CDT codes ("crown on 30" → D2740 #30)
lib/actions.js     Signed confirm-to-send actions, patient text templates, Twilio send
lib/cdt.js      CDT code → benefit class, X12 dental service type codes
lib/benefits.js 271 response → active / deductible / max / percentages / flags
lib/estimate.js Patient estimate engine (integer cents)
lib/service.js  Shared operations; demo vs live data
lib/nexhealth.js, lib/stedi.js   Live data adapters
```

## Safety notes

- Live mode refuses to serve data unless `APP_ACCESS_CODE` is set.
- Errors returned to clients are generic, and logs never include request bodies or PHI.
- Eligibility results are cached per warm function for 10 minutes to avoid duplicate clearinghouse charges.
- Estimates are labeled as estimates everywhere. The payer makes the final determination.
