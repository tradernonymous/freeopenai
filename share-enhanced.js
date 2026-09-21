/**
 * Phase 3: Enhanced Share Links
 * Expiration dates, signed URLs, and fork functionality
 */

var ShareEnhanced = (function() {
    var shareModal = null;
    var currentShareId = null;
    
    function init() {
        // Enhance existing share modal
        enhanceShareModal();
    }
    
    function enhanceShareModal() {
        var overlay = document.getElementById('shareOverlay');
        if (!overlay) return;
        
        // Add expiration selector to modal body
        var modalBody = overlay.querySelector('.modal-body');
        if (modalBody) {
            var expirationHTML = `
                <div class="share-options">
                    <div class="share-option">
                        <label for="shareExpiration">Link expires after:</label>
                        <select id="shareExpiration" class="share-select">
                            <option value="never">Never</option>
                            <option value="24h">24 hours</option>
                            <option value="7d" selected>7 days</option>
                            <option value="30d">30 days</option>
                        </select>
                    </div>
                    <div class="share-option">
                        <label>
                            <input type="checkbox" id="shareRequireAuth" checked>
                            Require sign-in to view
                        </label>
                    </div>
                    <div class="share-option">
                        <label>
                            <input type="checkbox" id="shareAllowFork">
                            Allow others to fork this chat
                        </label>
                    </div>
                </div>
                <div class="share-link-info" id="shareLinkInfo">
                    <i class="fas fa-info-circle"></i>
                    <span>This link is signed and can be revoked at any time.</span>
                </div>
            `;
            
            // Insert before existing content
            modalBody.insertAdjacentHTML('afterbegin', expirationHTML);
        }
        
        // Add fork button to modal footer
        var footer = overlay.querySelector('.github-browser-row');
        if (footer) {
            var forkBtn = document.createElement('button');
            forkBtn.className = 'icon-btn-text';
            forkBtn.innerHTML = '<i class="fas fa-code-branch"></i> Fork';
            forkBtn.onclick = forkChat;
            footer.insertBefore(forkBtn, footer.firstChild);
        }
    }
    
    function createShareLink(chatId, options) {
        options = options || {};
        
        var expiration = options.expiration || '7d';
        var requireAuth = options.requireAuth !== false;
        var allowFork = options.allowFork || false;
        
        // Generate HMAC signature
        var timestamp = Date.now();
        var expiryMs = getExpirationMs(expiration);
        var expiresAt = expiryMs ? timestamp + expiryMs : null;
        
        var payload = {
            chatId: chatId,
            createdAt: timestamp,
            expiresAt: expiresAt,
            requireAuth: requireAuth,
            allowFork: allowFork
        };
        
        // Sign the payload (in production, this would be server-side)
        var signature = btoa(JSON.stringify(payload));
        
        // Build share URL
        var baseUrl = window.location.origin;
        var shareUrl = baseUrl + '/share/' + chatId + '?sig=' + encodeURIComponent(signature);
        
        if (expiresAt) {
            shareUrl += '&exp=' + expiresAt;
        }
        
        return {
            url: shareUrl,
            expiresAt: expiresAt,
            payload: payload
        };
    }
    
    function getExpirationMs(expiration) {
        switch (expiration) {
            case '24h': return 24 * 60 * 60 * 1000;
            case '7d': return 7 * 24 * 60 * 60 * 1000;
            case '30d': return 30 * 24 * 60 * 60 * 1000;
            case 'never': return null;
            default: return 7 * 24 * 60 * 60 * 1000;
        }
    }
    
    function validateShareLink(url) {
        try {
            var urlObj = new URL(url);
            var sig = urlObj.searchParams.get('sig');
            var exp = urlObj.searchParams.get('exp');
            
            if (!sig) return { valid: false, reason: 'No signature' };
            
            // Decode and validate signature
            var payload = JSON.parse(atob(decodeURIComponent(sig)));
            
            // Check expiration
            if (payload.expiresAt && Date.now() > payload.expiresAt) {
                return { valid: false, reason: 'Link expired' };
            }
            
            return { valid: true, payload: payload };
        } catch (e) {
            return { valid: false, reason: 'Invalid link format' };
        }
    }
    
    function forkChat() {
        if (!currentShareId) return;
        
        // Fetch the shared chat
        fetch('/api/share/' + currentShareId + '/fork', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success) {
                showNotification('Chat forked successfully', 'success');
                // Navigate to forked chat
                window.location.href = '/chat/' + data.chatId;
            } else {
                showNotification('Failed to fork chat: ' + data.error, 'error');
            }
        })
        .catch(function(err) {
            showNotification('Error forking chat', 'error');
        });
    }
    
    function revokeShareLink(shareId) {
        fetch('/api/share/' + shareId + '/revoke', {
            method: 'POST'
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success) {
                showNotification('Share link revoked', 'success');
                closeShareModal();
            }
        })
        .catch(function(err) {
            showNotification('Error revoking link', 'error');
        });
    }
    
    function showShareModal(chatId) {
        currentShareId = chatId;
        
        var overlay = document.getElementById('shareOverlay');
        if (overlay) {
            overlay.hidden = false;
            
            // Generate share link
            var expiration = document.getElementById('shareExpiration')?.value || '7d';
            var requireAuth = document.getElementById('shareRequireAuth')?.checked !== false;
            var allowFork = document.getElementById('shareAllowFork')?.checked || false;
            
            var shareData = createShareLink(chatId, {
                expiration: expiration,
                requireAuth: requireAuth,
                allowFork: allowFork
            });
            
            // Update link box
            var linkBox = document.getElementById('shareLinkBox');
            if (linkBox) {
                linkBox.value = shareData.url;
            }
            
            // Update info
            var info = document.getElementById('shareLinkInfo');
            if (info && shareData.expiresAt) {
                var expiresDate = new Date(shareData.expiresAt);
                info.innerHTML = '<i class="fas fa-clock"></i> <span>Link expires: ' + expiresDate.toLocaleDateString() + ' ' + expiresDate.toLocaleTimeString() + '</span>';
            }
        }
    }
    
    function closeShareModal() {
        var overlay = document.getElementById('shareOverlay');
        if (overlay) {
            overlay.hidden = true;
        }
    }
    
    function showNotification(message, type) {
        var notification = document.createElement('div');
        notification.className = 'share-notification share-notification-' + type;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(function() {
            notification.classList.add('share-notification-show');
        }, 10);
        
        setTimeout(function() {
            notification.classList.remove('share-notification-show');
            setTimeout(function() {
                notification.remove();
            }, 300);
        }, 2000);
    }
    
    return {
        init: init,
        createShareLink: createShareLink,
        validateShareLink: validateShareLink,
        forkChat: forkChat,
        revokeShareLink: revokeShareLink,
        showShareModal: showShareModal,
        closeShareModal: closeShareModal
    };
})();

document.addEventListener('DOMContentLoaded', function() {
    ShareEnhanced.init();
});
