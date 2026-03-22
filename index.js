import { createClient } from '@supabase/supabase-js';
import WebSocket, { WebSocketServer } from 'ws';
import express from 'express';
import https from 'https';
import fs from 'fs';
import dotenv from 'dotenv';
import plivo from 'plivo';
import OpenAI from 'openai';
import { createSessionUpdate } from './sessionUpdate.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = https.createServer({
    key: fs.readFileSync('/etc/letsencrypt/live/server.vantage.quinite.co/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/server.vantage.quinite.co/fullchain.pem')
}, app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

const PORT = parseInt(process.env.PORT) || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Create Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Create OpenAI client for sentiment analysis
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

console.log('🚀 Starting WebSocket Server...');
console.log(`📡 Port: ${PORT}`);
console.log(`🔑 OpenAI API Key: ${OPENAI_API_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`🗄️  Supabase URL: ${SUPABASE_URL ? '✅ Set' : '❌ Missing'}`);
console.log(`🌐 Next.js Site URL: ${process.env.NEXT_PUBLIC_SITE_URL || '❌ Missing (Critical for Webhooks)'}`);

// Health check endpoint
app.get('/', (req, res) => {
    console.log('📍 Health check requested');
    res.send('OK');
});

app.get('/health', (req, res) => {
    console.log('📍 Health check requested');
    res.send('OK');
});

// Handle Plivo Answer URL - Generates XML for Call Streaming
app.all('/answer', (req, res) => {
    // Plivo sends parameters in body (POST) or query (GET)
    const callUuid = req.body.CallUUID || req.query.CallUUID;

    // Custom parameters passed via the Answer URL query string
    const leadId = req.query.leadId || req.body.leadId;
    const campaignId = req.query.campaignId || req.body.campaignId;

    console.log(`\n📞 [${callUuid}] Received Answer URL request`);
    console.log(`   Lead ID: ${leadId}`);
    console.log(`   Campaign ID: ${campaignId}`);

    if (!leadId || !campaignId) {
        console.warn(`⚠️  [${callUuid}] Missing leadId or campaignId in Answer URL`);
    }

    // Construct the WebSocket URL with necessary parameters
    const headers = req.headers;
    const host = headers.host;
    const protocol = headers['x-forwarded-proto'] === 'https' ? 'wss' : 'wss'; // Default to wss

    const wsUrl = `${protocol}://${host}:10000/voice/stream?leadId=${leadId}&campaignId=${campaignId}&callSid=${callUuid}`;

    // XML requires & to be escaped as &amp;
    const xmlWsUrl = wsUrl.replace(/&/g, '&amp;');

    console.log(`🔗 [${callUuid}] Generated Stream URL: ${wsUrl}`);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
        ${xmlWsUrl}
    </Stream>
</Response>`;

    res.set('Content-Type', 'text/xml');
    res.send(xml.trim());
});

// Handle WebSocket upgrade manually
server.on('upgrade', (request, socket, head) => {
    console.log(`\n🔄 [WS Server] Upgrade request received for: ${request.url}`);
    console.log(`   Headers: ${JSON.stringify(request.headers)}`);

    if (request.url.startsWith('/voice/stream')) {
        console.log('✅ [WS Server] Valid WebSocket path, handling upgrade...');
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log('✅ [WS Server] WebSocket Connection Established!');
            wss.emit('connection', ws, request);
        });
    } else {
        console.log(`❌ [WS Server] Invalid WebSocket path: ${request.url}`);
        socket.destroy();
    }
});

// ============================================================================
// SENTIMENT ANALYSIS & LEAD SCORING (India Edition)
// ============================================================================

/**
 * Analyze conversation sentiment using OpenAI
 * Supports Hindi/Hinglish conversations
 * Detects Indian property terms (BHK, sqft, lakh, crore)
 */
async function analyzeSentiment(transcript, leadId, callLogId, organizationId, callSid) {
    try {
        console.log(`🧠 [${callSid}] Analyzing sentiment...`);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "system",
                content: `You are analyzing a real estate sales conversation in India. The conversation may be in Hindi, Hinglish (Hindi-English mix), or English.

Analyze the conversation and return ONLY a JSON object with these fields:
{
  "sentiment_score": <number between -1 and 1>,
  "sentiment_label": <"very_positive" | "positive" | "neutral" | "negative" | "very_negative">,
  "primary_emotion": <"excited" | "interested" | "hesitant" | "frustrated" | "confused" | "angry" | "neutral">,
  "intent": <"wants_callback" | "ready_to_buy" | "just_browsing" | "not_interested" | "needs_info">,
  "interest_level": <"high" | "medium" | "low" | "none">,
  "purchase_readiness": <"immediate" | "short_term" | "long_term" | "not_ready">,
  "objections": <array of strings like ["price_concern", "location_issue", "timing_not_right"]>,
  "budget_mentioned": <boolean>,
  "budget_range": <string in format "₹X - ₹Y" or null>,
  "timeline_mentioned": <boolean>,
  "timeline": <string like "within 1 month" or null>,
  "key_phrases": <array of important phrases from conversation>,
  "recommended_action": <string describing next best action>
}

Look for Indian property terms:
- BHK (bedroom-hall-kitchen)
- sqft, square feet
- lakh, crore (Indian number system)
- locality, area names
- amenities (parking, gym, club)

Consider cultural context:
- Family involvement in decisions
- Budget discussions may be indirect
- Interest shown through questions about amenities`
            }, {
                role: "user",
                content: `Analyze this conversation:\n\n${transcript}`
            }],
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        const analysis = JSON.parse(completion.choices[0].message.content);
        console.log(`✅ [${callSid}] Sentiment: ${analysis.sentiment_label} (${analysis.sentiment_score})`);
        console.log(`   Interest: ${analysis.interest_level} | Intent: ${analysis.intent}`);

        // Calculate priority score
        const priorityScore = calculatePriorityScore(analysis);

        // Save to conversation_insights
        const { data, error } = await supabase
            .from('conversation_insights')
            .insert({
                organization_id: organizationId,
                call_log_id: callLogId,
                lead_id: leadId,
                overall_sentiment: analysis.sentiment_score,
                sentiment_label: analysis.sentiment_label,
                primary_emotion: analysis.primary_emotion,
                intent: analysis.intent,
                interest_level: analysis.interest_level,
                objections: analysis.objections || [],
                budget_mentioned: analysis.budget_mentioned || false,
                budget_range: analysis.budget_range,
                timeline_mentioned: analysis.timeline_mentioned || false,
                timeline: analysis.timeline,
                key_phrases: analysis.key_phrases || [],
                recommended_action: analysis.recommended_action,
                priority_score: priorityScore
            })
            .select()
            .single();

        if (error) {
            console.error(`❌ [${callSid}] Failed to save insights:`, error.message);
            return null;
        }

        console.log(`✅ [${callSid}] Insights saved | Priority: ${priorityScore}/100`);

        // Update call_logs with sentiment
        await supabase
            .from('call_logs')
            .update({
                sentiment_score: analysis.sentiment_score,
                interest_level: analysis.interest_level,
                conversation_summary: analysis.recommended_action
            })
            .eq('id', callLogId);

        // Update lead with insights
        await supabase
            .from('leads')
            .update({
                interest_level: analysis.interest_level,
                purchase_readiness: analysis.purchase_readiness,
                budget_range: analysis.budget_range,
                last_sentiment_score: analysis.sentiment_score,
                total_calls: supabase.raw('total_calls + 1')
            })
            .eq('id', leadId);

        return data;
    } catch (error) {
        console.error(`❌ [${callSid}] Sentiment analysis error:`, error.message);
        return null;
    }
}

/**
 * Calculate priority score (0-100) for lead prioritization
 */
function calculatePriorityScore(analysis) {
    let score = 50; // Base score

    // Sentiment impact (20 points)
    if (analysis.sentiment_score > 0.7) score += 20;
    else if (analysis.sentiment_score > 0.3) score += 10;
    else if (analysis.sentiment_score < -0.3) score -= 10;

    // Interest level (30 points)
    if (analysis.interest_level === 'high') score += 30;
    else if (analysis.interest_level === 'medium') score += 15;
    else if (analysis.interest_level === 'low') score -= 10;

    // Purchase readiness (30 points)
    if (analysis.purchase_readiness === 'immediate') score += 30;
    else if (analysis.purchase_readiness === 'short_term') score += 20;
    else if (analysis.purchase_readiness === 'long_term') score += 10;

    // Budget mentioned (10 points)
    if (analysis.budget_mentioned) score += 10;

    // Timeline mentioned (10 points)
    if (analysis.timeline_mentioned) score += 10;

    // Objections penalty
    if (analysis.objections && analysis.objections.length > 2) score -= 10;

    // Ensure score is between 0-100
    return Math.max(0, Math.min(100, score));
}

/**
 * Get appropriate pipeline stage for a lead based on outcome
 * @param {string} leadId - Lead ID
 * @param {string} outcome - Outcome type: 'qualified', 'contacted', 'lost', 'converted'
 * @returns {Promise<string|null>} - Stage ID or null
 */
async function getPipelineStageForOutcome(leadId, outcome) {
    try {
        // Get lead's current pipeline
        const { data: lead, error: leadError } = await supabase
            .from('leads')
            .select('stage_id, pipeline_stages!inner(pipeline_id)')
            .eq('id', leadId)
            .single();

        if (leadError || !lead) {
            console.error(`❌ Failed to get lead pipeline:`, leadError?.message);
            return null;
        }

        const pipelineId = lead.pipeline_stages.pipeline_id;

        // Map outcomes to stage name patterns
        const stagePatterns = {
            'qualified': ['%qualified%', '%interested%', '%hot%'],
            'contacted': ['%contacted%', '%in contact%', '%follow%'],
            'lost': ['%lost%', '%closed lost%', '%disqualified%', '%dead%'],
            'converted': ['%won%', '%converted%', '%closed won%', '%success%']
        };

        const patterns = stagePatterns[outcome] || ['%contacted%'];

        // Try to find matching stage
        for (const pattern of patterns) {
            const { data: stage } = await supabase
                .from('pipeline_stages')
                .select('id')
                .eq('pipeline_id', pipelineId)
                .ilike('name', pattern)
                .limit(1)
                .single();

            if (stage) {
                console.log(`✅ Found stage for outcome '${outcome}': ${stage.id}`);
                return stage.id;
            }
        }

        // Fallback: keep current stage
        console.warn(`⚠️  No matching stage found for outcome '${outcome}', keeping current stage`);
        return lead.stage_id;

    } catch (error) {
        console.error(`❌ Error getting pipeline stage:`, error.message);
        return null;
    }
}


// Start OpenAI Realtime WebSocket connection
const startRealtimeWSConnection = async (plivoWS, leadId, campaignId, callSid) => {
    console.log(`\n🎯 [${callSid}] ===== STARTING REALTIME CONNECTION =====`);
    console.log(`📊 [${callSid}] Lead ID: ${leadId}`);
    console.log(`📊 [${callSid}] Campaign ID: ${campaignId}`);

    try {
        // 1. Start OpenAI Connection IMMEDIATELY (Parallel to DB) 🚀
        console.log(`🔌 [${callSid}] Connecting to OpenAI Realtime API...`);
        const realtimeWS = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview',
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'OpenAI-Beta': 'realtime=v1'
                }
            }
        );

        const wsOpenPromise = new Promise((resolve, reject) => {
            realtimeWS.on('open', () => resolve());
            realtimeWS.on('error', (err) => reject(err));
        });

        // 2. Parallelize Data Fetching (Lead & Campaign)
        const dbFetchPromise = Promise.all([
            supabase.from('leads').select('*, project:projects(*)').eq('id', leadId).single(),
            supabase.from('campaigns').select('*, organization:organizations(*)').eq('id', campaignId).single()
        ]);


        // Wait for DB Data first (needed for Prompt)
        const [leadResult, campaignResult] = await dbFetchPromise;

        if (leadResult.error) throw new Error(`Lead error: ${leadResult.error.message}`);
        if (campaignResult.error) throw new Error(`Campaign error: ${campaignResult.error.message}`);

        const lead = leadResult.data;
        const campaign = campaignResult.data;

        console.log(`✅ [${callSid}] Data fetched: ${lead.name}, Campaign: ${campaign.name}`);

        // 4. Wait for OpenAI WebSocket to open (CRITICAL!)
        await wsOpenPromise;
        console.log(`✅ [${callSid}] OpenAI Connected!`);

        // 5. Send Session Update IMMEDIATELY (without projects for speed)
        console.log(`⚡ [${callSid}] Sending session update (fast path)...`);
        const quickSessionUpdate = createSessionUpdate(lead, campaign, []); // Empty projects for speed
        realtimeWS.send(JSON.stringify(quickSessionUpdate));

        // 6. Trigger AI greeting IMMEDIATELY (no delay!)
        console.log(`🎤 [${callSid}] Triggering AI greeting NOW...`);
        realtimeWS.send(JSON.stringify({ type: 'response.create' }));

        // 7. Fetch projects AND inventory in background (parallel for speed)
        const projectsPromise = supabase
            .from('projects')
            .select('name, description, status, location')
            .eq('organization_id', campaign.organization_id)
            .eq('status', 'active');

        const inventoryPromise = supabase
            .from('properties')
            .select('id, title, type, status, price, size_sqft, bedrooms, bathrooms, address')
            .eq('project_id', lead.project_id)
            .eq('status', 'available');

        Promise.all([projectsPromise, inventoryPromise])
            .then(([projectsResult, inventoryResult]) => {
                const otherProjects = projectsResult.data || [];
                const availableInventory = inventoryResult.data || [];

                console.log(`📋 [${callSid}] Loaded ${otherProjects.length} other projects`);
                console.log(`🏠 [${callSid}] Loaded ${availableInventory.length} available properties with ${availableInventory.reduce((sum, p) => sum + (p.property_units?.length || 0), 0)} units`);

                // Update session with full context
                const fullSessionUpdate = createSessionUpdate(lead, campaign, otherProjects, availableInventory);
                realtimeWS.send(JSON.stringify(fullSessionUpdate));
            })
            .catch(err => {
                console.error(`❌ [${callSid}] Background fetch error:`, err);
            });

        // 8. Create Call Log in Background (fire-and-forget)
        const callLogPromise = supabase
            .from('call_logs')
            .insert({
                organization_id: campaign.organization_id,
                project_id: campaign.project_id,
                campaign_id: campaignId,
                lead_id: leadId,
                call_sid: callSid,
                call_status: 'in_progress',
                direction: 'outbound',
                caller_number: campaign.caller_id || process.env.PLIVO_PHONE_NUMBER,
                callee_number: lead.phone
            })
            .select()
            .single()
            .then(({ data, error }) => {
                if (error) console.error(`❌ [${callSid}] Log Error:`, error.message);
                else console.log(`✅ [${callSid}] Log Created: ${data.id}`);
                return data;
            });

        // 📊 Track Call Attempt
        const attemptPromise = callLogPromise.then(async (callLog) => {
            if (!callLog) return null;

            // Count previous attempts for this lead
            const { count } = await supabase
                .from('call_attempts')
                .select('*', { count: 'exact', head: true })
                .eq('lead_id', leadId)
                .eq('campaign_id', campaignId);

            const attemptNumber = (count || 0) + 1;

            const { data, error } = await supabase
                .from('call_attempts')
                .insert({
                    organization_id: campaign.organization_id,
                    lead_id: leadId,
                    campaign_id: campaignId,
                    call_log_id: callLog.id,
                    attempt_number: attemptNumber,
                    channel: 'voice_ai',
                    attempted_at: new Date().toISOString(),
                    outcome: 'in_progress'
                })
                .select()
                .single();

            if (error) {
                console.error(`❌ [${callSid}] Attempt tracking error:`, error.message);
            } else {
                console.log(`✅ [${callSid}] Call attempt #${attemptNumber} tracked`);
            }

            return data;
        });

        let conversationTranscript = '';

        // Continue with event handlers... (Remove duplicate 'open' handler since we handled it)
        // We attached a one-time listener for the promise. The socket is already open.

        realtimeWS.on('close', () => {
            console.log(`🔌 [${callSid}] OpenAI connection closed`);
        });

        realtimeWS.on('error', (error) => {
            console.error(`❌ [${callSid}] OpenAI WebSocket error:`, error.message);
        });

        realtimeWS.on('message', async (message) => {
            try {
                const response = JSON.parse(message);

                switch (response.type) {
                    case 'session.updated':
                        console.log(`✅ [${callSid}] Session updated successfully`);
                        break;

                    case 'response.function_call_arguments.done':
                        if (response.name === 'transfer_call') {
                            const args = JSON.parse(response.arguments);
                            console.log(`📞 [${callSid}] Initiating Call Transfer to ${args.department || 'Support'} (Reason: ${args.reason})`);

                            // Initialize Plivo Client
                            const plivoClient = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

                            // 1. DYNAMIC AGENT SELECTION (Round Robin / Random)
                            let transferNumber = process.env.PLIVO_TRANSFER_NUMBER || '+918035740007'; // Fallback
                            let agentName = 'Support';

                            try {
                                // Fetch all active agents in this organization
                                const { data: agents, error: agentError } = await supabase
                                    .from('profiles')
                                    .select('phone, full_name, role')
                                    .eq('organization_id', campaign.organization_id)
                                    .not('phone', 'is', null) // Must have a phone number
                                    .eq('role', 'employee'); // RESTRICTION: Only transfer to 'employee' role

                                if (agentError) {
                                    console.error(`⚠️ [${callSid}] Failed to fetch agents:`, agentError.message);
                                } else if (agents && agents.length > 0) {
                                    console.log(`ℹ️ [${callSid}] Found ${agents.length} active agents.`);
                                    // 🎲 Pick a Random Agent (Simple Round Robin)
                                    // Improvement: We could store 'last_call_at' to pick the idle one.
                                    const randomAgent = agents[Math.floor(Math.random() * agents.length)];

                                    if (randomAgent.phone) {
                                        transferNumber = randomAgent.phone;
                                        agentName = randomAgent.full_name || 'Sales Agent';
                                        console.log(`🎯 [${callSid}] Selected Agent: ${agentName} (${transferNumber})`);
                                    } else {
                                        console.warn(`⚠️ [${callSid}] Selected agent ${randomAgent.full_name} has no phone number.`);
                                    }
                                } else {
                                    console.warn(`⚠️ [${callSid}] No active agents found with phone numbers. Using Fallback.`);
                                }
                            } catch (lookupErr) {
                                console.error(`❌ [${callSid}] Agent lookup crashed:`, lookupErr);
                            }

                            try {
                                const transferUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/api/webhooks/plivo/transfer?to=${encodeURIComponent(transferNumber)}&leadId=${leadId}&campaignId=${campaignId}`;
                                console.log(`🔗 [${callSid}] Transfer URL: ${transferUrl}`);

                                const transferResponse = await plivoClient.calls.transfer(callSid, {
                                    legs: 'aleg',
                                    aleg_url: transferUrl,
                                    aleg_method: 'POST'
                                });
                                console.log(`✅ [${callSid}] Transfer initiated via Plivo API. Response:`, JSON.stringify(transferResponse));

                                // ✅ Update Database Immediately for Dashboard Accuracy
                                const callLog = await callLogPromise;
                                if (callLog) {
                                    console.log(`💾 [${callSid}] Updating DB status to 'transferred'...`);

                                    // 1. Update Call Log
                                    const { data: updatedCallLog, error: callLogUpdateError } = await supabase
                                        .from('call_logs')
                                        .update({
                                            transferred: true,
                                            transferred_at: new Date().toISOString(),
                                            call_status: 'transferred',
                                            transfer_reason: args.reason,
                                            transfer_department: args.department || 'Support'
                                        })
                                        .eq('id', callLog.id)
                                        .select();

                                    if (callLogUpdateError) {
                                        console.error(`❌ [${callSid}] Call log update error:`, callLogUpdateError);
                                    } else {
                                        console.log(`✅ [${callSid}] Call log updated successfully:`, updatedCallLog);
                                    }

                                    // 2. Create Agent Call Record
                                    const { data: agentCall, error: agentCallError } = await supabase
                                        .from('agent_calls')
                                        .insert({
                                            organization_id: campaign.organization_id,
                                            lead_id: leadId,
                                            campaign_id: campaignId,
                                            ai_call_log_id: callLog.id,
                                            agent_name: agentName,
                                            call_sid: callSid,
                                            started_at: new Date().toISOString(),
                                            outcome: 'pending_acceptance',
                                            metadata: {
                                                transfer_reason: args.reason,
                                                department: args.department,
                                                transfer_number: transferNumber
                                            }
                                        })
                                        .select()
                                        .single();

                                    if (agentCallError) {
                                        console.error(`❌ [${callSid}] Agent call creation error:`, agentCallError);
                                    } else {
                                        console.log(`✅ [${callSid}] Agent call record created: ${agentCall.id}`);
                                    }
                                } else {
                                    console.warn(`⚠️  [${callSid}] callLog not found, skipping DB update for transfer.`);
                                }

                                // 2. Update Lead Status - Use Pipeline Stages
                                const qualifiedStageId = await getPipelineStageForOutcome(leadId, 'qualified');

                                const leadUpdatePayload = {
                                    transferred_to_human: true,
                                    last_contacted_at: new Date().toISOString()
                                };

                                // Only update stage if we found a valid one
                                if (qualifiedStageId) {
                                    leadUpdatePayload.stage_id = qualifiedStageId;
                                }

                                const { data: updatedLead, error: leadUpdateError } = await supabase
                                    .from('leads')
                                    .update(leadUpdatePayload)
                                    .eq('id', leadId)
                                    .select();

                                if (leadUpdateError) {
                                    console.error(`❌ [${callSid}] Lead update error:`, leadUpdateError);
                                } else {
                                    console.log(`✅ [${callSid}] Lead moved to qualified stage:`, updatedLead);
                                }

                                // 🛑 IMPORTANT: Stop AI from generating more audio immediately
                                // 1. Send conversation item (optional log)
                                const transferItem = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({ success: true, message: "Transfer initiated. Closing AI session." })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(transferItem));

                                // 2. Clear Plivo Audio Buffer to stop current speech
                                const clearMsg = JSON.stringify({ event: "clearAudio" });
                                plivoWS.send(clearMsg);

                                // 3. Cancel any pending OpenAI response
                                realtimeWS.send(JSON.stringify({ type: "response.cancel" }));

                                // 4. Close the WebSocket connection after a brief moment to ensure transfer command process
                                console.log(`👋 [${callSid}] Closing AI session for transfer...`);
                                setTimeout(() => {
                                    if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.close();
                                    if (plivoWS.readyState === WebSocket.OPEN) plivoWS.close();
                                }, 500);

                            } catch (err) {
                                console.error(`❌ [${callSid}] Transfer failed:`, err);
                                const errorItem = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({ success: false, error: "Failed to transfer call." })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(errorItem));
                                // In case of error, maybe we WANT the AI to say "Sorry I failed"
                                realtimeWS.send(JSON.stringify({ type: "response.create" }));
                            }
                        }

                        // Handle disconnect_call tool
                        if (response.name === 'disconnect_call') {
                            const args = JSON.parse(response.arguments);
                            console.log(`🚫 [${callSid}] AI Disconnecting Call - Reason: ${args.reason}`);
                            console.log(`📝 [${callSid}] Notes: ${args.notes || 'No notes provided'}`);

                            // Initialize Plivo Client
                            const plivoClient = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

                            try {
                                // Update Database before disconnecting
                                const callLog = await callLogPromise;
                                if (callLog) {
                                    console.log(`💾 [${callSid}] Updating call log with disconnect details...`);

                                    // Update Call Log with comprehensive notes
                                    await supabase
                                        .from('call_logs')
                                        .update({
                                            call_status: 'disconnected',
                                            disconnect_reason: args.reason,
                                            notes: args.notes || '',
                                            ended_at: new Date().toISOString()
                                        })
                                        .eq('id', callLog.id);

                                    console.log(`✅ [${callSid}] Call log updated successfully`);
                                }

                                // Update Lead Status based on disconnect reason - Use Pipeline Stages
                                const normalizedReason = (args.reason || 'other').toLowerCase().replace(/\s+/g, '_');

                                // Determine outcome based on reason
                                let outcome = 'contacted'; // Default
                                if (normalizedReason.includes('not_interested') || normalizedReason.includes('abusive')) {
                                    outcome = 'lost';
                                } else if (normalizedReason.includes('wrong')) {
                                    outcome = 'lost'; // Wrong number = lost lead
                                }

                                const stageId = await getPipelineStageForOutcome(leadId, outcome);

                                // Prepare lead update with detailed notes
                                const leadUpdatePayload = {
                                    rejection_reason: args.reason,
                                    notes: args.notes || `Call ended: ${args.reason}`,
                                    last_contacted_at: new Date().toISOString()
                                };

                                // Only update stage if we found a valid one
                                if (stageId) {
                                    leadUpdatePayload.stage_id = stageId;
                                }

                                // Add abuse flag if abusive
                                if (normalizedReason.includes('abusive')) {
                                    leadUpdatePayload.abuse_flag = true;
                                    leadUpdatePayload.abuse_details = args.notes || 'Abusive language during call';
                                }

                                const { error: leadError } = await supabase
                                    .from('leads')
                                    .update(leadUpdatePayload)
                                    .eq('id', leadId);

                                if (leadError) {
                                    console.error(`❌ [${callSid}] Lead status update FAILED:`, leadError);
                                } else {
                                    console.log(`✅ [${callSid}] Lead updated: ${outcome} | Reason: ${args.reason}`);
                                    console.log(`📋 [${callSid}] Notes saved: ${args.notes || 'None'}`);
                                }

                                // Send function output to AI
                                const disconnectItem = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({ success: true, message: "Database updated. Ending call now." })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(disconnectItem));

                                // Trigger AI to say final goodbye
                                realtimeWS.send(JSON.stringify({ type: "response.create" }));

                                // Hangup the call after allowing AI to finish
                                setTimeout(async () => {
                                    try {
                                        await plivoClient.calls.hangup(callSid);
                                        console.log(`✅ [${callSid}] Call disconnected successfully`);
                                    } catch (hangupErr) {
                                        console.error(`❌ [${callSid}] Hangup failed:`, hangupErr.message);
                                    }

                                    // Close WebSocket connections
                                    if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.close();
                                    if (plivoWS.readyState === WebSocket.OPEN) plivoWS.close();
                                }, 4000); // 4 second delay for proper goodbye

                            } catch (err) {
                                console.error(`❌ [${callSid}] Disconnect handler error:`, err);
                                const errorItem = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({ success: false, error: "Failed to disconnect properly." })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(errorItem));
                            }
                        }

                        // Handle check_unit_availability tool
                        if (response.name === 'check_unit_availability') {
                            const args = JSON.parse(response.arguments);
                            console.log(`🏠 [${callSid}] Checking availability for Unit ${args.unit_number}`);

                            try {
                                const { data: units, error } = await supabase
                                    .from('property_units')
                                    .select('id, unit_number, status, price, bhk_config, area_sqft, property_id, properties(name)')
                                    .eq('unit_number', args.unit_number);

                                let result;
                                if (error || !units || units.length === 0) {
                                    result = {
                                        available: false,
                                        message: `Unit ${args.unit_number} not found in our records`
                                    };
                                } else {
                                    // Find unit in the lead's project
                                    const projectUnit = units.find(u => u.properties?.name);

                                    if (!projectUnit) {
                                        result = {
                                            available: false,
                                            message: `Unit ${args.unit_number} not found`
                                        };
                                    } else if (projectUnit.status !== 'available') {
                                        result = {
                                            available: false,
                                            status: projectUnit.status,
                                            message: `Unit ${args.unit_number} is currently ${projectUnit.status}`
                                        };
                                    } else {
                                        result = {
                                            available: true,
                                            unit_number: projectUnit.unit_number,
                                            property: projectUnit.properties?.name || 'Unknown',
                                            config: projectUnit.bhk_config,
                                            area: projectUnit.area_sqft,
                                            price: projectUnit.price,
                                            message: `Unit ${args.unit_number} is available - ${projectUnit.bhk_config}, ${projectUnit.area_sqft} sqft, ₹${(projectUnit.price / 100000).toFixed(1)}L`
                                        };
                                    }
                                }

                                console.log(`✅ [${callSid}] Property check result:`, result);

                                const toolResponse = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify(result)
                                    }
                                };
                                realtimeWS.send(JSON.stringify(toolResponse));
                                realtimeWS.send(JSON.stringify({ type: "response.create" }));

                            } catch (err) {
                                console.error(`❌ [${callSid}] Property check failed:`, err);
                                const errorResponse = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({
                                            available: false,
                                            error: "Failed to check availability"
                                        })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(errorResponse));
                                realtimeWS.send(JSON.stringify({ type: "response.create" }));
                            }
                        }

                        // Handle update_lead_status tool
                        if (response.name === 'update_lead_status') {
                            const args = JSON.parse(response.arguments);
                            console.log(`📝 [${callSid}] Updating Lead Status: ${args.status}`);
                            console.log(`📋 [${callSid}] Reason: ${args.reason || 'Not specified'}`);
                            console.log(`📄 [${callSid}] Notes: ${args.notes || 'None'}`);

                            try {
                                // Map AI status to outcome
                                const outcomeMap = {
                                    'contacted': 'contacted',
                                    'qualified': 'qualified',
                                    'lost': 'lost',
                                    'converted': 'converted'
                                };

                                const outcome = outcomeMap[args.status] || 'contacted';
                                const stageId = await getPipelineStageForOutcome(leadId, outcome);

                                // Build comprehensive update payload
                                const updatePayload = {
                                    rejection_reason: args.reason || null,
                                    notes: args.notes || null,
                                    last_contacted_at: new Date().toISOString()
                                };

                                // Only update stage if we found a valid one
                                if (stageId) {
                                    updatePayload.stage_id = stageId;
                                }

                                const { error: updateError } = await supabase
                                    .from('leads')
                                    .update(updatePayload)
                                    .eq('id', leadId);

                                if (updateError) {
                                    console.error(`❌ [${callSid}] Lead update failed:`, updateError);
                                    throw updateError;
                                }

                                console.log(`✅ [${callSid}] Lead status updated successfully`);
                                console.log(`   Outcome: ${outcome}`);
                                console.log(`   Reason: ${args.reason || 'N/A'}`);
                                console.log(`   Notes: ${args.notes || 'N/A'}`);

                                // Also update call log with this information
                                const callLog = await callLogPromise;
                                if (callLog) {
                                    await supabase
                                        .from('call_logs')
                                        .update({
                                            notes: (args.notes || '') + (args.reason ? ` | Reason: ${args.reason}` : '')
                                        })
                                        .eq('id', callLog.id);
                                }

                                const outputItem = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({
                                            success: true,
                                            message: "Lead status and notes saved successfully."
                                        })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(outputItem));
                                // Don't auto-trigger response - let AI decide next action

                            } catch (err) {
                                console.error(`❌ [${callSid}] Update Status Error:`, err);
                                const errorItem = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({ success: false, error: err.message })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(errorItem));
                            }
                        }

                        // Handle schedule_callback tool
                        if (response.name === 'schedule_callback') {
                            const args = JSON.parse(response.arguments);
                            console.log(`📅 [${callSid}] Scheduling Callback: ${args.time}`);

                            try {
                                await supabase.from('leads').update({
                                    waiting_status: 'callback_scheduled',
                                    callback_time: new Date().toISOString(), // In a real app, parse args.time to specific Date
                                    notes: `Callback requested: ${args.time}`
                                }).eq('id', leadId);

                                console.log(`✅ [${callSid}] Callback scheduled`);

                                const outputItem = {
                                    type: "conversation.item.create",
                                    item: {
                                        type: "function_call_output",
                                        call_id: response.call_id,
                                        output: JSON.stringify({ success: true, message: `Callback set for ${args.time}` })
                                    }
                                };
                                realtimeWS.send(JSON.stringify(outputItem));
                                realtimeWS.send(JSON.stringify({ type: "response.create" }));

                            } catch (err) {
                                console.error(`❌ [${callSid}] Callback Schedule Error:`, err);
                            }
                        }
                        break;

                    case 'input_audio_buffer.speech_started':
                        console.log(`🎤 [${callSid}] User started speaking`);
                        // IMPORTANT: Stop Plivo from playing any more audio immediately
                        try {
                            if (plivoWS.readyState === WebSocket.OPEN) {
                                plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
                            }

                            // Cancel OpenAI response
                            if (realtimeWS.readyState === WebSocket.OPEN) {
                                const cancelResponse = { type: 'response.cancel' };
                                realtimeWS.send(JSON.stringify(cancelResponse));
                            }
                        } catch (err) {
                            console.error(`⚠️ [${callSid}] Error handling speech interruption:`, err.message);
                        }
                        break;

                    case 'response.audio.delta':
                        const audioDelta = {
                            event: 'playAudio',
                            media: {
                                contentType: 'audio/x-mulaw',
                                sampleRate: 8000,
                                payload: response.delta
                            }
                        };
                        plivoWS.send(JSON.stringify(audioDelta));
                        break;

                    case 'conversation.item.input_audio_transcription.completed':
                        const userText = response.transcript;
                        console.log(`👤 [${callSid}] User: "${userText}"`);
                        conversationTranscript += `User: ${userText}\n`;
                        break;

                    case 'response.audio_transcript.done':
                        const aiText = response.transcript;
                        console.log(`🤖 [${callSid}] AI: "${aiText}"`);
                        conversationTranscript += `AI: ${aiText}\n`;
                        break;

                    case 'conversation.item.input_audio_transcription.failed':
                        console.error(`❌ [${callSid}] Transcription FAILED:`, response.error);
                        conversationTranscript += `(User speech transcription failed: ${response.error?.message})\n`;
                        break;

                    case 'response.done':
                        console.log(`✅ [${callSid}] Response completed`);
                        break;

                    case 'error':
                        if (response.error?.code === 'response_cancel_not_active') {
                            console.log(`ℹ️  [${callSid}] Benign error: ${response.error.message}`);
                        } else {
                            console.error(`❌ [${callSid}] OpenAI error:`, response.error);
                        }
                        break;

                    default:
                        console.log(`📨 [${callSid}] OpenAI event: ${response.type}`);
                }
            } catch (error) {
                console.error(`❌ [${callSid}] Error processing OpenAI message:`, error.message);
            }
        });

        // Cleanup function
        const cleanup = async () => {
            console.log(`🧹 [${callSid}] Cleaning up connections...`);

            if (realtimeWS.readyState === WebSocket.OPEN) {
                realtimeWS.close();
            }

            // Save transcript and run sentiment analysis
            const callLog = await callLogPromise;
            if (callLog) {
                console.log(`💾 [${callSid}] Saving transcript...`);

                // Fetch current status to check if it was transferred
                const { data: currentLog } = await supabase
                    .from('call_logs')
                    .select('transferred')
                    .eq('id', callLog.id)
                    .single();

                const isTransferred = currentLog?.transferred || false;
                const finalStatus = isTransferred ? 'transferred' : (currentLog?.call_status === 'in_progress' ? 'completed' : currentLog?.call_status);

                const endedAt = new Date();
                const duration = Math.round((endedAt - new Date(callLog.created_at)) / 1000);

                const { error: updateError } = await supabase
                    .from('call_logs')
                    .update({
                        conversation_transcript: conversationTranscript,
                        call_status: finalStatus,
                        ended_at: endedAt.toISOString(),
                        duration: duration
                    })
                    .eq('id', callLog.id);

                // Update lead status if not transferred
                if (!isTransferred) {
                    await supabase
                        .from('leads')
                        .update({ call_status: 'called' })
                        .eq('id', leadId);
                }

                if (updateError) {
                    console.error(`❌ [${callSid}] Error saving transcript:`, updateError);
                } else {
                    console.log(`✅ [${callSid}] Transcript saved successfully`);
                }

                // 🧠 RUN SENTIMENT ANALYSIS (if transcript is substantial)
                if (conversationTranscript && conversationTranscript.length > 100) {
                    console.log(`🧠 [${callSid}] Running sentiment analysis...`);
                    await analyzeSentiment(
                        conversationTranscript,
                        leadId,
                        callLog.id,
                        campaign.organization_id,
                        callSid
                    );
                } else {
                    console.log(`⚠️  [${callSid}] Transcript too short for analysis`);
                }

                // 📊 Update Call Attempt Outcome
                const attempt = await attemptPromise;
                if (attempt) {
                    const callOutcome = conversationTranscript.length > 50 ? 'answered' : 'no_answer';
                    const duration = Math.floor((new Date() - new Date(attempt.attempted_at)) / 1000);

                    await supabase
                        .from('call_attempts')
                        .update({
                            outcome: callOutcome,
                            duration: duration,
                            // Schedule retry if no answer and attempt < 3
                            will_retry: callOutcome === 'no_answer' && attempt.attempt_number < 3,
                            next_retry_at: callOutcome === 'no_answer' && attempt.attempt_number < 3
                                ? new Date(Date.now() + (attempt.attempt_number === 1 ? 2 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000)).toISOString()
                                : null,
                            retry_reason: callOutcome === 'no_answer' ? 'no_answer' : null
                        })
                        .eq('id', attempt.id);

                    console.log(`✅ [${callSid}] Call attempt marked as: ${callOutcome}`);

                    if (callOutcome === 'no_answer' && attempt.attempt_number < 3) {
                        console.log(`🔄 [${callSid}] Retry scheduled for attempt #${attempt.attempt_number + 1}`);
                    }
                }
            }

            console.log(`🏁 [${callSid}] ===== CONNECTION CLOSED =====\n`);
        };

        // Guard against cleanup running twice (both sockets may close near-simultaneously)
        let cleanedUp = false;
        const safeCleanup = async () => {
            if (cleanedUp) return;
            cleanedUp = true;
            await cleanup();
        };
        plivoWS.on('close', safeCleanup);
        realtimeWS.on('close', safeCleanup);

        return realtimeWS;

    } catch (error) {
        console.error(`❌ [${callSid}] Fatal error in startRealtimeWSConnection:`, error);
        plivoWS.close(1011, 'Internal server error');
        return null;
    }
};

