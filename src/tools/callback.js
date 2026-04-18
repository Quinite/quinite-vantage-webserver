import { supabase } from '../../services/supabase.js';

export async function handleScheduleCallback(leadId, campaignId, args) {
    let callbackAt;
    try {
        const parsed = new Date(args.callback_at);
        if (isNaN(parsed)) throw new Error('invalid');
        callbackAt = parsed.toISOString();
    } catch {
        callbackAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }

    await supabase.from('leads').update({
        callback_time: callbackAt,
        waiting_status: 'callback_scheduled'
    }).eq('id', leadId);

    // Re-queue or insert new entry
    const { data: existing } = await supabase.from('call_queue')
        .select('id')
        .eq('lead_id', leadId)
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (existing) {
        await supabase.from('call_queue').update({
            status: 'queued',
            next_retry_at: callbackAt,
            attempt_count: 0,
            last_error: null
        }).eq('id', existing.id);
    } else {
        const { data: lead } = await supabase.from('leads').select('organization_id').eq('id', leadId).single();
        await supabase.from('call_queue').insert({
            lead_id: leadId,
            campaign_id: campaignId,
            organization_id: lead.organization_id,
            status: 'queued',
            next_retry_at: callbackAt
        });
    }

    return { success: true, scheduled_at: callbackAt };
}
