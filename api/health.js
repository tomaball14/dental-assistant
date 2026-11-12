import { send } from '../lib/http.js';

export default function handler(req, res) {
  send(res, 200, {
    ok: true,
    practice: process.env.PRACTICE_NAME || 'Danville Dental Care',
    mode: process.env.DATA_MODE === 'live' ? 'live' : 'demo',
    assistant: process.env.ANTHROPIC_API_KEY ? 'claude' : 'keyword',
    accessCodeRequired: Boolean(process.env.APP_ACCESS_CODE),
    sms: Boolean(process.env.TWILIO_AUTH_TOKEN),
  });
}
