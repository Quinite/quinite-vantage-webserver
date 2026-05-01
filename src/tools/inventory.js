import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

export async function handleDetailedInventory(leadId, args, context = {}) {
    const { campaignProjectIds = [] } = context;
    let targetProjectId = null;

    // 1. Explicit project_id from AI (security: must be a campaign project)
    if (args.project_id) {
        if (campaignProjectIds.length > 0 && !campaignProjectIds.includes(args.project_id)) {
            logger.warn('Inventory: AI requested project not in campaign', { leadId, requestedProjectId: args.project_id, campaignProjectIds });
            return { success: false, error: 'That project is not part of this campaign.' };
        }
        targetProjectId = args.project_id;
    }

    // 2. Resolve project_name to ID (must be within campaign projects)
    if (!targetProjectId && args.project_name && campaignProjectIds.length > 0) {
        const { data: projectMatch } = await supabase.from('projects')
            .select('id')
            .in('id', campaignProjectIds)
            .ilike('name', `%${args.project_name}%`)
            .limit(1)
            .single();
        if (projectMatch) targetProjectId = projectMatch.id;
    }

    // 3. Lead's own project_id (existing behavior)
    if (!targetProjectId) {
        const { data: lead } = await supabase.from('leads').select('project_id').eq('id', leadId).single();
        targetProjectId = lead?.project_id;
    }

    // 4. First campaign project fallback
    if (!targetProjectId && campaignProjectIds.length > 0) {
        targetProjectId = campaignProjectIds[0];
    }

    if (!targetProjectId) {
        logger.warn('Inventory: no project_id resolved', { leadId });
        return { success: false, error: 'Project context missing.' };
    }

    logger.info('Inventory lookup', { leadId, projectId: targetProjectId, filters: args, campaignProjectIds });

    // Fetch units with joins — do NOT filter on joined table columns via SDK (unreliable).
    // Apply joined-table filters (category, property_type, config_name, carpet_area) in JS after fetch.
    // price_undisclosed: unit-level flag overrides config-level flag (unit wins if set)
    let query = supabase.from('units').select(`
        id, unit_number, floor_number, facing, total_price, base_price, price_undisclosed,
        bedrooms, bathrooms, balconies, is_corner, is_vastu_compliant,
        possession_date, construction_status, transaction_type, status,
        tower:towers(name, total_floors),
        config:unit_configs(config_name, category, property_type, carpet_area, built_up_area, super_built_up_area, plot_area, price_undisclosed)
    `)
        .eq('project_id', targetProjectId)
        .eq('status', 'available')
        .eq('is_archived', false);

    // Apply direct-column filters only
    if (args.transaction_type) query = query.eq('transaction_type', args.transaction_type.toLowerCase());
    if (args.bedrooms && !args.config_name) query = query.eq('bedrooms', args.bedrooms);
    if (args.price_min) query = query.gte('total_price', args.price_min);
    if (args.price_max) query = query.lte('total_price', args.price_max);
    if (args.is_vastu_compliant !== undefined) query = query.eq('is_vastu_compliant', args.is_vastu_compliant);
    if (args.is_corner !== undefined) query = query.eq('is_corner', args.is_corner);
    if (args.facing) query = query.ilike('facing', `%${args.facing}%`);
    if (args.floor_min) query = query.gte('floor_number', args.floor_min);
    if (args.floor_max) query = query.lte('floor_number', args.floor_max);

    const { data: units, error } = await query.limit(30);

    if (error) {
        logger.error('Inventory query failed', { leadId, projectId: targetProjectId, error: error.message });
        return { success: false, error: 'Search failed. Please try again.' };
    }

    logger.info('Inventory DB result', { leadId, projectId: targetProjectId, totalFromDB: units?.length || 0, filtersApplied: Object.keys(args).length });

    // If filtered query returns nothing, try a broad fallback (just project + available)
    if (!units?.length) {
        logger.warn('Inventory: zero results with filters, trying broad query', { leadId, projectId: targetProjectId, args });
        const { data: broadUnits } = await supabase.from('units').select(`
            id, unit_number, floor_number, facing, total_price, base_price, price_undisclosed,
            bedrooms, bathrooms, balconies, is_corner, is_vastu_compliant,
            possession_date, construction_status, transaction_type, status,
            tower:towers(name, total_floors),
            config:unit_configs(config_name, category, property_type, carpet_area, built_up_area, super_built_up_area, plot_area, price_undisclosed)
        `)
            .eq('project_id', targetProjectId)
            .eq('status', 'available')
            .eq('is_archived', false)
            .limit(10);

        if (broadUnits?.length) {
            logger.info('Inventory: broad fallback found units', { leadId, count: broadUnits.length });
            const top5 = broadUnits.slice(0, 5);
            return {
                available: true,
                note: 'Exact match nahi mila, lekin ye similar options available hain.',
                units: top5.map(u => formatUnit(u))
            };
        }

        logger.warn('Inventory: truly zero units in project', { leadId, projectId: lead.project_id });
        return {
            available: false,
            message: 'Is project mein abhi sab units booked hain. Naye inventory ke liye aapko notify kar denge. Kya koi aur project dekhna chahenge?'
        };
    }

    // JS-level filtering for joined table columns — handles "2 BHK" / "2BHK" / "2bhk" variants
    let filtered = units;

    if (args.config_name) {
        const needle = args.config_name.replace(/\s/g, '').toLowerCase();
        const matched = units.filter(u => u.config?.config_name?.replace(/\s/g, '').toLowerCase().includes(needle));
        filtered = matched.length ? matched : units; // graceful fallback
    }

    if (args.category) {
        const cat = args.category.toLowerCase();
        const catFiltered = filtered.filter(u => u.config?.category?.toLowerCase() === cat);
        if (catFiltered.length) filtered = catFiltered;
    }

    if (args.property_type) {
        const pt = args.property_type.toLowerCase();
        const ptFiltered = filtered.filter(u => u.config?.property_type?.toLowerCase().includes(pt));
        if (ptFiltered.length) filtered = ptFiltered;
    }

    if (args.min_carpet_area) {
        const areaFiltered = filtered.filter(u => (u.config?.carpet_area || 0) >= args.min_carpet_area);
        if (areaFiltered.length) filtered = areaFiltered;
    }

    const top5 = filtered.slice(0, 5);
    const wasFiltered = top5.length < units.length && filtered.length === units.length && args.config_name;

    logger.info('Inventory result', { leadId, dbCount: units.length, filteredCount: filtered.length, returning: top5.length });

    return {
        available: true,
        total_available: filtered.length,
        ...(wasFiltered && { note: 'Exact BHK match nahi mila — ye closest available units hain.' }),
        units: top5.map(u => formatUnit(u))
    };
}

function formatUnit(u) {
    const priceHidden = u.price_undisclosed || u.config?.price_undisclosed || false;
    return {
        unit_id: u.id,
        unit_no: u.unit_number,
        tower: u.tower?.name,
        floor: u.floor_number,
        config: u.config?.config_name,
        category: u.config?.category,
        type: u.config?.property_type,
        transaction: u.transaction_type,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        balconies: u.balconies,
        area: {
            carpet: u.config?.carpet_area,
            built_up: u.config?.built_up_area,
            super_built: u.config?.super_built_up_area,
            plot: u.config?.plot_area
        },
        price: priceHidden ? 'PRICE_UNDISCLOSED' : (u.total_price || u.base_price),
        facing: u.facing,
        vastu: u.is_vastu_compliant ? 'Yes' : 'No',
        corner_unit: u.is_corner ? 'Yes' : 'No',
        possession: u.possession_date,
        construction: u.construction_status?.replace(/_/g, ' ')
    };
}
