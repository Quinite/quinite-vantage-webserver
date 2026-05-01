import OpenAI from 'openai';
import { supabase } from './supabase.js';
import { logger } from '../src/lib/logger.js';
import { updateLeadProject } from '../src/lib/updateLeadProject.js';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function analyzeSentiment(transcript, leadId, callLogId, organizationId, callSid, campaignId, durationSecs = 0) {
    if (!transcript || transcript.length < 50) return null;

    // Require the user to have actually spoken — AI-only transcripts produce false positives
    const userLines = transcript.split('\n').filter(l => l.startsWith('User:'));
    const userWordCount = userLines.join(' ').split(/\s+/).filter(Boolean).length;

    if (userWordCount < 5 || durationSecs < 20) {
        logger.info('Skipping sentiment — call too short or user did not speak', { callSid, durationSecs, userWordCount });
        // Write conservative defaults so the UI doesn't show blank or misleading data
        const { data: existingLog } = await supabase.from('call_logs').select('ai_metadata').eq('id', callLogId).single();
        await supabase.from('call_logs').update({
            summary: 'Call ended before conversation could begin.',
            sentiment_score: 0,
            interest_level: 'none',
            ai_metadata: { ...(existingLog?.ai_metadata || {}), priority_score: 0 }
        }).eq('id', callLogId);
        await supabase.from('leads').update({ interest_level: 'none', score: 0 }).eq('id', leadId);
        return null;
    }

    try {
        logger.info('Running sentiment analysis', { callSid });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{
                role: 'system',
                content: `You are an expert Indian Real Estate Analyst. Analyze this sales call transcript.
Return JSON only:
{
  "sentiment_score": float (-1 to 1),
  "interest_level": "high" | "medium" | "low" | "none",
  "summary": "1-sentence summary of call outcome",
  "objections": ["array of objections raised"],
  "budget": "estimated budget if mentioned, else null",
  "priority": float (0-100, higher = hotter lead),
  "key_takeaways": "bullet point summary"
}`
            }, {
                role: 'user',
                content: transcript
            }],
            response_format: { type: 'json_object' },
            temperature: 0
        });

        const analysis = JSON.parse(completion.choices[0].message.content);
        const sentimentUsage = completion.usage || {};

        // gpt-4o-mini pricing per 1M tokens (USD), as of May 2026
        const sentimentCostUsd = parseFloat((
            (sentimentUsage.prompt_tokens     || 0) / 1_000_000 * 0.15 +
            (sentimentUsage.completion_tokens || 0) / 1_000_000 * 0.60
        ).toFixed(6));

        // Fetch existing ai_metadata + usage_telemetry to merge
        const { data: existingLog } = await supabase.from('call_logs')
            .select('ai_metadata, usage_telemetry').eq('id', callLogId).single();

        const mergedMeta = {
            ...(existingLog?.ai_metadata || {}),
            objections: analysis.objections,
            budget_estimated: analysis.budget,
            priority_score: analysis.priority,
            key_takeaways: analysis.key_takeaways,
        };

        const mergedPlatformMeta = {
            ...(existingLog?.usage_telemetry || {}),
            sentiment_analysis: {
                prompt_tokens:     sentimentUsage.prompt_tokens     || 0,
                completion_tokens: sentimentUsage.completion_tokens || 0,
                total_tokens:      sentimentUsage.total_tokens      || 0,
                cost_usd:          sentimentCostUsd,
            },
        };

        await supabase.from('call_logs').update({
            summary: analysis.summary,
            sentiment_score: analysis.sentiment_score,
            interest_level: analysis.interest_level,
            ai_metadata: mergedMeta,
            usage_telemetry: mergedPlatformMeta,
        }).eq('id', callLogId);

        // Update lead with AI-derived behavioral signals
        await supabase.from('leads').update({
            interest_level: analysis.interest_level,
            score: Math.round(analysis.priority),
        }).eq('id', leadId);

        // Auto-update lead's project if logIntent captured a different interested project
        if (mergedMeta.interested_project_id) {
            await updateLeadProject(leadId, mergedMeta.interested_project_id, 'ai_call', callLogId);
        }

        if (campaignId && analysis.sentiment_score != null) {
            await supabase.rpc('update_campaign_sentiment', {
                campaign_uuid: campaignId,
                new_score: analysis.sentiment_score
            });
        }

        logger.info('Sentiment analysis complete', { callSid, priority: analysis.priority, interest: analysis.interest_level });
        return analysis;

    } catch (err) {
        logger.error('Sentiment analysis failed', { callSid, error: err.message });
        return null;
    }
}
