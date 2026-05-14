import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import answerRouter from './src/routes/answer.js';
import recordingRouter from './src/routes/recording.js';
import statusRouter from './src/routes/status.js';
import hangupRouter from './src/routes/hangup.js';
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
// Transfers the A-leg to a human agent, whispering call context to the agent (B-leg) upon answer
app.get('/transfer-xml', (req, res) => {
    const { target, context } = req.query;
    if (!target) return res.status(400).send('Missing target');
    res.set('Content-Type', 'text/xml');

    if (context) {
        // Use confirmSoundUrl to whisper context to the agent (B-leg) before bridging
        const whisperUrl = `${process.env.WEBSOCKET_SERVER_URL}/whisper-xml?context=${encodeURIComponent(context)}`;
        res.send(`<Response><Dial><Number confirmSoundUrl="${whisperUrl.replace(/&/g, '&amp;')}">${target}</Number></Dial></Response>`);
    } else {
        res.send(`<Response><Dial><Number>${target}</Number></Dial></Response>`);
    }
});

// Returns Speak XML for whispering context to an agent during transfer
app.get('/whisper-xml', (req, res) => {
    const { context } = req.query;
    res.set('Content-Type', 'text/xml');
    const speakXml = context
        ? `<Speak voice="Polly.Joanna">${context.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Speak>`
        : '';
    res.send(`<Response>${speakXml}</Response>`);
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
        setTimeout(resolve, 500); // Safety timeout if Plivo start event is delayed
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
