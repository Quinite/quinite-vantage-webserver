import WebSocket from 'ws';
import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';
import { createSessionUpdate } from '../../sessionUpdate.js';
import { logCallStart, finalizeCallOutcome } from '../lib/callLifecycle.js';
import { getCachedContext, setCachedContext } from '../lib/contextCache.js';
import { dispatchTool } from '../tools/index.js';
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

                // 2. Wait for context fetch to finish
                const [{ data: context, error: contextError }, { data: campaignData, error: campaignError }] = await contextPromise;
                
                if (contextError || campaignError || !context || !campaignData) {
                    logger.error('Context fetch failed', { callSid, leadError: contextError?.message, campaignError: campaignError?.message });
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

                // Derive campaign projects (junction table rows); backward-compat fallback to lead's project
                let campaignProjects = campaign.campaign_projects?.map(cp => cp.project).filter(Boolean) || [];
                if (campaignProjects.length === 0 && campaign.project_id) {
                    campaignProjects = [context.project].filter(Boolean);
                }
                campaignProjectIds = campaignProjects.map(p => p.id);

                // Snapshot lead preferences for the inventory tool's relevance ranking
                leadHints = {
                    preferred_configuration: context.preferred_configuration,
                    preferred_category: context.preferred_category,
                    preferred_location: context.preferred_location,
                    min_budget: context.min_budget,
                    max_budget: context.max_budget,
                    preferred_timeline: context.preferred_timeline,
                };

                // 3. Org projects & campaign available units were fetching in parallel — await both.
                const [allOrgProjects, campaignUnits] = await Promise.all([orgProjectsPromise, campaignUnitsPromise]);

                // 4. Send session update first, then wait for Plivo stream to be ready
                // before triggering the greeting — otherwise the opening audio chunks are
                // emitted before Plivo can play them and the lead hears nothing until they speak.
                const sessionUpdate = createSessionUpdate(context, campaign, campaignProjects, allOrgProjects, campaignUnits);
                realtimeWS.send(JSON.stringify(sessionUpdate));

                await plivoWS.startPromise;
                const t0 = Date.now();
                realtimeWS.send(JSON.stringify({ type: 'response.create' }));
                logger.info('Greeting dispatched', { callSid, msFromConnect: t0 - callStartTime, promptBytes: sessionUpdate.session.instructions.length });
                resetSilenceTimer();

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

