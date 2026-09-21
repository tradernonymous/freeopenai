const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test workspace isolation module
describe('workspace-isolation', () => {
  const workspace = require('../workspace-isolation.js');
  const path = require('path');
  const fs = require('fs');
  
  it('creates workspace directory for user session', () => {
    const dir = workspace.getWorkspaceDir('test-user', 'test-session');
    assert.ok(dir.includes('test-user'));
    assert.ok(dir.includes('test-session'));
    assert.ok(fs.existsSync(dir));
    
    // Cleanup
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
  
  it('adds and retrieves comments', () => {
    const shareId = 'test-share-' + Date.now();
    const comment = workspace.addComment(shareId, 'user1', 'Great chat!');
    
    assert.ok(comment.id);
    assert.equal(comment.userId, 'user1');
    assert.equal(comment.content, 'Great chat!');
    
    const comments = workspace.getComments(shareId);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].content, 'Great chat!');
    
    // Delete comment
    const deleted = workspace.deleteComment(shareId, comment.id, 'user1');
    assert.ok(deleted);
    
    const remaining = workspace.getComments(shareId);
    assert.equal(remaining.length, 0);
  });
  
  it('forks shared chat', () => {
    const result = workspace.forkSharedChat('share-123', 'user-456');
    assert.ok(result.forked);
    assert.equal(result.shareId, 'share-123');
    assert.equal(result.targetUserId, 'user-456');
  });
  
  it('cleans up expired workspaces', () => {
    // This is a basic test - actual cleanup requires time
    const cleaned = workspace.cleanupWorkspaces();
    assert.equal(typeof cleaned, 'number');
  });
});

// Test rate limiter
describe('rate-limiter', () => {
  const { limiter, ENDPOINT_LIMITS } = require('../rate-limits.js');
  
  it('allows requests within limit', () => {
    const key = 'test-ip-comments:get';
    const maxRequests = ENDPOINT_LIMITS['comments:get'].maxRequests;
    
    // First request should be allowed
    const result = limiter.check(key, maxRequests);
    assert.ok(result.allowed);
    assert.ok(result.remaining > 0);
  });
  
  it('blocks requests over limit', () => {
    const key = 'test-ip-block:' + Date.now();
    const maxRequests = 2;
    
    // Use up the limit
    limiter.check(key, maxRequests);
    limiter.check(key, maxRequests);
    
    // Third should be blocked
    const result = limiter.check(key, maxRequests);
    assert.ok(!result.allowed);
    assert.equal(result.remaining, 0);
  });
});

// Test WebSocket auth
describe('websocket-auth', () => {
  const { WsAuth } = require('../websocket-auth.js');
  
  it('creates and verifies valid token', () => {
    const auth = new WsAuth('test-secret-key');
    const token = auth.createToken('user-123');
    
    const result = auth.validateRequest({
      headers: { cookie: 'fo_session=' + token },
      url: '/'
    });
    
    assert.ok(result.valid);
    assert.equal(result.userId, 'user-123');
  });
  
  it('rejects invalid token', () => {
    const auth = new WsAuth('test-secret-key');
    const result = auth.validateRequest({
      headers: { cookie: 'fo_session=invalid-token' },
      url: '/'
    });
    
    assert.ok(!result.valid);
    assert.equal(result.reason, 'invalid_token');
  });
  
  it('rejects missing token', () => {
    const auth = new WsAuth('test-secret-key');
    const result = auth.validateRequest({
      headers: {},
      url: '/'
    });
    
    assert.ok(!result.valid);
    assert.equal(result.reason, 'no_token');
  });
});

// Test offline storage (browser-only, skip in Node)
describe('offline-storage', () => {
  it('exports expected functions', () => {
    // Just verify the module loads
    const offlineStorage = require('../offline-storage.js');
    assert.equal(typeof offlineStorage.init, 'function');
    assert.equal(typeof offlineStorage.saveConversation, 'function');
    assert.equal(typeof offlineStorage.getConversation, 'function');
  });
});
