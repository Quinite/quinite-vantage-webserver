import express from 'express';
import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// POST /recording — Plivo recording callback
// Called by Plivo when a call recording is ready.
router.all('/', async (req, res) => {
    const rawBody = { ...req.query, ...req.body };
    logger.info('Recording callback received', { body: rawBody });

    // Plivo wraps the actual payload as a JSON string inside `response`.
    // Merge parsed fields back into the lookup body so existing field reads still work.
    let body = rawBody;
    if (typeof rawBody.response === 'string') {
        try {
            body = { ...rawBody, ...JSON.parse(rawBody.response) };
        } catch (e) {
            logger.warn('Recording callback: failed to parse response JSON', { error: e.message });
        }
    }

    // Plivo may send CallUUID or call_uuid; RecordUrl or record_url or recording_url
    const callUuid = body.CallUUID || body.call_uuid;
    const recordUrl = body.RecordUrl || body.record_url || body.recording_url || body.RecordingUrl;

    if (!callUuid || !recordUrl) {
        logger.warn('Recording callback missing fields', { body });
        return res.status(200).send('OK'); // always 200 so Plivo stops retrying
    }

    const CallUUID = callUuid;
    const RecordUrl = recordUrl;

    const { data: existing } = await supabase.from('call_logs')
        .select('id, call_sid')
        .eq('call_sid', CallUUID)
        .maybeSingle();

    if (!existing) {
        logger.warn('Recording callback: no call_log matched call_sid', { CallUUID, RecordUrl });
        return res.status(200).send('OK');
    }

    const { error } = await supabase.from('call_logs')
        .update({ recording_url: RecordUrl })
        .eq('id', existing.id);

    if (error) {
        logger.error('Recording callback DB update failed', { callLogId: existing.id, error: error.message });
        return res.status(500).send('Error');
    }

    logger.info('Recording URL saved', { callSid: CallUUID, callLogId: existing.id, RecordUrl });
    res.status(200).send('OK');
});

export default router;
