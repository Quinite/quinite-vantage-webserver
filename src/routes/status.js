import express from 'express';
import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

const FAILED_STATUSES = new Set(['failed', 'busy', 'no-answer', 'no_answer', 'rejected', 'canceled', 'cancelled']);
const TERMINAL_STATUSES = new Set([...FAILED_STATUSES, 'completed']);

router.all('/', async (req, res) => {
    // Respond immediately — Plivo does not wait for processing
    res.status(200).send('OK');

    const params = { ...req.query, ...req.body };
    const { CallUUID, CallStatus, Duration, BillDuration, leadId, campaignId } = params;

    if (!CallUUID || !CallStatus) return;

    const callStatus = CallStatus.toLowerCase().replace(/_/g, '-');
    logger.info('Plivo status callback', { CallUUID, callStatus, Duration, leadId, campaignId });

    if (!TERMINAL_STATUSES.has(callStatus)) return;

    const durationSecs = parseInt(Duration || BillDuration || 0, 10);
    const endedAt = new Date().toISOString();
    const isFailed = FAILED_STATUSES.has(callStatus);

    // Look up existing call_log by call_sid
    const { data: callLog } = await supabase
        .from('call_logs')
        .select('id, call_status, campaign_id, lead_id, organization_id')
        .eq('call_sid', CallUUID)
        .maybeSingle();

    if (callLog) {
        // Safety net: only update if WebSocket finalization hasn't already completed it
        if (callLog.call_status === 'in_progress') {
            await supabase.from('call_logs')
                .update({
                    call_status: isFailed ? callStatus : 'completed',
                    ended_at: endedAt,
                    duration: durationSecs,
                    disconnect_reason: callStatus,
                })
                .eq('id', callLog.id)
                .eq('call_status', 'in_progress');

            logger.info('status webhook: updated in_progress call_log', { callLogId: callLog.id, callStatus });
        }

        // Update campaign_leads if still stuck on 'calling' (WebSocket finalize missed it)
        const effectiveCampaignId = campaignId || callLog.campaign_id;
        const effectiveLeadId = leadId || callLog.lead_id;

        if (effectiveCampaignId && effectiveLeadId) {
            await supabase.from('campaign_leads')
                .update({
                    status: isFailed ? 'failed' : 'called',
                    call_log_id: callLog.id,
                    last_call_attempt_at: endedAt,
                    updated_at: endedAt,
                })
                .match({ campaign_id: effectiveCampaignId, lead_id: effectiveLeadId })
                .eq('status', 'calling');
        }

    } else if (isFailed && leadId && campaignId) {
        // Call failed before WebSocket connected — no call_log was ever created.
        // Create a minimal record so the failure is traceable.
        const { data: camp } = await supabase
            .from('campaigns')
            .select('organization_id, project_id')
            .eq('id', campaignId)
            .maybeSingle();

        const { data: lead } = await supabase
            .from('leads')
            .select('phone')
            .eq('id', leadId)
            .maybeSingle();

        if (camp) {
            const { data: newLog } = await supabase.from('call_logs').insert({
                organization_id: camp.organization_id,
                project_id: camp.project_id || null,
                campaign_id: campaignId,
                lead_id: leadId,
                call_sid: CallUUID,
                call_status: callStatus,
                direction: 'outbound',
                duration: durationSecs,
                ended_at: endedAt,
                callee_number: lead?.phone || null,
                disconnect_reason: callStatus,
            }).select('id').maybeSingle();

            logger.info('status webhook: created missing call_log for failed call', {
                CallUUID, callStatus, leadId, campaignId, callLogId: newLog?.id,
            });
        }

        // Mark campaign_lead as failed
        await supabase.from('campaign_leads')
            .update({
                status: 'failed',
                last_call_attempt_at: endedAt,
                updated_at: endedAt,
            })
            .match({ campaign_id: campaignId, lead_id: leadId })
            .eq('status', 'calling');

        logger.info('status webhook: campaign_lead marked failed (no call_log existed)', { leadId, campaignId });
    }
});

export default router;
