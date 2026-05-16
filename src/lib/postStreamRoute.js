// Tracks what should happen to a Plivo call after the <Stream> element completes
// (i.e. after the AI WebSocket closes). Keyed by callSid.
//
// Lets us redirect the call to <Dial> (for transfers) or <Hangup> (for normal end)
// from XML, since Plivo's REST transfer API does NOT work on calls inside a Stream.

const pending = new Map();
const TTL_MS = 5 * 60 * 1000;

export function setPostStreamAction(callSid, action) {
    pending.set(callSid, { ...action, savedAt: Date.now() });
    setTimeout(() => pending.delete(callSid), TTL_MS);
}

export function consumePostStreamAction(callSid) {
    const entry = pending.get(callSid);
    pending.delete(callSid);
    return entry || null;
}
