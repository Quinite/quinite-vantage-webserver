/**
 * amenitiesMap.js — Webserver copy of all amenity label lookups.
 *
 * Standalone flat map (no React deps) so the webserver can resolve
 * amenity IDs → labels for the AI session prompt.
 *
 * PROJECT_AMENITY_MAP: society/community amenities (projects.amenities)
 * UNIT_AMENITY_MAP:    in-flat features (unit_configs.amenities / units.amenities)
 *
 * Keep in sync with lib/amenities-constants.js in quinite-vantage.
 */

export const PROJECT_AMENITY_MAP = {
    // Recreation & Wellness
    swimming_pool: { id: 'swimming_pool', label: 'Swimming Pool' },
    gym: { id: 'gym', label: 'Gymnasium' },
    yoga_deck: { id: 'yoga_deck', label: 'Yoga / Meditation Deck' },
    jogging_track: { id: 'jogging_track', label: 'Jogging Track' },
    cycling_track: { id: 'cycling_track', label: 'Cycling Track' },
    indoor_games: { id: 'indoor_games', label: 'Indoor Games Room' },
    outdoor_sports: { id: 'outdoor_sports', label: 'Outdoor Sports Court' },
    tennis_court: { id: 'tennis_court', label: 'Tennis Court' },
    badminton_court: { id: 'badminton_court', label: 'Badminton Court' },
    cricket_net: { id: 'cricket_net', label: 'Cricket Practice Net' },
    spa: { id: 'spa', label: 'Spa & Wellness Centre' },

    // Clubhouse & Community
    clubhouse: { id: 'clubhouse', label: 'Clubhouse' },
    banquet_hall: { id: 'banquet_hall', label: 'Banquet / Party Hall' },
    community_hall: { id: 'community_hall', label: 'Community Hall' },
    library: { id: 'library', label: 'Library / Reading Room' },
    amphitheater: { id: 'amphitheater', label: 'Open Amphitheater' },
    coworking: { id: 'coworking', label: 'Co-working Space' },
    business_centre: { id: 'business_centre', label: 'Business Centre' },

    // Kids & Family
    play_area: { id: 'play_area', label: "Children's Play Area" },
    toddler_zone: { id: 'toddler_zone', label: 'Toddler / Sand Pit Zone' },
    school_bus_point: { id: 'school_bus_point', label: 'School Bus Pick-up Point' },
    daycare: { id: 'daycare', label: 'Daycare / Crèche' },
    teen_zone: { id: 'teen_zone', label: 'Teen Zone / Hangout' },

    // Security & Safety
    '24hr_security': { id: '24hr_security', label: '24/7 Security' },
    cctv: { id: 'cctv', label: 'CCTV Surveillance' },
    intercom: { id: 'intercom', label: 'Video Intercom' },
    boom_barrier: { id: 'boom_barrier', label: 'Boom Barrier Entry' },
    fire_noc: { id: 'fire_noc', label: 'Fire NOC / Sprinklers' },
    biometric_access: { id: 'biometric_access', label: 'Biometric Access' },
    gated_community: { id: 'gated_community', label: 'Gated Community' },
    panic_button: { id: 'panic_button', label: 'Panic Button / SOS' },

    // Parking & Mobility
    covered_parking: { id: 'covered_parking', label: 'Covered / Stilt Parking' },
    open_parking: { id: 'open_parking', label: 'Open Parking' },
    visitor_parking: { id: 'visitor_parking', label: 'Visitor Parking' },
    ev_charging: { id: 'ev_charging', label: 'EV Charging Points' },
    car_wash: { id: 'car_wash', label: 'Car Wash Bay' },
    multi_level_parking: { id: 'multi_level_parking', label: 'Multi-level Car Parking' },

    // Utilities & Infrastructure
    power_backup: { id: 'power_backup', label: '100% Power Backup' },
    solar_power: { id: 'solar_power', label: 'Solar Power / Panels' },
    water_treatment: { id: 'water_treatment', label: 'Water Treatment Plant' },
    sewage_treatment: { id: 'sewage_treatment', label: 'STP (Sewage Treatment)' },
    rainwater_harvesting: { id: 'rainwater_harvesting', label: 'Rainwater Harvesting' },
    piped_gas: { id: 'piped_gas', label: 'Piped Gas (PNG)' },
    high_speed_internet: { id: 'high_speed_internet', label: 'High-speed Internet / OFC' },
    bms: { id: 'bms', label: 'Building Management System' },

    // Retail & Convenience
    supermarket: { id: 'supermarket', label: 'Supermarket / Mini Mart' },
    atm: { id: 'atm', label: 'ATM' },
    medical_store: { id: 'medical_store', label: 'Pharmacy / Medical Store' },
    laundry: { id: 'laundry', label: 'Laundry Service' },
    salon: { id: 'salon', label: 'Salon & Beauty Parlour' },

    // Green & Environment
    landscaped_garden: { id: 'landscaped_garden', label: 'Landscaped Garden' },
    rooftop_garden: { id: 'rooftop_garden', label: 'Rooftop Garden / Terrace' },
    organic_garden: { id: 'organic_garden', label: 'Organic / Herb Garden' },
    pet_zone: { id: 'pet_zone', label: 'Pet Park / Dog Walk Area' },
    green_certification: { id: 'green_certification', label: 'Green Building (IGBC/LEED)' },
}

