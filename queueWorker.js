import { supabase } from './services/supabase.js';
import { plivoClient } from './services/plivo.js';
import { logger } from './src/lib/logger.js';
import { hasAvailableCredits } from './src/lib/callLifecycle.js';
import dotenv from 'dotenv';

dotenv.config();

const POLL_INTERVAL_MS = 4000;
const MAX_CONCURRENT_CALLS = 10;

logger.info('Queue worker starting');

async function processQueue() {
    try {
        const now = new Date().toISOString();

        const { data: rawItems, error } = await supabase
            .from('call_queue')
            .select(`
                *,
                campaign:campaigns(
                    id, status, organization_id, call_settings, time_start, time_end, dnd_compliance,
                    organization:organizations(
                        id,
                        subscription_status,
                        call_credits(*)
                    )
                )
            `)
            .in('status', ['queued', 'failed'])
            .lte('next_retry_at', now)
            .lt('attempt_count', 4)
            .order('created_at', { ascending: true })
            .limit(50);

        if (error) {
            logger.error('Queue fetch error', { error: error.message });
            return;
        }

        const queueItems = (rawItems || []).filter(item => {
            const campStatus = item.campaign?.status;
            const subStatus = item.campaign?.organization?.subscription_status;
            return campStatus === 'running' && ['active', 'trialing'].includes(subStatus);
        }).slice(0, MAX_CONCURRENT_CALLS);

        if (!queueItems.length) return;

        logger.info('Queue processing', { eligible: queueItems.length, total: rawItems?.length });
        await Promise.allSettled(queueItems.map(item => executeCall(item)));

    } catch (err) {
        logger.error('Queue loop error', { error: err.message });
    }
}

