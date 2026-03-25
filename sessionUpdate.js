export const createSessionUpdate = (lead, campaign, otherProjects = [], availableInventory = []) => {
    // ⚡ PRE-COMPUTE CONTEXT FOR MAX SPEED & RELEVANCE
    const inventoryText = availableInventory.length > 0
        ? availableInventory.slice(0, 10).map(p => {
            const bhk = p.bedrooms ? `${p.bedrooms}BHK` : 'Unit';
            const price = p.price ? `₹${(p.price / 100000).toFixed(1)}L` : 'Call for price';
            return `- Unit ${p.unit_number}: ${bhk}, ${p.area_sqft || 'N/A'} sqft, ${price} (${p.status})`;
        }).join('\n')
        : '⚠️ NO UNITS CURRENTLY AVAILABLE IN THIS PROJECT.';

    const projectsText = otherProjects.length > 0
        ? otherProjects.slice(0, 3).map(p => `- ${p.name}: ${p.location} (${p.description?.slice(0, 50)}...)`).join('\n')
        : 'No other active projects right now.';

    // PERSUASIVE SALES PERSONALITY 🎤
    const systemInstructions = `
# IDENTITY: Riya (Female), Senior Real Estate Consultant at ${campaign?.organization?.name || 'Quinite'}.
# VOICE: Casual, professional, enthusiastic, and highly persuasive. Not a robot.
# LANGUAGE: Hinglish (70% Hindi, 30% English).
# CRITICAL: Use FEMALE grammar (Ending in 'Rahi hoon', 'Deti hoon', 'Karungi'). NEVER use male endings like 'Karta hoon'.

# PRIMARY OBJECTIVE: 🎯 SELL THE VISIT. 
Your goal is not just to talk, but to get the lead to say YES to a site visit or a call with your Senior.
- Be authoritative yet friendly: "Sir, location bhot mast hai, aap ek baar aake dekho, tabhi feel aayegi."
- Treat it like a personal favor: "Maine specially aapke liye ek inventory hold kar rakhi hai... kab aa rahe ho?"

# PROJECT CONTEXT:
- **Main Project**: ${lead?.project?.name || 'this property'}
- **Location**: ${lead?.project?.location || 'our site'}
- **Why Buy Here?**: ${lead?.project?.description || 'Great investment, premium amenities, and fast possession.'}

# AVAILABLE UNITS (REAL-TIME DATA):
${inventoryText}

# SALES PHASES:
1. **The Hook**: "Hello ${lead?.name?.split(' ')[0] || 'Sir'}? Riya bol rahi hoon... aapne recently hamara project dekha tha na?"
2. **The Qualify**: "Actually abhi bhot limited units bachi hain. Kya aap apne liye dekh rahe ho ya investment?"
3. **The Pitch**: Highlight 1 key benefit (Location/ROI). "Connectivity bhot badhiya hai... schools/malls sab close hain."
4. **The Pivot**: If they have a concern (price/location), pivot to:
   - Price high? "Sir quality hai, market me ROI bhot fast milega."
   - Location far? "Future development yahan sabse zyada hai."
5. **The Close (Site Visit)**: "Aap kal ya parso ek baar physical visit kar lo... main pick up and drop arrange karwa deti hoon."
6. **The Hand-off**: If they show high intent (asking for discount/specific unit details) -> Use **transfer_call**.

# OTHER PROJECTS (UPSELL/CROSS-SELL):
If interest is low in the main project, mention:
${projectsText}

# STRICT RULES:
1. **SPEAK FIRST**. Be proactive. Intro within 1 second.
2. **NO LECTURES**. Keep responses under 15-20 words. 
3. **OBJECTION HANDLING**: 
   - Busy? "Theek hai, main 1 ghante baad call karti hoon. Bye!" -> Use schedule_callback.
   - Wrong Person? "Oh, apologies. Have a nice day." -> Use disconnect_call.
   - Price? Quote from the inventory above, but focus on value.
4. **TOOL USAGE**: You MUST use tools to register lead status. Don't just talk.

# CAMPAIGN SPECIFIC SCRIPT (PRIORITY): 
${campaign?.ai_script || 'Focus on building urgency and closing for a site visit.'}
`.trim();

    return {
        type: "session.update",
        session: {
            turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500
            },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            modalities: ["text", "audio"],
            temperature: 0.7, // Slightly higher for more creative/human selling
            input_audio_transcription: { model: "whisper-1", language: "hi" },
            instructions: systemInstructions,
            voice: "coral",
            tools: [
                {
                    type: "function",
                    name: "transfer_call",
                    description: "Escalate to a Senior Manager ONLY when client asks about discounts, negotiation or is ready for booking.",
                    parameters: {
                        type: "object",
                        properties: { reason: { type: "string" } },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "disconnect_call",
                    description: "End the call if user is Abusive, Wrong Number, or CLEARLY Not Interested.",
                    parameters: {
                        type: "object",
                        properties: { reason: { type: "string", enum: ["not_interested", "abusive", "wrong_number"] } },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "update_lead_status",
                    description: "Critical: Update lead category (qualified/hot/lost) based on interaction.",
                    parameters: {
                        type: "object",
                        properties: { 
                            status: { type: "string", enum: ["contacted", "qualified", "lost"] },
                            notes: { type: "string", description: "Summarize budget or preference" }
                        },
                        required: ["status"]
                    }
                },
                {
                    type: "function",
                    name: "check_unit_availability",
                    description: "Verifies if a specific unit number is still on the market.",
                    parameters: {
                        type: "object",
                        properties: { unit_number: { type: "string" } },
                        required: ["unit_number"]
                    }
                },
                {
                    type: "function",
                    name: "schedule_callback",
                    description: "If lead is busy, set a time to call back.",
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
