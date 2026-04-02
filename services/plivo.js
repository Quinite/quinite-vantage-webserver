import plivo from 'plivo';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID;
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN;
const PLIVO_PHONE_NUMBER = process.env.PLIVO_PHONE_NUMBER;
const PLIVO_CALLER_ID = process.env.PLIVO_CALLER_ID;
const DEFAULT_CALLER_ID = '+918035740007';

if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN) {
    console.warn('Missing Plivo credentials. Calls will not work.');
}

export const plivoClient = new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);

export const normalizePhoneNumber = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const digits = raw.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
};

export const getCallerId = (campaign) => {
    const callSettings = campaign?.call_settings || {};
    const candidate =
        callSettings.caller_id ||
        callSettings.callerId ||
        callSettings.outbound_number ||
        callSettings.phone_number ||
        PLIVO_PHONE_NUMBER ||
        PLIVO_CALLER_ID ||
        DEFAULT_CALLER_ID;

    return normalizePhoneNumber(candidate);
};

export default plivoClient;