async function executeCall(item) {
    const { id, lead_id, campaign_id, attempt_count, organization_id, campaign } = item;

    // Security: verify queue item belongs to the correct organization
    if (organization_id && campaign?.organization_id && organization_id !== campaign.organization_id) {
        logger.error('Org mismatch on queue item — possible tampering', { queueId: id, organization_id, campaignOrgId: campaign.organization_id });
        await supabase.from('call_queue').update({ status: 'failed', last_error: 'org_mismatch_security' }).eq('id', id);
        return;
    }

    // Check campaign time window (IST)
    const nowIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });
    if (campaign?.time_start && campaign?.time_end) {
        if (nowIST < campaign.time_start || nowIST > campaign.time_end) {
            const nextWindow = computeNextWindowOpen(campaign.time_start);
            await supabase.from('call_queue').update({ status: 'queued', next_retry_at: nextWindow }).eq('id', id);
            logger.info('Call outside time window — rescheduled', { queueId: id, nowIST, window: `${campaign.time_start}–${campaign.time_end}` });
            return;
        }
    }

    // DND compliance: 9am-9pm IST (TRAI rules)
    if (campaign?.dnd_compliance !== false) {
        if (nowIST < '09:00' || nowIST > '21:00') {
            const nextWindow = computeNextWindowOpen(campaign?.time_start || '09:00');
            await supabase.from('call_queue').update({ status: 'queued', next_retry_at: nextWindow }).eq('id', id);
            logger.info('Call outside DND window — rescheduled', { queueId: id, nowIST });
            return;
        }
    }

    try {
        // Pre-call credit check: verify org has combined monthly + purchased credits > 0
        const orgId = organization_id || campaign?.organization_id;
        if (orgId) {
            const creditsAvailable = await hasAvailableCredits(orgId);
            if (!creditsAvailable) {
                logger.warn('Pre-call credit check failed — skipping lead', { queueId: id, lead_id, campaign_id, orgId });
                await Promise.all([
                    supabase.from('call_queue').update({
                        status: 'failed', attempt_count: 4, last_error: 'NO_CREDITS', updated_at: new Date()
                    }).eq('id', id),
                    campaign_id && supabase.from('campaign_leads').update({
                        status: 'skipped', skip_reason: 'skipped_no_credits', updated_at: new Date()
                    }).match({ campaign_id, lead_id })
                ].filter(Boolean));
                return;
            }
        }

        // Atomic lock — prevents double-calling
        const { data: lockedItem, error: lockError } = await supabase
            .from('call_queue')
            .update({ status: 'processing', updated_at: new Date() })
            .match({ id, status: item.status })
            .select()
            .single();

        if (lockError || !lockedItem) return;

        const { data: leadContext } = await supabase
            .from('leads')
            .select('name, phone, archived_at, do_not_call, project:projects(archived_at)')
            .eq('id', lead_id)
            .single();

        if (!leadContext?.phone) throw new Error('INVALID_LEAD_DATA');
        if (leadContext.archived_at) throw new Error('LEAD_ARCHIVED');
        if (leadContext.do_not_call) throw new Error('DO_NOT_CALL');
        if (leadContext.project?.archived_at) throw new Error('PROJECT_ARCHIVED');

        const rawFrom = process.env.PLIVO_PHONE_NUMBER || '';
        const fromNumber = rawFrom.startsWith('+') ? rawFrom.trim() : `+${rawFrom.replace(/\D/g, '')}`;
        const rawTo = String(leadContext.phone).trim();
        const formattedTo = rawTo.startsWith('+') ? rawTo : `+${rawTo.replace(/\D/g, '')}`;

        if (!fromNumber.startsWith('+') || fromNumber.replace(/\D/g, '').length < 10) throw new Error(`INVALID_SENDER_ID: '${fromNumber}'`);
        if (!formattedTo || formattedTo.replace(/\D/g, '').length < 10) throw new Error(`INVALID_DESTINATION: '${formattedTo}'`);

        const answerUrl = `${process.env.WEBSOCKET_SERVER_URL}/answer?leadId=${lead_id}&campaignId=${campaign_id}`;
        const recordingCallbackUrl = `${process.env.WEBSOCKET_SERVER_URL}/recording`;
        const hangupUrl = `${process.env.WEBSOCKET_SERVER_URL}/status?leadId=${lead_id}&campaignId=${campaign_id}`;
        const response = await plivoClient.calls.create(fromNumber, formattedTo, answerUrl, {
            answer_method: 'POST',
            time_limit: 1800,
            record: 'true',
            record_callback_url: recordingCallbackUrl,
            record_callback_method: 'POST',
            hangup_url: hangupUrl,
            hangup_method: 'POST',
        });

        const callSid = response.requestUuid || response.callUuid;
        logger.info('Call dispatched', { callSid, leadId: lead_id, campaignId: campaign_id });

        await supabase.from('call_queue').update({ status: 'completed', updated_at: new Date() }).eq('id', id);

        // Mark campaign_leads as calling — call-end handler will update to called/failed
        if (campaign_id) {
            await supabase.from('campaign_leads').update({
                status: 'calling',
                last_call_attempt_at: new Date().toISOString(),
                attempt_count: attempt_count + 1,
                updated_at: new Date()
            }).match({ campaign_id, lead_id });
        }

    } catch (err) {
        logger.error('Call execution failed', { queueId: id, error: err.message });

        const TERMINAL_ERRORS = ['LEAD_ARCHIVED', 'DO_NOT_CALL', 'PROJECT_ARCHIVED', 'INVALID_LEAD_DATA'];
        if (TERMINAL_ERRORS.includes(err.message)) {
            // No retry — skip permanently
            await Promise.all([
                supabase.from('call_queue').update({
                    status: 'failed', attempt_count: 4, last_error: err.message, updated_at: new Date()
                }).eq('id', id),
                campaign_id && supabase.from('campaign_leads').update({
                    status: 'skipped', skip_reason: err.message.toLowerCase(), updated_at: new Date()
                }).match({ campaign_id, lead_id })
            ].filter(Boolean));
            logger.warn('Terminal error — lead skipped', { queueId: id, lead_id, reason: err.message });
            return;
        }

        const isInsufficientFunds = err.message === 'INSUFFICIENT_FUNDS';
        const retryDelayMs = isInsufficientFunds ? 5 * 60 * 1000 : (attempt_count + 1) * 30 * 60 * 1000;

        await supabase.from('call_queue').update({
            status: isInsufficientFunds ? 'queued' : 'failed',
            attempt_count: isInsufficientFunds ? attempt_count : attempt_count + 1,
            last_error: err.message,
            next_retry_at: new Date(Date.now() + retryDelayMs).toISOString(),
            updated_at: new Date()
        }).eq('id', id);
    }
}

function computeNextWindowOpen(timeStart) {
    // Schedule for the time_start tomorrow (IST)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const [hours, minutes] = timeStart.split(':').map(Number);
    const nextOpen = new Date(tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
    nextOpen.setHours(hours - 5, minutes - 30, 0, 0); // Convert IST to UTC
    return nextOpen.toISOString();
}

async function cleanupStuckCalls() {
    const timeout = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data } = await supabase.from('call_queue')
        .update({ status: 'queued', updated_at: new Date() })
        .eq('status', 'processing')
        .lt('updated_at', timeout)
        .select('id, campaign_id, lead_id');

    if (data?.length) {
        logger.warn('Stuck calls reset', { count: data.length });
        // Also reset campaign_leads stuck in 'calling' state
        const stuckThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await supabase.from('campaign_leads')
            .update({ status: 'queued', updated_at: new Date() })
            .eq('status', 'calling')
            .lt('last_call_attempt_at', stuckThreshold);
    }
}

setInterval(processQueue, POLL_INTERVAL_MS);
setInterval(cleanupStuckCalls, 2 * 60 * 1000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
