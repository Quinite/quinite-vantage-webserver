# Quinite Vantage WebServer — AI Voice Call Engine

## Project Overview

This is the **real-time AI voice call server** for Quinite Vantage. It bridges Plivo (VoIP phone calls) with OpenAI's Realtime API to run automated AI sales conversations in real estate lead qualification. It also manages an outbound call queue worker.

**Frontend companion:** `../quinite-vantage` (Next.js SaaS frontend)

---

## Tech Stack

| Component | Technology |
|---|---|
| Server | Node.js 18+ / Express.js |
| WebSocket | `ws` library (bidirectional audio streaming) |
| AI Voice | OpenAI Realtime API (`gpt-4o-mini-realtime-preview`) |
| Telephony | Plivo VoIP (outbound calls, streaming, transfer) |
| Database | Supabase / PostgreSQL (service role) |
| Audio Codec | G.711 μ-law ↔ PCM (via `alawmulaw`) |
| Queue | Polling-based (setInterval, 4s) |
| Logging | Structured JSON (prod) / pretty (dev) |
| Deployment | AWS Elastic Beanstalk |

---

## Architecture

```
                    ┌─────────────────────────────┐
                    │       queueWorker.js         │
                    │  setInterval(4s) poll DB     │
                    │  → Plivo.calls.create()      │
                    └─────────────┬───────────────┘
                                  │ triggers call
                    ┌─────────────▼───────────────┐
Plivo Phone ◄──────►   Express Server (index.js)  │
                    │   POST /answer → XML         │
                    │   WS /voice/stream           │
                    └─────────────┬───────────────┘
                                  │ audio relay
                    ┌─────────────▼───────────────┐
                    │  OpenAI Realtime API (WSS)   │
                    │  gpt-4o-mini-realtime-preview│
                    └─────────────────────────────┘
```

---

## Feature Flows

### 1. Outbound Call Queue (`queueWorker.js`)
- **Poll interval:** 4 seconds, max 10 concurrent calls
- **Eligibility filters:**
  - `call_queue.status` = `queued` or `failed` (within retry window)
  - `campaigns.status` = `active` or `running`
  - `organizations.subscription_status` = `active` or `trialing`
  - Credit balance ≥ 0.2 INR
  - Attempt count < 4
  - IST time window (campaign `time_start`/`time_end`)
- **Atomic lock:** Sets status `queued → processing` with conditional update (prevents double-call)
- **Call creation:** `plivoClient.calls.create(from, to, answerUrl)` with `time_limit: 1800`
- **Retry logic:**
  - Insufficient funds: retry after 5 min (no attempt increment)
  - Other failures: `failed`, exponential backoff (30min × attempt)
  - After 4 attempts: permanent `failed`
- **Stuck call cleanup:** Every 2 min, reset `processing` calls stuck 15+ min → `queued`

### 2. Call Answer & WebSocket Upgrade (`src/routes/answer.js`, `index.js`)
- Plivo POSTs to `POST /answer?leadId=X&campaignId=Y`
- Returns Plivo XML: `<Stream>` pointing to `wss://host/voice/stream?leadId=X&campaignId=Y&callSid=Z`
- HTTP server upgrades WebSocket connections on `/voice/stream` path
- Credit check: balance ≥ 0.1 INR before accepting

### 3. Audio Bridging (`src/websocket/handler.js`)
- Opens two WebSocket connections:
  1. **Plivo WS** — raw G.711 μ-law audio from/to phone
  2. **OpenAI Realtime WS** — AI conversation with tool calling
- Audio flow:
  - Plivo audio event → decode μ-law → PCM → send to OpenAI
  - OpenAI audio delta → encode PCM → μ-law → send to Plivo
- **VAD config:** threshold 0.7, silence = 40% of campaign `silence_timeout` (max 1000ms)
- **Transcription:** Whisper with language code from campaign settings (en/hi/gu)

### 4. AI Session Configuration (`sessionUpdate.js`)
- Generates `session.update` message for OpenAI Realtime
- Model: `gpt-4o-mini-realtime-preview`
- Audio format: `g711_ulaw` at 8000 Hz
- Temperature: 0.65
- System prompt: Built from campaign's `ai_script` + lead context + project context
- **Context cache:** 30-min TTL in-memory cache for project/unit lists (`src/lib/contextCache.js`)
- Voice: Mapped from campaign `call_settings.voice` (shimmer, nova, etc.)
- Languages: English, Hindi (Hinglish), Gujarati

### 5. AI Agent Tools (`src/tools/`)

The AI agent can call 5 tools mid-conversation:

| Tool | File | What it does |
|---|---|---|
| `check_detailed_inventory` | `inventory.js` | Search available units by BHK, price, vastu, facing, floor — with fallback to similar units |
| `log_intent` | `logIntent.js` | Record lead preferences (budget, config, location) + optionally queue WhatsApp brochure task |
| `transfer_call` | `transfer.js` | Escalate to human agent via Plivo transfer; fallback to `PLIVO_TRANSFER_NUMBER` |
| `schedule_callback` | `callback.js` | Book future call — creates/updates `call_queue` with new retry date |
| `disconnect_call` | `disconnect.js` | End call gracefully with reason (not_interested, completed, silence, abusive, wrong_number) |

