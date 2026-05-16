import express from 'express';
import crypto from 'crypto';
import { logger } from '../lib/logger.js';

const router = express.Router();

// In-memory cache of generated briefing MP3s keyed by hash of the text.
// Plivo retries the confirmSound URL on each connect — caching avoids re-paying for TTS.
// TTL is 1 hour, plenty for a single transfer's lifetime.
const audioCache = new Map();
const TTL_MS = 60 * 60 * 1000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

router.get('/', async (req, res) => {
    const text = req.query.text;
    if (!text || typeof text !== 'string') {
        return res.status(400).send('Missing text');
    }

    const key = crypto.createHash('sha1').update(text).digest('hex');
    const cached = audioCache.get(key);
    if (cached && Date.now() - cached.savedAt < TTL_MS) {
        logger.info('briefing-audio cache hit', { key, bytes: cached.buffer.length });
        res.set('Content-Type', 'audio/mpeg').set('Cache-Control', 'public, max-age=3600').send(cached.buffer);
        return;
    }

    try {
        logger.info('briefing-audio generating', { key, textLen: text.length });
        const ttsResp = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'tts-1',
                voice: 'shimmer',
                input: text,
                response_format: 'mp3',
            }),
        });

        if (!ttsResp.ok) {
            const errText = await ttsResp.text();
            logger.error('OpenAI TTS failed', { status: ttsResp.status, body: errText });
            return res.status(500).send('TTS generation failed');
        }

        const buffer = Buffer.from(await ttsResp.arrayBuffer());
        audioCache.set(key, { buffer, savedAt: Date.now() });

        res.set('Content-Type', 'audio/mpeg').set('Cache-Control', 'public, max-age=3600').send(buffer);
    } catch (err) {
        logger.error('briefing-audio error', { error: err.message });
        res.status(500).send('Internal error');
    }
});

export default router;
