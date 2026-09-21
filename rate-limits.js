/**
 * Rate Limiting for New Endpoints
 * Protects comments, fork, and workspace APIs
 */

class RateLimiter {
    constructor() {
        this.limits = new Map();
        this.windowMs = 60 * 1000; // 1 minute window
    }
    
    /**
     * Check if request is allowed
     * @param {string} key - Rate limit key (e.g., IP + endpoint)
     * @param {number} maxRequests - Max requests per window
     * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
     */
    check(key, maxRequests = 30) {
        const now = Date.now();
        const windowStart = now - this.windowMs;
        
        if (!this.limits.has(key)) {
            this.limits.set(key, []);
        }
        
        const requests = this.limits.get(key);
        
        // Remove old requests outside window
        while (requests.length > 0 && requests[0] < windowStart) {
            requests.shift();
        }
        
        const remaining = Math.max(0, maxRequests - requests.length);
        const allowed = requests.length < maxRequests;
        
        if (allowed) {
            requests.push(now);
        }
        
        const resetAt = requests.length > 0 ? requests[0] + this.windowMs : now + this.windowMs;
        
        return { allowed, remaining, resetAt };
    }
    
    /**
     * Get client identifier from request
     */
    getClientId(req) {
        return req.headers['x-forwarded-for'] || 
               req.connection.remoteAddress || 
               'unknown';
    }
    
    /**
     * Send rate limit response
     */
    sendRateLimit(res, remaining, resetAt) {
        const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
        
        res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': retryAfter.toString(),
            'X-RateLimit-Remaining': remaining.toString(),
            'X-RateLimit-Reset': Math.ceil(resetAt / 1000).toString()
        });
        
        res.end(JSON.stringify({
            error: 'Too many requests',
            retryAfter,
            remaining
        }));
    }
    
    /**
     * Cleanup old entries (call periodically)
     */
    cleanup() {
        const now = Date.now() - this.windowMs;
        for (const [key, requests] of this.limits.entries()) {
            while (requests.length > 0 && requests[0] < now) {
                requests.shift();
            }
            if (requests.length === 0) {
                this.limits.delete(key);
            }
        }
    }
}

// Rate limit configurations for new endpoints
const ENDPOINT_LIMITS = {
    'comments:get': { maxRequests: 60, windowMs: 60000 },
    'comments:post': { maxRequests: 10, windowMs: 60000 },
    'comments:delete': { maxRequests: 20, windowMs: 60000 },
    'fork:post': { maxRequests: 5, windowMs: 60000 },
    'workspace:get': { maxRequests: 30, windowMs: 60000 },
    'workspace:cleanup': { maxRequests: 1, windowMs: 300000 } // 5 min cooldown
};

// Singleton instance
const limiter = new RateLimiter();

// Cleanup every 5 minutes
setInterval(() => limiter.cleanup(), 5 * 60 * 1000);

module.exports = { RateLimiter, ENDPOINT_LIMITS, limiter };
