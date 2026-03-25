import { supabase } from './services/supabase.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Retry Worker: Re-enqueues calls that failed (no answer, busy, etc.)
 * based on the retry schedule set in call_attempts.
 */
async function processRetries() {
    console.log(`\n⏳ [Retry Worker] Checking for scheduled retries...`);

    const now = new Date().toISOString();

    try {
        // 1. Fetch attempts that are due for retry
        const { data: retries, error } = await supabase
            .from('call_attempts')
            .select(`
                id,
                attempt_number,
                lead_id,
                campaign_id,
                organization_id,
                leads(name, phone)
            `)
            .eq('will_retry', true)
            .lte('next_retry_at', now)
            .limit(10); // Process in small batches

        if (error) throw error;

        if (!retries || retries.length === 0) {
            console.log('✅ [Retry Worker] No retries pending.');
            return;
        }

        console.log(`📞 [Retry Worker] Processing ${retries.length} retries...`);

        for (const attempt of retries) {
            try {
                const lead = attempt.leads;
                
                // Max attempts check (3 voice attempts, then SMS)
                if (attempt.attempt_number < 3) {
                    console.log(`🎤 [Retry Worker] Re-enqueuing Lead: ${lead?.name} (Attempt ${attempt.attempt_number + 1})`);

                    const { error: queueError } = await supabase.from('call_queue').insert({
                        campaign_id: attempt.campaign_id,
                        lead_id: attempt.lead_id,
                        organization_id: attempt.organization_id,
                        status: 'queued',
                        attempt_count: attempt.attempt_number, // The worker will increment this
                        next_retry_at: now
                    });

                    if (queueError) throw queueError;

                } else if (attempt.attempt_number === 3) {
                    // Final attempt fallback: SMS (Optional, but professional)
                    console.log(`📱 [Retry Worker] SMS Fallback for Lead: ${lead?.name}`);
                    // SMS logic could go here if needed
                }

                // 2. Mark this specific attempt as processed
                await supabase
                    .from('call_attempts')
                    .update({ will_retry: false })
                    .eq('id', attempt.id);

            } catch (innerErr) {
                console.error(`❌ [Retry Worker] Error processing attempt ${attempt.id}:`, innerErr.message);
            }
        }

    } catch (err) {
        console.error('❌ [Retry Worker] General Error:', err.message);
    }
}

// Polling interval: 1 minute for faster response to scheduled retries
const INTERVAL = 60 * 1000;
setInterval(processRetries, INTERVAL);

// Initial run
processRetries();

console.log(`✅ Retry worker active (Interval: ${INTERVAL}ms)`);