// ---------------------------------------------------------------------------
// Unit / In-flat amenities
// ---------------------------------------------------------------------------
export const UNIT_AMENITY_MAP = {
    // Cooling & Heating
    split_ac: { id: 'split_ac', label: 'Split AC' },
    central_ac: { id: 'central_ac', label: 'Central AC' },
    ceiling_fan: { id: 'ceiling_fan', label: 'Ceiling Fans' },
    air_purifier: { id: 'air_purifier', label: 'Air Purifier' },
    exhaust_fan: { id: 'exhaust_fan', label: 'Exhaust Fan' },

    // Kitchen
    modular_kitchen: { id: 'modular_kitchen', label: 'Modular Kitchen' },
    chimney: { id: 'chimney', label: 'Kitchen Chimney' },
    hob: { id: 'hob', label: 'Built-in Hob' },
    dishwasher_point: { id: 'dishwasher_point', label: 'Dishwasher Point' },
    ro_filter: { id: 'ro_filter', label: 'RO Water Filter' },

    // Flooring & Finish
    vitrified_tiles: { id: 'vitrified_tiles', label: 'Vitrified Tiles' },
    wooden_flooring: { id: 'wooden_flooring', label: 'Wooden Flooring' },
    false_ceiling: { id: 'false_ceiling', label: 'False Ceiling' },
    premium_paint: { id: 'premium_paint', label: 'Premium Paint Finish' },
    anti_skid_tiles: { id: 'anti_skid_tiles', label: 'Anti-skid Tiles (Balcony/Bath)' },

    // Bathroom & Fittings
    premium_sanitary: { id: 'premium_sanitary', label: 'Premium Sanitary Fittings' },
    shower_enclosure: { id: 'shower_enclosure', label: 'Shower Enclosure' },
    jacuzzi: { id: 'jacuzzi', label: 'Jacuzzi / Bathtub' },
    geyser: { id: 'geyser', label: 'Geyser / Water Heater' },
    rainshower: { id: 'rainshower', label: 'Rain Shower' },

    // Smart Home
    home_automation: { id: 'home_automation', label: 'Home Automation' },
    smart_locks: { id: 'smart_locks', label: 'Smart Door Locks' },
    video_door_phone: { id: 'video_door_phone', label: 'Video Door Phone' },
    smart_meter: { id: 'smart_meter', label: 'Smart Electricity Meter' },
    structured_wiring: { id: 'structured_wiring', label: 'Structured Network Wiring' },

    // Storage & Wardrobe
    wardrobes: { id: 'wardrobes', label: 'Built-in Wardrobes' },
    loft_storage: { id: 'loft_storage', label: 'Loft / Overhead Storage' },
    utility_room: { id: 'utility_room', label: 'Utility / Store Room' },

    // Power & Wiring
    power_points: { id: 'power_points', label: 'Ample Power Points' },
    inverter_provision: { id: 'inverter_provision', label: 'Inverter / UPS Provision' },
    fire_rated_wiring: { id: 'fire_rated_wiring', label: 'Fire-rated Electrical Wiring' },
}

// Combined map for resolving any amenity ID (project or unit context)
export const ALL_AMENITY_MAP = { ...PROJECT_AMENITY_MAP, ...UNIT_AMENITY_MAP }
