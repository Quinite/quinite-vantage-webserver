# 🔍 Quinite Vantage WebServer — Professional Codebase Audit

> **Audited Files**: [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js), [queueWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/queueWorker.js), [retryWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/retryWorker.js), [sessionUpdate.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/sessionUpdate.js), [services/openaiService.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/services/openaiService.js), [package.json](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/package.json), [.env.example](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/.env.example)
> **Date**: 2026-03-21

---

## 🐛 BUGS — Things That Are Currently Wrong

### 1. `supabase.raw()` Does Not Exist on the JS Client ❌ CRITICAL
**File**: [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js) line 217
```js
// BROKEN — supabase-js has no `.raw()` method
total_calls: supabase.raw('total_calls + 1')
```
**Fix**: Use a Postgres RPC or just fetch + increment:
```js
// Option A: Use an RPC function in Supabase
await supabase.rpc('increment_lead_total_calls', { lead_id: leadId });

// Option B: Read then write (fine for low volume)
const { data: lead } = await supabase.from('leads').select('total_calls').eq('id', leadId).single();
await supabase.from('leads').update({ total_calls: (lead.total_calls || 0) + 1 }).eq('id', leadId);
```

---

### 2. Race Condition in [queueWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/queueWorker.js) — Double Call Problem ❌ CRITICAL
**File**: [queueWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/queueWorker.js) lines 39–74

The queue worker fetches `status = 'queued'` rows and then marks them `processing` **after** fetching — but if the worker runs again (or two instances run), both can pick up the same item before either marks it `processing`.

```js
// No atomic lock — two instances race here!
const { data: queueItems } = await supabase
    .from('call_queue')
    .select('*')
    .in('status', ['queued', 'failed'])
    ...

// THEN marks as processing — too late!
await supabase.from('call_queue').update({ status: 'processing' }).eq('id', id);
```

**Fix**: Use a single atomic `UPDATE ... RETURNING` via Supabase RPC, or use `SELECT FOR UPDATE SKIP LOCKED` via a raw query. At minimum, mark `status = 'processing'` in a single operation **before** the for-loop starts:

```js
// In Supabase, use a stored procedure for atomic claim:
// CREATE OR REPLACE FUNCTION claim_queue_items(batch_size int) ...
const { data: claimed } = await supabase.rpc('claim_queue_items', { batch_size: 10 });
```

---

### 3. Campaign `total_calls` Uses Read-Modify-Write — Race Condition ⚠️
**File**: [queueWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/queueWorker.js) lines 118–123

```js
const { data: campaign } = await supabase.from('campaigns').select('total_calls')...
await supabase.from('campaigns').update({ total_calls: (campaign.total_calls || 0) + 1 })...
```
Ten concurrent calls will all read `0` and write `1`. Use an RPC with `UPDATE campaigns SET total_calls = total_calls + 1`.

---

### 4. Hardcoded Fallback Transfer Number in Source Code ⚠️
**File**: [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js) line 495
```js
let transferNumber = process.env.PLIVO_TRANSFER_NUMBER || '+918035740007'; // Fallback
```
A real phone number is hardcoded. Remove it — if the env var is missing, fail loudly rather than silently dialing a wrong number.

---

### 5. `protocol` Variable Always `wss` Regardless of Input ⚠️
**File**: [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js) line 69
```js
const protocol = headers['x-forwarded-proto'] === 'https' ? 'wss' : 'wss'; // Default to wss
```
Both branches are `'wss'`. The comment says "default to wss" but the ternary is broken. This is harmless in production (you always want wss), but misleading. Clean it up:
```js
const protocol = 'wss'; // Always WSS in production
```

---

### 6. `schedule_callback` Ignores the Time Argument ⚠️
**File**: [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js) lines 942–946
```js
await supabase.from('leads').update({
    callback_time: new Date().toISOString(), // <-- Always sets to NOW, ignores args.time!
    notes: `Callback requested: ${args.time}`
})
```
The natural language `args.time` ("tomorrow 5pm") is never parsed. Use a library like `chrono-node` or send it back to GPT for parsing.

---

### 7. [openaiService.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/services/openaiService.js) Whisper Language is English-Only ⚠️
**File**: [services/openaiService.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/services/openaiService.js) line 53
```js
language: "en", // Optimize for Hinglish if possible, or auto
```
Main session uses `"hi"` (Hindi) but this fallback service uses `"en"`. Also, this file creates its **own** `OpenAI` instance without checking if `OPENAI_API_KEY` is set. Unify key validation.

---

### 8. [retryWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/retryWorker.js) SMS Attempt Number is Hardcoded ⚠️
**File**: [retryWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/retryWorker.js) line 86
```js
attempt_number: 4, // hardcoded — breaks if max retry is changed
```
Should be `attempt.attempt_number + 1`.

---

