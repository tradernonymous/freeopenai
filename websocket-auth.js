/**
 * WebSocket JWT Authentication
 * Validates tokens on WebSocket upgrade
 */

const crypto = require('crypto');

class WsAuth {
    constructor(sessionSecret) {
        this.sessionSecret = sessionSecret;
    }
    
    /**
     * Validate session token from cookie or query param
     */
    validateRequest(req) {
        // Check cookie first
        const cookies = this.parseCookies(req.headers.cookie || '');
        const token = cookies['fo_session'] || 
                      new URL(req.url, 'http://localhost').searchParams.get('token');
        
        if (!token) {
            return { valid: false, userId: null, reason: 'no_token' };
        }
        
        try {
            const payload = this.verifyToken(token);
            return { valid: true, userId: payload.userId, payload };
        } catch (e) {
            return { valid: false, userId: null, reason: 'invalid_token' };
        }
    }
    
    /**
     * Verify JWT-like token (HMAC-SHA256)
     */
    verifyToken(token) {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error('Invalid token format');
        
        const [header, payload, signature] = parts;
        
        // Verify signature
        const expectedSig = crypto
            .createHmac('sha256', this.sessionSecret)
            .update(`${header}.${payload}`)
            .digest('base64url');
        
        if (signature !== expectedSig) {
            throw new Error('Invalid signature');
        }
        
        // Decode payload
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
        
        // Check expiration
        if (decoded.exp && decoded.exp < Date.now() / 1000) {
            throw new Error('Token expired');
        }
        
        return decoded;
    }
    
    /**
     * Parse cookie header
     */
    parseCookies(cookieHeader) {
        const cookies = {};
        cookieHeader.split(';').forEach(function(cookie) {
            const [name, ...rest] = cookie.split('=');
            cookies[name.trim()] = rest.join('=').trim();
        });
        return cookies;
    }
    
    /**
     * Create a signed token for testing
     */
    createToken(userId, expiresInMs = 24 * 60 * 60 * 1000) {
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            userId,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor((Date.now() + expiresInMs) / 1000)
        })).toString('base64url');
        
        const signature = crypto
            .createHmac('sha256', this.sessionSecret)
            .update(`${header}.${payload}`)
            .digest('base64url');
        
        return `${header}.${payload}.${signature}`;
    }
}

module.exports = { WsAuth };
