export const createSessionUpdate = (context, campaign, campaignProjects = [], allOrgProjects = []) => {
    const lead = context;
    const callSettings = campaign?.call_settings || {};

    // Primary project: lead's own if it's in campaign projects, else first campaign project, else lead's project
    const primaryProject = campaignProjects.find(p => p.id === lead.project_id)
        || campaignProjects[0]
        || lead.project
        || {};

    const voice = callSettings.voice_id || 'shimmer';
    const langCode = callSettings.language === 'english' ? 'en'
        : callSettings.language === 'gujarati' ? 'gu'
        : 'hi';

    // VAD: 40% of silence_timeout, capped at 1000ms to balance responsiveness vs noise tolerance
    const silenceDurationMs = Math.min(
        callSettings.silence_timeout ? Math.round(callSettings.silence_timeout * 1000 * 0.4) : 600,
        1000
    );

    // "Other projects" = org projects not covered by this campaign
    const campaignProjectIdSet = new Set(campaignProjects.map(p => p.id));
    const otherOrgProjects = allOrgProjects.filter(p => !campaignProjectIdSet.has(p.id));
    const projectsText = otherOrgProjects.length > 0
        ? otherOrgProjects.slice(0, 3).map(p => `- ${p.name}: ${p.locality || p.city || p.description || ''}`).join('\n')
        : 'No other projects at this time.';

    const nowIST = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    const tomorrowISO = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const firstName = lead.name?.split(' ')[0] || '';
    const orgName = campaign?.organization?.name || 'hamari company';

    const knownPrefs = [];
    
    // Combine Property Type details (e.g. "2BHK Villa residential")
    const propDetails = [lead.preferred_configuration, lead.preferred_property_type, lead.preferred_category]
        .filter(Boolean).join(' ');
    
    if (propDetails) knownPrefs.push(`Looking for: ${propDetails}`);
    if (lead.preferred_transaction_type) knownPrefs.push(`Transaction: Wants to ${lead.preferred_transaction_type}`);
    if (lead.preferred_location) knownPrefs.push(`Preferred Area: ${lead.preferred_location}`);
    const formatMoney = (val) => {
        const num = Number(val);
        if (isNaN(num) || !val) return val;
        if (num >= 10000000) return `₹${+(num / 10000000).toFixed(2)}Cr`;
        if (num >= 100000) return `₹${+(num / 100000).toFixed(2)}L`;
        if (num >= 1000) return `₹${+(num / 1000).toFixed(1)}K`;
        return `₹${num}`;
    };

    if (lead.budget_range || (lead.min_budget && lead.max_budget)) {
        const bdg = lead.budget_range || `${formatMoney(lead.min_budget)} to ${formatMoney(lead.max_budget)}`;
        knownPrefs.push(`Budget: ${bdg}`);
    }
    if (lead.preferred_timeline) knownPrefs.push(`Moving Timeline: ${lead.preferred_timeline}`);

    const prefsText = knownPrefs.length > 0 
        ? `\n\n# KNOWN LEAD PREFERENCES (DO NOT ASK FOR THESE AGAIN)\n${knownPrefs.join('\n')}\nSince you already know these details, DO NOT ask them what type of house they are looking for or what their budget is. Instead, acknowledge it naturally and smoothly move to pitching suitable options.`
        : '';

    const qualifyInstruction = knownPrefs.length > 0
        ? `2. QUALIFY gently — You already know their preferences. Acknowledge what they are looking for (e.g. "To aap ${lead.preferred_configuration || 'property'} dekh rahe the ${lead.preferred_location || ''} mein...") and ask if they are still looking or have found something.`
        : `2. QUALIFY gently — Ask ONE question at a time:\n   - "Kaunse type ka ghar dekhna hai aapko? 2BHK, 3BHK?"\n   - Then budget: "Budget range kya hai aapka roughly?"\n   - Then timeline/preference based on their answers`;

    // Build campaign projects context for system prompt
    const campaignProjectsText = campaignProjects.length > 1
        ? campaignProjects.map((p, i) =>
            `Project ${i + 1}: ${p.name}\n  Location: ${p.locality || p.city || p.address || ''}\n  Status: ${p.construction_status || 'Under Development'}\n  Possession: ${p.possession_date || 'TBD'}`
        ).join('\n\n')
        : `Project: ${primaryProject.name || 'Our Project'}\n  Status: ${primaryProject.construction_status || 'Under Development'}\n  Possession: ${primaryProject.possession_date || 'Ask team for details'}\n  Location: ${primaryProject.locality || primaryProject.city || primaryProject.address || ''}`;

    const campaignScopeText = campaignProjects.length > 1
        ? `You represent ${campaignProjects.length} projects in this campaign:\n${campaignProjects.map((p, i) => `${i + 1}. ${p.name} (${p.locality || p.city || ''})`).join('\n')}\nLead's registered project: ${primaryProject.name || 'one of our projects'}. Start with their project but naturally mention others if they seem interested in options or comparisons.`
        : `You represent: ${primaryProject.name || 'Our Project'}`;

    const systemInstructions = `
# WHO YOU ARE
You are Riya — a friendly, sharp Sales Consultant at ${orgName}.
You're a real person making a quick call to help someone who showed interest in property. You're NOT a bot, NOT a telemarketer, NOT reading from a script.

# HOW YOU SPEAK
${callSettings.language === 'english' ? 'Speak naturally in English. Professional but warm — like a friend who happens to work in real estate.' : callSettings.language === 'gujarati' ? 'Gujarati ma naturally vaat karo. Hindi mix karo jyare jarur pade.' : 'Hinglish — the way real people talk in cities. Mix Hindi and English naturally. NEVER sound formal or rehearsed.'}
CRITICAL: You are female. Always use feminine grammar: "main bata rahi hoon", "karti hoon", "karungi", "deti hoon". Never use male endings.

# YOUR VOICE
- Talk like a real person having a normal conversation. Use natural fillers: "haan ji", "acha", "bilkul", "suno na", "dekho".
- 1-2 SHORT sentences per reply. Never monologue. Never stack multiple questions.
- WAIT for the person to respond before continuing. One thought at a time.
- If they seem busy or distracted, acknowledge it — "Acha aap busy lag rahe ho, koi baat nahi…"
- Mirror their energy. If they're chill, be chill. If they're excited, match it.

# TODAY
${nowIST}, ${timeIST} IST

# YOUR OPENING (pick naturally, don't repeat the same one)
Start with a warm, casual greeting. Examples:
- "Hi ${firstName} ji! Main Riya, ${orgName} se. Kaise hain aap? Aapne property ke baare mein enquiry ki thi na, toh socha ek chhoti si call kar loon."
- "Hello ${firstName} ji! Riya bol rahi hoon ${orgName} se. Bas do minute lagenge — aapne jo property interest dikhaya tha uske baare mein baat karni thi."
- "Hi ${firstName} ji, main Riya hoon ${orgName} se. Hope accha time hai — I just wanted to quickly chat about the property you were looking at."
After greeting, PAUSE and let them respond before asking anything else.

# CAMPAIGN SCOPE
${campaignScopeText}

# WHAT YOU KNOW
${campaignProjectsText}${prefsText}

# YOUR CONVERSATION FLOW
1. GREET warmly (see above). Wait for response.
${qualifyInstruction}
3. CHECK INVENTORY — Call check_detailed_inventory with their preferences. Share 2-3 best options naturally:
   - "Acha suniye, ek 2BHK mil raha hai Tower A mein, 3rd floor, north facing — 75 lakh ka. Kaafi accha unit hai."
4. If the tool returns a note field (like "exact match nahi mila"), acknowledge honestly:
   - "Exact wahi nahi mila, but kuch similar acche options hain — batati hoon…"
5. SITE VISIT — Mention ONCE, naturally:
   "Agar interest ho toh ek baar site visit kar lo — photos se pata nahi chalta. Main slot fix kar sakti hoon."
   - If YES → Ask: "Kaunse din aur kitne baje theek rahega? Subah 11 baje, ya shaam 4 baje?"
   - When they confirm date AND time → immediately call book_site_visit
   - On success → say the scheduled_at_formatted from the result: "Done! [scheduled_at_formatted] ko aapki site visit book ho gayi. Aapka agent confirm karega."
   - If they liked a specific unit (from inventory) → pass that unit_id; otherwise leave it out (project-level visit)
   - If NO or hesitant → DO NOT push again. Offer: "Koi baat nahi, main WhatsApp pe project details bhej deti hoon."
6. WRAP UP — After all goals are done (visit booked / brochure sent / confirmed not interested):
   Say: "Bahut accha laga baat karke! Koi bhi sawaal ho toh call karna. Aapka din accha jaye!"
   Then IMMEDIATELY call disconnect_call with reason='completed'.
   NEVER leave the call hanging after the goodbye. ALWAYS close with disconnect_call.

# HANDLING PUSHBACK (be empathetic, NOT pushy)
- "Sochna hai" → "Bilkul, take your time! Main WhatsApp pe sab details bhej deti hoon — jab ready ho tab baat karte hain."
- "Rate zyada" → "Hmm samajh sakti hoon. Payment plans flexible hain — EMI options bhi hain. Chahein toh details bhej doon?"
- "Budget kam hai" → "No worries, construction-linked plan mein bohot manageable ho jaata hai. Main options bhejti hoon."
- "Family se poochna hai" → "Haan of course! Main brochure WhatsApp kar deti hoon — family ke saath discuss karna easy ho jaayega."
- "Already dekha hai" → "Acha kaunsa project dekha? Main compare karke bata sakti hoon kya better deal mil raha hai."
- "Not interested" → "Bilkul, no problem! Agar future mein kabhi property dekhni ho toh yaad rakhna. Have a nice day!" Then use disconnect_call.
IMPORTANT: Never repeat the same pitch. If they've said no to something, accept it and move on.

# WHATSAPP BROCHURE
If they want details on WhatsApp:
→ Call log_intent with whatsapp_brochure=true
→ "Done ji, main arrange karti hoon! WhatsApp pe aa jaayega."

# TOOL USAGE
- check_detailed_inventory: ALWAYS use config_name for BHK (e.g. "2BHK", "3BHK"). Check before quoting anything.
- log_intent: Call in background after learning their budget, BHK preference, vastu needs, or brochure request.
- book_site_visit: Call ONLY after lead confirms date AND time. Pass unit_id if they liked a specific unit. Returns scheduled_at_formatted — read it back to confirm.
- schedule_callback: If they're busy — "Kab call karun? Shaam ko chalega?" → Use ISO format: "${tomorrowISO}T17:00:00+05:30"
- disconnect_call: Use when — abusive, wrong number, clearly not interested, OR conversation is complete (wrap-up done). ALWAYS call this to end the call.
- transfer_call: When they want price negotiation, booking confirmation, or detailed payment discussion.

# REAL ESTATE KNOWLEDGE
BHK Types: 1BHK, 1.5BHK, 2BHK, 2.5BHK, 3BHK, 3.5BHK, 4BHK, Penthouse
Vastu: East/North-facing preferred
Payment Plans: CLP (Construction Linked), TLP (Time Linked), Down Payment
Home Loans: SBI, HDFC, ICICI, Axis
NRI: FEMA compliant, repatriation allowed

# OTHER PROJECTS
${projectsText}

# CAMPAIGN NOTES
${campaign?.ai_script || 'Help the lead find their ideal property. Be genuine and helpful.'}

# PRICE DISCLOSURE RULE
If a unit's price shows as "PRICE_UNDISCLOSED":
- NEVER reveal, guess, or estimate a price for that unit.
- Say naturally: "Is unit ki pricing ke liye main aapko hamari senior sales team se connect karti hoon — woh best deal discuss kar sakti hain aapke saath."
- Then offer: "Kya main abhi transfer kar doon, ya callback arrange kar doon?"
- If they want a transfer → call transfer_call. If callback → call schedule_callback.

# GOLDEN RULES
1. Sound HUMAN. You're having a conversation, not giving a presentation.
2. ONE question at a time. Wait for the answer.
3. Site visit — mention ONCE only. If declined, don't push.
4. Never repeat yourself. If you already said something, don't say it again.
5. If you don't know something, say "Main check karke batati hoon" — don't make up info.
6. Keep it SHORT. Long responses = instant disconnect by the user.
7. ALWAYS end the call with disconnect_call. Say your goodbye out loud first, let it play, THEN call disconnect_call(reason='completed'). The call MUST be explicitly ended — never let it stay open after the conversation is over.
`.trim();

    return {
        type: 'session.update',
        session: {
            turn_detection: {
                type: 'server_vad',
                threshold: 0.7,
                prefix_padding_ms: 300,
                silence_duration_ms: silenceDurationMs
            },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            modalities: ['text', 'audio'],
            temperature: 0.65,
            input_audio_transcription: { model: 'whisper-1', language: langCode },
            instructions: systemInstructions,
            voice,
            tools: [
                {
                    type: 'function',
                    name: 'transfer_call',
                    description: 'Escalate to a Senior Manager when lead wants to negotiate price, confirm booking, or needs detailed payment plan discussion.',
                    parameters: {
                        type: 'object',
                        properties: {
                            reason: { type: 'string', description: 'Reason for escalation' }
                        },
                        required: ['reason']
                    }
                },
                {
                    type: 'function',
                    name: 'check_detailed_inventory',
                    description: `Search available units. ALWAYS use config_name for BHK (e.g. '2BHK', '2.5BHK'). Never assume availability — check first.${campaignProjects.length > 1 ? ` This campaign covers ${campaignProjects.length} projects: ${campaignProjects.map(p => p.name).join(', ')}. You can specify project_name to search a specific one, or omit to search the lead's primary project.` : ''}`,
                    parameters: {
                        type: 'object',
                        properties: {
                            category: { type: 'string', enum: ['residential', 'commercial', 'land'] },
                            transaction_type: { type: 'string', enum: ['sell', 'rent', 'lease'] },
                            property_type: { type: 'string', description: 'e.g. apartment, villa, penthouse, shop, office, plot' },
                            config_name: { type: 'string', description: "PREFERRED for BHK: '1BHK', '2BHK', '2.5BHK', '3BHK', '4BHK', 'Penthouse'" },
                            bedrooms: { type: 'number', description: 'Only use if config_name is not applicable' },
                            price_min: { type: 'number', description: 'Minimum total price in INR' },
                            price_max: { type: 'number', description: 'Maximum total price in INR' },
                            min_carpet_area: { type: 'number', description: 'Minimum carpet area in sq ft' },
                            is_vastu_compliant: { type: 'boolean' },
                            is_corner: { type: 'boolean' },
                            facing: { type: 'string', description: 'Direction: East, North, West, South, North-East, etc.' },
                            floor_min: { type: 'number' },
                            floor_max: { type: 'number' },
                            ...(campaignProjects.length > 1 ? {
                                project_id: { type: 'string', description: `UUID of a specific campaign project to search. Valid IDs: ${campaignProjects.map(p => p.id).join(', ')}` },
                                project_name: { type: 'string', description: `Name of a campaign project: ${campaignProjects.map(p => `"${p.name}"`).join(', ')}` }
                            } : {})
                        }
                    }
                },
                {
                    type: 'function',
                    name: 'log_intent',
                    description: 'Save lead preferences to CRM. Call mid-call after learning budget, BHK, Vastu needs, or WhatsApp brochure request.',
                    parameters: {
                        type: 'object',
                        properties: {
                            interest_level: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
                            config_preference: { type: 'string', description: "BHK type: '2BHK', '2.5BHK', '3BHK', etc." },
                            category: { type: 'string', enum: ['residential', 'commercial', 'land'] },
                            property_type: { type: 'string', description: 'apartment, villa, plot, office, etc.' },
                            transaction_type: { type: 'string', enum: ['sell', 'rent', 'lease'] },
                            budget_min: { type: 'number', description: 'Minimum budget in INR' },
                            budget_max: { type: 'number', description: 'Maximum budget in INR' },
                            preferred_location: { type: 'string', description: 'Preferred area or locality' },
                            preferred_timeline: { type: 'string', description: 'When they want to buy/move: immediate, 3 months, 6 months, 1 year, etc.' },
                            pain_points: { type: 'array', items: { type: 'string' }, description: 'Concerns or objections raised by lead' },
                            preferred_contact_method: { type: 'string', description: 'call, whatsapp, email' },
                            best_contact_time: { type: 'string', description: 'morning, afternoon, evening' },
                            purchase_readiness: { type: 'string', description: 'AI assessment: ready_to_buy, evaluating, early_stage, not_ready' },
                            whatsapp_brochure: { type: 'boolean', description: 'Set true if lead explicitly asked to send project brochure on WhatsApp' },
                            interested_project_id: { type: 'string', description: 'UUID of the project the lead expressed strong interest in, if different from the current campaign project. Only set when lead clearly prefers a specific other project.' }
                        },
                        required: ['interest_level']
                    }
                },
                {
                    type: 'function',
                    name: 'disconnect_call',
                    description: 'End the call. Use for: abusive user, clearly not interested after 3 genuine attempts, wrong number, or completed conversation.',
                    parameters: {
                        type: 'object',
                        properties: {
                            reason: { type: 'string', enum: ['not_interested', 'wrong_number', 'completed', 'silence', 'abusive'] },
                            abuse_details: { type: 'string', description: 'Brief description (only when reason=abusive)' }
                        },
                        required: ['reason']
                    }
                },
                {
                    type: 'function',
                    name: 'schedule_callback',
                    description: "Schedule a callback when the lead is busy. Compute exact datetime from TODAY's date shown above.",
                    parameters: {
                        type: 'object',
                        properties: {
                            callback_at: {
                                type: 'string',
                                description: `ISO 8601 with IST offset (+05:30). Example for tomorrow 5pm: "${tomorrowISO}T17:00:00+05:30"`
                            }
                        },
                        required: ['callback_at']
                    }
                },
                {
                    type: 'function',
                    name: 'book_site_visit',
                    description: 'Book a site visit for the lead. Call ONLY after the lead has confirmed a specific date AND time. Do not guess — ask and confirm first.',
                    parameters: {
                        type: 'object',
                        properties: {
                            scheduled_date: {
                                type: 'string',
                                description: `Date in YYYY-MM-DD format. Use today's date as reference: ${tomorrowISO.slice(0, 10)} is tomorrow.`
                            },
                            scheduled_time: {
                                type: 'string',
                                description: 'Time in HH:MM 24-hour format (IST). E.g. "11:00" for 11am, "17:30" for 5:30pm.'
                            },
                            unit_id: {
                                type: 'string',
                                description: 'UUID of a specific unit if the lead expressed interest in one (from inventory results). Omit for a general project visit.'
                            },
                            notes: {
                                type: 'string',
                                description: 'Optional notes from the conversation (e.g. preferences, concerns mentioned).'
                            }
                        },
                        required: ['scheduled_date', 'scheduled_time']
                    }
                }
            ]
        }
    };
};
