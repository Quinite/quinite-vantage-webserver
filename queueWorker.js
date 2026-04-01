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
        console.log(`📥 [v4-HARDEN] Heartbeat: ${now}`);
        // [1] OPTIMIZED POLLING: Using cached subscription_status for high-speed dialing
        const { data: queueItems, error } = await supabase
            .from('call_queue')
            .select(`
                *,
                campaign:campaigns!inner(
                    status,
                    ai_script,
                    call_settings,
                    organization:organizations!inner(
                        subscription_status,
                        credits:call_credits(balance)
                    )
                )
            `)
            .in('status', ['queued', 'failed'])
            .lte('next_retry_at', now)
            .lt('attempt_count', 4)
            .in('campaign.status', ['active', 'running']) 
            .in('campaign.organization.subscription_status', ['active', 'trialing'])
            .order('priority', { ascending: false }) 
            .order('created_at', { ascending: true }) 
            .limit(MAX_CONCURRENT_CALLS);

        if (error) {
            console.error("❌ Queue fetch error:", error.message);
            return;
        }

        if (!queueItems?.length) {
            console.log('😴 [Queue Worker] No calls ready to process.');
            return;
        }

        console.log(`📥 [Queue Worker] Found ${queueItems.length} items to process.`);

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
    
    // Credit Logic Check
    const balance = parseFloat(campaign.organization.credits?.[0]?.balance || 0);

    try {
        // [1] ATOMIC LOCK: Prevent double-calling
        const { data: lockedItem, error: lockError } = await supabase
            .from('call_queue')
            .update({ status: 'processing', updated_at: new Date() })
            .match({ id, status: item.status })
            .select().single();

        if (lockError || !lockedItem) return;

        // [2] BILLING & DATA HEARTBEAT
        if (balance < 0.2) throw new Error("INSUFFICIENT_FUNDS");

        const { data: leadContext } = await supabase
            .from('leads')
            .select('name, phone, project:projects(archived_at)')
            .eq('id', lead_id)
            .single();

        if (!leadContext || !leadContext.phone) throw new Error("INVALID_LEAD_DATA");
        if (leadContext.project?.archived_at) throw new Error("PROJECT_ARCHIVED");

        // [3] PHONE FORMATTING (Strict E.164)
        const fromNumber = String(getCallerId(campaign)).trim();
        const rawTo = String(leadContext.phone).trim();
        const formattedTo = rawTo.startsWith('+') ? rawTo : `+${rawTo.replace(/\D/g, '')}`;
        const answerUrl = `${process.env.WEBSOCKET_SERVER_URL}/answer?leadId=${lead_id}&campaignId=${campaign_id}`;

        if (!fromNumber.startsWith('+') || fromNumber.length < 10) throw new Error("INVALID_SENDER_ID");
        if (formattedTo.length < 10) throw new Error("INVALID_DESTINATION_FORMAT");

        console.log(`\n📞 [Queue Worker] DISPATCHING CALL:`);
        console.log(`   📤 FROM: ${fromNumber}`);
        console.log(`   📥 TO: ${formattedTo} (${leadContext.name})`);
        console.log(`   🔗 URL: ${answerUrl}`);

        // [4] PLIVO DISPATCH (Hardened Positional Args)
        const response = await plivoClient.calls.create(
            fromNumber,
            formattedTo,
            answerUrl,
            {
                answer_method: 'POST',
                time_limit: 1800, // 30 mins max
                machine_detection: 'hangup'
            }
        );

        const callSid = response.requestUuid || response.callUuid;
        console.log(`✅ [Queue Worker] SUCCESS | SID: ${callSid}`);

        // [5] UPDATE STATE
        await supabase.from('call_queue').update({ status: 'completed', updated_at: new Date() }).eq('id', id);
        await supabase.from('leads').update({ call_status: 'calling', last_contacted_at: new Date().toISOString() }).eq('id', lead_id);

    } catch (err) {
        console.error(`❌ [Queue Worker] FAILURE [Item ${id}]:`, err.message);
        
        const nextRetry = new Date();
        const backoffMinutes = (attempt_count + 1) * 30; // 30, 60, 90 mins backoff
        nextRetry.setMinutes(nextRetry.getMinutes() + backoffMinutes);

        // Update Queue Item with Error Detail
        await supabase.from('call_queue').update({
            status: err.message === 'INSUFFICIENT_FUNDS' ? 'queued' : 'failed',
            attempt_count: err.message === 'INSUFFICIENT_FUNDS' ? attempt_count : attempt_count + 1,
            last_error: err.message,
            next_retry_at: err.message === 'INSUFFICIENT_FUNDS' ? new Date(Date.now() + 300000).toISOString() : nextRetry.toISOString(),
            updated_at: new Date()
        }).eq('id', id);

        // Audit Log Entry
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