### 9. Variable Shadowing: `duration` Declared Twice in [cleanup()](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js#1034-1128) ⚠️
**File**: [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js) lines 1058 and 1102
```js
const duration = Math.round(...) // Line 1058
// ... 44 lines later ...
const duration = Math.floor(...) // Line 1102 — JS error in strict mode!
```
This will throw `SyntaxError: Identifier 'duration' has already been declared` at runtime in strict ESM modules.

---

### 10. No Validation of Plivo Webhook Signatures — Security Hole ❌ CRITICAL
**File**: [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js) lines 50–87 (`/answer` endpoint)

Anyone can send a fake POST to `/answer` with arbitrary `leadId` and `campaignId` and your server will open a WebSocket connection to OpenAI, burning your API credits.

**Fix**: Verify the Plivo signature on every incoming webhook:
```js
import crypto from 'crypto';

function validatePlivoSignature(req, res, next) {
    const authToken = process.env.PLIVO_AUTH_TOKEN;
    const plivoSignature = req.headers['x-plivo-signature-v2'] || req.headers['x-plivo-signature'];
    // Use Plivo's SDK validation
    const isValid = plivo.utils.validateSignature(
        req.url, req.body, plivoSignature, authToken
    );
    if (!isValid) return res.status(403).send('Forbidden');
    next();
}

app.all('/answer', validatePlivoSignature, (req, res) => { ... });
```

---

## 🔐 SECURITY ISSUES

### S1. No Rate Limiting on HTTP Endpoints
The `/answer`, `/health`, and `/` endpoints have **no rate limiting**. Add `express-rate-limit`:
```js
import rateLimit from 'express-rate-limit';
const limiter = rateLimit({ windowMs: 60_000, max: 100 });
app.use(limiter);
```

### S2. Secrets Could Be Logged Accidentally
The startup logs print which keys are set. However, any error that includes the `req.headers` object (line 92) could leak the Authorization header in logs. Sanitize before logging:
```js
const safeHeaders = { ...request.headers };
delete safeHeaders['authorization'];
console.log(`Headers: ${JSON.stringify(safeHeaders)}`);
```

### S3. No Input Sanitization on `leadId` / `campaignId`
`leadId` and `campaignId` come from the URL query string and go directly into Supabase queries. Since Supabase uses parameterized queries this is safe from SQL injection, but you should still validate they are valid UUIDs before proceeding to avoid log pollution and wasted DB calls:
```js
import { validate as isUUID } from 'uuid';
if (!isUUID(leadId) || !isUUID(campaignId)) {
    return plivoWS.close(1008, 'Invalid parameters');
}
```

### S4. OpenAI API Key Startup Validation is Missing
If `OPENAI_API_KEY` is undefined, the server starts anyway and fails only when the first call happens. Add a hard check at startup:
```js
const REQUIRED_ENV = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) { console.error(`❌ Missing: ${key}`); process.exit(1); }
}
```

---

## ⚡ CONCURRENCY & SCALABILITY

### C1. Single OpenAI Realtime WebSocket Per Call — OK, But No Connection Limit
Currently each Plivo call spawns one OpenAI WebSocket. If 100 calls come in simultaneously, you open 100 OpenAI realtime connections. Add a concurrency guard:
```js
const MAX_CONCURRENT_CALLS = 50; // tune to your OpenAI tier
let activeCalls = 0;

wss.on('connection', async (plivoWS, request) => {
    if (activeCalls >= MAX_CONCURRENT_CALLS) {
        plivoWS.close(1013, 'Server at capacity');
        return;
    }
    activeCalls++;
    // ... on cleanup:
    activeCalls--;
});
```

