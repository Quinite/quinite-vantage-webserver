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
        logger.info('Fetching call context', { callSid, leadId, campaignId });

        // Fetch lead and campaign BEFORE creating the OpenAI WS.
        // If we created the WS first and then awaited DB queries, the 'open' event
        // could fire while we're still awaiting — before the handler is registered — and be lost.
        const [{ data: context, error: contextError }, { data: campaignData, error: campaignError }] = await Promise.all([
            supabase.from('leads').select('*, project:projects(*)').eq('id', leadId).single(),
            supabase.from('campaigns').select('*, organization:organizations!inner(id, name, caller_id, subscription_status, call_credits(*)), campaign_projects(project_id, project:projects(id, name, description, address, city, locality, possession_date, rera_number, amenities))').eq('id', campaignId).single()
        ]);

        if (contextError || campaignError || !context || !campaignData) {
            logger.error('Context fetch failed', { callSid, leadError: contextError?.message, campaignError: campaignError?.message });
            try { await plivoClient.calls.hangup(callSid); } catch (_) {}
            plivoWS.close();
            return null;
        }

        const campaign = campaignData;
        const organization = campaign.organization;
        const credits = organization?.call_credits;
        const balance = Array.isArray(credits) ? parseFloat(credits[0]?.balance || 0) : parseFloat(credits?.balance || 0);

        // Derive campaign projects (junction table rows); backward-compat fallback to lead's project
        let campaignProjects = campaign.campaign_projects?.map(cp => cp.project).filter(Boolean) || [];
        if (campaignProjects.length === 0 && campaign.project_id) {
            campaignProjects = [context.project].filter(Boolean);
        }
        const campaignProjectIds = campaignProjects.map(p => p.id);

        if (!['active', 'running'].includes(campaign.status)) {
            logger.warn('Campaign or project inactive — rejecting call', { callSid, status: campaign.status });
            try { await plivoClient.calls.hangup(callSid); } catch (_) {}
            plivoWS.close();
            return null;
        }

        if (!['active', 'trialing'].includes(organization.subscription_status) || balance < 0.5) {
            logger.warn('Credits exhausted or subscription inactive — rejecting call', { callSid, balance, subStatus: organization.subscription_status });
            try { await plivoClient.calls.hangup(callSid); } catch (_) {}
            plivoWS.close();
            return null;
        }

        logger.info('Context ready — opening OpenAI WS', { callSid, leadName: context.name, campaignId });

        // All validation passed. Now create the OpenAI WS. All handlers are registered
        // synchronously before yielding, so no event can fire before we're ready.
        const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        let conversationTranscript = '';
        let callLogId = null;
        let callStartTime = null;
        let silenceTimer = null;
        let cleanupCalled = false;
        let keepalive = null;
        let responseActive = false; // tracks whether OpenAI has an active response in-flight

        const silenceTimeoutMs = (campaign.call_settings?.silence_timeout || 15) * 1000;

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

            await finalizeCallOutcome(
                callLogId, leadId, campaignId, conversationTranscript,
                callSid, callStartTime || Date.now(), organization.id, campaign.name
            );
        };

        // Wire cleanup to both sides before anything can close them
        plivoWS.on('close', cleanup);
        realtimeWS.on('close', cleanup);

        realtimeWS.on('error', (err) => {
            logger.error('OpenAI WS error', { callSid, error: err.message });
            // error always precedes close, so cleanup will run via the 'close' handler
        });

        realtimeWS.on('open', async () => {
            try {
                clearTimeout(startupTimeout);
                logger.info('OpenAI WS ready', { callSid });

                await plivoWS.startPromise;
                await sendSessionUpdate(realtimeWS, context, campaign, campaignProjects, callSid);
                realtimeWS.send(JSON.stringify({ type: 'response.create' }));

                callLogId = await logCallStart(context, campaign, callSid);
                callStartTime = Date.now();
                resetSilenceTimer();

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
                resetSilenceTimer();

                switch (response.type) {
                    case 'response.function_call_arguments.done': {
                        const { name, arguments: argsJson, call_id } = response;
                        const args = JSON.parse(argsJson);

                        // Mid-call credit pulse check
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
                            result = await dispatchTool(name, args, { plivoWS, realtimeWS, callSid, leadId, campaignId, callLogId, organizationId: organization.id, campaignProjectIds });
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
                    case 'response.cancelled':
                        responseActive = false;
                        break;

                    case 'input_audio_buffer.speech_started':
                        if (plivoWS.readyState === WebSocket.OPEN) {
                            plivoWS.send(JSON.stringify({ event: 'clearAudio' }));
                        }
                        if (responseActive) {
                            realtimeWS.send(JSON.stringify({ type: 'response.cancel' }));
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

async function sendSessionUpdate(realtimeWS, lead, campaign, campaignProjects, callSid) {
    // Fetch all org projects for the "other projects" section (cached 30min)
    const cacheKey = `projects_${campaign.organization_id}`;
    let allOrgProjects = getCachedContext(cacheKey);

    if (!allOrgProjects) {
        const { data } = await supabase.from('projects')
            .select('id, name, description, locality, city, address')
            .eq('organization_id', campaign.organization_id)
            .eq('status', 'active');
        allOrgProjects = data || [];
        setCachedContext(cacheKey, allOrgProjects);
    }

    logger.info('Session context', {
        callSid,
        leadName: lead.name,
        leadProject: lead.project?.name || 'none',
        campaignProjects: campaignProjects.map(p => p.name),
        language: campaign.call_settings?.language,
        voice: campaign.call_settings?.voice_id
    });

    const sessionUpdate = createSessionUpdate(lead, campaign, campaignProjects, allOrgProjects);
    if (realtimeWS.readyState === WebSocket.OPEN) {
        realtimeWS.send(JSON.stringify(sessionUpdate));
        logger.info('session.update sent', { callSid, voice: campaign.call_settings?.voice_id, lang: campaign.call_settings?.language, campaignProjectCount: campaignProjects.length });
    }
}
