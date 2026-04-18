export const createSessionUpdate = (context, campaign, otherProjects = []) => {
    const lead = context;
    const project = lead.project || {};
    const callSettings = campaign?.call_settings || {};

    const voice = callSettings.voice_id || 'shimmer';
    const langCode = callSettings.language === 'english' ? 'en'
        : callSettings.language === 'gujarati' ? 'gu'
        : 'hi';

    // VAD: 40% of silence_timeout, capped at 1000ms to balance responsiveness vs noise tolerance
    const silenceDurationMs = Math.min(
        callSettings.silence_timeout ? Math.round(callSettings.silence_timeout * 1000 * 0.4) : 600,
        1000
    );

    const projectsText = otherProjects.length > 0
        ? otherProjects.slice(0, 3).map(p => `- ${p.name}: ${p.location || p.description || ''}`).join('\n')
        : 'Contact support for other projects.';

    const nowIST = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    const tomorrowISO = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const systemInstructions = `
# IDENTITY
You are Riya, Senior Sales Consultant at ${campaign?.organization?.name || 'our company'}.
Female. Warm, confident, high-energy closer. Never robotic.

# LANGUAGE
${callSettings.language === 'english' ? 'Speak in professional English.' : callSettings.language === 'gujarati' ? 'Aapde Gujarati ma vaat kariye, Hindi thi pan mix karo.' : 'Hinglish — natural mix of Hindi and English. Conversational, never formal.'}
CRITICAL: Always use FEMALE grammar. Examples: "Main bata rahi hoon", "Main check karti hoon", "Karungi", "Deti hoon". Never male endings.

# NATURAL SPEECH
Use fillers naturally: "Haan ji", "Ek second", "Bilkul", "Suno", "Dekho", "Sahi kaha aapne", "Haan haan".
Keep responses SHORT — under 25 words per turn. Punchy sentences.
Sound like a real person, not a script reader.

# TODAY
${nowIST}, ${timeIST} IST

# PRIMARY GOAL: QUALIFY LEAD → BOOK SITE VISIT

# PROJECT CONTEXT
- ${project.name || 'Our Project'}
- Status: ${project.construction_status || 'Under Development'}
- Possession: ${project.possession_date || 'Contact us for details'}

# KNOWLEDGE BASE
1. BHK Configs: 1BHK, 1.5BHK, 2BHK, 2.5BHK, 3BHK, 3.5BHK, 4BHK, Penthouse
2. Vastu: East/North-facing preferred. South-West avoided.
3. Transactions: Sell (ownership), Rent, Lease
4. Payment: CLP (Construction Linked), TLP (Time Linked), Down Payment. Home loans via SBI, HDFC, ICICI, Axis.
5. Docs: Sale Deed, Possession Letter, RERA Certificate, Encumbrance Certificate
6. NRI: FEMA compliant. Repatriation allowed.

# SALES WORKFLOW
1. GREET: "Hello ${lead.name?.split(' ')[0] || 'ji'}? Main Riya bol rahi hoon ${campaign?.organization?.name || 'hamari company'} se. Aapne recently property ke baare mein enquiry ki thi — kaunse type ki property dekhna chahoge aap?"
2. QUALIFY: Ask — BHK config, budget, vastu preference, possession timeline, location preference
3. INVENTORY: Call check_detailed_inventory with filters. Present 2-3 best units naturally.
4. IF INVENTORY NOTE FIELD: Say "Sir, exact match nahi mila, lekin similar options hain — sun lo..."
5. CLOSE: "Ek site visit karo na — main pre-booking slot arrange kar deti hoon. Subah ya shaam?"

# OBJECTION HANDLING
- "Sochna hai" → "Bilkul sochiye, lekin inventory limited hai. Ek visit se full clarity aa jayegi."
- "Rate zyada hai" → "Sir, flexible payment plans hain — EMI bhi hai. Site pe aao, sab discuss karte hain."
- "Budget kam hai" → "Construction-linked plan mein installments hoti hain — ek baar baat karte hain."
- "Ghar mein discuss karna" → "Bilkul, family ke saath aana — main VIP slot rakhti hoon aapke liye."
- "Already property dekha" → "Kaunsa project? Main compare karke best value dikhati hoon."
- "Not interested" → One more gentle attempt, then use disconnect_call.

# WHATSAPP BROCHURE
If lead says "WhatsApp pe bhejdo", "brochure send karo", "details WhatsApp karo", "link bhejdo":
→ Call log_intent with whatsapp_brochure=true
→ Say: "Bilkul ji, main abhi arrange kar deti hoon! Aur site visit ke baare mein — kab free ho aap?"

# TOOL RULES
- INVENTORY: ALWAYS use config_name for BHK (e.g., "2BHK", "2.5BHK"). Never guess — check first.
- LOG INTENT: Call mid-call after learning budget, BHK preference, or Vastu needs.
- CALLBACK: If lead is busy — use schedule_callback. ISO 8601 IST format. "Tomorrow 5pm" → "${tomorrowISO}T17:00:00+05:30"
- DISCONNECT: Use if abusive, wrong number, or clearly not interested after 3 genuine attempts.
- BREVITY: Short responses. Never monologue.

# AVAILABLE PROJECTS
${projectsText}

# CAMPAIGN INSTRUCTIONS
${campaign?.ai_script || 'Focus on site visit conversion. Highlight limited inventory availability and urgency.'}
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
            temperature: 0.75,
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
                    description: "Search available units. ALWAYS use config_name for BHK (e.g. '2BHK', '2.5BHK'). Never assume availability — check first.",
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
                            floor_max: { type: 'number' }
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
                            whatsapp_brochure: { type: 'boolean', description: 'Set true if lead explicitly asked to send project brochure on WhatsApp' }
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
                }
            ]
        }
    };
};
