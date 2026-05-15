import WebSocket from 'ws';
import { logger } from './logger.js';

// Pre-warmed OpenAI Realtime WS connections, keyed by callSid.
// Started in /answer (the moment Plivo tells us the lead picked up) so the
// ~1-1.5s OpenAI WS handshake overlaps with Plivo's stream setup instead of
// running serially after the Plivo media WS connects.
const pending = new Map();

// Stale entries are cleaned up if no consumer claims them within 30s.
const STALE_MS = 30000;

export function prewarmRealtime(callSid) {
    if (!callSid) return;
    if (pending.has(callSid)) return; // already pre-warming
    const startedAt = Date.now();
    const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
        }
    });

    // Buffer the 'open' state so consumers that attach late don't miss it.
    let opened = false;
    let openError = null;
    ws.once('open', () => { opened = true; logger.info('Realtime prewarm open', { callSid, ms: Date.now() - startedAt }); });
    ws.once('error', (err) => { openError = err; logger.warn('Realtime prewarm error', { callSid, error: err.message }); });

    const entry = {
        ws,
        startedAt,
        isOpen: () => opened,
        getError: () => openError,
    };
    pending.set(callSid, entry);

    setTimeout(() => {
        const cur = pending.get(callSid);
        if (cur === entry) {
            pending.delete(callSid);
            if (cur.ws.readyState === WebSocket.OPEN || cur.ws.readyState === WebSocket.CONNECTING) {
                try { cur.ws.terminate(); } catch (_) {}
            }
            logger.warn('Realtime prewarm expired unused', { callSid });
        }
    }, STALE_MS).unref?.();
}

export function consumePrewarm(callSid) {
    if (!callSid) return null;
    const entry = pending.get(callSid);
    if (!entry) return null;
    pending.delete(callSid);
    return entry;
}
