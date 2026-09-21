/**
 * Share Comments & Fork Integration
 * Adds comment/fork UI to the share modal and connects offline sync
 */

var ShareComments = (function() {
    var shareModal = null;
    var commentsContainer = null;
    var currentShareId = null;
    
    function init() {
        // Wait for share modal to be available
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setup);
        } else {
            setup();
        }
    }
    
    function setup() {
        shareModal = document.getElementById('shareOverlay');
        if (!shareModal) return;
        
        // Enhance existing share modal with comments and fork
        enhanceShareModal();
        
        // Connect offline sync
        connectOfflineSync();
    }
    
    function enhanceShareModal() {
        var modalBody = shareModal.querySelector('.modal-body');
        if (!modalBody) return;
        
        // Add fork button
        var forkBtn = document.createElement('button');
        forkBtn.className = 'share-fork-btn';
        forkBtn.innerHTML = '<i class="fas fa-code-fork"></i> Fork this chat';
        forkBtn.onclick = forkChat;
        forkBtn.style.cssText = `
            margin-top: 12px;
            padding: 8px 16px;
            background: var(--accent-bg);
            border: 1px solid var(--accent);
            border-radius: var(--r-sm);
            color: var(--accent);
            cursor: pointer;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: var(--transition);
        `;
        
        // Add comments section
        var commentsSection = document.createElement('div');
        commentsSection.className = 'share-comments-section';
        commentsSection.innerHTML = `
            <div class="comments-header" style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border);">
                <h4 style="font-size: 13px; color: var(--text-dim); margin-bottom: 8px;">
                    <i class="fas fa-comments"></i> Comments
                </h4>
            </div>
            <div class="comments-list" id="commentsList" style="max-height: 200px; overflow-y: auto; margin-bottom: 8px;"></div>
            <div class="comment-input" style="display: flex; gap: 8px;">
                <input type="text" id="commentInput" placeholder="Add a comment..." 
                    style="flex: 1; padding: 8px 12px; background: var(--surface-2); border: 1px solid var(--border); 
                    border-radius: var(--r-sm); color: var(--text); font-size: 13px;">
                <button id="commentSubmit" style="padding: 8px 12px; background: var(--accent); border: none; 
                    border-radius: var(--r-sm); color: var(--bg); cursor: pointer; font-size: 13px;">
                    Post
                </button>
            </div>
        `;
        
        // Append to modal body
        modalBody.appendChild(forkBtn);
        modalBody.appendChild(commentsSection);
        
        // Wire up comment submission
        var commentInput = document.getElementById('commentInput');
        var commentSubmit = document.getElementById('commentSubmit');
        
        if (commentSubmit) {
            commentSubmit.onclick = addComment;
        }
        if (commentInput) {
            commentInput.onkeydown = function(e) {
                if (e.key === 'Enter') addComment();
            };
        }
    }
    
    function setShareId(shareId) {
        currentShareId = shareId;
        loadComments();
    }
    
    async function loadComments() {
        if (!currentShareId) return;
        
        try {
            var res = await fetch('/api/comments?shareId=' + currentShareId);
            var data = await res.json();
            renderComments(data.comments || []);
        } catch (e) {
            console.warn('Failed to load comments:', e);
        }
    }
    
    function renderComments(comments) {
        var list = document.getElementById('commentsList');
        if (!list) return;
        
        if (comments.length === 0) {
            list.innerHTML = '<p style="font-size: 12px; color: var(--text-muted); padding: 8px;">No comments yet</p>';
            return;
        }
        
        list.innerHTML = comments.map(function(c) {
            var time = new Date(c.createdAt).toLocaleDateString();
            var isOwner = c.userId === (window.currentUser?.id || 'anonymous');
            return `
                <div class="comment-item" style="padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                        <span style="color: var(--text-dim); font-weight: 500;">${escapeHtml(c.userId)}</span>
                        <span style="color: var(--text-muted);">${time}</span>
                    </div>
                    <p style="color: var(--text); margin: 0;">${escapeHtml(c.content)}</p>
                    ${isOwner ? '<button onclick="ShareComments.deleteComment(\'' + c.id + '\')" style="background: none; border: none; color: var(--danger); cursor: pointer; font-size: 11px; margin-top: 4px;">Delete</button>' : ''}
                </div>
            `;
        }).join('');
    }
    
    async function addComment() {
        var input = document.getElementById('commentInput');
        if (!input || !input.value.trim() || !currentShareId) return;
        
        var content = input.value.trim();
        input.value = '';
        
        try {
            await fetch('/api/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shareId: currentShareId, content })
            });
            loadComments();
        } catch (e) {
            console.warn('Failed to add comment:', e);
        }
    }
    
    async function deleteComment(commentId) {
        if (!currentShareId) return;
        
        try {
            await fetch('/api/comments', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shareId: currentShareId, commentId })
            });
            loadComments();
        } catch (e) {
            console.warn('Failed to delete comment:', e);
        }
    }
    
    async function forkChat() {
        if (!currentShareId) return;
        
        try {
            var res = await fetch('/api/fork', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shareId: currentShareId })
            });
            
            if (res.ok) {
                var data = await res.json();
                alert('Chat forked successfully! Check your workspace.');
                // Could navigate to the forked chat
            } else if (res.status === 401) {
                alert('Please sign in to fork this chat.');
            }
        } catch (e) {
            console.warn('Failed to fork chat:', e);
        }
    }
    
    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    /**
     * Connect offline sync queue to actual API calls
     */
    function connectOfflineSync() {
        if (!window.OfflineStorage || !OfflineStorage.isAvailable()) return;
        
        // Sync when coming back online
        window.addEventListener('online', syncOfflineChanges);
        
        // Try syncing on page load
        setTimeout(syncOfflineChanges, 5000);
    }
    
    async function syncOfflineChanges() {
        if (!window.OfflineStorage || !OfflineStorage.isAvailable()) return;
        
        try {
            var pending = await OfflineStorage.getPendingSync();
            for (var item of pending) {
                await syncItem(item);
                await OfflineStorage.markSynced(item.id);
            }
        } catch (e) {
            console.warn('Offline sync failed:', e);
        }
    }
    
    async function syncItem(item) {
        // Route based on action type
        switch (item.action) {
            case 'addMessage':
                // Messages are synced via the chat API
                break;
            case 'addComment':
                await fetch('/api/comments', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item.data)
                });
                break;
            case 'forkChat':
                await fetch('/api/fork', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item.data)
                });
                break;
        }
    }
    
    return {
        init: init,
        setShareId: setShareId,
        loadComments: loadComments,
        addComment: addComment,
        deleteComment: deleteComment,
        forkChat: forkChat
    };
})();

// Auto-initialize
document.addEventListener('DOMContentLoaded', function() {
    ShareComments.init();
});