### C2. `queueWorker` `setInterval` Can Overlap
**File**: [queueWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/queueWorker.js) line 143
```js
setInterval(processQueue, POLL_INTERVAL_MS);
```
If [processQueue](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/queueWorker.js#36-68) takes longer than 5 seconds (network lag, slow DB), the next invocation **overlaps** with the current one. Use a recursive `setTimeout` instead:
```js
async function scheduleNext() {
    try { await processQueue(); }
    catch (e) { console.error(e); }
    finally { setTimeout(scheduleNext, POLL_INTERVAL_MS); }
}
scheduleNext();
```

### C3. `retryWorker` Same Overlap Problem
**File**: [retryWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/retryWorker.js) line 151 — Same fix as C2.

### C4. No Back-Pressure on Audio Streaming
In the Plivo `message` handler, every media frame is immediately forwarded to OpenAI without any buffering or back-pressure. If OpenAI is slow, WebSocket send buffers will grow unbounded. Check `realtimeWS.bufferedAmount` before sending.

### C5. No WebSocket Heartbeat / Ping-Pong
Long-lived WebSocket connections (calls can be 3-5 minutes) can be silently dropped by load balancers. Add a ping interval:
```js
const pingInterval = setInterval(() => {
    if (realtimeWS.readyState === WebSocket.OPEN) {
        realtimeWS.ping();
    }
}, 30_000); // every 30s
realtimeWS.on('close', () => clearInterval(pingInterval));
```

---

## 🏗️ ARCHITECTURE IMPROVEMENTS

### A1. Move to a Proper Queue System (BullMQ + Redis)
The current `call_queue` polling via `setInterval` is fragile. For production:
- Replace with **BullMQ** (Redis-backed) which gives: atomic job claiming, retries, rate limiting, dead letter queue, and a UI dashboard
- Each job is a "make call" task
- Workers are isolated processes

### A2. Separate the Three Processes Properly
Currently `npm start` runs all three nodes with `concurrently`. On a real server:
- Use **PM2** with a `ecosystem.config.js` to manage processes
- Each gets its own restart policy, log file, and CPU binding
- [retryWorker.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/retryWorker.js) should be a PM2 cron job, not a long‑running setInterval process

### A3. Add Structured Logging
Replace `console.log` with a structured logger like **Pino** or **Winston**:
```js
import pino from 'pino';
const logger = pino({ level: 'info' });
logger.info({ callSid, leadId }, 'New Plivo connection');
```
This enables log aggregation, filtering by `callSid`, and shipping to services like Datadog or Logtail.

### A4. Add a Circuit Breaker for OpenAI
If OpenAI's API is down, every incoming call will fail after a timeout. Use a circuit breaker (e.g., `opossum`) so that after 5 consecutive failures, you immediately reject new calls and alert instead of hammering the failing API.

### A5. Centralized Error Handling Middleware
Currently errors in async WebSocket handlers are caught in individual `try/catch` blocks inconsistently. Create a central error handler and a typed error system.

### A6. [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js) is 1,245 Lines — Break It Up
Split into:
```
src/
  routes/
    answer.js        ← /answer endpoint
    health.js        ← /health, /
  websocket/
    server.js        ← WSS setup, upgrade handler
    callHandler.js   ← wss.on('connection', ...)
  ai/
    realtimeSession.js ← startRealtimeWSConnection()
    toolHandlers.js    ← transfer_call, disconnect_call, etc.
  analysis/
    sentiment.js     ← analyzeSentiment(), calculatePriorityScore()
```

### A7. Add Request ID / Correlation ID
Attach a unique ID to every HTTP request and WebSocket connection for end-to-end tracing:
```js
import { randomUUID } from 'crypto';
app.use((req, res, next) => { req.id = randomUUID(); next(); });
```

---

## 📦 DEPENDENCY / CONFIG ISSUES

| Issue | Detail |
|-------|---------|
| `@ricky0123/vad-node` in [package.json](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/package.json) | Installed but **never imported** anywhere. Remove it to reduce bundle size. |
| `alawmulaw` | Used only in [openaiService.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/services/openaiService.js) which itself is never imported in [index.js](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/index.js). Dead code path. |
| `wavefile` | Same as above — orphaned dependency. |
| No [package-lock.json](file:///c:/Local%20Disk%20%28E%29/0Quinite/quinite-vantage-webserver/package-lock.json) lockfile integrity check | Add `npm ci` (not `npm install`) in deployment scripts. |
| No `devDependencies` section | Linting / formatting tools (ESLint, Prettier) should be `devDependencies`. |
| `engines.node: ">=18.0.0"` | Good. But no `.nvmrc` or `.node-version` file for consistency. |

---

## ✅ THINGS DONE WELL

- ✅ `cleanedUp` flag guards against double-cleanup on simultaneous close events
- ✅ Parallel DB fetch for lead + campaign at connection time
- ✅ Background session refresh with projects/inventory doesn't block the greeting
- ✅ `perMessageDeflate: false` on WSS (reduces CPU overhead for audio)
- ✅ `process.on('uncaughtException')` and `unhandledRejection` handlers exist
- ✅ Plivo client initialized inside the handler (so credentials are always fresh from env)
- ✅ `callLogPromise` is awaited lazily — used across multiple tool handlers
- ✅ `noServer: true` on WSS with manual upgrade handler (correct pattern)

---

## 🗂️ PRIORITY MATRIX

| Priority | Issue | Effort |
|----------|-------|--------|
| 🔴 P0 | No Plivo webhook signature validation (S0) | Medium |
| 🔴 P0 | `supabase.raw()` bug causes silent failures (Bug 1) | Low |
| 🔴 P0 | Queue double-claim race condition (Bug 2) | High |
| 🔴 P0 | `duration` variable declared twice — runtime crash (Bug 9) | Low |
| 🟠 P1 | No request rate limiting | Low |
| 🟠 P1 | queueWorker interval overlap (C2) | Low |
| 🟠 P1 | No concurrent call limit (C1) | Low |
| 🟠 P1 | campaign.total_calls race (Bug 3) | Medium |
| 🟡 P2 | schedule_callback ignores time (Bug 6) | Medium |
| 🟡 P2 | UUID validation on WS params (S3) | Low |
| 🟡 P2 | Startup env validation (S4) | Low |
| 🟡 P2 | Structured logging (A3) | Medium |
| 🟢 P3 | Refactor index.js into modules (A6) | High |
| 🟢 P3 | BullMQ migration (A1) | High |
| 🟢 P3 | PM2 process management (A2) | Low |
