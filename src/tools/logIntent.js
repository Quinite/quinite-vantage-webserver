import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

export async function handleLogIntent(leadId, args, callLogId) {
    // Map intent args to structured leads columns — avoids using the metadata jsonb blob
    const leadUpdate = {
        interest_level: args.interest_level,
    };

    if (args.config_preference) leadUpdate.preferred_configuration = args.config_preference;
    if (args.category) leadUpdate.preferred_category = args.category.toLowerCase();
    if (args.property_type) leadUpdate.preferred_property_type = args.property_type;
    if (args.transaction_type) leadUpdate.preferred_transaction_type = args.transaction_type.toLowerCase();
    if (args.preferred_location) leadUpdate.preferred_location = args.preferred_location;
    if (args.preferred_timeline) leadUpdate.preferred_timeline = args.preferred_timeline;
    if (args.budget_min != null) leadUpdate.min_budget = args.budget_min;
    if (args.budget_max != null) leadUpdate.max_budget = args.budget_max;
    if (args.pain_points?.length) leadUpdate.pain_points = args.pain_points;
    if (args.preferred_contact_method) leadUpdate.preferred_contact_method = args.preferred_contact_method;
    if (args.best_contact_time) leadUpdate.best_contact_time = args.best_contact_time;
    if (args.purchase_readiness) leadUpdate.purchase_readiness = args.purchase_readiness;

    // budget_range as a human-readable summary for display purposes
    if (args.budget_min != null && args.budget_max != null) {
        leadUpdate.budget_range = `₹${(args.budget_min / 100000).toFixed(0)}L – ₹${(args.budget_max / 100000).toFixed(0)}L`;
    }

    const { error } = await supabase.from('leads').update(leadUpdate).eq('id', leadId);
    if (error) logger.warn('handleLogIntent leads update failed', { leadId, error: error.message });

    // Merge into call_logs.ai_metadata — fetch first to avoid overwriting existing keys
    const { data: existing } = await supabase.from('call_logs').select('ai_metadata').eq('id', callLogId).single();
    const mergedMeta = {
        ...(existing?.ai_metadata || {}),
        ...args,
        ...(args.whatsapp_brochure ? { whatsapp_brochure_requested: true } : {})
    };

    await supabase.from('call_logs').update({ ai_metadata: mergedMeta }).eq('id', callLogId);

    return { success: true };
}
