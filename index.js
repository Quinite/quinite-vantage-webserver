import { supabase } from './services/supabase.js';
import { plivoClient, getCallerId } from './services/plivo.js';
import { analyzeSentiment } from './services/sentimentService.js';
import { createSessionUpdate } from './sessionUpdate.js';
import WebSocket, { WebSocketServer } from 'ws';
import express from 'express';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Quinite Vantage WebServer: Optimized Call & AI Engine
 */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

const PORT = parseInt(process.env.PORT) || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log(`\n🚀 [Vantage OS] Booting Server...`);
console.log(`📡 Port: ${PORT}`);
console.log(`🔑 OpenAI: ${OPENAI_API_KEY ? '✅' : '❌'}`);

/* -------------------------------
   HTTP ENDPOINTS
-------------------------------- */

app.get(['/', '/health'], (req, res) => res.send('OK'));

/**
 * /answer: Plivo webhook that returns XML for WebSocket streaming.
 */
app.all('/answer', (req, res) => {
    const callUuid = req.body.CallUUID || req.query.CallUUID;
    const leadId = req.query.leadId || req.body.leadId;
    const campaignId = req.query.campaignId || req.body.campaignId;

    console.log(`📞 [${callUuid}] Incoming Answer Request | Lead: ${leadId}`);

    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    const host = req.headers.host;
    const wsUrl = `${protocol}://${host}/voice/stream?leadId=${leadId}&campaignId=${campaignId}&callSid=${callUuid}`;
    const xmlWsUrl = wsUrl.replace(/&/g, '&amp;');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
        ${xmlWsUrl}
    </Stream>
</Response>`;

    res.set('Content-Type', 'text/xml').send(xml.trim());
});

/* -------------------------------
   WEBSOCKET UPGRADE
-------------------------------- */

server.on('upgrade', (request, socket, head) => {
    if (request.url.startsWith('/voice/stream')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

/* -------------------------------
   AI ENGINE: OpenAI Realtime
-------------------------------- */

const startRealtimeWSConnection = async (plivoWS, leadId, campaignId, callSid) => {
    console.log(`\n🎯 [${callSid}] INITIALIZING AI SESSION...`);

    try {
        // Step 1: Initialize OpenAI WebSocket EARLY 🚀
        const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        // Step 2: Parallelize DB Fetching (Lead & Campaign)
        const fetchContext = Promise.all([
            supabase.from('leads').select('*, project:projects(*)').eq('id', leadId).single(),
            supabase.from('campaigns').select('*, organization:organizations(*)').eq('id', campaignId).single()
        ]);

        let conversationTranscript = '';
        let callLogId = null;

        // Step 3: Handle OpenAI Readiness
        realtimeWS.on('open', async () => {
            console.log(`✅ [${callSid}] OpenAI Realtime Connected!`);

            const [leadRes, campRes] = await fetchContext;
            if (leadRes.error || campRes.error) {
                console.error(`❌ Data fetch failed:`, leadRes.error || campRes.error);
                return;
            }

            const lead = leadRes.data;
            const campaign = campRes.data;

            // Trigger AI Greeting with initial (lean) prompt for speed ⚡
            const initialSession = createSessionUpdate(lead, campaign, [], []);
            realtimeWS.send(JSON.stringify(initialSession));
            realtimeWS.send(JSON.stringify({ type: 'response.create' }));

            // Step 4: Background fetch full context (Inventory/Other Projects)
            fetchFullContext(realtimeWS, lead, campaign, callSid);

            // Step 5: Log the call start
            callLogId = await logCallStart(lead, campaign, callSid);
        });

        // Step 6: Define Tool Handlers (Centralized)
        const handleToolCall = async (response) => {
            const { name, arguments: argsJson, call_id } = response;
            const args = JSON.parse(argsJson);
            console.log(`🛠️ [${callSid}] Tool Call: ${name}`, args);

            let result = { success: false };

            try {
                switch (name) {
                    case 'transfer_call':
                        result = await handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId);
                        break;
                    case 'disconnect_call':
                        result = await handleDisconnect(plivoWS, realtimeWS, callSid, leadId, args, callLogId);
                        break;
                    case 'update_lead_status':
                        result = await handleUpdateLead(leadId, args, callLogId);
                        break;
                    case 'check_unit_availability':
                        result = await handleAvailability(leadId, args);
                        break;
                    case 'schedule_callback':
                        result = await handleScheduleCallback(leadId, args);
                        break;
                    default:
                        console.warn(`⚠️ Unknown Tool: ${name}`);
                }
            } catch (err) {
                console.error(`❌ Tool execution error [${name}]:`, err.message);
                result = { success: false, error: err.message };
            }

            // Send tool result back to AI
            realtimeWS.send(JSON.stringify({
                type: "conversation.item.create",
                item: { type: "function_call_output", call_id, output: JSON.stringify(result) }
            }));
            
            // For certain tools, trigger a response
            if (['check_unit_availability', 'schedule_callback'].includes(name)) {
                realtimeWS.send(JSON.stringify({ type: 'response.create' }));
            }
        };

        // Step 7: Handle Messages
        realtimeWS.on('message', async (message) => {
            try {
                const response = JSON.parse(message);
                
                switch (response.type) {
                    case 'response.function_call_arguments.done':
                        await handleToolCall(response);
                        break;

                    case 'input_audio_buffer.speech_started':
                        // INTERRUPT LOGIC: Stop AI audio and clear Plivo buffer ⚡
                        if (plivoWS.readyState === WebSocket.OPEN) {
                            plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
                        }
                        realtimeWS.send(JSON.stringify({ type: 'response.cancel' }));
                        break;

                    case 'response.audio.delta':
                        // STREAM AUDIO to Plivo 🎬
                        if (plivoWS.readyState === WebSocket.OPEN) {
                            plivoWS.send(JSON.stringify({
                                event: 'playAudio',
                                media: { payload: response.delta }
                            }));
                        }
                        break;

                    case 'conversation.item.input_audio_transcription.completed':
                        console.log(`👤 [${callSid}] User: "${response.transcript}"`);
                        conversationTranscript += `User: ${response.transcript}\n`;
                        break;

                    case 'response.audio_transcript.done':
                        conversationTranscript += `AI: ${response.transcript}\n`;
                        break;
                    
                    case 'error':
                        console.error(`❌ [${callSid}] AI Error:`, response.error?.message);
                        break;
                }
            } catch (err) {
                console.error(`❌ Message processing error:`, err.message);
            }
        });

        // Step 8: Cleanup & Finalization
        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) return;
            cleanedUp = true;
            console.log(`🧹 [${callSid}] Finishing AI Session...`);

            if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.close();
            
            // Final DB synchronization
            if (callLogId) {
                await finalizeCallOutcome(callLogId, leadId, campaignId, conversationTranscript, callSid);
            }
        };

        plivoWS.on('close', cleanup);
        realtimeWS.on('close', cleanup);

        return realtimeWS;

    } catch (err) {
        console.error(`❌ Fatal Session Error [${callSid}]:`, err.message);
        plivoWS.close();
        return null;
    }
};

/* -------------------------------
   HELPER FUNCTIONS (MODULARIZED)
-------------------------------- */

async function fetchFullContext(realtimeWS, lead, campaign, callSid) {
    try {
        console.log(`📦 [${callSid}] Fetching full context...`);
        const [projectsRes, inventoryRes] = await Promise.all([
            supabase.from('projects').select('name, description, location').eq('organization_id', campaign.organization_id).eq('status', 'active'),
            supabase.from('properties').select('*').eq('project_id', lead.project_id).eq('status', 'available')
        ]);

        const fullSession = createSessionUpdate(lead, campaign, projectsRes.data || [], inventoryRes.data || []);
        if (realtimeWS.readyState === WebSocket.OPEN) {
            realtimeWS.send(JSON.stringify(fullSession));
            console.log(`✅ [${callSid}] Rich Context Attached.`);
        }
    } catch (err) {
        console.error(`❌ Context fetch error:`, err.message);
    }
}

async function logCallStart(lead, campaign, callSid) {
    const { data, error } = await supabase.from('call_logs').insert({
        organization_id: campaign.organization_id,
        project_id: campaign.project_id,
        campaign_id: campaign.id,
        lead_id: lead.id,
        call_sid: callSid,
        call_status: 'in_progress',
        direction: 'outbound',
        caller_number: getCallerId(campaign),
        callee_number: lead.phone
    }).select('id').single();

    if (error) console.error(`❌ Log start error:`, error.message);
    return data?.id;
}

// TOOL: Handlers
async function handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId) {
    console.log(`📞 Initiating Transfer: ${args.reason}`);
    
    // Dynamic Agent Selection 
    const { data: agents } = await supabase.from('profiles').select('phone, full_name').eq('organization_id', (await supabase.from('leads').select('organization_id').eq('id', leadId).single()).data.organization_id).eq('status', 'active').limit(1);
    const transferNumber = agents?.[0]?.phone || process.env.PLIVO_TRANSFER_NUMBER || '+918035740007';

    const transferUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/api/webhooks/plivo/transfer?to=${encodeURIComponent(transferNumber)}&leadId=${leadId}&campaignId=${campaignId}`;
    
    await plivoClient.calls.transfer(callSid, { legs: 'aleg', aleg_url: transferUrl, aleg_method: 'POST' });

    // Update DB
    await supabase.from('call_logs').update({ transferred: true, call_status: 'transferred', transfer_reason: args.reason }).eq('id', callLogId);
    await supabase.from('leads').update({ transferred_to_human: true }).eq('id', leadId);

    // Stop AI
    plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
    realtimeWS.send(JSON.stringify({ type: 'response.cancel' }));
    setTimeout(() => { plivoWS.close(); realtimeWS.close(); }, 500);

    return { success: true, agent: agents?.[0]?.full_name || 'Senior Manager' };
}

async function handleDisconnect(plivoWS, realtimeWS, callSid, leadId, args, callLogId) {
    console.log(`🚫 AI Disconnect: ${args.reason}`);
    
    await supabase.from('call_logs').update({ call_status: 'disconnected', disconnect_reason: args.reason, notes: args.notes }).eq('id', callLogId);
    await supabase.from('leads').update({ rejection_reason: args.reason, call_status: 'called' }).eq('id', leadId);

    // Give goodbye window
    setTimeout(async () => {
        try { await plivoClient.calls.hangup(callSid); } catch (e) {}
        plivoWS.close();
        realtimeWS.close();
    }, 3000);

    return { success: true };
}

async function handleUpdateLead(leadId, args, callLogId) {
    const { error } = await supabase.from('leads').update({
        interest_level: args.status === 'qualified' ? 'high' : 'low',
        notes: args.notes,
        call_status: 'contacted'
    }).eq('id', leadId);
    
    return { success: !error };
}

async function handleAvailability(leadId, args) {
    const { data: unit } = await supabase.from('property_units').select('*').eq('unit_number', args.unit_number).single();
    if (!unit) return { available: false, message: "No such unit found." };
    return { available: unit.status === 'available', price: unit.price, config: unit.bhk_config };
}

async function handleScheduleCallback(leadId, args) {
    const { error } = await supabase.from('leads').update({
        waiting_status: 'callback_scheduled',
        callback_time_text: args.time,
        notes: `AI Scheduled callback: ${args.time}`
    }).eq('id', leadId);
    return { success: !error, message: `Callback noted for ${args.time}` };
}

async function finalizeCallOutcome(callLogId, leadId, campaignId, transcript, callSid) {
    try {
        const endedAt = new Date();
        const duration = 0; // Simplified
        
        await supabase.from('call_logs').update({
            conversation_transcript: transcript,
            ended_at: endedAt.toISOString()
        }).eq('id', callLogId);

        // Run analysis in background
        analyzeSentiment(transcript, leadId, callLogId, null, callSid);

        // Update retry status if no answer
        if (transcript.length < 50) {
            await supabase.from('call_attempts').insert({
                lead_id: leadId,
                campaign_id: campaignId,
                outcome: 'no_answer',
                will_retry: true,
                next_retry_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
            });
        }
    } catch (err) {
        console.error(`❌ Finalization error:`, err.message);
    }
}

/* -------------------------------
   MAIN CONNECTION HANDLER
-------------------------------- */

wss.on('connection', async (plivoWS, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const leadId = url.searchParams.get('leadId');
    const campaignId = url.searchParams.get('campaignId');
    const callSid = url.searchParams.get('callSid');

    if (!leadId || !campaignId || !callSid) {
        plivoWS.close(1008, 'Missing params');
        return;
    }

    try {
        const realtimeWS = await startRealtimeWSConnection(plivoWS, leadId, campaignId, callSid);
        
        plivoWS.on('message', (message) => {
            const data = JSON.parse(message);
            if (data.event === 'media' && realtimeWS.readyState === WebSocket.OPEN) {
                realtimeWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
            }
        });
    } catch (err) {
        console.error(`❌ Connection boot error:`, err.message);
    }
});

server.listen(PORT, () => console.log(`\n✅ Vantage AI Server listening on ${PORT}`));

process.on('uncaughtException', (err) => console.error('💥 CRASH:', err));
process.on('unhandledRejection', (err) => console.error('💥 REJECTION:', err));
