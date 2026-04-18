import { supabase } from '../../services/supabase.js';
import { plivoClient } from '../../services/plivo.js';

export async function handleDisconnect(plivoWS, realtimeWS, callSid, leadId, args, callLogId) {
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
