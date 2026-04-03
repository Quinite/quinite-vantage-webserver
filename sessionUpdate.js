export const createSessionUpdate = (context, campaign, otherProjects = []) => {
    // ⚡ PRE-COMPUTE CONTEXT
    const lead = context;
    const project = lead.project || {};
    const callSettings = campaign?.call_settings || {};

    // Voice & language from campaign call_settings
    const voice = callSettings.voice_id || 'shimmer';
    const langCode = callSettings.language === 'english' ? 'en'
        : callSettings.language === 'gujarati' ? 'gu'
        : 'hi'; // hinglish and hindi both use hindi ASR

    // VAD silence duration (ms) — 40% of silence_timeout, capped at 1000ms
    const silenceDurationMs = Math.min(
        callSettings.silence_timeout ? Math.round(callSettings.silence_timeout * 1000 * 0.4) : 600,
        1000
    );

    const projectsText = otherProjects.length > 0
        ? otherProjects.slice(0, 3).map(p => `- ${p.name}: ${p.location}`).join('\n')
        : 'Contact Support for other projects.';

    // Current date/time in IST for callback scheduling context
    const nowIST = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    const tomorrowISO = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const systemInstructions = `
# IDENTITY: Riya (Female), Senior Sales Consultant at ${campaign?.organization?.name || 'our company'}.
# VOICE: Vibrant, professional, culturally aware. High-energy closer.
# LANGUAGE: ${callSettings.language === 'english' ? 'English (professional)' : callSettings.language === 'gujarati' ? 'Gujarati mixed with Hindi' : 'Hinglish (natural conversational mix of Hindi + English)'}.
# CRITICAL: Use FEMALE grammar endings ('Rahi hoon', 'Deti hoon', 'Karungi'). NEVER use male endings.

# TODAY: ${nowIST}, ${timeIST} IST

# PRIMARY OBJECTIVE: QUALIFY THE LEAD & CONVERT TO SITE VISIT.
- Build urgency: "Sir, inventory bohot fast move ho rahi hai, last few units bachi hain."
- Trust Factor: "Ye project premium location pe hai, future ROI solid rahega."

# PROPERTY KNOWLEDGE BASE:
1. **Category**: Residential (Apartments/Villas/Penthouses), Commercial (Shops/Showrooms/Offices), Land (Plots).
2. **BHK Configurations**: 1BHK, 1.5BHK, 2BHK, 2.5BHK, 3BHK, 3.5BHK, 4BHK, Penthouse.
   - IMPORTANT: ALWAYS use 'check_detailed_inventory' with config_name for BHK queries (e.g. config_name="2.5BHK"). NEVER guess availability — check the database first.
3. **Vastu**: East/North-facing entry preferred. South-West entry avoided.
4. **Transaction**: Sell (ownership), Rent, Lease.
5. **Payment Plans**: Construction-Linked Plan (CLP), Time-Linked Plan, Down Payment Plan. Home loans available via SBI, HDFC, ICICI, Axis.
6. **Legal Documents**: Sale Deed, Possession Letter, Completion Certificate, RERA Registration, Encumbrance Certificate, Title Deed.
7. **RERA**: Project must be RERA registered. Buyer has right to compensation for delays.
8. **NRI Buyers**: FEMA compliant purchase. Repatriation of sale proceeds allowed.
9. **Project Info**:
   - Status: ${project.construction_status || 'Under Development'}.
   - Possession: ${project.possession_date || 'Check with senior consultant'}.

# SALES WORKFLOW:
1. **Hook**: "Hello ${lead.name?.split(' ')[0] || 'ji'}? Riya bol rahi hoon, ${campaign?.organization?.name || 'hamari company'} se. Aapne recently hamari property enquiry ki thi, aapko kaunse type ki property chahiye?"
2. **Qualify**: Ask — Type (Home/Office/Plot), BHK Config, Budget Range, Vastu preference, Possession timeline.
3. **Inventory Check**: Use 'check_detailed_inventory' with ALL known filters. Present 2-3 best matching units.
4. **Handle Objections**:
   - "Sochna hai": "Bilkul, lekin inventory limited hai — ek site visit se clarity aa jayegi."
   - "Budget kam hai": "Sir, flexible payment plans hain — CLP mein construction ke saath installments hote hain."
   - "Already dekha": "Kaunsa project? Main compare karke best value dikhati hoon."
5. **Close**: "Aap kal ek visit kar lo — main pre-booking slot arrange kar deti hoon. Subah ya shaam, kis time aayoge?"

# CRITICAL TOOL RULES:
- **BHK SEARCH**: ALWAYS use config_name="2BHK" / "2.5BHK" etc. in check_detailed_inventory. NEVER use bedrooms field for BHK.
- **LOG INTENT**: Use 'log_intent' mid-call after learning budget, BHK preference, or Vastu needs.
- **CALLBACK**: If lead is busy, use 'schedule_callback'. Compute callback_at as ISO 8601 with IST offset. Example: "tomorrow 5pm" → "${tomorrowISO}T17:00:00+05:30".
- **DISCONNECT**: Use 'disconnect_call' if: user is abusive, clearly not interested after 3 attempts, or wrong number.
- **BREVITY**: Keep each response under 25 words. Use fillers: "Ji", "Bilkul", "Haan", "Sahi kaha aapne".
- **DO NOT**: Never make up prices or availability. Always check inventory first before telling the lead.

# AVAILABLE PROJECTS:
${projectsText}

# CUSTOM SCRIPT FROM CAMPAIGN MANAGER:
${campaign?.ai_script || 'Focus on site visit conversion. Highlight limited inventory availability.'}
`.trim();

    return {
        type: "session.update",
        session: {
            turn_detection: {
                type: "server_vad",
                threshold: 0.7,           // Higher = less noise-triggered interruptions
                prefix_padding_ms: 300,
                silence_duration_ms: silenceDurationMs
            },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            modalities: ["text", "audio"],
            temperature: 0.75,
            input_audio_transcription: { model: "whisper-1", language: langCode },
            instructions: systemInstructions,
            voice: voice,
            tools: [
                {
                    type: "function",
                    name: "transfer_call",
                    description: "Escalate to a Senior Manager when lead wants to negotiate price, confirm booking, or needs detailed payment plan discussion.",
                    parameters: {
                        type: "object",
                        properties: { reason: { type: "string", description: "Reason for escalation" } },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "check_detailed_inventory",
                    description: "Search available units. ALWAYS use config_name for BHK queries (e.g. '2BHK', '2.5BHK'). Never assume availability — always check.",
                    parameters: {
                        type: "object",
                        properties: {
                            category: { type: "string", enum: ["residential", "commercial", "land"] },
                            transaction_type: { type: "string", enum: ["sell", "rent", "lease"] },
                            property_type: { type: "string", description: "e.g. apartment, villa, penthouse, shop, office, plot" },
                            config_name: { type: "string", description: "PREFERRED for BHK: '1BHK', '2BHK', '2.5BHK', '3BHK', '4BHK', 'Penthouse'" },
                            bedrooms: { type: "number", description: "Only use if config_name is not applicable" },
                            price_min: { type: "number", description: "Minimum total price in INR" },
                            price_max: { type: "number", description: "Maximum total price in INR" },
                            min_carpet_area: { type: "number", description: "Minimum carpet area in sq ft" },
                            is_vastu_compliant: { type: "boolean" },
                            is_corner: { type: "boolean" },
                            facing: { type: "string", description: "Direction: East, North, West, South, North-East, etc." },
                            floor_min: { type: "number" },
                            floor_max: { type: "number" }
                        }
                    }
                },
                {
                    type: "function",
                    name: "log_intent",
                    description: "Save lead's preferences to CRM mid-call. Use after learning budget, BHK preference, or Vastu needs.",
                    parameters: {
                        type: "object",
                        properties: {
                            interest_level: { type: "string", enum: ["high", "medium", "low"] },
                            config_preference: { type: "string", description: "BHK type preferred, e.g. '2BHK', '2.5BHK'" },
                            is_vastu_required: { type: "boolean" },
                            preferred_facing: { type: "string" },
                            category: { type: "string", enum: ["residential", "commercial", "land"] },
                            transaction_type: { type: "string", enum: ["sell", "rent", "lease"] },
                            budget_min: { type: "number", description: "Minimum budget in INR" },
                            budget_max: { type: "number", description: "Maximum budget in INR" },
                            pain_points: { type: "array", items: { type: "string" }, description: "Concerns or objections raised" }
                        },
                        required: ["interest_level"]
                    }
                },
                {
                    type: "function",
                    name: "disconnect_call",
                    description: "End the call. Use for: abusive user, clearly not interested after 3 genuine attempts, wrong number, or conversation completed.",
                    parameters: {
                        type: "object",
                        properties: {
                            reason: { type: "string", enum: ["not_interested", "wrong_number", "completed", "silence", "abusive"] },
                            abuse_details: { type: "string", description: "Brief description of abusive behavior (only when reason=abusive)" }
                        },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "schedule_callback",
                    description: "Schedule a callback when the lead is currently busy. Compute exact datetime from TODAY's date above.",
                    parameters: {
                        type: "object",
                        properties: {
                            callback_at: {
                                type: "string",
                                description: "ISO 8601 datetime with IST offset (+05:30). Compute from user's request using TODAY's date shown above. Example for tomorrow 5pm: '${tomorrowISO}T17:00:00+05:30'"
                            }
                        },
                        required: ["callback_at"]
                    }
                }
            ]
        }
    };
};
