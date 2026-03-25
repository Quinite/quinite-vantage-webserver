import OpenAI from 'openai';
import { supabase } from './supabase.js';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Analyze conversation sentiment using OpenAI (India context)
 */
export async function analyzeSentiment(transcript, leadId, callLogId, organizationId, callSid) {
    if (!transcript || transcript.length < 50) return null;

    try {
        console.log(`🧠 [${callSid}] Running Sentiment Analysis...`);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "system",
                content: `Analyze this Indian real estate sales transcript. 
                Return JSON: {
                  "sentiment_score": float (-1 to 1),
                  "sentiment_label": string,
                  "interest_level": "high"|"medium"|"low"|"none",
                  "intent": string,
                  "readiness": string,
                  "objections": string[],
                  "budget": string|null,
                  "summary": string
                }`
            }, {
                role: "user",
                content: transcript
            }],
            response_format: { type: "json_object" },
            temperature: 0
        });

        const analysis = JSON.parse(completion.choices[0].message.content);
        
        // 1. Calculate Priority (0-100)
        let priority = 50;
        if (analysis.interest_level === 'high') priority += 30;
        if (analysis.sentiment_score > 0.5) priority += 20;
        if (analysis.interest_level === 'none') priority -= 40;

        // 2. Save Insights
        await supabase.from('conversation_insights').insert({
            organization_id: organizationId,
            call_log_id: callLogId,
            lead_id: leadId,
            overall_sentiment: analysis.sentiment_score,
            sentiment_label: analysis.sentiment_label,
            interest_level: analysis.interest_level,
            intent: analysis.intent,
            objections: analysis.objections || [],
            budget_range: analysis.budget,
            recommended_action: analysis.summary,
            priority_score: Math.max(0, Math.min(100, priority))
        });

        // 3. Update Call Log
        await supabase.from('call_logs').update({
            sentiment_score: analysis.sentiment_score,
            interest_level: analysis.interest_level,
            conversation_summary: analysis.summary
        }).eq('id', callLogId);

        // 4. Update Lead Record
        await supabase.from('leads').update({
            interest_level: analysis.interest_level,
            purchase_readiness: analysis.readiness,
            last_sentiment_score: analysis.sentiment_score
        }).eq('id', leadId);

        console.log(`✅ [${callSid}] Analysis complete. Interest: ${analysis.interest_level}`);
        return analysis;

    } catch (err) {
        console.error(`❌ [${callSid}] Sentiment analysis error:`, err.message);
        return null;
    }
}
