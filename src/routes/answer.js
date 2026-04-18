import express from 'express';
import plivo from 'plivo';
import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// Plivo HMAC signature validation for production security
function validatePlivoSignature(req) {
    if (process.env.NODE_ENV !== 'production') return true;
    try {
        const signature = req.headers['x-plivo-signature-v2'];
        const nonce = req.headers['x-plivo-signature-v2-nonce'];
        if (!signature || !nonce) return false;
        const url = `${process.env.WEBSOCKET_SERVER_URL}/answer`;
        return plivo.utils.validateSignatureV2(url, nonce, signature, process.env.PLIVO_AUTH_TOKEN);
    } catch {
        return false;
    }
}

router.all('/', async (req, res) => {
    const callUuid = req.body.CallUUID || req.query.CallUUID;
    const leadId = req.query.leadId || req.body.leadId;
    const campaignId = req.query.campaignId || req.body.campaignId;

    if (!validatePlivoSignature(req)) {
        logger.warn('Invalid Plivo signature', { callUuid });
        return res.status(403).send('Forbidden');
    }

    logger.info('Answer webhook', { callUuid, leadId, campaignId });

    const { data: campaignContext } = await supabase
        .from('campaigns')
        .select('status, organization:organizations!inner(subscription_status, call_credits(*))')
        .eq('id', campaignId)
        .single();

    const credits = campaignContext?.organization?.call_credits;
    const balance = Array.isArray(credits) ? parseFloat(credits[0]?.balance || 0) : parseFloat(credits?.balance || 0);
    const subStatus = campaignContext?.organization?.subscription_status || 'inactive';
    const campaignStatus = campaignContext?.status || 'inactive';

    if (!campaignContext || !['active', 'running'].includes(campaignStatus) || !['active', 'trialing'].includes(subStatus) || balance < 0.1) {
        logger.warn('Call rejected at answer', { callUuid, campaignStatus, subStatus, balance });
        return res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }

    const host = req.headers.host;
    const wsUrl = `wss://${host}/voice/stream?leadId=${leadId}&campaignId=${campaignId}&callSid=${callUuid}`;
    const xmlWsUrl = wsUrl.replace(/&/g, '&amp;');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${xmlWsUrl}</Stream>
</Response>`;

    res.set('Content-Type', 'text/xml').send(xml.trim());
});

export default router;
