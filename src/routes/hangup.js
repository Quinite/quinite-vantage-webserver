import express from 'express';
import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

// POST /calls/:callLogId/hangup
// Force-terminates an active call. Called by the frontend "End Call" button.
// Verifies org ownership, hangs up via Plivo, closes the WebSocket, and updates DB.
router.post('/:callLogId/hangup', async (req, res) => {
    const { callLogId } = req.params;
    const { organizationId } = req.body;

    if (!callLogId || !organizationId) {
        return res.status(400).json({ error: 'Missing callLogId or organizationId' });
    }

    const { data: callLog, error } = await supabase
        .from('call_logs')
        .select('id, call_sid, call_status, organization_id')
        .eq('id', callLogId)
        .eq('organization_id', organizationId)
        .single();

    if (error || !callLog) {
        return res.status(404).json({ error: 'Call not found' });
    }

    if (!['in_progress', 'ringing'].includes(callLog.call_status)) {
        return res.status(400).json({ error: 'Call is not active' });
    }

    logger.info('Force hangup requested', { callLogId, callSid: callLog.call_sid, organizationId });

    // 1. Hang up via Plivo
    if (callLog.call_sid) {
        try {
            await plivoClient.calls.hangup(callLog.call_sid);
            logger.info('Plivo hangup sent', { callSid: callLog.call_sid });
        } catch (err) {
            // 404 means call already ended — not an error
            if (!err.message?.includes('404')) {
                logger.warn('Plivo hangup error', { callSid: callLog.call_sid, error: err.message });
            }
        }
    }

    // 2. Update DB — 'disconnected' signals intentional termination, not a failure
    await supabase.from('call_logs').update({
        call_status: 'disconnected',
        ended_at: new Date().toISOString(),
        disconnect_reason: 'force_cancelled',
    }).eq('id', callLogId);

    logger.info('Force hangup complete', { callLogId });
    res.json({ success: true });
});

export default router;
