import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';

export async function handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId) {
    const { data: lead } = await supabase.from('leads').select('organization_id').eq('id', leadId).single();

    const { data: agents } = await supabase.from('profiles')
        .select('phone, full_name')
        .eq('organization_id', lead.organization_id)
        .eq('role', 'employee')
        .eq('status', 'active')
        .not('phone', 'is', null)
        .limit(1);

    const target = agents?.[0]?.phone || process.env.PLIVO_TRANSFER_NUMBER;
    if (!target) return { success: false, error: 'No available agents to transfer to.' };

    const url = `${process.env.FRONTEND_URL}/api/webhooks/plivo/transfer?to=${encodeURIComponent(target)}&leadId=${leadId}&campaignId=${campaignId}`;

    await plivoClient.calls.transfer(callSid, { legs: 'aleg', aleg_url: url, aleg_method: 'POST' });

    await Promise.all([
        supabase.from('call_logs').update({ transferred: true, call_status: 'transferred' }).eq('id', callLogId),
        supabase.rpc('increment_campaign_stat', { campaign_uuid: campaignId, stat_name: 'transferred_calls' })
    ]);

    plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
    setTimeout(() => { plivoWS.close(); realtimeWS.close(); }, 700);

    return { success: true, agent: agents?.[0]?.full_name || 'Senior Consultant' };
}
