import WebSocket from 'ws';
import { supabase } from '../../services/supabase.js';
import { logger } from './logger.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Keyed by callSid. Each entry holds the eagerly-opened OpenAI WS + parallel DB fetches
// kicked off the moment Plivo hits /answer, so by the time Plivo's WebSocket stream
// connects (~1.5s later), the OpenAI handshake and greeting query are already in flight
// or done. Saves ~1.5s of dead time on every call.
const prewarmCache = new Map();

// Auto-evict stale entries (e.g. call dropped before WS connected) after 30s.
const TTL_MS = 30000;

export function prewarmCall(callSid, leadId, campaignId) {
    if (prewarmCache.has(callSid)) return;

    const startedAt = Date.now();
    const realtimeWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
        }
    });

    const greetingPromise = Promise.all([
        supabase.from('leads').select('name').eq('id', leadId).single(),
        supabase.from('campaigns').select('call_settings, organization:organizations!inner(name), campaign_projects(project:projects(name, locality))').eq('id', campaignId).single()
    ]);

    const contextPromise = Promise.all([
        supabase.from('leads').select('*, project:projects(*)').eq('id', leadId).single(),
        supabase.from('campaigns').select('*, organization:organizations!inner(id, name, caller_id, subscription_status, call_credits(*)), campaign_projects(project_id, project:projects(id, name, description, address, city, locality, possession_date, rera_number, amenities))').eq('id', campaignId).single()
    ]);

    const entry = { realtimeWS, greetingPromise, contextPromise, startedAt };
    prewarmCache.set(callSid, entry);

    // Eviction safety net — if WS handler never picks this up, close the OpenAI socket.
    const ttlTimer = setTimeout(() => {
        if (prewarmCache.has(callSid)) {
            logger.warn('Prewarm entry evicted (TTL) — no WS upgrade arrived', { callSid });
            try { realtimeWS.terminate(); } catch (_) {}
            prewarmCache.delete(callSid);
        }
    }, TTL_MS);
    entry.ttlTimer = ttlTimer;

    logger.info('Prewarm started', { callSid });
}

export function consumePrewarm(callSid) {
    const entry = prewarmCache.get(callSid);
    if (!entry) return null;
    clearTimeout(entry.ttlTimer);
    prewarmCache.delete(callSid);
    logger.info('Prewarm consumed', { callSid, ageMs: Date.now() - entry.startedAt });
    return entry;
}
