import WebSocket from 'ws';
import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';
import { createSessionUpdate } from '../../sessionUpdate.js';
import { logCallStart, finalizeCallOutcome } from '../lib/callLifecycle.js';
import { getCachedContext, setCachedContext } from '../lib/contextCache.js';
import { dispatchTool } from '../tools/index.js';
import { handleDisconnect } from '../tools/disconnect.js';

// Detects farewell/closing utterances in the AI's transcript so we can force a hangup
// if the model said goodbye but forgot to call disconnect_call.
const FAREWELL_PATTERNS = [
    /\bhave a (nice|good|great) (day|evening)\b/i,
    /\bbye[\s,!.]/i,
    /\bgoodbye\b/i,
    /\btake care\b/i,
    /\bthank you (for your time|so much)\b/i,
    /\bphir baat karte\b/i,
    /\brakh deti hoon\b/i,
    /\brakh rahi hoon\b/i,
    /\bdhanyavaad\b/i,
    /\bshukriya\b/i,
    /\baabhar\b/i,
    /\baavjo\b/i,
    /\bnamaste[\s,!.]*$/i,
    /\bcall karte hain\b/i,
    /\bbaat karte hain\b/i,
];
function isFarewell(t) {
    if (!t) return false;
    return FAREWELL_PATTERNS.some(re => re.test(t));
}
import { logger } from '../lib/logger.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export async function startRealtimeWSConnection(plivoWS, leadId, campaignId, callSid) {
    try {
        // 1. Start OpenAI WS and DB context fetches in parallel IMMEDIATELY
        const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        // Fast greeting query — only the columns the opening line needs.
        // Resolves in ~100-200ms so we can start the AI talking ASAP after WS open.
        const greetingPromise = Promise.all([
            supabase.from('leads').select('name').eq('id', leadId).single(),
            supabase.from('campaigns').select('call_settings, organization:organizations!inner(name), campaign_projects(project:projects(name, locality))').eq('id', campaignId).single()
        ]);

        const contextPromise = Promise.all([
            supabase.from('leads').select('*, project:projects(*)').eq('id', leadId).single(),
            supabase.from('campaigns').select('*, organization:organizations!inner(id, name, caller_id, subscription_status, call_credits(*)), campaign_projects(project_id, project:projects(id, name, description, address, city, locality, possession_date, rera_number, amenities))').eq('id', campaignId).single()
        ]);

        // As soon as campaign resolves we know org ID — fire projects fetch immediately
        // so it runs in parallel with the open handler's validation logic.
        const orgProjectsPromise = contextPromise.then(([, { data: camp }]) => {
            if (!camp?.organization?.id) return [];
            const cacheKey = `projects_${camp.organization.id}`;
            const cached = getCachedContext(cacheKey);
            if (cached) return cached;
            return supabase.from('projects')
                .select('id, name, description, locality, city, address')
                .eq('organization_id', camp.organization.id)
                .eq('status', 'active')
                .then(({ data }) => {
                    const projects = data || [];
                    setCachedContext(cacheKey, projects);
                    return projects;
                });
        });

        // Fetch ACTUAL available units (not just config blueprints) for all campaign projects.
        // Units = real inventory the AI can promise. The joined config gives us the
        // property_type / category / config_name labels for each available unit.
        const campaignUnitsPromise = contextPromise.then(([, { data: camp }]) => {
            const projectIds = (camp?.campaign_projects || [])
                .map(cp => cp.project_id)
                .filter(Boolean);
            const fallbackProjectId = !projectIds.length && camp?.project_id ? [camp.project_id] : [];
            const ids = projectIds.length ? projectIds : fallbackProjectId;
            if (!ids.length) return [];
            const cacheKey = `units_${ids.sort().join('_')}`;
            const cached = getCachedContext(cacheKey);
            if (cached) return cached;
            return supabase.from('units')
                .select('project_id, total_price, base_price, price_undisclosed, bedrooms, facing, floor_number, config:unit_configs(category, property_type, config_name)')
                .in('project_id', ids)
                .eq('status', 'available')
                .eq('is_archived', false)
                .then(({ data }) => {
                    const units = data || [];
                    setCachedContext(cacheKey, units);
                    return units;
                });
        });

        let conversationTranscript = '';
        let callLogId = null;
        // Record when Plivo WS connects — this is when the lead actually answered.
        const callStartTime = Date.now();
        let silenceTimer = null;
        let cleanupCalled = false;
        let keepalive = null;
        let responseActive = false; // tracks whether OpenAI has an active response in-flight
        let silenceTimeoutMs = 25000; // Default until campaign context loads
        // Debounce cancel: only cancel AI if user speech is sustained (>300ms), not brief
        // backchannel affirmations like "haa", "acha", "hmm" common in Indian conversations.
        let cancelDebounce = null;
        // Backstop: scheduled disconnect after AI says a farewell line. Cleared if the lead
        // speaks again (false alarm — conversation continued).
        let farewellDisconnectTimer = null;
        // Timestamp of the most recent tool call. The farewell backstop uses this to avoid
        // hanging up while a multi-tool turn (e.g. book_site_visit + log_intent) is still firing.
        let lastToolCallAt = 0;

        // Shared context lifted to the outer scope so the message handler (registered
        // outside the open handler) can access them when dispatching tool calls.
        let organization = null;
        let campaignProjectIds = [];
        let leadHints = {};

        // Accumulated OpenAI Realtime token usage across all response.done events this call
        const realtimeUsage = {
            input_text_tokens: 0, input_audio_tokens: 0,
            output_text_tokens: 0, output_audio_tokens: 0,
            total_tokens: 0,
        };

        // If OpenAI WS doesn't open within 12s, hang up
        const startupTimeout = setTimeout(async () => {
            if (realtimeWS.readyState !== WebSocket.OPEN) {
                logger.error('OpenAI connect timeout — hanging up', { callSid });
                realtimeWS.terminate();
                try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                plivoWS.close();
            }
        }, 12000);

        const resetSilenceTimer = () => {
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
                logger.info('Silence timeout — disconnecting', { callSid, timeoutSec: silenceTimeoutMs / 1000 });
                const { handleDisconnect } = await import('../tools/disconnect.js');
                await handleDisconnect(plivoWS, realtimeWS, callSid, leadId, { reason: 'silence' }, callLogId);
            }, silenceTimeoutMs);
        };

        const cleanup = async () => {
            if (cleanupCalled) return;
            cleanupCalled = true;
            clearTimeout(startupTimeout);
            if (silenceTimer) clearTimeout(silenceTimer);
            if (farewellDisconnectTimer) clearTimeout(farewellDisconnectTimer);
            if (keepalive) clearInterval(keepalive);
            if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.close();

            // We need the context for cleanup too, so wait if it hasn't finished yet
            const [{ data: context }, { data: campaign }] = await contextPromise;
            if (context && campaign) {
                await finalizeCallOutcome(
                    callLogId, leadId, campaignId, conversationTranscript,
                    callSid, callStartTime || Date.now(), campaign.organization_id, campaign.name,
                    realtimeUsage
                );
            }
        };

        // Wire cleanup to both sides before anything can close them
        plivoWS.on('close', cleanup);
        realtimeWS.on('close', cleanup);

        realtimeWS.on('error', (err) => {
            logger.error('OpenAI WS error', { callSid, error: err.message });
            // error always precedes close, so cleanup will run via the 'close' handler
        });

        // Resolves when OpenAI confirms session config is applied
        let resolveSessionReady;
        const sessionReadyPromise = new Promise(r => { resolveSessionReady = r; });

        realtimeWS.on('open', async () => {
            try {
                clearTimeout(startupTimeout);
                logger.info('OpenAI WS ready', { callSid });

                // 2a. Wait for the FAST greeting query (lead name + campaign org/projects).
                // This typically resolves in ~100-200ms so the AI can start speaking quickly
                // instead of waiting for the heavy contextPromise (~500-1500ms).
                const [{ data: leadLite, error: leadLiteErr }, { data: campLite, error: campLiteErr }] = await greetingPromise;

                if (leadLiteErr || campLiteErr || !leadLite || !campLite) {
                    logger.error('Greeting context fetch failed', { callSid, leadErr: leadLiteErr?.message, campErr: campLiteErr?.message });
                    realtimeWS.close();
                    try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                    plivoWS.close();
                    return;
                }

                const firstName = leadLite.name?.split(' ')[0] || '';
                const orgNameFast = campLite.organization?.name || 'hamari company';
                const firstProject = campLite.campaign_projects?.[0]?.project;
                const projectNameFast = firstProject?.name || '';
                const projectLocFast = firstProject?.locality || '';
                silenceTimeoutMs = (campLite.call_settings?.silence_timeout || 25) * 1000;

                // Minimal greet-only prompt. Same VAD/audio config as the full session.update —
                // the follow-up update will replace `instructions` with the rich prompt before
                // turn 2 needs it. The greeting (turn 1) is constrained to ONE line so an
                // abbreviated prompt is sufficient and safe.
                const greetingInstructions = `You are Riya, a female sales consultant at ${orgNameFast}. The call has JUST connected. Your VERY FIRST utterance must be exactly one short Hinglish greeting line — introduce yourself + company + reason for call. Use feminine grammar ("bol rahi hoon"). Then STOP and wait for the lead. Do NOT ask qualifying questions yet. Do NOT explain anything. ONE sentence only.\n\nSay exactly: "Hi ${firstName} ji, main Riya bol rahi hoon ${orgNameFast} se — ${projectNameFast ? `${projectNameFast} project${projectLocFast ? ` ${projectLocFast} mein` : ''} ke regarding` : 'ek premium property project ke regarding'} call kar rahi thi."`;

                const fastSessionUpdate = {
                    type: 'session.update',
                    session: {
                        turn_detection: { type: 'server_vad', threshold: 0.55, prefix_padding_ms: 150, silence_duration_ms: 500 },
                        input_audio_format: 'g711_ulaw',
                        output_audio_format: 'g711_ulaw',
                        modalities: ['text', 'audio'],
                        temperature: 0.6,
                        input_audio_transcription: { model: 'whisper-1' },
                        instructions: greetingInstructions,
                        voice: 'shimmer',
                    }
                };
                realtimeWS.send(JSON.stringify(fastSessionUpdate));

                await plivoWS.startPromise;
                const t0 = Date.now();
                realtimeWS.send(JSON.stringify({ type: 'response.create' }));
                logger.info('Greeting dispatched (fast path)', { callSid, msFromConnect: t0 - callStartTime });
                resetSilenceTimer();

                // Kick off Plivo-side recording. Plivo's <Stream> doesn't record by itself —
                // we trigger it via API so the recording callback fires with a recording_url.
                plivoClient.calls.record(callSid, {
                    callback_url: `${process.env.WEBSOCKET_SERVER_URL}/recording`,
                    callback_method: 'POST',
                    file_format: 'mp3',
                }).then(r => {
                    logger.info('Recording started', { callSid, recordingId: r?.recordingId || r?.recording_id });
                }).catch(err => {
                    logger.error('Recording start failed', { callSid, error: err.message });
                });

                // 2b. Now wait for full context — runs in background while greeting plays.
                const [{ data: context, error: contextError }, { data: campaignData, error: campaignError }] = await contextPromise;

                if (contextError || campaignError || !context || !campaignData) {
                    logger.error('Context fetch failed', { callSid, leadError: contextError?.message, campaignError: campaignError?.message });
                    // Greeting already playing; tear down after it finishes naturally via close handlers.
                    realtimeWS.close();
                    try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                    plivoWS.close();
                    return;
                }

                const campaign = campaignData;
                silenceTimeoutMs = (campaign.call_settings?.silence_timeout || 25) * 1000;

                organization = campaign.organization;
                const credits = organization?.call_credits;
                const balance = Array.isArray(credits) ? parseFloat(credits[0]?.balance || 0) : parseFloat(credits?.balance || 0);

                if (!['active', 'running'].includes(campaign.status) || !['active', 'trialing'].includes(organization.subscription_status) || balance < 0.5) {
                    logger.warn('Call rejected (status or credits)', { callSid, campaignStatus: campaign.status, balance });
                    realtimeWS.close();
                    try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                    plivoWS.close();
                    return;
                }

                let campaignProjects = campaign.campaign_projects?.map(cp => cp.project).filter(Boolean) || [];
                if (campaignProjects.length === 0 && campaign.project_id) {
                    campaignProjects = [context.project].filter(Boolean);
                }
                campaignProjectIds = campaignProjects.map(p => p.id);

                leadHints = {
                    preferred_configuration: context.preferred_configuration,
                    preferred_category: context.preferred_category,
                    preferred_location: context.preferred_location,
                    min_budget: context.min_budget,
                    max_budget: context.max_budget,
                    preferred_timeline: context.preferred_timeline,
                };

                const [allOrgProjects, campaignUnits] = await Promise.all([orgProjectsPromise, campaignUnitsPromise]);

                // Send the full session.update — replaces the minimal greeting prompt for turn 2 onwards.
                // OpenAI Realtime applies session updates immediately; any in-flight greeting completes
                // under the original instructions, which is what we want.
                const sessionUpdate = createSessionUpdate(context, campaign, campaignProjects, allOrgProjects, campaignUnits);
                realtimeWS.send(JSON.stringify(sessionUpdate));
                logger.info('Full session prompt installed', { callSid, msFromConnect: Date.now() - callStartTime, promptBytes: sessionUpdate.session.instructions.length });

                // Resolve call log ID in background; tools that need it will find it set.
                logCallStart(context, campaign, callSid).then(async id => {
                    callLogId = id;
                    // Record the actual conversation start time so the live calls page
                    // can show accurate duration (call_logs.created_at is pre-connection).
                    if (id) {
                        await supabase.from('call_logs')
                            .update({ metadata: { started_at: new Date(callStartTime).toISOString() } })
                            .eq('id', id);
                    }
                }).catch(err => {
                    logger.error('logCallStart failed', { callSid, error: err.message });
                });

                // Prevent idle connection drops on cloud proxies
                keepalive = setInterval(() => {
                    if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.ping();
                    else clearInterval(keepalive);
                }, 25000);
            } catch (err) {
                logger.error('Open handler crash', { callSid, error: err.message });
                realtimeWS.close();
                try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                plivoWS.close();
            }
        });

        realtimeWS.on('pong', () => {});

        realtimeWS.on('message', async (message) => {
            try {
                const response = JSON.parse(message);

                // Only user-side activity should reset the silence timer. Resetting on every
                // OpenAI event (including the AI's own audio deltas) means the timer effectively
                // never measures actual lead silence. We reset on user speech start/stop and
                // on completed user transcriptions below.
                switch (response.type) {
                    case 'session.updated':
                        resolveSessionReady();
                        break;

                    case 'response.function_call_arguments.done': {
                        const { name, arguments: argsJson, call_id } = response;
                        const args = JSON.parse(argsJson);
                        lastToolCallAt = Date.now();

                        // Mid-call credit pulse check (skip if context not yet ready)
                        if (!organization?.id) {
                            logger.warn('Tool call before context ready', { callSid, tool: name });
                            break;
                        }
                        const { data: creditPulse } = await supabase.from('call_credits').select('balance').eq('organization_id', organization.id).single();
                        if (!creditPulse || creditPulse.balance < 0.1) {
                            realtimeWS.send(JSON.stringify({
                                type: 'conversation.item.create',
                                item: { type: 'function_call_output', call_id, output: JSON.stringify({ success: false, error: 'Balance depleted.' }) }
                            }));
                            realtimeWS.send(JSON.stringify({ type: 'response.create' }));
                            break;
                        }

                        let result;
                        try {
                            result = await dispatchTool(name, args, { plivoWS, realtimeWS, callSid, leadId, campaignId, callLogId, organizationId: organization?.id, campaignProjectIds, leadHints });
                        } catch (err) {
                            logger.error('Tool dispatch error', { callSid, tool: name, error: err.message });
                            result = { success: false, error: err.message };
                        }

                        realtimeWS.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: { type: 'function_call_output', call_id, output: JSON.stringify(result) }
                        }));
                        realtimeWS.send(JSON.stringify({ type: 'response.create' }));
                        break;
                    }

                    case 'response.created':
                        responseActive = true;
                        break;

                    case 'response.done':
                        responseActive = false;
                        // Start measuring lead silence from the moment the AI finishes speaking.
                        resetSilenceTimer();
                        if (response.response?.usage) {
                            const u = response.response.usage;
                            realtimeUsage.input_text_tokens  += u.input_token_details?.text_tokens  || 0;
                            realtimeUsage.input_audio_tokens += u.input_token_details?.audio_tokens || 0;
                            realtimeUsage.output_text_tokens  += u.output_token_details?.text_tokens  || 0;
                            realtimeUsage.output_audio_tokens += u.output_token_details?.audio_tokens || 0;
                            realtimeUsage.total_tokens        += u.total_tokens || 0;
                        }
                        break;

                    case 'response.cancelled':
                        responseActive = false;
                        break;

                    case 'input_audio_buffer.speech_started':
                        resetSilenceTimer();
                        // Lead is speaking again — false alarm on the farewell, conversation continues.
                        if (farewellDisconnectTimer) {
                            clearTimeout(farewellDisconnectTimer);
                            farewellDisconnectTimer = null;
                        }
                        // Debounce: wait 320ms before cancelling the AI response.
                        // Brief Indian backchannels ("haa", "acha", "hmm") are typically
                        // under 300ms and should not interrupt the AI mid-sentence.
                        // If speech_stopped fires before the debounce fires, we clear it.
                        if (cancelDebounce) clearTimeout(cancelDebounce);
                        cancelDebounce = setTimeout(() => {
                            cancelDebounce = null;
                            if (plivoWS.readyState === WebSocket.OPEN) {
                                plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
                            }
                            if (responseActive) {
                                realtimeWS.send(JSON.stringify({ type: 'response.cancel' }));
                            }
                        }, 320);
                        break;

                    case 'input_audio_buffer.speech_stopped':
                        resetSilenceTimer();
                        // User stopped speaking before the debounce fired — it was a brief
                        // backchannel, not a real interruption. Cancel the pending cancel.
                        if (cancelDebounce) {
                            clearTimeout(cancelDebounce);
                            cancelDebounce = null;
                        }
                        break;

                    case 'response.audio.delta':
                        if (plivoWS.readyState === WebSocket.OPEN) {
                            plivoWS.send(JSON.stringify({
                                event: 'playAudio',
                                media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: response.delta }
                            }));
                        }
                        break;

                    case 'conversation.item.input_audio_transcription.completed':
                        conversationTranscript += `User: ${response.transcript}\n`;
                        break;

                    case 'response.audio_transcript.done':
                        conversationTranscript += `AI: ${response.transcript}\n`;
                        // Backstop: if the AI clearly said a farewell line but didn't call disconnect_call,
                        // auto-disconnect after a delay (so the goodbye audio finishes playing AND any
                        // in-flight tool calls — e.g. book_site_visit + log_intent fired in the same turn —
                        // get a chance to complete). Without this the line stays open in awkward silence
                        // until the 25s silence timer.
                        if (!farewellDisconnectTimer && isFarewell(response.transcript)) {
                            logger.info('Farewell detected in AI transcript — scheduling auto-disconnect', { callSid, transcript: response.transcript });
                            const tryDisconnect = async () => {
                                // Defer if a tool call was made recently — let it finish.
                                const sinceLastTool = Date.now() - lastToolCallAt;
                                if (lastToolCallAt > 0 && sinceLastTool < 3000) {
                                    logger.info('Farewell disconnect deferred — tool call in flight', { callSid, sinceLastTool });
                                    farewellDisconnectTimer = setTimeout(tryDisconnect, 1500);
                                    return;
                                }
                                // Defer if the AI is mid-response (still generating audio).
                                if (responseActive) {
                                    logger.info('Farewell disconnect deferred — response still active', { callSid });
                                    farewellDisconnectTimer = setTimeout(tryDisconnect, 1000);
                                    return;
                                }
                                try {
                                    await handleDisconnect(plivoWS, realtimeWS, callSid, leadId, { reason: 'completed' }, callLogId);
                                } catch (e) {
                                    logger.error('Auto-disconnect after farewell failed', { callSid, error: e.message });
                                }
                            };
                            farewellDisconnectTimer = setTimeout(tryDisconnect, 4000);
                        }
                        break;

                    case 'error':
                        logger.error('OpenAI Realtime API error event', { callSid, error: response.error });
                        break;
                }
            } catch (err) {
                logger.error('WS message handler error', { callSid, error: err.message });
            }
        });

        return realtimeWS;

    } catch (err) {
        logger.error('startRealtimeWSConnection crash', { callSid, error: err.message, stack: err.stack });
        try { await plivoClient.calls.hangup(callSid); } catch (_) {}
        plivoWS.close();
        return null;
    }
}

