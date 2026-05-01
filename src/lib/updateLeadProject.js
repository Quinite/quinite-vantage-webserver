import { supabase } from '../../services/supabase.js';
import { logger } from './logger.js';

/**
 * Update a lead's project_id if it differs from the current one.
 * Inserts a lead_interactions record to document the change.
 *
 * @param {string} leadId
 * @param {string|null} newProjectId
 * @param {'site_visit'|'ai_call'|'ai_task'} triggeredBy
 * @param {string} referenceId - ID of the triggering record (site_visit.id, call_log.id, task.id)
 * @returns {{ changed: boolean }}
 */
export async function updateLeadProject(leadId, newProjectId, triggeredBy, referenceId) {
    if (!leadId || !newProjectId) return { changed: false };

    const { data: lead, error: fetchError } = await supabase
        .from('leads')
        .select('project_id, organization_id, projects(name)')
        .eq('id', leadId)
        .single();

    if (fetchError || !lead) {
        logger.warn('updateLeadProject: lead fetch failed', { leadId, error: fetchError?.message });
        return { changed: false };
    }

    if (lead.project_id === newProjectId) return { changed: false };

    const oldProjectName = lead.projects?.name || lead.project_id || 'None';

    // Fetch new project name for the interaction log
    const { data: newProject } = await supabase
        .from('projects')
        .select('name')
        .eq('id', newProjectId)
        .single();

    const newProjectName = newProject?.name || newProjectId;

    const { error: updateError } = await supabase
        .from('leads')
        .update({ project_id: newProjectId })
        .eq('id', leadId);

    if (updateError) {
        logger.error('updateLeadProject: update failed', { leadId, newProjectId, error: updateError.message });
        return { changed: false };
    }

    const triggerLabels = {
        site_visit: 'site visit booking',
        ai_call: 'AI call interest detection',
        ai_task: 'AI follow-up task',
    };

    await supabase.from('lead_interactions').insert({
        lead_id: leadId,
        organization_id: lead.organization_id,
        type: 'note',
        subject: 'Project association updated',
        content: `Project changed from "${oldProjectName}" to "${newProjectName}" via ${triggerLabels[triggeredBy] || triggeredBy}. Ref: ${referenceId || 'n/a'}`,
    });

    logger.info('Lead project updated', { leadId, oldProjectId: lead.project_id, newProjectId, triggeredBy });
    return { changed: true };
}
