import { supabase } from './services/supabase.js';
import { plivoClient, getCallerId } from './services/plivo.js';
import dotenv from 'dotenv';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBSOCKET_SERVER_URL = process.env.WEBSOCKET_SERVER_URL;
const POLL_INTERVAL_MS = 4000;
const MAX_CONCURRENT_CALLS = 10; 
const RETRY_DELAY_MINUTES = 20;

console.log("🚀 Starting Production-Grade Queue Worker...");

/**
 * Polls the database for the highest priority leads ready for a call.
 */
async function processQueue() {
    try {
        const now = new Date().toISOString();

        // [1] ADVANCED POLLING: Priority + Status + Retry Logic
        const { data: queueItems, error } = await supabase
            .from('call_queue')
            .select(`
                *,
                campaign:campaigns!inner(
                    status, 
                    organization:organizations!inner(
                        subscription_status, 
                        credits:call_credits(balance)
                    )
                )
            `)
            .in('status', ['queued', 'failed'])
            .lte('next_retry_at', now)
            .lt('attempt_count', 4)
            .eq('campaign.status', 'active') // Only active campaigns
            .eq('campaign.organization.subscription_status', 'active') // Cached status check
            .gte('campaign.organization.subscription_period_end', now) // Ensure plan isn't expired
            .order('priority', { ascending: false }) // High priority first
            .order('created_at', { ascending: true }) // Oldest first within priority
            .limit(MAX_CONCURRENT_CALLS);

        if (error) {
            console.error("❌ Queue fetch error:", error.message);
            return;
        }

        if (!queueItems?.length) return;

        console.log(`📥 Processing ${queueItems.length} priority items.`);

        // Parallel execution with atomic lock handling in executeCall
        await Promise.allSettled(queueItems.map(item => executeCall(item)));

    } catch (err) {
        console.error("❌ Loop Error:", err.message);
    }
}

/**
 * Executes the Plivo outbound call with strict lifecycle validation.
 */
async function executeCall(item) {
    const { id, lead_id, campaign_id, attempt_count, organization_id, campaign } = item;
    const balance = campaign.organization.credits?.[0]?.balance || 0;

    try {
        // [2] ATOMIC LOCK: Prevent double-calling
        const { data: lockedItem, error: lockError } = await supabase
            .from('call_queue')
            .update({ status: 'processing', updated_at: new Date() })
            .match({ id, status: item.status })
            .select().single();

        if (lockError || !lockedItem) return;

        // [3] LIFECYCLE & BILLING HEARTBEAT
        if (balance < 0.5) throw new Error("INSUFFICIENT_FUNDS");

        const { data: leadContext } = await supabase
            .from('leads')
            .select('name, phone, project:projects(archived_at)')
            .eq('id', lead_id)
            .single();

        if (!leadContext || !leadContext.phone) throw new Error("INVALID_LEAD");
        if (leadContext.project?.archived_at) throw new Error("PROJECT_ARCHIVED");

        const fromNumber = getCallerId(campaign);
        const answerUrl = `${WEBSOCKET_SERVER_URL}/answer?leadId=${lead_id}&campaignId=${campaign_id}`;

        console.log(`📞 Dialing ${leadContext.name} (${lead_id})...`);

        // [4] PLIVO INITIATION
        const response = await plivoClient.calls.create(
            fromNumber,
            leadContext.phone,
            answerUrl,
            {
                answer_method: 'POST',
                time_limit: 1200, // 20 mins
                machine_detection: 'hangup' // Prevent voicemail costs
            }
        );

        // [5] SUCCESS LOGGING
        await supabase.from('call_queue').update({ status: 'completed', updated_at: new Date() }).eq('id', id);
        await supabase.from('leads').update({ call_status: 'calling', last_contacted_at: new Date().toISOString() }).eq('id', lead_id);

    } catch (err) {
        console.error(`❌ Call Failed [Item ${id}]:`, err.message);
        
        const nextRetry = new Date();
        const backoff = (attempt_count + 1) * RETRY_DELAY_MINUTES;
        nextRetry.setMinutes(nextRetry.getMinutes() + backoff);

        await supabase.from('call_queue').update({
            status: err.message === 'INSUFFICIENT_FUNDS' ? 'queued' : 'failed', // Don't burn attempts on billing errors
            attempt_count: err.message === 'INSUFFICIENT_FUNDS' ? attempt_count : attempt_count + 1,
            last_error: err.message,
            next_retry_at: err.message === 'INSUFFICIENT_FUNDS' ? new Date(Date.now() + 60000).toISOString() : nextRetry.toISOString(),
            updated_at: new Date()
        }).eq('id', id);

        // Persistent failure log
        await supabase.from('call_attempts').insert({
            organization_id, lead_id, campaign_id,
            attempt_number: attempt_count + 1,
            outcome: 'failed',
            error_message: err.message
        });
    }
}

async function cleanupStuckCalls() {
    const timeout = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await supabase.from('call_queue').update({ status: 'queued' }).eq('status', 'processing').lt('updated_at', timeout);
}

setInterval(processQueue, POLL_INTERVAL_MS);
setInterval(cleanupStuckCalls, 120000);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
