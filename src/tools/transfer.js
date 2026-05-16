import { supabase } from '../../services/supabase.js';
import { firePipelineTrigger, TRIGGER_KEYS } from '../lib/pipelineTriggers.js';
import { setPostStreamAction } from '../lib/postStreamRoute.js';
import { logger } from '../lib/logger.js';

export async function handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId) {
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

    if (!lead) {
        plivoWS.transferInProgress = false;
        return { success: false, error: 'Lead not found.' };
    }

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
            targetPhone = agents[0].phone;
            agentName = agents[0].full_name;
            agentUserId = agents[0].id;
        }
    }

    if (!targetPhone) targetPhone = process.env.PLIVO_TRANSFER_NUMBER;
    if (!targetPhone) {
        plivoWS.transferInProgress = false;
        return { success: false, error: 'No available agent phone numbers configured.' };
    }

    // ── Briefing audio URL — Plivo will fetch this MP3 and play it to the agent
    //    BEFORE bridging. Generated on demand by /briefing-audio via OpenAI TTS,
    //    cached server-side for repeat fetches.
    const interestLabel = lead.interest_level
        ? lead.interest_level.charAt(0).toUpperCase() + lead.interest_level.slice(1)
        : null;
    const briefingText = [
        `Incoming transfer from your AI assistant.`,
        `Lead name: ${lead.name || 'Unknown'}.`,
        campaign?.name ? `Campaign: ${campaign.name}.` : null,
        interestLabel ? `Interest level: ${interestLabel}.` : null,
        lead.score != null ? `Lead score: ${lead.score} out of ten.` : null,
        args?.reason ? `Reason for transfer: ${args.reason}.` : null,
        `Press 1 to accept.`,
    ].filter(Boolean).join(' ');
    const briefingUrl = `${process.env.WEBSOCKET_SERVER_URL}/briefing-audio?text=${encodeURIComponent(briefingText)}`;

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

    // ── Execute transfer after AI's farewell line finishes ───────────────────
    // The strategy: stash the desired post-stream action in shared state, then close
    // the AI WebSocket. Plivo's <Stream> element completes when the WS closes (because
    // keepCallAlive=false), and Plivo follows the <Redirect> to /after-stream, which
    // reads the stashed action and returns <Dial> XML with the briefing confirmSound.
    const executeTransfer = async () => {
        try {
            setPostStreamAction(callSid, {
                type: 'transfer',
                target: targetPhone,
                briefingUrl,
            });
            logger.info('Post-stream action set, closing AI WebSocket', { callSid, targetPhone });

            // Detach AI side. This closes our Plivo WS too via the WS handler cleanup,
            // which ends the <Stream> element and triggers the <Redirect>.
            plivoWS.aiDetached = true;
            try { realtimeWS?.close(); } catch (_) {}
            try { plivoWS.close(); } catch (_) {}
        } catch (err) {
            logger.error('Transfer execution failed', { callSid, error: err.message });
        }
    };

    if (plivoWS.scheduleAfterResponse) {
        plivoWS.scheduleAfterResponse(executeTransfer);
    } else {
        setTimeout(executeTransfer, 2500);
    }

    return { success: true, agent: agentName || 'Senior Consultant' };
}
