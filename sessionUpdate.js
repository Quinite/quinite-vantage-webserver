export const createSessionUpdate = (lead, campaign, otherProjects = [], availableInventory = []) => {
    // ⚡ PRE-COMPUTE CONTEXT FOR SPEED
    const inventoryText = availableInventory.length > 0
        ? availableInventory.slice(0, 5).map(p => `- ${p.unit_number}: ${p.bedrooms}BHK, ₹${(p.price / 100000).toFixed(1)}L (${p.status})`).join('\n')
        : 'None available currently (Sold Out).';

    const projectsText = otherProjects.length > 0
        ? otherProjects.slice(0, 3).map(p => `- ${p.name}: ${p.location}`).join('\n')
        : 'No other projects.';

    return {
        type: "session.update",
        session: {
            // OPTIMIZED FOR LOW LATENCY SALES ⚡
            turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500
            },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            modalities: ["text", "audio"],
            temperature: 0.6,
            input_audio_transcription: { model: "whisper-1", language: "hi" },

            instructions: `
# IDENTITY: Riya (Female), Casual Real Estate Consultant.
# STYLE: Hinglish (Hindi-English mix). 
# CRITICAL: Use FEMALE grammar (Ending in 'Rahi hoon', 'Deti hoon', 'Karungi'). NEVER say 'Karta hoon' or 'Aaunga'.

# GOAL: Qualify interest in ${lead?.project?.name || 'this project'} in 90 seconds. 
- If Interested: Tell about availability/price.
- If Hot: Say "Senior ko line pe leti hoon" & call transfer_call.
- If Not Interested: Say "Theek hai, bye!" & call disconnect_call.

# MAIN PROJECT: ${lead?.project?.name || 'N/A'}
- Location: ${lead?.project?.location || 'Vapi'}
- Details: ${lead?.project?.description || ''}

# AVAILABLE UNITS:
${inventoryText}

# ALTERNATIVES:
${projectsText}

# RULES:
1. SPEAK FIRST! Say "Hello ${lead?.name?.split(' ')[0] || 'Sir'}? Hi, main Riya bol rahi hoon from ${campaign?.organization?.name || 'Quinite'}."
2. One sentence responses. NO LECTURES.
3. If user is silent, say "Aawaz aa rahi hai?"
4. Use check_unit_availability if they ask about specific numbers.
5. Use schedule_callback if they are busy.
6. Use update_lead_status for every outcome.

# IMMEDIATE GREETING NOW!
`.trim(),
            voice: "coral",
            tools: [
                {
                    type: "function",
                    name: "transfer_call",
                    description: "Connect to human senior manager for hot leads.",
                    parameters: {
                        type: "object",
                        properties: { reason: { type: "string" } },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "disconnect_call",
                    description: "End call for lost leads or abuse.",
                    parameters: {
                        type: "object",
                        properties: { reason: { type: "string", enum: ["not_interested", "abusive", "wrong_number"] } },
                        required: ["reason"]
                    }
                },
                {
                    type: "function",
                    name: "update_lead_status",
                    description: "Save lead interest level.",
                    parameters: {
                        type: "object",
                        properties: { status: { type: "string", enum: ["contacted", "qualified", "lost"] }, notes: { type: "string" } },
                        required: ["status"]
                    }
                },
                {
                    type: "function",
                    name: "check_unit_availability",
                    description: "Check if unit is still available.",
                    parameters: {
                        type: "object",
                        properties: { unit_number: { type: "string" } },
                        required: ["unit_number"]
                    }
                },
                {
                    type: "function",
                    name: "schedule_callback",
                    description: "Set a time to call back.",
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
