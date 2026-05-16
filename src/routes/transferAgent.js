import express from 'express';
import { logger } from '../lib/logger.js';

const router = express.Router();

// Stage 1: agent picks up the outbound dial. Speak the lead briefing,
// then prompt for digit confirmation.
router.all('/answer', (req, res) => {
    const conference = req.query.conference;
    const context = req.query.context || 'Incoming transfer from your AI assistant.';
    const confirmUrl = `${process.env.WEBSOCKET_SERVER_URL}/transfer-agent/confirm?` + new URLSearchParams({ conference });

    const safeContext = String(context).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    logger.info('transfer-agent/answer', { conference, contextLen: context.length });

    res.set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="Polly.Aditi" language="en-IN">${safeContext}</Speak>
    <GetDigits action="${confirmUrl.replace(/&/g, '&amp;')}" method="POST" timeout="15" numDigits="1" retries="2" redirect="true" finishOnKey="">
        <Speak voice="Polly.Aditi" language="en-IN">Press 1 to accept and connect with the lead. Press any other key to decline.</Speak>
    </GetDigits>
    <Speak voice="Polly.Aditi" language="en-IN">No input received. Goodbye.</Speak>
    <Hangup/>
</Response>`);
});

// Stage 2: agent pressed a digit. If 1 → join conference (bridges with lead).
// Anything else → decline.
router.all('/confirm', (req, res) => {
    const conference = req.query.conference;
    const digits = req.body?.Digits || req.query?.Digits || '';

    logger.info('transfer-agent/confirm', { conference, digits });

    res.set('Content-Type', 'text/xml');

    if (digits === '1') {
        // Join the conference room the lead is sitting in
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="Polly.Aditi" language="en-IN">Connecting now.</Speak>
    <Conference enterSound="" exitSound="" endConferenceOnExit="true" startConferenceOnEnter="true">${conference}</Conference>
</Response>`);
    } else {
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="Polly.Aditi" language="en-IN">Transfer declined. Goodbye.</Speak>
    <Hangup/>
</Response>`);
    }
});

export default router;
