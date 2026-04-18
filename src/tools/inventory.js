import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

export async function handleDetailedInventory(leadId, args) {
    const { data: lead } = await supabase.from('leads').select('project_id').eq('id', leadId).single();
    if (!lead?.project_id) return { success: false, error: 'Project context missing.' };

    // Fetch units with joins — do NOT filter on joined table columns via SDK (unreliable).
    // Apply joined-table filters (category, property_type, config_name, carpet_area) in JS after fetch.
    let query = supabase.from('units').select(`
        id, unit_number, floor_number, facing, total_price, base_price,
        bedrooms, bathrooms, balconies, is_corner, is_vastu_compliant,
        possession_date, construction_status, transaction_type, status,
        tower:towers(name, total_floors),
        config:unit_configs(config_name, category, property_type, carpet_area, built_up_area, super_built_up_area, plot_area)
    `)
        .eq('project_id', lead.project_id)
        .eq('status', 'available')
        .is('archived_at', null)
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

    const { data: units, error } = await query.limit(20);

    if (error) {
        logger.error('Inventory query failed', { leadId, error: error.message });
        return { success: false, error: 'Search failed. Please try again.' };
    }

    if (!units?.length) {
        return { available: false, message: 'No available units in this project currently.' };
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

    return {
        available: true,
        ...(wasFiltered && { note: 'Exact BHK match not found — showing closest available units.' }),
        units: top5.map(u => ({
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
            price: u.total_price || u.base_price,
            facing: u.facing,
            vastu: u.is_vastu_compliant ? 'Yes' : 'No',
            corner_unit: u.is_corner ? 'Yes' : 'No',
            possession: u.possession_date,
            construction: u.construction_status?.replace(/_/g, ' ')
        }))
    };
}
