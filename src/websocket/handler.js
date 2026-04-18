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
        const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        });

        realtimeWS.on('error', (err) => {
            logger.error('OpenAI WS error', { callSid, error: err.message });
        });

        const startupTimeout = setTimeout(async () => {
            if (realtimeWS.readyState !== WebSocket.OPEN) {
                logger.error('OpenAI connect timeout', { callSid });
                realtimeWS.terminate();
                try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                plivoWS.close();
            }
        }, 10000);

        // Fetch lead and campaign in parallel
        const [{ data: context, error: contextError }, { data: campaignData }] = await Promise.all([
            supabase.from('leads').select('*, project:projects(*)').eq('id', leadId).single(),
            supabase.from('campaigns').select('*, organization:organizations!inner(id, name, caller_id, subscription_status, call_credits(*))').eq('id', campaignId).single()
        ]);

        if (contextError || !context || !campaignData) {
            logger.error('Context fetch failed', { callSid, error: contextError?.message });
            clearTimeout(startupTimeout);
            realtimeWS.close();
            return null;
        }

        const campaign = campaignData;
        const organization = campaign.organization;
        const credits = organization?.call_credits;
        const balance = Array.isArray(credits) ? parseFloat(credits[0]?.balance || 0) : parseFloat(credits?.balance || 0);

        if (!['active', 'running'].includes(campaign.status) || (context.project && context.project.archived_at)) {
            logger.warn('Campaign or project inactive', { callSid, status: campaign.status });
            clearTimeout(startupTimeout);
            realtimeWS.close();
            return null;
        }

        if (!['active', 'trialing'].includes(organization.subscription_status) || balance < 0.5) {
            logger.warn('Credits exhausted or subscription inactive', { callSid, balance, subStatus: organization.subscription_status });
            clearTimeout(startupTimeout);
            realtimeWS.close();
            return null;
        }

        let conversationTranscript = '';
        let callLogId = null;
        let callStartTime = null;
        let silenceTimer = null;
        let cleanupCalled = false;

        const silenceTimeoutMs = (campaign.call_settings?.silence_timeout || 15) * 1000;

        const resetSilenceTimer = () => {
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(async () => {
                logger.info('Silence timeout', { callSid, timeoutSec: silenceTimeoutMs / 1000 });
                const { handleDisconnect } = await import('../tools/disconnect.js');
                await handleDisconnect(plivoWS, realtimeWS, callSid, leadId, { reason: 'silence' }, callLogId);
            }, silenceTimeoutMs);
        };

        realtimeWS.on('open', async () => {
            try {
                clearTimeout(startupTimeout);
                logger.info('OpenAI WS ready', { callSid });

                await plivoWS.startPromise;
                await sendSessionUpdate(realtimeWS, context, campaign, callSid);
                realtimeWS.send(JSON.stringify({ type: 'response.create' }));

                callLogId = await logCallStart(context, campaign, callSid);
                callStartTime = Date.now();
                resetSilenceTimer();
            } catch (err) {
                logger.error('Open handler crash', { callSid, error: err.message });
                realtimeWS.close();
                try { await plivoClient.calls.hangup(callSid); } catch (_) {}
                plivoWS.close();
            }
        });

        // Prevent idle connection drops on cloud proxies
        const keepalive = setInterval(() => {
            if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.ping();
            else clearInterval(keepalive);
        }, 25000);

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
                            result = await dispatchTool(name, args, { plivoWS, realtimeWS, callSid, leadId, campaignId, callLogId });
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
                }
            } catch (err) {
                logger.error('WS message handler error', { callSid, error: err.message });
            }
        });

        const cleanup = async () => {
            if (cleanupCalled) return;
            cleanupCalled = true;
            clearTimeout(startupTimeout);
            if (silenceTimer) clearTimeout(silenceTimer);
            clearInterval(keepalive);
            if (realtimeWS.readyState === WebSocket.OPEN) realtimeWS.close();
            if (callLogId) {
                await finalizeCallOutcome(
                    callLogId, leadId, campaignId, conversationTranscript,
                    callSid, callStartTime || Date.now(), organization.id, campaign.name
                );
            }
        };

        plivoWS.on('close', cleanup);
        realtimeWS.on('close', cleanup);

        return realtimeWS;

    } catch (err) {
        logger.error('startRealtimeWSConnection crash', { callSid, error: err.message, stack: err.stack });
        plivoWS.close();
        return null;
    }
}

async function sendSessionUpdate(realtimeWS, lead, campaign, callSid) {
    const cacheKey = `projects_${campaign.organization_id}`;
    let projects = getCachedContext(cacheKey);

    if (!projects) {
        const { data } = await supabase.from('projects')
            .select('name, description, location')
            .eq('organization_id', campaign.organization_id)
            .eq('status', 'active');
        projects = data || [];
        setCachedContext(cacheKey, projects);
    }

    const sessionUpdate = createSessionUpdate(lead, campaign, projects);
    if (realtimeWS.readyState === WebSocket.OPEN) {
        realtimeWS.send(JSON.stringify(sessionUpdate));
        logger.info('session.update sent', { callSid, voice: campaign.call_settings?.voice_id, lang: campaign.call_settings?.language });
    }
}
