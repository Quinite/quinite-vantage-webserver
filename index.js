import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import answerRouter from './src/routes/answer.js';
import recordingRouter from './src/routes/recording.js';
import statusRouter from './src/routes/status.js';
import hangupRouter from './src/routes/hangup.js';
import briefingAudioRouter from './src/routes/briefingAudio.js';
import { consumePostStreamAction } from './src/lib/postStreamRoute.js';
import { startRealtimeWSConnection } from './src/websocket/handler.js';
import { logger } from './src/lib/logger.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

const PORT = parseInt(process.env.PORT) || 10000;

app.get(['/', '/health'], (req, res) => res.send('OK'));
app.use('/answer', answerRouter);
app.use('/recording', recordingRouter);
app.use('/status', statusRouter);
app.use('/calls', hangupRouter);
app.use('/briefing-audio', briefingAudioRouter);

// Called by Plivo after the <Stream> element completes (i.e. our WebSocket closed).
// Consults in-memory state to decide what's next: transfer to agent, or hang up.
app.all('/after-stream', (req, res) => {
    const callSid = req.query.callSid || req.body?.callSid;
    const action = consumePostStreamAction(callSid);
    res.set('Content-Type', 'text/xml');

    logger.info('after-stream hit', { callSid, hasAction: !!action, action: action?.type });

    if (action?.type === 'transfer' && action.target) {
        const briefingAttr = action.briefingUrl
            ? ` confirmSound="${action.briefingUrl.replace(/&/g, '&amp;')}" confirmKey="1"`
            : '';
        res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="30" hangupOnStar="false" callerId="${process.env.PLIVO_PHONE_NUMBER || ''}"><Number${briefingAttr}>${action.target}</Number></Dial>
</Response>`);
        return;
    }

    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup/>
</Response>`);
});

server.on('upgrade', (request, socket, head) => {
    if (request.url.startsWith('/voice/stream')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', async (plivoWS, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const leadId = url.searchParams.get('leadId');
    const campaignId = url.searchParams.get('campaignId');
    const callSid = url.searchParams.get('callSid');

    logger.info('WS connection', { leadId, campaignId, callSid });

    plivoWS.startPromise = new Promise((resolve) => {
        plivoWS.resolveStart = resolve;
        setTimeout(resolve, 800); // Safety timeout if Plivo start event is delayed
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
            logger.error('Plivo message parse error', { error: err.message });
        }
    });

    const realtimeWS = await startRealtimeWSConnection(plivoWS, leadId, campaignId, callSid);
    if (realtimeWS) {
        plivoWS.realtime = realtimeWS;
    } else {
        logger.error('Failed to start realtime connection', { callSid });
        plivoWS.close();
    }
});

wss.on('error', (err) => logger.error('WSS error', { error: err.message }));

server.listen(PORT, () => logger.info(`Vantage AI Server listening`, { port: PORT }));
