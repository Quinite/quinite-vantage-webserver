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

// Security Middleware: Plivo Signature Validation Placeholder
const validatePlivoRequest = (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    // Implementation: Use Plivo's SDK to validate X-Plivo-Signature-V2
    next();
};

console.log(`\n🚀 [Vantage OS] Booting Server...`);
console.log(`📡 Port: ${PORT}`);

/* -------------------------------
   HTTP ENDPOINTS
-------------------------------- */

app.get(['/', '/health'], (req, res) => res.send('OK'));

/**
 * /answer: Plivo webhook that returns XML for WebSocket streaming.
 */
app.all('/answer', validatePlivoRequest, async (req, res) => {
    const callUuid = req.body.CallUUID || req.query.CallUUID;
    const leadId = req.query.leadId || req.body.leadId;
    const campaignId = req.query.campaignId || req.body.campaignId;

    console.log(`📞 [${callUuid}] Incoming Answer | Lead: ${leadId} | Campaign: ${campaignId}`);

    // [1] DIRECT CAMPAIGN & BILLING CHECK
    const { data: campaignContext } = await supabase
        .from('campaigns')
        .select('status, organization:organizations!inner(subscription_status, call_credits(*))')
        .eq('id', campaignId)
        .single();

    const credits = campaignContext?.organization?.call_credits;
    const balance = Array.isArray(credits) ? parseFloat(credits[0]?.balance || 0) : parseFloat(credits?.balance || 0);
    const subStatus = campaignContext?.organization?.subscription_status || 'inactive';
    const campaignStatus = campaignContext?.status || 'inactive';

    if (!campaignContext || !['active', 'running'].includes(campaignStatus) || !['active', 'trialing'].includes(subStatus) || balance < 0.1) {
        console.warn(`🛑 [${callUuid}] Lifecycle/Credit Rejection (Camp: ${campaignStatus}, Sub: ${subStatus}, Balance: ${balance}). Hanging up.`);
        return res.set('Content-Type', 'text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }

    // [2] BUILD WEBSOCKET URL from request host (same pattern as old working code)
    const host = req.headers.host;
    const wsUrl = `wss://${host}/voice/stream?leadId=${leadId}&campaignId=${campaignId}&callSid=${callUuid}`;
    const xmlWsUrl = wsUrl.replace(/&/g, '&amp;');

    // [3] RETURN STREAM XML (no <Speak> — it blocks Plivo WebSocket connection)
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${xmlWsUrl}</Stream>
</Response>`;

    console.log(`📤 [Answer] Stream URL: ${wsUrl}`);
    res.set('Content-Type', 'text/xml').send(xml.trim());
});

/* -------------------------------
   WEBSOCKET UPGRADE
-------------------------------- */

// WebSocket upgrade: manual handler (proven to work with Plivo on Railway)
server.on('upgrade', (request, socket, head) => {
    console.log(`\n🔄 [WS] Upgrade request: ${request.url}`);
    console.log(`   Host: ${request.headers.host}`);
    if (request.url.startsWith('/voice/stream')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            console.log('✅ [WS] Upgrade successful — emitting connection.');
            wss.emit('connection', ws, request);
        });
    } else {
        console.warn(`⚠️ [WS] Unknown path, destroying socket: ${request.url}`);
        socket.destroy();
    }
});

/* -------------------------------
   SESSION CACHE
-------------------------------- */
const contextCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCachedContext(id) {
    const cached = contextCache.get(id);
    return (cached && (Date.now() - cached.timestamp < CACHE_TTL)) ? cached.data : null;
}

function setCachedContext(id, data) {
    contextCache.set(id, { data, timestamp: Date.now() });
}

// Prune expired cache entries every 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of contextCache.entries()) {
        if (now - value.timestamp >= CACHE_TTL) contextCache.delete(key);
    }
}, 15 * 60 * 1000);

/* -------------------------------
   AI ENGINE: OpenAI Realtime
-------------------------------- */

const startRealtimeWSConnection = async (plivoWS, leadId, campaignId, callSid) => {
    console.log(`\n🎯 [${callSid}] INITIALIZING SEARCH-READY SESSION...`);

    try {
        // [1] Pre-emptive OpenAI Connection
        const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        realtimeWS.on('error', (err) => {
            console.error(`❌ [${callSid}] OpenAI WS Error: ${err.message}`);
            // 'close' fires after 'error' — cleanup() handles finalization
        });

        const startupTimeout = setTimeout(async () => {
            if (realtimeWS.readyState !== WebSocket.OPEN) {
                console.error(`❌ [${callSid}] OpenAI connect timeout (10s) — hanging up.`);
                realtimeWS.terminate();
                try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                plivoWS.close();
            }
        }, 10000);

        // [2] Optimized Single-Query Context Join
        const { data: context, error: contextError } = await supabase
            .from('leads')
            .select(`
                *,
                project:projects(*)
            `)
            .eq('id', leadId)
            .single();

        // Fetch campaign independently (leads may not be linked to campaigns yet)
        const { data: campaignData } = await supabase
            .from('campaigns')
            .select('*, organization:organizations!inner(id, name, caller_id, subscription_status, call_credits(*))')
            .eq('id', campaignId)
            .single();

        if (contextError || !context || !campaignData) {
            console.error(`❌ [${callSid}] Handshake Failed:`, contextError?.message || 'Missing campaign');
            clearTimeout(startupTimeout);
            realtimeWS.close();
            return null;
        }

        const campaign = campaignData;
        const project = context.project;
        const organization = campaign.organization;
        const credits = organization?.call_credits;
        const balance = Array.isArray(credits) ? parseFloat(credits[0]?.balance || 0) : parseFloat(credits?.balance || 0);

        // [3] Lifecycle & Billing Validation
        if (!['active', 'running'].includes(campaign.status) || (project && project.archived_at)) {
            console.warn(`🛑 [${callSid}] Campaign/Project Inactive (${campaign.status}).`);
            clearTimeout(startupTimeout);
            realtimeWS.close();
            return null;
        }

        if (!['active', 'trialing'].includes(organization.subscription_status) || balance < 0.5) {
            console.warn(`💳 [${callSid}] Credits Exhausted/Sub Inactive (Sub: ${organization.subscription_status}, Bal: ${balance}).`);
            clearTimeout(startupTimeout);
            realtimeWS.close();
            return null;
        }

        let conversationTranscript = '';
        let callLogId = null;
        let callStartTime = null;
        let silenceTimer = null;
        let cleanupCalled = false;

        // Silence timeout respects campaign call_settings
        const silenceTimeoutMs = (campaign.call_settings?.silence_timeout || 15) * 1000;

        const resetSilenceTimer = () => {
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
                console.log(`🔇 [${callSid}] Silence Timeout (${silenceTimeoutMs / 1000}s).`);
                await handleDisconnect(plivoWS, realtimeWS, callSid, leadId, { reason: 'silence_timeout' }, callLogId);
            }, silenceTimeoutMs);
        };

        // Handle OpenAI Readiness
        realtimeWS.on('open', async () => {
            try {
                clearTimeout(startupTimeout);
                console.log(`✅ [${callSid}] OpenAI Ready!`);

                await plivoWS.startPromise;

                // Await full context before triggering AI response.
                // Prevents a second session.update from interrupting the AI's
                // opening line and causing silent/garbled calls.
                await fetchFullContext(realtimeWS, context, campaign, callSid);
                realtimeWS.send(JSON.stringify({ type: 'response.create' }));
                console.log(`🎤 [${callSid}] response.create sent — AI should speak now.`);

                // Log Session Start
                callLogId = await logCallStart(context, campaign, callSid);
                callStartTime = Date.now();
                resetSilenceTimer();
            } catch (err) {
                console.error(`❌ [${callSid}] Open handler crash: ${err.message}`);
                realtimeWS.close();
                try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                plivoWS.close();
            }
        });

        // Keepalive: ping OpenAI WS every 25s to prevent idle connection drops.
        // Railway/cloud proxies drop connections after 30-60s of silence.
        const keepaliveInterval = setInterval(() => {
            if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.ping();
            else clearInterval(keepaliveInterval);
        }, 25000);

        realtimeWS.on('pong', () => { /* connection alive */ });

        // Tool Execution Management
        const handleToolCall = async (response) => {
            const { name, arguments: argsJson, call_id } = response;
            const args = JSON.parse(argsJson);

            // Post-Handshake Credit Pulse Check
            const { data: creditPulse } = await supabase.from('call_credits').select('balance').eq('organization_id', organization.id).single();
            if (!creditPulse || creditPulse.balance < 0.1) {
                return { success: false, error: 'Balance depleted.' };
            }

            let result = { success: false };
            try {
                switch (name) {
                    case 'transfer_call':
                        result = await handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId);
                        break;
                    case 'disconnect_call':
                        result = await handleDisconnect(plivoWS, realtimeWS, callSid, leadId, args, callLogId);
                        break;
                    case 'check_detailed_inventory':
                        result = await handleDetailedInventory(leadId, args);
                        break;
                    case 'schedule_callback':
                        result = await handleScheduleCallback(leadId, campaignId, args);
                        break;
                    case 'log_intent':
                        result = await handleLogIntent(leadId, args, callLogId);
                        break;
                    default:
                        console.warn(`⚠️ Tool Not Registered: ${name}`);
                }
            } catch (err) {
                console.error(`❌ Tool Error:`, err.message);
                result = { success: false, error: err.message };
            }

            realtimeWS.send(JSON.stringify({
                type: "conversation.item.create",
                item: { type: "function_call_output", call_id, output: JSON.stringify(result) }
            }));
            realtimeWS.send(JSON.stringify({ type: 'response.create' }));
        };

        realtimeWS.on('message', async (message) => {
            try {
                const response = JSON.parse(message);
                resetSilenceTimer();

                switch (response.type) {
                    case 'response.function_call_arguments.done':
                        await handleToolCall(response);
                        break;

                    case 'input_audio_buffer.speech_started':
                        if (plivoWS.readyState === WebSocket.OPEN) {
                            plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
                        }
                        realtimeWS.send(JSON.stringify({ type: 'response.cancel' }));
                        break;

                    case 'response.audio.delta':
                        if (plivoWS.readyState === WebSocket.OPEN) {
                            plivoWS.send(JSON.stringify({
                                event: 'playAudio',
                                media: {
                                    contentType: 'audio/x-mulaw',
                                    sampleRate: 8000,
                                    payload: response.delta
                                }
                            }));
                        }
                        break;

                    case 'conversation.item.input_audio_transcription.completed':
                        conversationTranscript += `User: ${response.transcript}\n`;
                        break;

                    case 'response.audio_transcript.done':
                        conversationTranscript += `AI: ${response.transcript}\n`;
                        break;
                }
            } catch (err) {
                console.error(`❌ [${callSid}] Message handler error:`, err.message);
            }
        });

        const cleanup = async () => {
            if (cleanupCalled) return;
            cleanupCalled = true;
            clearTimeout(startupTimeout);
            if (silenceTimer) clearTimeout(silenceTimer);
            clearInterval(keepaliveInterval);
            if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.close();
            if (callLogId) {
                await finalizeCallOutcome(callLogId, leadId, campaignId, conversationTranscript, callSid, callStartTime || Date.now(), organization.id);
            }
        };

        plivoWS.on('close', cleanup);
        realtimeWS.on('close', cleanup);

        return realtimeWS;

    } catch (err) {
        console.error(`❌ [${callSid}] startRealtimeWSConnection CRASH:`, err.message, err.stack);
        plivoWS.close();
        return null;
    }
};

/* -------------------------------
   MODULAR UTILS
-------------------------------- */

async function fetchFullContext(realtimeWS, lead, campaign, callSid) {
    try {
        const cacheKey = `projects_${campaign.organization_id}`;
        let projects = getCachedContext(cacheKey);

        if (!projects) {
            const { data } = await supabase.from('projects').select('name, description, location').eq('organization_id', campaign.organization_id).eq('status', 'active');
            projects = data || [];
            setCachedContext(cacheKey, projects);
        }

        const fullSession = createSessionUpdate(lead, campaign, projects, []);
        if (realtimeWS.readyState === WebSocket.OPEN) {
            realtimeWS.send(JSON.stringify(fullSession));
            console.log(`📤 [${callSid}] session.update sent (voice: ${campaign.call_settings?.voice_id || 'shimmer'}, lang: ${campaign.call_settings?.language || 'hinglish'})`);
        }
    } catch (err) {
        console.error(`❌ [${callSid}] fetchFullContext failed:`, err.message);
    }
}

async function logCallStart(lead, campaign, callSid) {
    const { data } = await supabase.from('call_logs').insert({
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
    const logId = data?.id;
    if (logId) {
        // Link lead to this call log and increment total call count
        await Promise.all([
            supabase.from('leads').update({ call_log_id: logId }).eq('id', lead.id),
            supabase.rpc('increment_campaign_stat', { campaign_uuid: campaign.id, stat_name: 'total_calls' })
        ]);
    }
    return logId;
}

async function handleDetailedInventory(leadId, args) {
    const { data: lead } = await supabase.from('leads').select('project_id').eq('id', leadId).single();
    if (!lead?.project_id) return { success: false, error: "Project context missing." };

    // [1] ADVANCED JOINED QUERY: Units + Towers + UnitConfigs
    let query = supabase.from('units').select(`
        id, unit_number, floor_number, facing, total_price, base_price,
        bedrooms, bathrooms, balconies, is_corner, is_vastu_compliant,
        possession_date, construction_status, transaction_type,
        tower:towers(name, total_floors),
        config:unit_configs(
            config_name, category, property_type, 
            carpet_area, built_up_area, super_built_up_area, plot_area
        )
    `)
        .eq('project_id', lead.project_id)
        .eq('status', 'available')
        .is('archived_at', null)
        .is('is_archived', false);

    // [2] GRANULAR FILTERING LOGIC
    if (args.category) query = query.eq('unit_configs.category', args.category.toLowerCase());
    if (args.transaction_type) query = query.eq('transaction_type', args.transaction_type.toLowerCase());
    if (args.property_type) query = query.ilike('unit_configs.property_type', `%${args.property_type}%`);

    // Config name takes precedence for BHK lookup (2.5BHK units have null bedrooms field)
    if (args.config_name) query = query.filter('config.config_name', 'ilike', `%${args.config_name}%`);
    else if (args.bedrooms) query = query.eq('bedrooms', args.bedrooms);

    // Pricing Filters
    if (args.price_min) query = query.gte('total_price', args.price_min);
    if (args.price_max) query = query.lte('total_price', args.price_max);

    // Area Filters
    if (args.min_carpet_area) query = query.gte('unit_configs.carpet_area', args.min_carpet_area);

    // Architectural Filters
    if (args.is_vastu_compliant !== undefined) query = query.eq('is_vastu_compliant', args.is_vastu_compliant);
    if (args.is_corner !== undefined) query = query.eq('is_corner', args.is_corner);
    if (args.facing) query = query.ilike('facing', `%${args.facing}%`);

    // Floor Filters
    if (args.floor_min) query = query.gte('floor_number', args.floor_min);
    if (args.floor_max) query = query.lte('floor_number', args.floor_max);

    const { data: units, error } = await query.limit(5);

    if (error) {
        console.error("❌ Inventory Query Error:", error.message);
        return { success: false, error: "Search logic failed." };
    }

    if (!units?.length) {
        return {
            available: false,
            message: "No units found matching these exact filters. Try broadening the search (e.g. different floor or BHK)."
        };
    }

    // [3] RICH DATA TRANSFORMATION
    return {
        available: true,
        units: units.map(u => ({
            unit_id: u.id,
            unit_no: u.unit_number,
            tower: u.tower?.name,
            floor: u.floor_number,
            config: u.config?.config_name,
            category: u.config?.category,
            type: u.config?.property_type,
            transaction: u.transaction_type,
            bedrooms: u.bedrooms,
            bathrooms: u.bathrooms,
            balconies: u.balconies,
            area: {
                carpet: u.config?.carpet_area,
                built_up: u.config?.built_up_area || u.built_up_area,
                super_built: u.config?.super_built_up_area || u.super_built_up_area,
                plot: u.config?.plot_area || u.plot_area
            },
            price: u.total_price || u.base_price,
            facing: u.facing,
            vastu: u.is_vastu_compliant ? 'Yes' : 'No',
            corner_unit: u.is_corner ? 'Yes' : 'No',
            possession: u.possession_date,
            construction: u.construction_status?.replace('_', ' ')
        }))
    };
}

async function handleLogIntent(leadId, args, callLogId) {
    const { error } = await supabase.from('leads').update({
        interest_level: args.interest_level,
        metadata: {
            budget_min: args.budget_min,
            budget_max: args.budget_max,
            category_interest: args.category?.toLowerCase(),
            property_type_interest: args.property_type,
            transaction_type_interest: args.transaction_type?.toLowerCase(),
            preferred_bhk: args.config_preference || args.bhk,
            preferences: {
                vastu_required: args.is_vastu_required,
                preferred_facing: args.preferred_facing,
                balconies_needed: args.balconies
            },
            pain_points: args.pain_points
        }
    }).eq('id', leadId);

    await supabase.from('call_logs').update({
        ai_metadata: args
    }).eq('id', callLogId);

    return { success: !error };
}

async function handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId) {
    const { data: org } = await supabase.from('leads').select('organization_id').eq('id', leadId).single();
    const { data: agents } = await supabase.from('profiles').select('phone, full_name').eq('organization_id', org.organization_id).eq('role', 'employee').eq('status', 'active').limit(1);

    const target = agents?.[0]?.phone || process.env.PLIVO_TRANSFER_NUMBER;
    const url = `${process.env.FRONTEND_URL}/api/webhooks/plivo/transfer?to=${encodeURIComponent(target)}&leadId=${leadId}&campaignId=${campaignId}`;

    await plivoClient.calls.transfer(callSid, { legs: 'aleg', aleg_url: url, aleg_method: 'POST' });
    await Promise.all([
        supabase.from('call_logs').update({ transferred: true, call_status: 'transferred' }).eq('id', callLogId),
        supabase.rpc('increment_campaign_stat', { campaign_uuid: campaignId, stat_name: 'transferred_calls' })
    ]);

    plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
    setTimeout(() => { plivoWS.close(); realtimeWS.close(); }, 700);
    return { success: true, agent: agents?.[0]?.full_name || 'Senior Consultant' };
}

async function handleDisconnect(plivoWS, realtimeWS, callSid, leadId, args, callLogId) {
    await supabase.from('call_logs').update({
        call_status: 'completed',
        disconnect_reason: args.reason
    }).eq('id', callLogId);

    // Flag lead as abusive if AI detected abuse
    if (args.reason === 'abusive') {
        await supabase.from('leads').update({
            abuse_flag: true,
            abuse_details: args.abuse_details || 'Abusive behavior detected during AI call'
        }).eq('id', leadId);
    }

    setTimeout(async () => {
        try { await plivoClient.calls.hangup(callSid); } catch (e) { }
        plivoWS.close();
        realtimeWS.close();
    }, 2000);
    return { success: true };
}

async function handleScheduleCallback(leadId, campaignId, args) {
    let callbackAt;
    try {
        callbackAt = new Date(args.callback_at).toISOString();
        if (isNaN(new Date(args.callback_at))) throw new Error('invalid date');
    } catch {
        // Fallback: 24 hours from now if AI sent unparseable value
        callbackAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }

    // 1. Update lead with callback time and waiting status
    await supabase.from('leads').update({
        callback_time: callbackAt,
        waiting_status: 'callback_scheduled'
    }).eq('id', leadId);

    // 2. Re-queue or create call_queue entry to fire at the requested time
    const { data: existing } = await supabase.from('call_queue')
        .select('id')
        .eq('lead_id', leadId)
        .eq('campaign_id', campaignId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (existing) {
        await supabase.from('call_queue').update({
            status: 'queued',
            next_retry_at: callbackAt,
            attempt_count: 0,
            last_error: null
        }).eq('id', existing.id);
    } else {
        const { data: lead } = await supabase.from('leads').select('organization_id').eq('id', leadId).single();
        await supabase.from('call_queue').insert({
            lead_id: leadId,
            campaign_id: campaignId,
            organization_id: lead.organization_id,
            status: 'queued',
            next_retry_at: callbackAt
        });
    }

    return { success: true, scheduled_at: callbackAt };
}

async function finalizeCallOutcome(callLogId, leadId, campaignId, transcript, callSid, callStartTime, organizationId) {
    try {
        const endedAt = new Date().toISOString();
        const durationSecs = Math.max(0, Math.round((Date.now() - callStartTime) / 1000));
        const COST_PER_MINUTE = parseFloat(process.env.CALL_COST_PER_MINUTE || '0.50');
        const callCost = parseFloat(((durationSecs / 60) * COST_PER_MINUTE).toFixed(4));

        // Finalize call log — only set call_status='completed' if still 'in_progress'
        // (handleDisconnect/handleTransfer may have already set a terminal status)
        await supabase.from('call_logs')
            .update({
                conversation_transcript: transcript,
                ended_at: endedAt,
                duration: durationSecs,
                call_cost: callCost,
                call_status: 'completed'
            })
            .eq('id', callLogId)
            .eq('call_status', 'in_progress');  // only overwrite if not already finalized

        // Also ensure ended_at/duration/cost are set even for transferred/completed calls
        await supabase.from('call_logs')
            .update({ conversation_transcript: transcript, ended_at: endedAt, duration: durationSecs, call_cost: callCost })
            .eq('id', callLogId)
            .neq('call_status', 'in_progress');

        // Deduct credits atomically (RPC enforces balance >= 0)
        if (callCost > 0 && organizationId) {
            await supabase.rpc('deduct_call_credits', { org_id: organizationId, deduction: callCost });
        }

        // Increment campaign answered_calls (any call with duration > 0 was answered)
        if (durationSecs > 0) {
            await supabase.rpc('increment_campaign_stat', { campaign_uuid: campaignId, stat_name: 'answered_calls' });
        }

        // Async sentiment analysis (non-blocking — errors caught inside)
        analyzeSentiment(transcript, leadId, callLogId, organizationId, callSid, campaignId);
    } catch (err) {
        console.error(`❌ [${callSid}] finalizeCallOutcome failed:`, err.message);
    }
}

/* -------------------------------
   WS HANDLER
-------------------------------- */

wss.on('connection', async (plivoWS, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const leadId = url.searchParams.get('leadId');
    const campaignId = url.searchParams.get('campaignId');
    const callSid = url.searchParams.get('callSid');

    plivoWS.startPromise = new Promise((resolve) => {
        plivoWS.resolveStart = resolve;
        // 5s Safety Timeout for Plivo Start Event
        setTimeout(() => resolve(), 5000);
    });

    plivoWS.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.event === 'media' && plivoWS.realtime?.readyState === WebSocket.OPEN) {
                plivoWS.realtime.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
            } else if (data.event === 'start') {
                plivoWS.streamId = data.start.streamId;
                if (plivoWS.resolveStart) plivoWS.resolveStart();
            }
        } catch (err) {
            console.error(`❌ [WS] Plivo message parse error:`, err.message);
        }
    });

    console.log(`🔌 [WS] New connection | Lead: ${leadId} | Campaign: ${campaignId} | CallSid: ${callSid}`);

    const realtimeWS = await startRealtimeWSConnection(plivoWS, leadId, campaignId, callSid);
    if (!realtimeWS) {
        console.error(`❌ [WS] startRealtimeWSConnection returned null — closing plivoWS.`);
        plivoWS.close();
    } else {
        plivoWS.realtime = realtimeWS;
    }
});

wss.on('error', (error) => {
    console.error('❌ WebSocket server error:', error);
});

server.listen(PORT, () => console.log(`\n✅ Vantage AI Server listening on ${PORT}`));
