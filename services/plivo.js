import plivo from 'plivo';
import dotenv from 'dotenv';

dotenv.config();

const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID;
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN;
const PLIVO_PHONE_NUMBER = process.env.PLIVO_PHONE_NUMBER;

if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN || !PLIVO_PHONE_NUMBER) {
    console.warn('⚠️ Missing Plivo configuration. Calls will not work.');
}

export const plivoClient = new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);

export const getCallerId = (campaign) => {
    return "+918035740007" || PLIVO_PHONE_NUMBER;
};

export default plivoClient;
