const isProd = process.env.NODE_ENV === 'production';

function log(level, msg, meta = {}) {
    const entry = { level, ts: new Date().toISOString(), msg, ...meta };
    if (isProd) {
        console.log(JSON.stringify(entry));
    } else {
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        console.log(`[${level.toUpperCase()}] ${msg}${metaStr}`);
    }
}

export const logger = {
    info:  (msg, meta) => log('info',  msg, meta),
    warn:  (msg, meta) => log('warn',  msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    debug: (msg, meta) => log('debug', msg, meta),
};
