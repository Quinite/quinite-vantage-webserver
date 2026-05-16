import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';
import { firePipelineTrigger, TRIGGER_KEYS } from '../lib/pipelineTriggers.js';
import { logger } from '../lib/logger.js';

export async function handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId) {
    // Idempotency guard: if a transfer is already in progress for this call, drop the
    // duplicate invocation immediately. Prevents double-dial when both the model AND
    // the transcript safety net fire transfer_call.
    if (plivoWS.transferInProgress) {
        logger.info('Transfer already in progress — ignoring duplicate invocation', { callSid });
        return { success: true, note: 'transfer already in progress' };
    }
    plivoWS.transferInProgress = true;
    const [{ data: lead }, { data: campaign }] = await Promise.all([
        supabase.from('leads')
            .select('name, phone, interest_level, score, organization_id, assigned_to')
            .eq('id', leadId)
            .single(),
        campaignId
            ? supabase.from('campaigns').select('name, ai_script').eq('id', campaignId).single()
            : Promise.resolve({ data: null })
    ]);

    if (!lead) return { success: false, error: 'Lead not found.' };

    // ── Find best available agent ────────────────────────────────────────────
    let targetPhone = null;
    let agentName = null;
    let agentUserId = null;

    if (lead.assigned_to) {
        const { data: assignedAgent } = await supabase.from('profiles')
            .select('id, phone, full_name')
            .eq('id', lead.assigned_to)
            .not('phone', 'is', null)
            .single();
        if (assignedAgent?.phone) {
            targetPhone = assignedAgent.phone;
            agentName = assignedAgent.full_name;
            agentUserId = assignedAgent.id;
        }
    }

    if (!targetPhone) {
        const { data: agents } = await supabase.from('profiles')
            .select('id, phone, full_name')
            .eq('organization_id', lead.organization_id)
            .eq('role', 'employee')
            .not('phone', 'is', null)
            .limit(5);

        if (agents?.length) {
            const chosen = agents[0];
            targetPhone = chosen.phone;
            agentName = chosen.full_name;
            agentUserId = chosen.id;
        }
    }

    if (!targetPhone) {
        targetPhone = process.env.PLIVO_TRANSFER_NUMBER;
    }
    if (!targetPhone) {
        // No agent available — release the guard so a retry can happen
        plivoWS.transferInProgress = false;
        return { success: false, error: 'No available agent phone numbers configured.' };
    }

    // ── Build briefing text spoken to agent before bridging ──────────────────
    const interestLabel = lead.interest_level
        ? lead.interest_level.charAt(0).toUpperCase() + lead.interest_level.slice(1)
        : null;
    const spokenContext = [
        `Incoming transfer from your AI assistant.`,
        `Lead name: ${lead.name || 'Unknown'}.`,
        campaign?.name ? `Campaign: ${campaign.name}.` : null,
        interestLabel ? `Interest level: ${interestLabel}.` : null,
        lead.score != null ? `Lead score: ${lead.score} out of ten.` : null,
        args?.reason ? `Reason for transfer: ${args.reason}.` : null,
    ].filter(Boolean).join(' ');

    // ── In-app notification (immediate, non-blocking) ────────────────────────
    if (agentUserId) {
        const notifMessage = `Lead: ${lead.name || 'Unknown'} (${lead.phone || '—'}). ${campaign?.name ? `Campaign: ${campaign.name}. ` : ''}${interestLabel ? `Interest: ${interestLabel}. ` : ''}Connecting now.`;
        supabase.from('notifications').insert({
            user_id: agentUserId,
            type: 'info',
            title: `📞 Incoming transfer: ${lead.name || 'Lead'}`,
            message: notifMessage,
            link: leadId ? `/dashboard/admin/crm/leads/${leadId}` : null,
        }).then(({ error }) => {
            if (error) logger.error('Transfer notification insert failed', { error: error.message });
        });
    }

    // ── DB updates (non-blocking) ────────────────────────────────────────────
    Promise.all([
        callLogId && supabase.from('call_logs').update({
            transferred: true,
            transferred_at: new Date().toISOString(),
            call_status: 'transferred',
        }).eq('id', callLogId),
        campaignId && supabase.rpc('increment_campaign_stat', {
            campaign_uuid: campaignId,
            stat_name: 'transferred_calls',
        }),
    ]).catch(err => logger.error('Transfer DB update failed', { error: err.message }));

    if (lead.organization_id) {
        firePipelineTrigger(TRIGGER_KEYS.CALL_TRANSFERRED, leadId, lead.organization_id).catch(() => {});
    }

    // ── Schedule the actual call routing after the AI finishes its goodbye ───
    // Wait for the AI's current response to finish, then put the lead into a
    // conference room and dial the agent on a separate leg with a briefing prompt.
    // The 1500ms minimum-wait covers the case where response.done fires before
    // the audio finishes streaming to Plivo's player buffer.
    const conferenceRoom = `transfer-${callSid}`;
    const conferenceXmlUrl = `${process.env.WEBSOCKET_SERVER_URL}/conference-xml?room=${encodeURIComponent(conferenceRoom)}`;
    const agentAnswerUrl = `${process.env.WEBSOCKET_SERVER_URL}/transfer-agent/answer?` + new URLSearchParams({
        conference: conferenceRoom,
        context: spokenContext,
    });

    const executeTransfer = async () => {
        try {
            // Detach the AI side BEFORE redirecting the lead. Once the lead is in
            // the conference, the OpenAI Realtime socket has no useful role — keeping
            // it open means VAD silence timers and stray transcripts can re-fire tools.
            try { plivoWS.aiDetached = true; } catch (_) {}
            try { realtimeWS?.close(); } catch (_) {}

            // 1. Redirect the lead's A-leg to the conference holding room
            // NOTE: Plivo Node SDK requires camelCase params (alegUrl, alegMethod).
            // Snake-case (aleg_url) is silently accepted by the SDK but ignored by the
            // Plivo API — the call returns "success" but no redirect actually happens.
            logger.info('Calling plivo.calls.transfer', { callSid, conferenceXmlUrl });
            const transferResp = await plivoClient.calls.transfer(callSid, {
                legs: 'aleg',
                alegUrl: conferenceXmlUrl,
                alegMethod: 'GET',
            });
            logger.info('Lead moved to conference', { callSid, conferenceRoom, transferResp: JSON.stringify(transferResp) });

            // 2. Outbound-dial the agent into the same conference (after briefing)
            await plivoClient.calls.create(
                process.env.PLIVO_PHONE_NUMBER,
                targetPhone,
                agentAnswerUrl,
                {
                    answerMethod: 'GET',
                    timeLimit: 1800,
                }
            );
            logger.info('Agent leg dialed', { callSid, targetPhone, conferenceRoom });
        } catch (err) {
            logger.error('Transfer execution failed', { callSid, error: err.message });
        }
    };

    // Wait for AI to finish speaking before redirecting the call.
    // The handler sets `pendingAfterResponse` if a response is in-flight; otherwise
    // we wait a short safety window for any audio in Plivo's player buffer.
    if (plivoWS.scheduleAfterResponse) {
        plivoWS.scheduleAfterResponse(executeTransfer);
    } else {
        setTimeout(executeTransfer, 2500);
    }

    return { success: true, agent: agentName || 'Senior Consultant' };
}
