export const createSessionUpdate = (context, campaign, otherProjects = []) => {
    // ⚡ PRE-COMPUTE CONTEXT
    const lead = context;
    const project = lead.project || {};
    
    const projectsText = otherProjects.length > 0
        ? otherProjects.slice(0, 3).map(p => `- ${p.name}: ${p.location}`).join('\n')
        : 'Contact Support for other projects.';

    const systemInstructions = `
# IDENTITY: Riya (Female), Senior Sales Consultant at ${campaign?.organization?.name || 'Quinite'}.
# VOICE: Vibrant, professional, culturally aware. High-energy closer.
# LANGUAGE: Hinglish (Professional conversational mix).
# CRITICAL: Use FEMALE grammar (Ending in 'Rahi hoon', 'Deti hoon', 'Karungi'). NEVER use male endings like 'Karta hoon'.

# PRIMARY OBJECTIVE: 🎯 QUALIFY & SELL THE VISIT. 
- Build urgency: "Sir, inventory bhot fast move ho rahi hai, last few units bachi hain."
- Trust Factor: "Ye project ka location premium hai, future ROI bhot solid rahega."

# TECHNICAL PROPERTY PARAMETERS:
1. **Property Category**:
   - **Residential**: Apartments, Villas, Penthouses.
   - **Commercial**: Shops, Showrooms, Offices.
   - **Land**: Residential or Commercial Plots.
2. **Architecture & Choice**:
   - **Vastu Compliance**: East-facing, South-West entry etc. (Critical for most Indian families).
   - **Corner Units**: Offer better ventilation/privacy (Sell as a premium option).
   - **Facing**: Direction of the balcony/entry (East/North/etc).
   - **Config Names**: 1BHK, 1.5BHK, 2BHK, 3.5BHK, 4BHK (Derive from unit_configs).
   - **Transaction**: Buying (Sell), Renting, or Leasing (Lease).
3. **Project Stats**:
   - **Status**: ${project.construction_status || 'Under development'}.
   - **Possession**: ${project.possession_date || 'check with senior'}.

# SALES GUIDELINES:
1. **The Hook**: "Hello ${lead.name?.split(' ')[0] || 'Sir'}? Riya bol rahi hoon... aapne recently hamari property enquiries check kari thi?"
2. **The Qualify**: Ask for Type (Home/Office/Plot), BHK preferred (1BHK/2BHK), Budget, and Vastu needs.
3. **The Pivot**: 
   - Vastu? "Ji, East-facing entry wali limited units available hain."
   - Floor? "Lower floors convenience ke liye best hain, par higher floors se view bhot shandar milega."
4. **The Close**: "Aap kal physical visit kar lo, main ek pre-booking slot arrange karwa deti hoon... kis time aaoge?"

# STRICT RULES:
- **TOOL USAGE**: Use 'check_detailed_inventory' with ALL parameters (vastu, corner, facing) if the lead specifies them.
- **DATA CAPTURE**: Use 'log_intent' mid-call to save lead specifications (BHK, Vastu, Budget).
- **BREVITY**: Keep responses under 20 words for natural flow. Use fillers like "Ji", "Bilkul", "I understand".

# OTHER PROJECTS:
${projectsText}

# CAMPAIGN SCRIPT: 
${campaign.ai_script || 'Focus on site visit conversion.'}
`.trim();

    return {
        type: "session.update",
        session: {
            turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            modalities: ["text", "audio"],
            temperature: 0.75,
            input_audio_transcription: { model: "whisper-1", language: "hi" },
            instructions: systemInstructions,
            voice: "shimmer",
            tools: [
                {
                    type: "function",
                    name: "transfer_call",
                    description: "Escalate to a Senior Manager for deep negotiation or booking confirmations.",
                    parameters: {
                        type: "object",
                        properties: { reason: { type: "string" } },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "check_detailed_inventory",
                    description: "Advanced search for units using all REVAMP criteria: category, transaction, configuration (1BHK/2BHK), vastu, corner, or facing.",
                    parameters: {
                        type: "object",
                        properties: { 
                            category: { type: "string", enum: ["residential", "commercial", "land"] },
                            transaction_type: { type: "string", enum: ["sell", "rent", "lease"] },
                            property_type: { type: "string", description: "e.g. apartment, villa, office" },
                            config_name: { type: "string", description: "e.g. 1BHK, 2.5BHK, 4BHK" },
                            bedrooms: { type: "number" },
                            price_min: { type: "number" },
                            price_max: { type: "number" },
                            min_carpet_area: { type: "number" },
                            is_vastu_compliant: { type: "boolean" },
                            is_corner: { type: "boolean" },
                            facing: { type: "string", description: "Direction like East, North-East etc." },
                            floor_min: { type: "number" },
                            floor_max: { type: "number" }
                        }
                    }
                },
                {
                    type: "function",
                    name: "log_intent",
                    description: "CRITICAL: Capture lead specifics in CRM during call: BHK, Vastu, Facing, and Budget.",
                    parameters: {
                        type: "object",
                        properties: { 
                            interest_level: { type: "string", enum: ["high", "medium", "low"] },
                            config_preference: { type: "string", description: "e.g. 2BHK, 3BHK" },
                            is_vastu_required: { type: "boolean" },
                            preferred_facing: { type: "string" },
                            category: { type: "string", enum: ["residential", "commercial", "land"] },
                            transaction_type: { type: "string", enum: ["sell", "rent", "lease"] },
                            budget_min: { type: "number" },
                            budget_max: { type: "number" },
                            pain_points: { type: "array", items: { type: "string" } }
                        },
                        required: ["interest_level"]
                    }
                },
                {
                    type: "function",
                    name: "disconnect_call",
                    description: "End the call if user is Abusive or clearly Not Interested.",
                    parameters: {
                        type: "object",
                        properties: { reason: { type: "string", enum: ["not_interested", "wrong_number", "completed", "silence"] } },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "schedule_callback",
                    description: "Set a time to call back if lead is busy.",
                    parameters: {
                        type: "object",
                        properties: { time: { type: "string" } },
                        required: ["time"]
                    }
                }
            ]
        }
    };
};
