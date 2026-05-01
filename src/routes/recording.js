import express from 'express';
import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// POST /recording — Plivo recording callback
// Called by Plivo when a call recording is ready.
router.post('/', async (req, res) => {
    logger.info('Recording callback received', { body: req.body });

    const { CallUUID, RecordUrl } = req.body;

    if (!CallUUID || !RecordUrl) {
        logger.warn('Recording callback missing fields', { body: req.body });
        return res.status(400).send('Missing CallUUID or RecordUrl');
    }

    // Confirm the call_log exists before updating
    const { data: existing } = await supabase.from('call_logs')
        .select('id, call_sid')
        .eq('call_sid', CallUUID)
        .maybeSingle();

    if (!existing) {
        logger.warn('Recording callback: no call_log found for CallUUID', { CallUUID, RecordUrl });
        // Respond 200 so Plivo doesn't retry — we can't do anything without the row
        return res.status(200).send('OK');
    }

    const { error } = await supabase.from('call_logs')
        .update({ recording_url: RecordUrl })
        .eq('call_sid', CallUUID);

    if (error) {
        logger.error('Recording callback DB update failed', { callSid: CallUUID, error: error.message });
        return res.status(500).send('Error');
    }

    logger.info('Recording URL saved', { callSid: CallUUID, callLogId: existing.id, RecordUrl });
    res.status(200).send('OK');
});

export default router;
