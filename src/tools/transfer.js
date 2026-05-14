import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';
import { firePipelineTrigger, TRIGGER_KEYS } from '../lib/pipelineTriggers.js';

export async function handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId) {
    // ── 1. Fetch lead + campaign context ─────────────────────────────────────
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

    // ── 2. Find best available agent ──────────────────────────────────────────
    // Prefer the lead's assigned agent first, then any employee with a phone
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

    // Fall back to env number
    if (!targetPhone) targetPhone = process.env.PLIVO_TRANSFER_NUMBER;
    if (!targetPhone) return { success: false, error: 'No available agent phone numbers configured.' };

    // ── 3. Send in-app notification to agent with full context ────────────────
    const interestLabel = lead.interest_level
        ? lead.interest_level.charAt(0).toUpperCase() + lead.interest_level.slice(1)
        : null;
    const reasonNote = args?.reason ? ` Reason: ${args.reason}.` : '';
    const notifMessage = [
        `Lead: ${lead.name || 'Unknown'} (${lead.phone || '—'}).`,
        campaign?.name ? `Campaign: ${campaign.name}.` : null,
        interestLabel ? `Interest: ${interestLabel}.` : null,
        lead.score != null ? `Score: ${lead.score}/10.` : null,
        reasonNote || null,
        'Pick up — the lead is being connected to you now.',
    ].filter(Boolean).join(' ');

    if (agentUserId) {
        await supabase.from('notifications').insert({
            user_id: agentUserId,
            type: 'info',
            title: `📞 Incoming transfer: ${lead.name || 'Lead'}`,
            message: notifMessage,
            link: leadId ? `/dashboard/admin/crm/leads/${leadId}` : null,
        }).then(({ error }) => {
            if (error) console.error('Transfer notification insert failed:', error.message);
        });
    }

    // ── 4. Build transfer XML with spoken context for agent ───────────────────
    // Plivo whispers this to the agent before connecting (B-leg prompt)
    const spokenContext = [
        `Incoming transfer from your AI assistant.`,
        `Lead name: ${lead.name || 'Unknown'}.`,
        campaign?.name ? `Campaign: ${campaign.name}.` : null,
        interestLabel ? `Interest level: ${interestLabel}.` : null,
        args?.reason ? `Reason for transfer: ${args.reason}.` : null,
        `Connecting you now.`,
    ].filter(Boolean).join(' ');

    const transferUrl = `${process.env.WEBSOCKET_SERVER_URL}/transfer-xml?` + new URLSearchParams({
        target: targetPhone,
        context: spokenContext,
    });

    await plivoClient.calls.transfer(callSid, {
        legs: 'aleg',
        aleg_url: transferUrl,
        aleg_method: 'GET',
    });

    // ── 5. Update DB ──────────────────────────────────────────────────────────
    await Promise.all([
        supabase.from('call_logs').update({
            transferred: true,
            transferred_at: new Date().toISOString(),
            call_status: 'transferred',
        }).eq('id', callLogId),
        campaignId && supabase.rpc('increment_campaign_stat', {
            campaign_uuid: campaignId,
            stat_name: 'transferred_calls',
        }),
    ]);

    // Pipeline trigger — non-blocking
    if (lead.organization_id) {
        firePipelineTrigger(TRIGGER_KEYS.CALL_TRANSFERRED, leadId, lead.organization_id).catch(() => {});
    }

    // ── 6. Tear down AI WebSockets ────────────────────────────────────────────
    plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
    setTimeout(() => {
        try { plivoWS.close(); } catch {}
        try { realtimeWS.close(); } catch {}
    }, 700);

    return { success: true, agent: agentName || 'Senior Consultant' };
}
