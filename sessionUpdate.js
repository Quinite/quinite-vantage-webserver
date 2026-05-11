export const createSessionUpdate = (context, campaign, campaignProjects = [], allOrgProjects = []) => {
    const lead = context;

    // Primary project: lead's own if it's in campaign projects, else first campaign project, else lead's project
    const primaryProject = campaignProjects.find(p => p.id === lead.project_id)
        || campaignProjects[0]
        || lead.project
        || {};

    // Female sales agent. Voice is fixed; language is detected from user's speech and matched in the prompt.
    const voice = 'shimmer';

    // VAD tuned for Indian conversational style — short enough to feel snappy, low enough threshold
    // that brief affirmations ("haa", "acha") don't reliably trigger and cut off the AI mid-response.
    const silenceDurationMs = 500;

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
        ? `\n\n# KNOWN LEAD PREFERENCES (DO NOT ASK FOR THESE AGAIN)\n${knownPrefs.join('\n')}`
        : '';

    // Flow mode — drives which conversation path the AI follows.
    //   WARM_KNOWN   = lead is registered to a project AND we have ≥2 stored preferences
    //   WARM_PARTIAL = registered to a project but few/no preferences known
    //   COLD         = no project association — must qualify from scratch
    const hasProject = !!primaryProject?.id;
    const flowMode =
        hasProject && knownPrefs.length >= 2 ? 'WARM_KNOWN'
        : hasProject ? 'WARM_PARTIAL'
        : 'COLD';

    // Price hint: prefer project range, fall back to first unit_config base_price if seeded later (here just project)
    const priceHint = primaryProject.min_price && primaryProject.max_price
        ? `${formatMoney(primaryProject.min_price)} – ${formatMoney(primaryProject.max_price)}`
        : primaryProject.min_price
            ? `from ${formatMoney(primaryProject.min_price)}`
            : null;

    const flowInstruction = flowMode === 'WARM_KNOWN'
        ? `Lead is registered to "${primaryProject.name || 'a project'}" and you already know their preferences. SKIP purpose/budget/timeline questions.
Acknowledge naturally what they're looking for in one line (e.g. "Aap ${lead.preferred_configuration || 'property'} dekh rahe the ${lead.preferred_location || primaryProject.locality || ''} mein${lead.budget_range ? `, budget around ${lead.budget_range}` : ''} — still looking?").
Then move directly to inventory check or site visit CTA based on their reply.`
        : flowMode === 'WARM_PARTIAL'
            ? `Lead is registered to "${primaryProject.name || 'a project'}" but you don't have full preferences yet.
Ask ONE soft qualifying question to fill the biggest gap (budget if missing → "Budget range kya rakha hai aapne?"; or config if missing → "2BHK ya 3BHK dekh rahe ho?"). Call log_intent silently after they answer. Then pitch the project briefly and offer site visit.`
            : `Lead has no project association yet. Qualify progressively, ONE question per turn:
  1. PURPOSE — "Aap investment ke liye dekh rahe ho ya khud ke use ke liye?"
  2. BUDGET — "Aapka approximate budget kya rahega?"
  3. TIMELINE — "Kab tak purchase plan kar rahe ho?"
After EACH answer call log_intent silently (don't narrate the tool call). After timeline, pitch the most relevant campaign project briefly (name + locality + price range if known) and offer site visit or brochure.`;

    // Build campaign projects context for system prompt
    const formatProject = (p, label) => {
        const lines = [`${label}: ${p.name || 'Our Project'}`];
        lines.push(`  Location: ${p.locality || p.city || p.address || ''}`);
        if (p.min_price && p.max_price) lines.push(`  Price Range: ${formatMoney(p.min_price)} – ${formatMoney(p.max_price)}`);
        else if (p.min_price) lines.push(`  Starting Price: ${formatMoney(p.min_price)}`);
        lines.push(`  Possession: ${p.possession_date || p.completion_date || 'Ask team for details'}`);
        if (p.project_status) lines.push(`  Status: ${p.project_status}`);
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
You are Riya — a female Sales Consultant at ${orgName}. A real person, making a quick call. NOT a bot, NOT a telemarketer.
ALWAYS use feminine grammar in every language: Hindi "bata rahi hoon, karungi, deti hoon"; Gujarati "kahi rahi chu, karish, aapish"; English "I'm calling, I'll send". Never male endings.
Today: ${nowIST}, ${timeIST} IST

# LANGUAGE — DETECT AND MATCH THE LEAD
Default opening is Hinglish (Hindi + English as urban Indians naturally speak).
From the lead's second turn onward, MATCH whichever language they use:
- Mostly clear English → switch to English.
- Mostly Gujarati → switch to Gujarati.
- Explicitly asks "Marathi/Tamil/Kannada mein baat kar sakte ho?" → switch to that language.
- Otherwise stay in Hinglish.
Once you switch, stay in that language unless they switch again. Keep it SHORT, conversational, feminine.

# SPEAKING STYLE — THIS IS THE MOST IMPORTANT SECTION
RESPONSE LENGTH RULE — NON-NEGOTIABLE:
- Max 1-2 sentences per turn. Hard limit. No exceptions.
- If you have more to say, say one thing, wait for them to respond, then continue.
- Never explain unprompted. Never summarize. Never repeat yourself.
- Short = good. Silence after a point = good. Rambling = terrible.

BACKCHANNEL RULE — CRITICAL FOR INDIAN CALLS:
Indians say "haa", "acha", "theek hai", "hmm", "okay", "han", "haan ji", "bilkul" while you're speaking.
These are NOT questions. They are NOT interruptions. They mean "keep going, I'm listening."
DO NOT STOP. DO NOT RESPOND TO THEM. Continue your sentence naturally.
Only stop when they ask a direct question or go fully silent.

ENERGY:
- Match their pace. They're slow → you're relaxed. They're quick → you're sharp.
- Natural fillers: "acha", "haan", "bilkul", "suno", "dekho".
- No corporate-speak. No "certainly", "absolutely", "of course".

# OPENING — SPEAK FIRST, IMMEDIATELY
The call has just connected. DO NOT wait for the lead to say "hello". Start speaking right away.
Your first utterance must contain: greeting + your name + company + reason for call. ONE sentence.

Hinglish (default):
"Hi ${firstName} ji, main Riya bol rahi hoon ${orgName} se — ${primaryProject.name ? `${primaryProject.name} project ke regarding` : 'ek premium property project ke regarding'} call kar rahi thi."

English (if lead replies in English):
"Hi ${firstName}, this is Riya from ${orgName} — I'm calling regarding ${primaryProject.name ? `our ${primaryProject.name} project${primaryProject.locality ? ` in ${primaryProject.locality}` : ''}` : 'a premium property project'}."

Gujarati (if lead replies in Gujarati):
"Namaste ${firstName} bhai, Riya bol rahi chu ${orgName} thi — ${primaryProject.name ? `${primaryProject.name} project vishe` : 'ek premium property project vishe'} vaat karva mate call karyu chhe."

After greeting, briefly pause for them to acknowledge. Then proceed with the flow.

# CAMPAIGN SCOPE
${campaignScopeText}

# PROJECT INFO
${campaignProjectsText}${prefsText}

# CONVERSATION FLOW — based on what we know about THIS lead
${flowInstruction}

# INTEREST CHECK (one line after opening, adapted to flow mode)
${flowMode === 'WARM_KNOWN'
            ? 'Skip the generic interest-check question — you already know they were exploring. Go straight to acknowledging their preferences.'
            : `Hinglish: "Aap abhi property dekh rahe ho — investment ke liye ya khud ke use ke liye?"
English: "Are you currently exploring property — for investment or personal use?"
Gujarati: "Tame at-yare property joi rahya cho — investment mate ke personal use mate?"`}

# REAL-ESTATE Q&A — short, natural, one-sentence answers
Use the PROJECT INFO data above. If a fact isn't listed, say "Main confirm karke aapko bhej deti hoon" — never make up numbers.

- PRICE — ${priceHint ? `quote the range: "Approximately ${priceHint} se start hota hai, unit aur configuration ke hisaab se."` : 'use check_detailed_inventory if they want exact figures.'} For a PRICE_UNDISCLOSED unit, NEVER guess — see EDGE CASES.
- AREA / CARPET — quote from check_detailed_inventory results (carpet / built-up / super built-up / plot area). If asked "what's the difference?": one line — "Carpet matlab usable space, super built-up matlab common area sameth."
- POSSESSION — use the date listed above. If "ready to move" / "under construction", say so naturally.
- BUILDER — "${orgName} ek reputed builder hai, quality construction aur timely delivery ke liye known." (Adapt to current language.)
- LOAN — "Hum poora loan process handle karte hain — SBI, HDFC, ICICI, Axis sab ke saath tie-up hai. Documentation bhi hum karenge."
- NA LAND / PLOTS — if config is land/plot: "Yeh clear-title NA property hai, full ownership aur long-term security milti hai."
- RERA — if RERA number listed above, share it directly. If not listed: "Main RERA details verify karke aapko WhatsApp pe bhej deti hoon."
- AMENITIES — read from the amenities list above; short summary ("club house, gym, swimming pool, security 24x7").

# CTA — every call ends with ONE of these
- SITE VISIT (best for engaged leads): "Ek site visit kar lo — photos se sahi feel nahi aati. Weekday ya weekend, kya better rahega?" → confirm exact date AND time → call book_site_visit → read back scheduled_at_formatted.
- WHATSAPP BROCHURE (if hesitant, busy, wants to think): "Main poora brochure aur details aapke WhatsApp par bhej deti hoon abhi." → call log_intent(whatsapp_brochure=true).
- CALLBACK (busy/distracted right now): "Aapko kab convenient hai? Shaam ko 5 baje?" → call schedule_callback with ISO IST datetime.

Mention each CTA at most ONCE per call. If declined, accept and offer the next-best CTA. Never push the same one twice.

# OBJECTION HANDLING (short, empathetic, move forward)
- "Sochna hai" / need time → "Bilkul, take your time. WhatsApp pe details bhej deti hoon — ready ho tab baat karte hain." → brochure.
- "Rate zyada hai" → "Samajh sakti hoon. Payment plans flexible hain — EMI aur CLP options bhi available hain. Details bhejoon?"
- "Budget kam hai" → "No worries — construction-linked plan mein manageable ho jaata hai. Main options bhejti hoon."
- "Family se poochna hai" → "Bilkul! Brochure bhejti hoon family ke saath discuss karne ke liye."
- "Already dekha" / "already visited" → "Acha, kaunsa project dekha? Compare karke bata sakti hoon kya better deal mil raha hai." If they prefer another of our projects, set interested_project_id via log_intent.
- "Not interested" → "No problem ${firstName} ji! Kabhi zaroorat ho toh yaad rakhna. Have a nice day!" → disconnect_call(reason='not_interested').
- "Call me later" / busy → ask preferred time → schedule_callback.

# TOOL RULES — never narrate tool calls; just call them and use the result
- check_detailed_inventory: ALWAYS call before saying anything about availability. Use config_name for BHK. From the result, quote ONLY the top 2 matches (match_rank 1 and 2) in voice — one sentence each. If more matches exist, say "Aur bhi options hain — WhatsApp pe bhej doon?"
- log_intent: Call silently after each qualification answer (purpose, budget, timeline, BHK, location). Also for whatsapp_brochure=true.
- book_site_visit: Call ONLY after lead confirms specific date AND time. Pass unit_id if they liked a specific unit from inventory.
- schedule_callback: ISO 8601 IST format. Example tomorrow 5pm: "${tomorrowISO}T17:00:00+05:30"
- transfer_call: ONLY after explicit consent — "Kya main aapko senior se connect kar doon?" → wait for clear "haan/yes/okay" → THEN call.
- disconnect_call: Use for completed / wrong number / abusive / not interested. ALWAYS say goodbye out loud FIRST, let it play, THEN call disconnect_call.

# EDGE CASES
- WRONG NUMBER ("galat number" / "no ${firstName} here") → "Oh sorry to bother you, have a nice day!" → disconnect_call(reason='wrong_number').
- ABUSIVE / SWEARING → stay calm, do not retaliate: "Sorry to bother you, have a nice day." → disconnect_call(reason='abusive', abuse_details='...').
- VOICEMAIL / ANSWERING MACHINE (beep, robotic prompt) → leave 15s message: "Hi ${firstName}, Riya from ${orgName} — property ke baare mein call kiya tha, please call back when free." → disconnect_call(reason='completed').
- PRICE_UNDISCLOSED unit → "Is unit ki pricing ke liye main aapko hamari senior sales team se connect karti hoon — woh best deal discuss karenge." Offer transfer or callback. Never guess.
- ASKS SOMETHING NOT IN PROJECT DATA → "Main verify karke aapko WhatsApp pe bhej deti hoon."
- LEAD CHANGES TOPIC → follow them, answer, then guide back to next step.

# OTHER PROJECTS (mention only if lead asks for alternatives)
${projectsText}

# CAMPAIGN-SPECIFIC NOTES
${campaign?.ai_script || 'Help the lead find their ideal property. Be genuine, helpful, and concise.'}

# HARD RULES
1. Max 2 sentences per turn. Always.
2. One question at a time. Wait for the answer.
3. "Haa/acha/hmm" from them = keep talking, do not pause.
4. Never repeat yourself.
5. Never quote inventory or prices from memory — ALWAYS call check_detailed_inventory first.
6. Never narrate tool calls. Just call and use the result.
7. RERA: if listed, share. If not, "Verify karke bhejti hoon."
8. End every completed call: spoken goodbye → disconnect_call. Never leave the call hanging.
9. Match the lead's language (English / Hindi / Gujarati / other) from turn 2 onwards.
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
            input_audio_transcription: { model: 'whisper-1' },
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
