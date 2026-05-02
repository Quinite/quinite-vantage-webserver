import { supabase } from '../../services/supabase.js';
import { logger } from './logger.js';

export const TRIGGER_KEYS = {
    CALL_ANSWERED:           'call_answered',
    CALL_TRANSFERRED:        'call_transferred',
    CALL_CALLBACK_REQUESTED: 'call_callback_requested',
    CALL_EXHAUSTED:          'call_exhausted',
};

export async function firePipelineTrigger(triggerKey, leadId, organizationId) {
    try {
        const { data: trigger } = await supabase
            .from('org_pipeline_triggers')
            .select('is_enabled, target_stage_id')
            .eq('organization_id', organizationId)
            .eq('trigger_key', triggerKey)
            .maybeSingle();

        if (!trigger || !trigger.is_enabled || !trigger.target_stage_id) return;

        const { data: lead } = await supabase
            .from('leads')
            .select('id, stage_id, archived_at')
            .eq('id', leadId)
            .maybeSingle();

        if (!lead || lead.archived_at) return;
        if (lead.stage_id === trigger.target_stage_id) return;

        const fromStageId = lead.stage_id;

        await supabase
            .from('leads')
            .update({ stage_id: trigger.target_stage_id, updated_at: new Date().toISOString() })
            .eq('id', leadId);

        await supabase.from('pipeline_stage_transitions').insert({
            lead_id:         leadId,
            organization_id: organizationId,
            from_stage_id:   fromStageId ?? null,
            to_stage_id:     trigger.target_stage_id,
            moved_by:        null,
            source:          'pipeline_trigger',
            automation_id:   null,
        });
    } catch (err) {
        logger.error(`[PipelineTrigger] ${triggerKey} failed for lead ${leadId}`, { error: err.message });
    }
}
