import { supabase } from '../../services/supabase.js';
import { logger } from '../lib/logger.js';

export async function handleDetailedInventory(leadId, args, context = {}) {
    const { campaignProjectIds = [], leadHints = {} } = context;
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

    // Rank by closeness to lead preferences (passed in via context.leadHints from handler).
    // Higher score = better match. Stable sort: ties keep original DB order.
    const scoreUnit = (u) => {
        let s = 0;
        const reasons = [];
        const cfg = u.config?.config_name?.replace(/\s/g, '').toLowerCase();
        const leadCfg = leadHints.preferred_configuration?.replace(/\s/g, '').toLowerCase();
        if (leadCfg && cfg && cfg.includes(leadCfg)) { s += 10; reasons.push(`matches preferred ${leadHints.preferred_configuration}`); }
        if (leadHints.preferred_category && u.config?.category?.toLowerCase() === leadHints.preferred_category.toLowerCase()) { s += 5; reasons.push('matches category'); }
        const price = u.total_price || u.base_price || 0;
        if (leadHints.max_budget && price && price <= leadHints.max_budget) { s += 5; reasons.push('within budget'); }
        if (leadHints.min_budget && price && price >= leadHints.min_budget) { s += 2; }
        return { score: s, reason: reasons[0] || null };
    };
    const ranked = filtered
        .map(u => ({ unit: u, ...scoreUnit(u) }))
        .sort((a, b) => b.score - a.score);

    const topN = ranked.slice(0, 5);
    const wasFiltered = topN.length < units.length && filtered.length === units.length && args.config_name;

    logger.info('Inventory result', { leadId, dbCount: units.length, filteredCount: filtered.length, returning: topN.length, topScore: topN[0]?.score });

    return {
        available: true,
        total_available: filtered.length,
        ...(wasFiltered && { note: 'Exact BHK match nahi mila — ye closest available units hain.' }),
        units: topN.map((entry, i) => ({
            ...formatUnit(entry.unit),
            match_rank: i + 1,
            ...(entry.reason && { match_reason: entry.reason })
        }))
    };
}

// English word for small integers — disambiguates digits for TTS so "75" can't be heard as "50".
const NUM_WORDS = {
    0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine',
    10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen',
    17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty',
    60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety'
};
function numWord(n) {
    if (n in NUM_WORDS) return NUM_WORDS[n];
    if (n < 100) {
        const tens = Math.floor(n / 10) * 10;
        const ones = n % 10;
        return `${NUM_WORDS[tens]}-${NUM_WORDS[ones]}`;
    }
    return String(n);
}

// Convert a raw INR amount into a SPOKEN string with the lakh/crore unit baked in.
// The AI must read this verbatim — never re-convert. This prevents "75 lakh" being
// misspoken as "75 crore" (a 100× error) or "50 lakh" (a TTS-mishearing error).
// We spell the number in words AND include a clarifier so TTS produces unambiguous audio.
function priceSpoken(amount) {
    const n = Number(amount);
    if (!n || isNaN(n)) return null;
    if (n >= 10000000) {
        const crVal = n / 10000000;
        if (crVal % 1 === 0 && crVal < 100) {
            return `${numWord(crVal)} crore rupees`;
        }
        return `${(+crVal.toFixed(2))} crore rupees`;
    }
    if (n >= 100000) {
        const lkVal = n / 100000;
        if (lkVal % 1 === 0 && lkVal < 100) {
            // e.g. "seventy-five lakh rupees" — words form is much harder for TTS to garble than digits.
            return `${numWord(lkVal)} lakh rupees`;
        }
        return `${(+lkVal.toFixed(2))} lakh rupees`;
    }
    if (n >= 1000) {
        const k = +(n / 1000).toFixed(1);
        return `${k} thousand rupees`;
    }
    return `${n} rupees`;
}

function formatUnit(u) {
    // Unit-level flag takes precedence; only fall back to config if unit flag is null/undefined
    const priceHidden = u.price_undisclosed != null ? u.price_undisclosed : (u.config?.price_undisclosed ?? false);
    const rawPrice = u.total_price || u.base_price;
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
        price: priceHidden ? 'PRICE_UNDISCLOSED' : rawPrice,
        // Pre-rendered spoken form — READ THIS VERBATIM. Do NOT re-convert from `price`.
        price_spoken: priceHidden ? null : priceSpoken(rawPrice),
        facing: u.facing,
        vastu: u.is_vastu_compliant ? 'Yes' : 'No',
        corner_unit: u.is_corner ? 'Yes' : 'No',
        possession: u.possession_date,
        construction: u.construction_status?.replace(/_/g, ' ')
    };
}
