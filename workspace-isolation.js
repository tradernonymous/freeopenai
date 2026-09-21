/**
 * Workspace Isolation Module
 * Per-user, per-session directories with automatic cleanup
 * Fork + Comments for shared chats
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE_BASE = path.join(__dirname, 'workspace');
const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

// In-memory store for comments (extends to file-based like shareStore)
const commentsStore = new Map();
let commentsStoreDirty = false;
let commentsStoreTimer = null;

/**
 * Get or create a workspace directory for a user session
 */
function getWorkspaceDir(userId, sessionId) {
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(WORKSPACE_BASE, safeUserId, safeSessionId);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // Write a metadata file with creation time
    fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({
      userId: safeUserId,
      sessionId: safeSessionId,
      createdAt: Date.now(),
      lastAccessed: Date.now()
    }));
  } else {
    // Update last accessed time
    updateAccessTime(dir);
  }
  
  return dir;
}

/**
 * Update access time for workspace
 */
function updateAccessTime(dir) {
  const metaPath = path.join(dir, '.meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.lastAccessed = Date.now();
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch (e) { /* ignore */ }
  }
}

/**
 * Cleanup expired workspaces
 */
function cleanupWorkspaces() {
  if (!fs.existsSync(WORKSPACE_BASE)) return;
  
  const now = Date.now();
  const userDirs = fs.readdirSync(WORKSPACE_BASE);
  
  let cleaned = 0;
  for (const userDir of userDirs) {
    const userPath = path.join(WORKSPACE_BASE, userDir);
    if (!fs.statSync(userPath).isDirectory()) continue;
    
    const sessionDirs = fs.readdirSync(userPath);
    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(userPath, sessionDir);
      const metaPath = path.join(sessionPath, '.meta.json');
      
      if (!fs.existsSync(metaPath)) {
        // No meta file, check file ages
        const files = fs.readdirSync(sessionPath);
        let oldest = now;
        for (const file of files) {
          const stat = fs.statSync(path.join(sessionPath, file));
          if (stat.mtimeMs < oldest) oldest = stat.mtimeMs;
        }
        if (now - oldest > WORKSPACE_TTL_MS) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          cleaned++;
        }
      } else {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (now - meta.lastAccessed > WORKSPACE_TTL_MS) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch (e) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          cleaned++;
        }
      }
    }
    
    // Remove empty user dirs
    try {
      const remaining = fs.readdirSync(userPath);
      if (remaining.length === 0) {
        fs.rmSync(userPath, { recursive: true, force: true });
      }
    } catch (e) { /* ignore */ }
  }
  
  return cleaned;
}

/**
 * Fork a shared chat into a user's workspace
 */
function forkSharedChat(shareId, targetUserId) {
  // This would read from shareStore and create a new conversation
  // For now, return the share data with a fork flag
  return {
    forked: true,
    shareId,
    targetUserId,
    forkedAt: Date.now()
  };
}

/**
 * Add a comment to a shared chat
 */
function addComment(shareId, userId, content, parentId = null) {
  const commentId = crypto.randomBytes(8).toString('hex');
  const comment = {
    id: commentId,
    shareId,
    userId,
    content,
    parentId,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  if (!commentsStore.has(shareId)) {
    commentsStore.set(shareId, []);
  }
  commentsStore.get(shareId).push(comment);
  commentsStoreDirty = true;
  
  return comment;
}

/**
 * Get comments for a shared chat
 */
function getComments(shareId) {
  return commentsStore.get(shareId) || [];
}

/**
 * Delete a comment
 */
function deleteComment(shareId, commentId, userId) {
  const comments = commentsStore.get(shareId);
  if (!comments) return false;
  
  const idx = comments.findIndex(c => c.id === commentId && c.userId === userId);
  if (idx === -1) return false;
  
  comments.splice(idx, 1);
  commentsStoreDirty = true;
  return true;
}

/**
 * Flush comments to disk (like shareStore)
 */
function commentsStorePath() {
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'comments.json');
}

function flushCommentsStore() {
  if (!commentsStoreDirty) return Promise.resolve();
  const payload = JSON.stringify(Object.fromEntries(commentsStore));
  const tmp = commentsStorePath() + '.tmp';
  return new Promise((resolve) => {
    fs.writeFile(tmp, payload, (err) => {
      if (err) { commentsStoreDirty = false; return resolve(); }
      fs.rename(tmp, commentsStorePath(), () => {
        commentsStoreDirty = false;
        resolve();
      });
    });
  });
}

function loadCommentsStore() {
  const p = commentsStorePath();
  if (!fs.existsSync(p)) return;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [key, val] of Object.entries(data)) {
      commentsStore.set(key, val);
    }
  } catch (e) { /* corrupted, start fresh */ }
}

// Auto-cleanup interval
let cleanupTimer = null;
function startCleanupScheduler() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupWorkspaces();
    flushCommentsStore();
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

// Initialize
loadCommentsStore();
startCleanupScheduler();

module.exports = {
  getWorkspaceDir,
  cleanupWorkspaces,
  forkSharedChat,
  addComment,
  getComments,
  deleteComment,
  flushCommentsStore,
  WORKSPACE_BASE,
  WORKSPACE_TTL_MS
};
