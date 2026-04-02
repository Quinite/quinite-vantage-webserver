const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin';
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';

function buildProjectsText(otherProjects) {
    if (!otherProjects.length) return 'Focus on the current project only unless the lead asks for alternatives.';

    return otherProjects
        .slice(0, 3)
        .map((project) => `- ${project.name}: ${project.location || 'Location unavailable'}`)
        .join('\n');
}

function buildInstructions(context, campaign, otherProjects) {
    const lead = context;
    const project = lead.project || {};
    const firstName = lead.name?.split(' ')?.[0] || 'Sir';

    return `
You are Riya, a female senior real-estate sales consultant for ${campaign?.organization?.name || 'Quinite'}.
Speak in concise professional Hinglish, always using feminine grammar.
Keep replies short, natural, and phone-friendly. Avoid long monologues.

Primary goal:
- qualify the lead
- answer project questions accurately
- move the lead toward a site visit or callback

Lead:
- name: ${lead.name || 'Unknown'}
- phone: ${lead.phone || 'Unknown'}

Current project:
- name: ${project.name || 'Current project'}
- location: ${project.location || 'Location unavailable'}
- status: ${project.construction_status || 'Under development'}
- possession: ${project.possession_date || 'Check with senior'}

Conversation approach:
- Start with: "Hello ${firstName}, Riya bol rahi hoon. Aapne recently property enquiry ki thi?"
- Confirm interest before pitching.
- Ask only one or two questions at a time.
- Capture budget, unit preference, transaction type, vastu/facing, and callback timing when relevant.
- If the lead sounds busy, offer a callback quickly.
- If the lead asks for inventory specifics, use the available tools instead of guessing.

Tool rules:
- Use check_detailed_inventory for specific inventory requests.
- Use log_intent once meaningful preferences are known.
- Use schedule_callback if the lead is busy.
- Use disconnect_call only for wrong number, explicit refusal, abuse, or prolonged silence.
- Use transfer_call only when the lead is highly interested or asks for a human closer.

Other active projects:
${buildProjectsText(otherProjects)}

Campaign guidance:
${campaign.ai_script || 'Focus on helpful qualification and site visit conversion.'}
    `.trim();
}

export const createSessionUpdate = (context, campaign, otherProjects = []) => {
    const instructions = buildInstructions(context, campaign, otherProjects);

    return {
        type: 'session.update',
        session: {
            type: 'realtime',
            model: REALTIME_MODEL,
            output_modalities: ['audio'],
            audio: {
                input: {
                    format: {
                        type: 'audio/pcmu'
                    },
                    turn_detection: {
                        type: 'semantic_vad',
                        create_response: true,
                        interrupt_response: true
                    },
                    transcription: {
                        model: TRANSCRIPTION_MODEL,
                        language: 'hi'
                    }
                },
                output: {
                    format: {
                        type: 'audio/pcmu'
                    },
                    voice: REALTIME_VOICE
                }
            },
            instructions,
            tools: [
                {
                    type: 'function',
                    name: 'transfer_call',
                    description: 'Escalate to a senior human agent for high-intent or negotiation-ready leads.',
                    parameters: {
                        type: 'object',
                        properties: {
                            reason: { type: 'string' }
                        },
                        required: ['reason']
                    }
                },
                {
                    type: 'function',
                    name: 'check_detailed_inventory',
                    description: 'Search available units using category, transaction, BHK/config, price, vastu, facing, corner, and floor preferences.',
                    parameters: {
                        type: 'object',
                        properties: {
                            category: { type: 'string', enum: ['residential', 'commercial', 'land'] },
                            transaction_type: { type: 'string', enum: ['sell', 'rent', 'lease'] },
                            property_type: { type: 'string', description: 'For example apartment, villa, office, shop.' },
                            config_name: { type: 'string', description: 'For example 1BHK, 2BHK, 3.5BHK.' },
                            bedrooms: { type: 'number' },
                            price_min: { type: 'number' },
                            price_max: { type: 'number' },
                            min_carpet_area: { type: 'number' },
                            is_vastu_compliant: { type: 'boolean' },
                            is_corner: { type: 'boolean' },
                            facing: { type: 'string' },
                            floor_min: { type: 'number' },
                            floor_max: { type: 'number' }
                        }
                    }
                },
                {
                    type: 'function',
                    name: 'log_intent',
                    description: 'Persist the lead preferences and buying intent captured during the call.',
                    parameters: {
                        type: 'object',
                        properties: {
                            interest_level: { type: 'string', enum: ['high', 'medium', 'low'] },
                            config_preference: { type: 'string' },
                            is_vastu_required: { type: 'boolean' },
                            preferred_facing: { type: 'string' },
                            category: { type: 'string', enum: ['residential', 'commercial', 'land'] },
                            transaction_type: { type: 'string', enum: ['sell', 'rent', 'lease'] },
                            budget_min: { type: 'number' },
                            budget_max: { type: 'number' },
                            pain_points: { type: 'array', items: { type: 'string' } }
                        },
                        required: ['interest_level']
                    }
                },
                {
                    type: 'function',
                    name: 'disconnect_call',
                    description: 'End the call when the lead is not interested, it is a wrong number, or the call is silent.',
                    parameters: {
                        type: 'object',
                        properties: {
                            reason: { type: 'string', enum: ['not_interested', 'wrong_number', 'completed', 'silence'] }
                        },
                        required: ['reason']
                    }
                },
                {
                    type: 'function',
                    name: 'schedule_callback',
                    description: 'Store a callback time when the lead asks to speak later.',
                    parameters: {
                        type: 'object',
                        properties: {
                            time: { type: 'string' }
                        },
                        required: ['time']
                    }
                }
            ]
        }
    };
};
