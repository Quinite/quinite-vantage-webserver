import { supabase } from './services/supabase.js';
import { plivoClient, getCallerId } from './services/plivo.js';
import dotenv from 'dotenv';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config();

const WEBSOCKET_SERVER_URL = process.env.WEBSOCKET_SERVER_URL || 'https://vantage-websocket-server.up.railway.app';
const POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT_CALLS = 5; // Reduced for safety & Plivo limits
const RETRY_DELAY_MINUTES = 15;

console.log("🚀 Starting Optimized Queue Worker...");
console.log(`📡 WebSocket URL: ${WEBSOCKET_SERVER_URL}`);

/**
 * Main loop for processing the call queue
 */
async function processQueue() {
    try {
        const now = new Date().toISOString();

        // 1. Fetch pending items
        // We select the oldest items that are due for retry/initial call
        const { data: queueItems, error } = await supabase
            .from('call_queue')
            .select('*')
            .in('status', ['queued', 'failed'])
            .lte('next_retry_at', now)
            .lt('attempt_count', 3)
            .order('created_at', { ascending: true })
            .limit(MAX_CONCURRENT_CALLS);

        if (error) {
            console.error("❌ [Queue Worker] Database fetch error:", error.message);
            return;
        }

        if (!queueItems || queueItems.length === 0) {
            return;
        }

        console.log(`📥 [Queue Worker] Found ${queueItems.length} items to process.`);

        // Process in parallel with a limit
        await Promise.allSettled(queueItems.map(item => executeCall(item)));

    } catch (err) {
        console.error("❌ [Queue Worker] Loop Error:", err.message);
    }
}

/**
 * Internal logic for executing a single call
 */
async function executeCall(item) {
    const { id, lead_id, campaign_id, attempt_count, organization_id } = item;

    try {
        // Step A: Immediate Status Update (Prevent Race Conditions)
        const { data: checkItem, error: checkError } = await supabase
            .from('call_queue')
            .update({ status: 'processing', updated_at: new Date() })
            .match({ id, status: item.status }) // Ensure it's still in the expected state
            .select()
            .single();

        if (checkError || !checkItem) {
            console.warn(`⚠️ [Queue Worker] Item ${id} already being processed or missing.`);
            return;
        }

        // Step B: Fetch Comprehensive Lead & Campaign Data
        const [{ data: lead }, { data: campaign }] = await Promise.all([
            supabase.from('leads').select('name, phone, project_id').eq('id', lead_id).single(),
            supabase.from('campaigns').select('name, caller_id').eq('id', campaign_id).single()
        ]);

        if (!lead?.phone) {
            throw new Error(`Invalid Lead data for ID ${lead_id}`);
        }

        const fromNumber = getCallerId(campaign);
        if (!fromNumber) {
            throw new Error("Missing mandatory field: from (PLIVO_PHONE_NUMBER)");
        }

        console.log(`📞 [Queue Worker] Dialing ${lead.name} (${lead.phone}) from ${fromNumber}...`);

        // Step C: Execute Call via Plivo
        const answerUrl = `${WEBSOCKET_SERVER_URL}/answer?leadId=${lead_id}&campaignId=${campaign_id}`;
        
        const response = await plivoClient.calls.create(
            fromNumber,
            lead.phone,
            answerUrl,
            {
                answer_method: 'POST',
                time_limit: 1800, // 30 mins max
                // If Plivo supports tagging, use it
                extra_params: {
                    leadId: lead_id,
                    campaignId: campaign_id
                }
            }
        );

        console.log(`✅ [Queue Worker] Call SID: ${response.requestUuid} for Item: ${id}`);

        // Step D: Mark as Completed in Queue
        await supabase.from('call_queue').update({
            status: 'completed',
            updated_at: new Date(),
            last_error: null
        }).eq('id', id);

        // Step E: Update Lead Record
        await supabase.from('leads').update({
            call_status: 'calling',
            last_contacted_at: new Date().toISOString()
        }).eq('id', lead_id);

    } catch (err) {
        const errorMsg = err.message || "Unknown error";
        console.error(`❌ [Queue Worker] Call execution failed for Item ${id}:`, errorMsg);

        // Step F: Failure Logging & Retry Strategy
        const currentAttempt = attempt_count + 1;
        const nextRetry = new Date();
        
        // Strategy: Exponential-ish backoff (15m, 30m, 45m)
        nextRetry.setMinutes(nextRetry.getMinutes() + (RETRY_DELAY_MINUTES * currentAttempt));

        await supabase.from('call_queue').update({
            status: 'failed',
            attempt_count: currentAttempt,
            last_error: errorMsg,
            next_retry_at: nextRetry.toISOString(),
            updated_at: new Date()
        }).eq('id', id);

        // Log to call_attempts for persistent history
        await supabase.from('call_attempts').insert({
            organization_id,
            lead_id,
            campaign_id,
            attempt_number: currentAttempt,
            channel: 'voice_ai',
            outcome: 'failed',
            error_message: errorMsg,
            attempted_at: new Date().toISOString()
        });
    }
}

// Start polling
console.log(`🕒 Polling every ${POLL_INTERVAL_MS}ms`);
setInterval(processQueue, POLL_INTERVAL_MS);

// Handle graceful shutdown
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
