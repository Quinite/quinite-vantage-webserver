const cache = new Map();
const TTL = 30 * 60 * 1000;

export function getCachedContext(key) {
    const entry = cache.get(key);
    return entry && Date.now() - entry.ts < TTL ? entry.data : null;
}

export function setCachedContext(key, data) {
    cache.set(key, { data, ts: Date.now() });
}

// Prune expired entries every 15 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (now - entry.ts >= TTL) cache.delete(key);
    }
}, 15 * 60 * 1000);
