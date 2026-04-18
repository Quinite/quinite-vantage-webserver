import { handleDetailedInventory } from './inventory.js';
import { handleLogIntent } from './logIntent.js';
import { handleTransfer } from './transfer.js';
import { handleDisconnect } from './disconnect.js';
import { handleScheduleCallback } from './callback.js';
import { logger } from '../lib/logger.js';

export async function dispatchTool(name, args, { plivoWS, realtimeWS, callSid, leadId, campaignId, callLogId }) {
    switch (name) {
        case 'transfer_call':
            return handleTransfer(plivoWS, realtimeWS, callSid, leadId, campaignId, args, callLogId);
        case 'disconnect_call':
            return handleDisconnect(plivoWS, realtimeWS, callSid, leadId, args, callLogId);
        case 'check_detailed_inventory':
            return handleDetailedInventory(leadId, args);
        case 'schedule_callback':
            return handleScheduleCallback(leadId, campaignId, args);
        case 'log_intent':
            return handleLogIntent(leadId, args, callLogId);
        default:
            logger.warn('Unknown tool called', { name, callSid });
            return { success: false, error: `Unknown tool: ${name}` };
    }
}
