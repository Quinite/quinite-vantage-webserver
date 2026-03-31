import OpenAI from 'openai';
import { supabase } from './supabase.js';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * Production-Grade Sentiment Analysis for Indian Real Estate
 */
export async function analyzeSentiment(transcript, leadId, callLogId, organizationId, callSid) {
    if (!transcript || transcript.length < 50) return null;

    try {
        console.log(`🧠 [${callSid}] Running Contextual Sentiment Analysis...`);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "system",
                content: `You are an expert Indian Real Estate Analyst. Analyze this sales transcript.
                Extract structured insights focused on the lead's intent and budget.
                Return JSON: {
                  "sentiment_score": float (-1 to 1),
                  "sentiment_label": "Positive" | "Neutral" | "Negative",
                  "interest_level": "high" | "medium" | "low" | "none",
                  "summary": "1-sentence conversational summary",
                  "objections": ["list", "of", "objections"],
                  "budget": "estimated budget if mentioned",
                  "priority": float (0-100),
                  "key_takeaways": "bullet points"
                }`
            }, {
                role: "user",
                content: transcript
            }],
            response_format: { type: "json_object" },
            temperature: 0
        });

        const analysis = JSON.parse(completion.choices[0].message.content);
        
        // 1. UPDATE CALL LOG (Consolidated Source)
        const { error: callLogError } = await supabase.from('call_logs').update({
            summary: analysis.summary,
            sentiment_score: analysis.sentiment_score,
            sentiment_label: analysis.sentiment_label,
            interest_level: analysis.interest_level,
            ai_metadata: {
                objections: analysis.objections,
                budget_estimated: analysis.budget,
                priority_score: analysis.priority,
                key_takeaways: analysis.key_takeaways
            }
        }).eq('id', callLogId);

        if (callLogError) throw callLogError;

        // 2. UPDATE LEAD BEHAVIORAL DATA
        await supabase.from('leads').update({
            interest_level: analysis.interest_level,
            score: Math.round(analysis.priority), // Priority maps to Lead Score
            last_sentiment_score: analysis.sentiment_score,
            last_contacted_at: new Date().toISOString()
        }).eq('id', leadId);

        console.log(`✅ [${callSid}] Analysis Saved. Priority: ${analysis.priority}`);
        return analysis;

    } catch (err) {
        console.error(`❌ [${callSid}] Sentiment Error:`, err.message);
        return null;
    }
}
