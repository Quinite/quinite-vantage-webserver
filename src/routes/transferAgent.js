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

    // GetDigits captures key presses throughout the entire nested Speak — the agent can
    // press 1 as soon as they have enough context, doesn't have to wait for the prompt to finish.
    // On timeout, redirect=true sends to the confirm URL with empty Digits, which we handle.
    res.set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <GetDigits action="${confirmUrl.replace(/&/g, '&amp;')}" method="POST" timeout="20" numDigits="1" retries="1" redirect="true" finishOnKey="">
        <Speak voice="WOMAN" language="en-US">${safeContext} Press 1 to accept and connect with the lead. Press 2 to decline.</Speak>
    </GetDigits>
    <Redirect>${confirmUrl.replace(/&/g, '&amp;')}</Redirect>
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
        // Join the conference room the lead is sitting in. No pre-speech — that would
        // delay the agent's entry and the lead would keep waiting silently. enterSound
        // is a short beep so both parties hear when the other joined.
        // startConferenceOnEnter=true: the moment the agent enters, the conference
        // "starts" which unmutes the lead (who has been waiting silently).
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Conference enterSound="beep:1" exitSound="beep:2" endConferenceOnExit="true" startConferenceOnEnter="true">${conference}</Conference>
</Response>`);
    } else {
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="WOMAN" language="en-US">Transfer declined. Goodbye.</Speak>
    <Hangup/>
</Response>`);
    }
});

export default router;
