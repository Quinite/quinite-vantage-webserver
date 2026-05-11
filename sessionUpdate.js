export const createSessionUpdate = (context, campaign, campaignProjects = [], allOrgProjects = []) => {
    const lead = context;
    const callSettings = campaign?.call_settings || {};

    // Primary project: lead's own if it's in campaign projects, else first campaign project, else lead's project
    const primaryProject = campaignProjects.find(p => p.id === lead.project_id)
        || campaignProjects[0]
        || lead.project
        || {};

    // Language and voice are fixed defaults while UI selectors are hidden
    const voice = 'shimmer';
    const langCode = 'hi';

    // VAD tuning for Indian conversational style:
    // - silence_duration_ms: 500ms — short enough to feel snappy but not cut off mid-sentence
    // - threshold: 0.55 — lower than before so brief affirmations ("haa", "acha") don't reliably
    //   trigger speech_started and cancel the AI mid-response; real speech is louder and sustained
    // - prefix_padding_ms: 150ms — capture actual speech start without false triggers
    const silenceDurationMs = Math.min(
        callSettings.silence_timeout ? Math.round(callSettings.silence_timeout * 1000 * 0.35) : 500,
        700
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
    const formatProject = (p, label) => {
        const lines = [`${label}: ${p.name || 'Our Project'}`];
        lines.push(`  Location: ${p.locality || p.city || p.address || ''}`);
        lines.push(`  Possession: ${p.possession_date || 'Ask team for details'}`);
        if (p.description) lines.push(`  About: ${p.description}`);
        if (p.rera_number) lines.push(`  RERA: ${p.rera_number}`);
        if (p.amenities) lines.push(`  Amenities: ${Array.isArray(p.amenities) ? p.amenities.join(', ') : p.amenities}`);
        return lines.join('\n');
    };

    const campaignProjectsText = campaignProjects.length > 1
        ? campaignProjects.map((p, i) => formatProject(p, `Project ${i + 1}`)).join('\n\n')
        : formatProject(primaryProject, 'Project');

    const campaignScopeText = campaignProjects.length > 1
        ? `You represent ${campaignProjects.length} projects in this campaign:\n${campaignProjects.map((p, i) => `${i + 1}. ${p.name} (${p.locality || p.city || ''})`).join('\n')}\nLead's registered project: ${primaryProject.name || 'one of our projects'}. Start with their project but naturally mention others if they seem interested in options or comparisons.`
        : `You represent: ${primaryProject.name || 'Our Project'}`;

    const systemInstructions = `
# WHO YOU ARE
Riya — Sales Consultant at ${orgName}. Real person, quick call. NOT a bot.
Female. Always feminine grammar: "bata rahi hoon", "karungi", "deti hoon". Never male endings.
Today: ${nowIST}, ${timeIST} IST

# SPEAKING STYLE — THIS IS THE MOST IMPORTANT SECTION
Hinglish. Cities mein log kaise bolte hain, exactly that.

RESPONSE LENGTH RULE — NON-NEGOTIABLE:
- Max 1-2 sentences per turn. Hard limit. No exceptions.
- If you have more to say, say one thing, wait for them to respond, then continue.
- Never explain, never summarize, never repeat what you just said.
- Short = good. Silence from you after a point = good. Rambling = terrible.

BACKCHANNEL RULE — CRITICAL FOR INDIAN CALLS:
Indian people say "haa", "acha", "theek hai", "hmm", "okay", "han", "haan ji" while you're speaking.
These are NOT questions. They are NOT interruptions. They mean "keep going, I'm listening."
When you hear these — DO NOT STOP. DO NOT RESPOND TO THEM. Continue your sentence naturally.
Only stop and respond when they ask a direct question or go silent for a moment.

ENERGY:
- Match their pace. They're slow → you're relaxed. They're quick → you're sharp.
- Fillers: "acha", "haan", "bilkul", "suno", "dekho" — use them, sound alive.
- No corporate-speak. No "certainly", "absolutely", "of course".

# OPENING
ONE of these (vary it, pick what feels right):
- "Hi ${firstName} ji! Main Riya, ${orgName} se — aapne property dekhi thi na, toh bas ek quick call."
- "Hello ${firstName} ji, Riya bol rahi hoon ${orgName} se. Bas do minute — property wali baat karni thi."
Then STOP. Wait for them.

# CAMPAIGN SCOPE
${campaignScopeText}

# PROJECT INFO
${campaignProjectsText}${prefsText}

# CONVERSATION FLOW
1. Greet (one line). Wait.
${qualifyInstruction}
3. Inventory — ALWAYS call check_detailed_inventory before saying anything about availability. Never assume. Share max 2 options, one sentence each.
4. If tool note says "exact match nahi mila" — say so honestly, offer closest alternatives.
5. Site visit — mention ONCE: "Site visit karoge? Main slot fix kar sakti hoon."
   - YES → "Kaunse din? Subah ya shaam?" → confirm date+time → call book_site_visit → read back scheduled_at_formatted.
   - NO → "Theek hai, WhatsApp pe details bhejti hoon." → log_intent(whatsapp_brochure=true). Move on. Don't push again.
6. Done → "Accha, bahut accha laga baat karke! Take care!" → call disconnect_call(reason='completed').

# PUSHBACK (short, empathetic, move on)
- "Sochna hai" → "Bilkul. WhatsApp pe bhejti hoon details."
- "Rate zyada" → "Payment plans flexible hain — EMI options bhi hain. Details bhejoon?"
- "Budget kam" → "CLP plan mein manageable ho jaata hai. Options bhejti hoon."
- "Family se poochna" → "Haan! Brochure bhejti hoon, easy rahega discuss karna."
- "Already dekha" → "Kaunsa project? Compare karke bata sakti hoon."
- "Not interested" → "No problem! Kabhi zaroorat ho toh call karna." → disconnect_call.

# TOOLS
- check_detailed_inventory: config_name for BHK ("2BHK", "3BHK"). Always before quoting availability.
- log_intent: After learning budget, BHK, vastu preference, or brochure request.
- book_site_visit: Only after lead confirms date AND time. Pass unit_id if specific unit liked.
- schedule_callback: If busy — "Kab call karun?" → ISO: "${tomorrowISO}T17:00:00+05:30"
- disconnect_call: Abusive, wrong number, not interested, or call complete.
- transfer_call: Ask "Kya connect kar doon senior se?" → wait for clear yes → THEN call. Never without confirmation.

# REAL ESTATE KNOWLEDGE
BHK Types: 1BHK, 1.5BHK, 2BHK, 2.5BHK, 3BHK, 3.5BHK, 4BHK, Penthouse
Vastu: East/North-facing preferred
Payment Plans: CLP (Construction Linked), TLP (Time Linked), Down Payment
Home Loans: SBI, HDFC, ICICI, Axis
RERA: If a lead asks about RERA registration, refer to the RERA number in the project details above. If RERA is listed, confirm it's RERA registered and share the number. If not listed, say "Main RERA details verify karke aapko bhejti hoon" — never make up a number.
# PRICE UNDISCLOSED
If price = "PRICE_UNDISCLOSED": "Pricing ke liye senior team se connect karti hoon — woh best deal discuss karenge." Offer transfer or callback.

# OTHER PROJECTS
${projectsText}

# CAMPAIGN NOTES
${campaign?.ai_script || 'Help the lead find their ideal property. Be genuine and helpful.'}

# HARD RULES
1. Max 2 sentences. Always. No monologues.
2. One question at a time.
3. "Haa/acha/hmm" from them = keep talking, don't pause.
4. Never repeat yourself.
5. Never make up inventory. Always call the tool.
6. RERA: If listed above, confirm and share number. If not → "Verify karke bhejti hoon."
7. End every completed call: say goodbye out loud → then call disconnect_call.
`.trim();

    return {
        type: 'session.update',
        session: {
            turn_detection: {
                type: 'server_vad',
                threshold: 0.55,
                prefix_padding_ms: 150,
                silence_duration_ms: silenceDurationMs
            },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            modalities: ['text', 'audio'],
            temperature: 0.7,
            max_response_output_tokens: 150,
            input_audio_transcription: { model: 'whisper-1', language: langCode },
            instructions: systemInstructions,
            voice,
            tools: [
                {
                    type: 'function',
                    name: 'transfer_call',
                    description: 'Transfer to a Senior Manager ONLY after the lead has explicitly agreed to be transferred. You MUST first ask "Kya main aapko hamare senior manager se connect kar doon?" (or equivalent in the call language) and wait for a clear "yes/haan/okay/please" before calling this tool. Never call this mid-sentence or without explicit confirmation.',
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
