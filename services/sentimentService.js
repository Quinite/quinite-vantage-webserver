import OpenAI from 'openai';
import { supabase } from './supabase.js';
import { logger } from '../src/lib/logger.js';
import { updateLeadProject } from '../src/lib/updateLeadProject.js';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function analyzeSentiment(transcript, leadId, callLogId, organizationId, callSid, campaignId) {
    if (!transcript || transcript.length < 50) return null;

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

        const sentimentLabel = analysis.sentiment_score > 0.3 ? 'Positive'
            : analysis.sentiment_score < -0.3 ? 'Negative' : 'Neutral';

        // Fetch existing ai_metadata to preserve fields set during the call (e.g. interested_project_id)
        const { data: existingLog } = await supabase.from('call_logs').select('ai_metadata').eq('id', callLogId).single();
        const mergedMeta = {
            ...(existingLog?.ai_metadata || {}),
            objections: analysis.objections,
            budget_estimated: analysis.budget,
            priority_score: analysis.priority,
            key_takeaways: analysis.key_takeaways,
        };

        await supabase.from('call_logs').update({
            summary: analysis.summary,
            sentiment_score: analysis.sentiment_score,
            sentiment_label: sentimentLabel,
            interest_level: analysis.interest_level,
            ai_metadata: mergedMeta
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
