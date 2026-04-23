import { supabase } from '../../services/supabase.js';
import { getCallerId } from '../../services/plivo.js';
import { analyzeSentiment } from '../../services/sentimentService.js';
import { logger } from './logger.js';

export async function logCallStart(lead, campaign, callSid) {
    const { data } = await supabase.from('call_logs').insert({
        organization_id: campaign.organization_id,
        project_id: campaign.project_id,
        campaign_id: campaign.id,
        lead_id: lead.id,
        call_sid: callSid,
        call_status: 'in_progress',
        direction: 'outbound',
        caller_number: getCallerId(campaign),
        callee_number: lead.phone
    }).select('id').single();

    const logId = data?.id;
    if (logId) {
        await supabase.rpc('increment_campaign_stat', { campaign_uuid: campaign.id, stat_name: 'total_calls' });
    }
    return logId;
}

export async function finalizeCallOutcome(callLogId, leadId, campaignId, transcript, callSid, callStartTime, organizationId, campaignName) {
    try {
        const endedAt = new Date().toISOString();
        const durationSecs = Math.max(0, Math.round((Date.now() - callStartTime) / 1000));
        const COST_PER_MINUTE = parseFloat(process.env.CALL_COST_PER_MINUTE || '1.0');
        const callCost = parseFloat(((durationSecs / 60) * COST_PER_MINUTE).toFixed(4));

        // Set completed status only if still in_progress; preserve transferred/abusive terminal states
        await supabase.from('call_logs')
            .update({ conversation_transcript: transcript, ended_at: endedAt, duration: durationSecs, call_cost: callCost, call_status: 'completed' })
            .eq('id', callLogId)
            .eq('call_status', 'in_progress');

        // Always set time/cost even for non-in_progress terminal states
        await supabase.from('call_logs')
            .update({ conversation_transcript: transcript, ended_at: endedAt, duration: durationSecs, call_cost: callCost })
            .eq('id', callLogId)
            .neq('call_status', 'in_progress');

        // Deduct credits atomically (RPC enforces balance >= 0)
        if (callCost > 0 && organizationId) {
            await supabase.rpc('deduct_call_credits', { org_id: organizationId, deduction: callCost });

            // Auto-pause active campaigns if org credits are now fully exhausted
            const { data: creditsAfter } = await supabase
                .from('call_credits')
                .select('monthly_balance, balance')
                .eq('organization_id', organizationId)
                .single();

            if (creditsAfter && (creditsAfter.monthly_balance + creditsAfter.balance) <= 0) {
                const { data: pausedCampaigns } = await supabase
                    .from('campaigns')
                    .update({ status: 'paused', paused_at: endedAt, updated_at: endedAt })
                    .eq('organization_id', organizationId)
                    .in('status', ['active', 'running'])
                    .select('id');
                if (pausedCampaigns?.length) {
                    logger.warn('Campaigns auto-paused: org credits exhausted', {
                        organizationId,
                        pausedCount: pausedCampaigns.length,
                        campaignIds: pausedCampaigns.map(c => c.id)
                    });
                }
            }
        }

        // Update campaign_leads: mark call as completed
        if (campaignId && leadId) {
            const finalCampaignLeadStatus = durationSecs > 0 ? 'called' : 'failed';
            await supabase.from('campaign_leads').update({
                status: finalCampaignLeadStatus,
                call_log_id: callLogId,
                last_call_attempt_at: endedAt,
                updated_at: endedAt
            }).match({ campaign_id: campaignId, lead_id: leadId });
        }

        // Increment campaign credit_spent and auto-pause if cap exceeded
        if (callCost > 0 && campaignId) {
            const { data: newSpent } = await supabase.rpc('increment_campaign_credit_spent', {
                p_campaign_id: campaignId,
                p_amount: callCost
            });
            if (newSpent != null) {
                const { data: camp } = await supabase.from('campaigns')
                    .select('credit_cap, status').eq('id', campaignId).single();
                if (camp?.credit_cap && newSpent >= camp.credit_cap && camp.status === 'running') {
                    await supabase.from('campaigns')
                        .update({ status: 'paused', paused_at: endedAt, updated_at: endedAt })
                        .eq('id', campaignId);
                    logger.warn('Campaign auto-paused: credit cap reached', { campaignId, credit_spent: newSpent, credit_cap: camp.credit_cap });
                }
            }
        }

        if (durationSecs > 0) {
            await supabase.rpc('increment_campaign_stat', { campaign_uuid: campaignId, stat_name: 'answered_calls' });
        }

        // Get lead assigned_to for WhatsApp task creation
        const { data: leadData } = await supabase.from('leads').select('assigned_to').eq('id', leadId).single();

        // Get final call_status (may have been set to 'transferred' etc. by a tool)
        const { data: finalLog } = await supabase.from('call_logs')
            .select('call_status, ai_metadata')
            .eq('id', callLogId)
            .single();

        // Create lead_interactions record for call history
        await supabase.from('lead_interactions').insert({
            lead_id: leadId,
            organization_id: organizationId,
            type: 'call',
            direction: 'outbound',
            subject: `AI Call — ${campaignName || 'Campaign'}`,
            duration: durationSecs,
            outcome: finalLog?.call_status || 'completed',
            content: `Automated AI call. Call SID: ${callSid}. Duration: ${durationSecs}s.`
        });

        // Create WhatsApp brochure task if lead requested it during the call
        if (finalLog?.ai_metadata?.whatsapp_brochure_requested && leadData?.assigned_to) {
            await supabase.from('lead_tasks').insert({
                lead_id: leadId,
                organization_id: organizationId,
                title: 'Send project brochure via WhatsApp',
                description: `Lead requested brochure during AI call. Campaign ID: ${campaignId}`,
                assigned_to: leadData.assigned_to,
                priority: 'medium',
                status: 'pending',
                due_date: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
            });
            logger.info('WhatsApp brochure task created', { callSid, leadId });
        }

        // Non-blocking sentiment analysis
        analyzeSentiment(transcript, leadId, callLogId, organizationId, callSid, campaignId);

    } catch (err) {
        logger.error('finalizeCallOutcome failed', { callSid, error: err.message });
    }
}

// Check total available credits (monthly + purchased) before initiating a call
export async function hasAvailableCredits(organizationId, supabaseClient = supabase) {
    const { data } = await supabaseClient
        .from('call_credits')
        .select('monthly_balance, balance')
        .eq('organization_id', organizationId)
        .single();

    if (!data) return false;
    return (data.monthly_balance + data.balance) > 0;
}
