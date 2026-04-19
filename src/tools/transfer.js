import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';

export async function handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId) {
    const { data: lead } = await supabase.from('leads').select('organization_id').eq('id', leadId).single();

    const { data: agents } = await supabase.from('profiles')
        .select('phone, full_name')
        .eq('organization_id', lead.organization_id)
        .eq('role', 'employee')
        .not('phone', 'is', null)
        .limit(1);

    const target = agents?.[0]?.phone || process.env.PLIVO_TRANSFER_NUMBER;
    if (!target) return { success: false, error: 'No available agents to transfer to.' };

    // Transfer the A-leg directly to the agent's number
    const transferXml = `<Response><Dial><Number>${target}</Number></Dial></Response>`;
    const transferUrl = `${process.env.WEBSOCKET_SERVER_URL}/transfer-xml?target=${encodeURIComponent(target)}`;

    await plivoClient.calls.transfer(callSid, { legs: 'aleg', aleg_url: transferUrl, aleg_method: 'GET' });

    // call_logs.transferred = true is the single source of truth for transfer state
    await Promise.all([
        supabase.from('call_logs').update({ transferred: true, transferred_at: new Date().toISOString(), call_status: 'transferred' }).eq('id', callLogId),
        supabase.rpc('increment_campaign_stat', { campaign_uuid: campaignId, stat_name: 'transferred_calls' })
    ]);

    plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
    setTimeout(() => { plivoWS.close(); realtimeWS.close(); }, 700);

    return { success: true, agent: agents?.[0]?.full_name || 'Senior Consultant' };
}