Tool dispatch: `src/tools/index.js` — switch/case, called from WebSocket handler on `response.function_call_arguments.done` events.

### 6. Call Lifecycle (`src/lib/callLifecycle.js`)
- **Start:** Creates `call_logs` row, sets `leads.call_log_id`, increments campaign stats
- **Credit pulse:** Mid-call check before tool execution
- **End:** Updates `call_logs` with transcript, duration, cost; deducts credits via `deduct_call_credits` RPC; updates `leads.last_contacted_at`, `total_calls`
- **Credit deduction:** Atomic RPC `deduct_call_credits(org_id, amount)` — prevents negative balance

### 7. Sentiment Analysis (`services/sentimentService.js`)
- Triggered post-call with full transcript
- Model: `gpt-4o-mini` (non-realtime)
- Extracts: `sentiment_score` (-1 to 1), `interest_level`, `objections`, `estimated_budget`, `priority_score`, `key_takeaways`
- Updates:
  - `call_logs.ai_metadata`, `sentiment_score`, `interest_level`, `summary`
  - `leads.interest_level`, `score`, `sentiment_score`
  - Campaign aggregate via `update_campaign_sentiment` RPC

---

## File Structure

```
quinite-vantage-webserver/
├── index.js                      # Express server + WebSocket upgrade handler
├── queueWorker.js                # Background queue processor
├── sessionUpdate.js              # OpenAI session.update generator (system prompt)
├── package.json
├── .ebextensions/                # AWS Elastic Beanstalk config
├── services/
│   ├── supabase.js               # Supabase client (service role)
│   ├── plivo.js                  # Plivo client
│   └── sentimentService.js       # Post-call GPT-4o Mini analysis
└── src/
    ├── lib/
    │   ├── logger.js             # Structured logging
    │   ├── callLifecycle.js      # Call start/end, credits, metrics
    │   └── contextCache.js       # 30-min TTL project cache
    ├── routes/
    │   └── answer.js             # POST /answer — Plivo webhook
    ├── tools/
    │   ├── index.js              # Tool dispatcher
    │   ├── inventory.js          # Unit search
    │   ├── logIntent.js          # Record preferences
    │   ├── transfer.js           # Escalate to agent
    │   ├── disconnect.js         # End call
    │   └── callback.js           # Schedule callback
    └── websocket/
        └── handler.js            # Plivo ↔ OpenAI audio bridge
```

---

## Database Tables Used

| Table | Key Operations |
|---|---|
| `call_queue` | poll, atomic lock, update status, cleanup stuck |
| `campaigns` | read settings, status, time window, ai_script, silence_timeout |
| `organizations` | check subscription_status |
| `call_credits` | read balance, deduct via RPC |
| `leads` | read contact info, update interest/score/callback |
| `call_logs` | create, update with transcript/sentiment/metadata |
| `projects` | read context for AI prompt (cached 30 min) |
| `units` | search inventory for AI tool |
| `unit_configs` / `towers` | joined for unit details |
| `profiles` | find agents for transfer |
| `lead_interactions` | create interaction record |
| `tasks` | create WhatsApp brochure task |

**RPC functions called:**
- `update_campaign_sentiment(campaign_uuid, new_score)`
- `increment_campaign_stat(campaign_uuid, stat_name)`
- `deduct_call_credits(org_id, deduction)`

---

## API Endpoints

| Route | Method | Description |
|---|---|---|
| `/` | GET | Health check |
| `/health` | GET | Health check |
| `/answer` | POST | Plivo webhook — returns XML for audio stream |
| `/voice/stream` | WebSocket | Bidirectional audio bridge (Plivo ↔ OpenAI) |

**WebSocket query params:** `leadId`, `campaignId`, `callSid`

---

## Environment Variables

```
PORT=10000
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
PLIVO_AUTH_ID=
PLIVO_AUTH_TOKEN=
PLIVO_PHONE_NUMBER=         # Caller ID for outbound (+91...)
WEBSOCKET_SERVER_URL=        # wss://... used in Plivo XML
NEXT_PUBLIC_SITE_URL=        # Frontend URL (context only)
PLIVO_TRANSFER_NUMBER=       # Optional fallback transfer number
CALL_COST_PER_MINUTE=        # Default 0.50 INR
NODE_ENV=development
```

---

## Key Commands

```bash
# Run server + queue worker together
npm start   # uses concurrently

# Server only
node index.js

# Worker only
node queueWorker.js
```

---

## Important Patterns

- **Audio codec:** All phone audio is G.711 μ-law (8kHz). Must encode/decode when crossing to OpenAI (PCM).
- **Plivo ↔ OpenAI sync:** Both connections are maintained simultaneously per call; errors on either side must close the other.
- **No HTTP auth on /answer in dev** — Plivo signature validation only in production (`NODE_ENV === 'production'`).
- **Concurrency limit:** Max 10 simultaneous calls enforced in queue worker; beyond this, items stay queued.
- **Credit checks happen 3 times:** queue entry, answer webhook, mid-call pulse.
- **Time windows in IST:** Campaign `time_start`/`time_end` are compared against current IST time.
