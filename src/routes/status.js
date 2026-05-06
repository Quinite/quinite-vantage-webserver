import express from 'express';
import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

const FAILED_STATUSES = new Set(['failed', 'busy', 'no-answer', 'no_answer', 'rejected', 'canceled', 'cancelled']);
const TERMINAL_STATUSES = new Set([...FAILED_STATUSES, 'completed']);
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 30 * 60 * 1000; // 30 min between retries

// Handles a failed Plivo call: re-queues for retry if attempts remain, else marks permanently failed.
async function handleFailedCall(campaignId, leadId, callLogId, endedAt, callStatus) {
    // Read current attempt count + org from campaign_leads in one query
    const { data: cl } = await supabase.from('campaign_leads')
        .select('attempt_count, organization_id')
        .match({ campaign_id: campaignId, lead_id: leadId })
        .maybeSingle();

    // attempt_count on campaign_leads was already incremented by queueWorker at dispatch time.
    // Do not increment again here — just use the current value to decide whether to retry.
    const attempts = cl?.attempt_count || 0;
    const hasRetries = attempts < MAX_ATTEMPTS;

    if (hasRetries) {
        const nextRetryAt = new Date(Date.now() + attempts * RETRY_DELAY_MS).toISOString();

        // Re-insert or update the retry entry into call_queue
        await supabase.from('call_queue').upsert({
            campaign_id: campaignId,
            lead_id: leadId,
            organization_id: cl?.organization_id || null,
            status: 'failed',
            attempt_count: attempts,
            last_error: callStatus,
            next_retry_at: nextRetryAt,
        }, { onConflict: 'campaign_id,lead_id' });

        // Keep campaign_leads as 'queued' so the auto-complete trigger doesn't fire
        await supabase.from('campaign_leads')
            .update({
                status: 'queued',
                ...(callLogId ? { call_log_id: callLogId } : {}),
                last_call_attempt_at: endedAt,
                updated_at: endedAt,
            })
            .match({ campaign_id: campaignId, lead_id: leadId })
            .eq('status', 'calling');

        logger.info('status webhook: call failed, re-queued for retry', { campaignId, leadId, attempts, nextRetryAt });
    } else {
        // Exhausted all retries — mark as permanently failed
        await supabase.from('campaign_leads')
            .update({
                status: 'failed',
                ...(callLogId ? { call_log_id: callLogId } : {}),
                last_call_attempt_at: endedAt,
                updated_at: endedAt,
            })
            .match({ campaign_id: campaignId, lead_id: leadId })
            .eq('status', 'calling');

        logger.info('status webhook: call failed, max attempts reached', { campaignId, leadId, attempts });
    }
}

router.all('/', async (req, res) => {
    // Respond immediately — Plivo does not wait for processing
    res.status(200).send('OK');

    const params = { ...req.query, ...req.body };
    const { CallUUID, CallStatus, Duration, BillDuration, TotalCost, leadId, campaignId } = params;

    if (!CallUUID || !CallStatus) return;

    const callStatus = CallStatus.toLowerCase().replace(/-/g, '_');
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

        // Merge Plivo's reported cost into usage_telemetry (always, regardless of call_status)
        if (TotalCost != null) {
            const plivoCostUsd = parseFloat(TotalCost) || 0;
            const { data: existing } = await supabase.from('call_logs')
                .select('usage_telemetry').eq('id', callLog.id).single();
            await supabase.from('call_logs')
                .update({ usage_telemetry: { ...(existing?.usage_telemetry || {}), plivo_cost_usd: plivoCostUsd } })
                .eq('id', callLog.id);
            logger.info('status webhook: plivo cost recorded', { callLogId: callLog.id, plivoCostUsd });
        }

        // Update campaign_leads if still stuck on 'calling' (WebSocket finalize missed it)
        const effectiveCampaignId = campaignId || callLog.campaign_id;
        const effectiveLeadId = leadId || callLog.lead_id;

        if (effectiveCampaignId && effectiveLeadId) {
            if (isFailed) {
                await handleFailedCall(effectiveCampaignId, effectiveLeadId, callLog.id, endedAt, callStatus);
            } else {
                await supabase.from('campaign_leads')
                    .update({ status: 'called', call_log_id: callLog.id, last_call_attempt_at: endedAt, updated_at: endedAt })
                    .match({ campaign_id: effectiveCampaignId, lead_id: effectiveLeadId })
                    .eq('status', 'calling');
            }
        }

    } else if (isFailed && leadId && campaignId) {
        // Call failed before WebSocket connected — no call_log was ever created.
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

        let createdLogId = null;
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

            createdLogId = newLog?.id;

            logger.info('status webhook: created missing call_log for failed call', {
                CallUUID, callStatus, leadId, campaignId, callLogId: createdLogId,
            });
        }

        await handleFailedCall(campaignId, leadId, createdLogId, endedAt, callStatus);
    }
});

export default router;