// Handle WebSocket connections from Plivo
wss.on('connection', async (plivoWS, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const leadId = url.searchParams.get('leadId');
    const campaignId = url.searchParams.get('campaignId');
    const callSid = url.searchParams.get('callSid');

    console.log(`\n🔔 [${callSid}] ===== NEW PLIVO CONNECTION =====`);
    console.log(`📞 [${callSid}] Connection established from Plivo`);
    console.log(`🔗 [${callSid}] URL: ${request.url}`);

    if (!leadId || !campaignId || !callSid) {
        console.error(`❌ [${callSid}] Missing required parameters`);
        console.error(`   Lead ID: ${leadId || 'MISSING'}`);
        console.error(`   Campaign ID: ${campaignId || 'MISSING'}`);
        console.error(`   Call SID: ${callSid || 'MISSING'}`);
        plivoWS.close(1008, 'Missing required parameters');
        return;
    }

    try {
        const realtimeWS = await startRealtimeWSConnection(plivoWS, leadId, campaignId, callSid);
        if (!realtimeWS) {
            console.error(`❌ [${callSid}] Failed to establish OpenAI connection`);
            return;
        }

        plivoWS.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (realtimeWS && realtimeWS.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            realtimeWS.send(JSON.stringify(audioAppend));
                        }
                        break;

                    case 'start':
                        console.log(`▶️  [${callSid}] Plivo stream started: ${data.start.streamId}`);
                        plivoWS.streamId = data.start.streamId;
                        break;

                    case 'stop':
                        console.log(`⏹️  [${callSid}] Plivo stream stopped`);
                        break;

                    case 'clearAudio':
                        console.log(`🔇 [${callSid}] Clear audio received from Plivo`);
                        break;

                    default:
                        console.log(`📨 [${callSid}] Plivo event: ${data.event}`);
                }
            } catch (error) {
                console.error(`❌ [${callSid}] Error processing Plivo message:`, error.message);
            }
        });

        plivoWS.on('close', () => {
            console.log(`🔌 [${callSid}] Plivo connection closed`);
        });

        plivoWS.on('error', (error) => {
            console.error(`❌ [${callSid}] Plivo WebSocket error:`, error.message);
        });

    } catch (error) {
        console.error(`❌ [${callSid}] Error in connection handler:`, error);
        plivoWS.close(1011, 'Internal server error');
    }
});

wss.on('error', (error) => {
    console.error('❌ WebSocket server error:', error);
});

server.listen(PORT, () => {
    console.log(`\n✅ ========================================`);
    console.log(`✅ WebSocket Server Running!`);
    console.log(`✅ Port: ${PORT}`);
    console.log(`✅ WebSocket Path: /voice/stream`);
    console.log(`✅ Health Check: /health`);
    console.log(`✅ ========================================\n`);
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
