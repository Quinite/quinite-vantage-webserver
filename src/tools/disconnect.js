import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';

export async function handleDisconnect(plivoWS, realtimeWS, callSid, leadId, args, callLogId) {
    // Guard: if a transfer is in progress or completed, the call belongs to the agent/lead
    // bridge now — disconnect_call would tear down the AI-side cleanly but ALSO race with
    // the in-flight transfer and could hang up the lead's leg. Treat as a no-op.
    if (plivoWS.transferInProgress) {
        return { success: true, note: 'transfer already in progress — disconnect ignored' };
    }

    if (callLogId) {
        await supabase.from('call_logs').update({
            call_status: 'completed',
            disconnect_reason: args.reason
        }).eq('id', callLogId);
    }

    if (args.reason === 'abusive') {
        await supabase.from('leads').update({
            abuse_flag: true,
            abuse_details: args.abuse_details || 'Abusive behavior detected during AI call'
        }).eq('id', leadId);
    }

    setTimeout(async () => {
        try { await plivoClient.calls.hangup(callSid); } catch (_) {}
        plivoWS.close();
        realtimeWS.close();
    }, 2000);

    return { success: true };
}
