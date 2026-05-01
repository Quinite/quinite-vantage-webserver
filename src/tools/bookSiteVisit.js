import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';
import { updateLeadProject } from '../lib/updateLeadProject.js';

export async function handleBookSiteVisit(leadId, organizationId, args, callLogId) {
    const { scheduled_date, scheduled_time, unit_id, notes } = args;

    if (!scheduled_date || !scheduled_time) {
        return { success: false, error: 'scheduled_date and scheduled_time are required' };
    }

    // Parse IST datetime and convert to UTC ISO
    const scheduledAt = new Date(`${scheduled_date}T${scheduled_time}:00+05:30`).toISOString();

    if (isNaN(new Date(scheduledAt).getTime())) {
        return { success: false, error: 'Invalid date or time format' };
    }

    // Get lead's assigned agent and project
    const { data: lead, error: leadError } = await supabase
        .from('leads')
        .select('assigned_to, project_id, name')
        .eq('id', leadId)
        .single();

    if (leadError || !lead) {
        logger.error('bookSiteVisit: lead fetch failed', { leadId, error: leadError?.message });
        return { success: false, error: 'Could not fetch lead details' };
    }

    const { data: visit, error: insertError } = await supabase
        .from('site_visits')
        .insert({
            organization_id: organizationId,
            lead_id: leadId,
            project_id: lead.project_id || null,
            unit_id: unit_id || null,
            scheduled_at: scheduledAt,
            status: 'scheduled',
            booked_via: 'ai_call',
            assigned_agent_id: lead.assigned_to || null,
            visit_notes: notes || null,
            created_by: lead.assigned_to || null,
        })
        .select('id, scheduled_at')
        .single();

    if (insertError || !visit) {
        logger.error('bookSiteVisit: insert failed', { leadId, error: insertError?.message });
        return { success: false, error: 'Could not book site visit' };
    }

    // Auto-update lead's project if the booked unit belongs to a different project
    if (unit_id && lead.project_id) {
        const { data: unit } = await supabase.from('units').select('project_id').eq('id', unit_id).single();
        if (unit?.project_id && unit.project_id !== lead.project_id) {
            await updateLeadProject(leadId, unit.project_id, 'site_visit', visit.id);
        }
    } else if (!lead.project_id && visit.project_id) {
        await updateLeadProject(leadId, visit.project_id, 'site_visit', visit.id);
    }

    // Merge site_visit info into call_logs.ai_metadata
    if (callLogId) {
        const { data: existing } = await supabase
            .from('call_logs')
            .select('ai_metadata')
            .eq('id', callLogId)
            .single();

        await supabase.from('call_logs').update({
            ai_metadata: {
                ...(existing?.ai_metadata || {}),
                site_visit_booked: true,
                site_visit_id: visit.id,
            }
        }).eq('id', callLogId);
    }

    const scheduledAtFormatted = new Date(scheduledAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
    });

    logger.info('Site visit booked via AI call', {
        leadId,
        visitId: visit.id,
        scheduledAt,
        unitId: unit_id || null,
        projectId: lead.project_id,
    });

    return {
        success: true,
        visit_id: visit.id,
        scheduled_at_formatted: scheduledAtFormatted,
    };
}
