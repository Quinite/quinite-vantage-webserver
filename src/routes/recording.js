import express from 'express';
import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// POST /recording — Plivo recording callback
// Called by Plivo when a call recording is ready.
router.post('/', async (req, res) => {
    const { CallUUID, RecordUrl } = req.body;

    if (!CallUUID || !RecordUrl) {
        return res.status(400).send('Missing CallUUID or RecordUrl');
    }

    const { error } = await supabase.from('call_logs')
        .update({ recording_url: RecordUrl })
        .eq('call_sid', CallUUID);

    if (error) {
        logger.error('Recording callback failed', { callSid: CallUUID, error: error.message });
        return res.status(500).send('Error');
    }

    logger.info('Recording URL saved', { callSid: CallUUID });
    res.status(200).send('OK');
});

export default router;
