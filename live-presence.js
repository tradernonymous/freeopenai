/**
 * Phase 3: WebSocket Live Presence
 * Shows who's viewing/shared-chat with real-time indicators
 */

var LivePresence = (function() {
    var ws = null;
    var presenceContainer = null;
    var users = [];
    var currentUser = null;
    var chatId = null;
    
    function init() {
        // Create presence container
        presenceContainer = document.createElement('div');
        presenceContainer.className = 'live-presence-container';
        presenceContainer.innerHTML = `
            <div class="presence-avatars" id="presenceAvatars"></div>
            <div class="presence-count" id="presenceCount">0 viewers</div>
        `;
        
        // Insert into chat header
        var chatBar = document.querySelector('.chat-bar-title');
        if (chatBar) {
            chatBar.appendChild(presenceContainer);
        }
    }
    
    function connect(chatIdParam) {
        chatId = chatIdParam;
        if (!chatId) return;
        
        // WebSocket connection
        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        var wsUrl = protocol + '//' + window.location.host + '/ws/presence';
        
        try {
            ws = new WebSocket(wsUrl);
            
            ws.onopen = function() {
                console.log('Presence WebSocket connected');
                // Join chat room
                ws.send(JSON.stringify({
                    type: 'join',
                    chatId: chatId,
                    user: getCurrentUser()
                }));
            };
            
            ws.onmessage = function(event) {
                var data = JSON.parse(event.data);
                handleMessage(data);
            };
            
            ws.onclose = function() {
                console.log('Presence WebSocket disconnected');
                // Reconnect after 3 seconds
                setTimeout(function() {
                    connect(chatId);
                }, 3000);
            };
            
            ws.onerror = function(err) {
                console.error('Presence WebSocket error:', err);
            };
        } catch (e) {
            console.log('WebSocket not supported, using polling');
            startPolling();
        }
    }
    
    function handleMessage(data) {
        switch (data.type) {
            case 'users':
                users = data.users;
                updatePresenceUI();
                break;
            case 'user_joined':
                if (!users.find(function(u) { return u.id === data.user.id; })) {
                    users.push(data.user);
                    updatePresenceUI();
                    showNotification(data.user.name + ' joined', 'info');
                }
                break;
            case 'user_left':
                users = users.filter(function(u) { return u.id !== data.user.id; });
                updatePresenceUI();
                showNotification(data.user.name + ' left', 'info');
                break;
            case 'cursor':
                updateRemoteCursor(data);
                break;
        }
    }
    
    function updatePresenceUI() {
        var avatars = document.getElementById('presenceAvatars');
        var count = document.getElementById('presenceCount');
        
        if (!avatars || !count) return;
        
        // Render avatars
        avatars.innerHTML = users.slice(0, 5).map(function(user) {
            var initials = user.name.split(' ').map(function(n) { return n[0]; }).join('').toUpperCase();
            var color = stringToColor(user.id);
            return '<div class="presence-avatar" style="background: ' + color + '" title="' + user.name + '">' + initials + '</div>';
        }).join('');
        
        // Show overflow indicator
        if (users.length > 5) {
            avatars.innerHTML += '<div class="presence-avatar presence-overflow">+' + (users.length - 5) + '</div>';
        }
        
        // Update count
        count.textContent = users.length + ' viewer' + (users.length !== 1 ? 's' : '');
        
        // Show/hide container
        presenceContainer.style.display = users.length > 0 ? 'flex' : 'none';
    }
    
    function updateRemoteCursor(data) {
        // Update remote user cursor position
        var cursor = document.getElementById('cursor-' + data.user.id);
        
        if (!cursor) {
            cursor = document.createElement('div');
            cursor.id = 'cursor-' + data.user.id;
            cursor.className = 'remote-cursor';
            cursor.innerHTML = '<div class="cursor-pointer"></div><div class="cursor-label">' + data.user.name + '</div>';
            document.body.appendChild(cursor);
        }
        
        cursor.style.left = data.x + 'px';
        cursor.style.top = data.y + 'px';
        
        // Hide after 3 seconds of inactivity
        clearTimeout(cursor.hideTimeout);
        cursor.style.opacity = '1';
        cursor.hideTimeout = setTimeout(function() {
            cursor.style.opacity = '0';
        }, 3000);
    }
    
    function sendCursorPosition(x, y) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'cursor',
                chatId: chatId,
                user: getCurrentUser(),
                x: x,
                y: y
            }));
        }
    }
    
    function getCurrentUser() {
        // Get from app state
        if (window.currentUser) {
            return window.currentUser;
        }
        
        // Fallback
        return {
            id: 'user-' + Math.random().toString(36).substr(2, 9),
            name: 'Anonymous',
            avatar: null
        };
    }
    
    function startPolling() {
        // Polling fallback when WebSocket is not available
        setInterval(function() {
            if (chatId) {
                fetch('/api/presence/' + chatId)
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        users = data.users || [];
                        updatePresenceUI();
                    })
                    .catch(function() {});
            }
        }, 5000);
    }
    
    function stringToColor(str) {
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        var hue = hash % 360;
        return 'hsl(' + hue + ', 70%, 50%)';
    }
    
    function showNotification(message, type) {
        var notification = document.createElement('div');
        notification.className = 'presence-notification presence-notification-' + type;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(function() {
            notification.classList.add('presence-notification-show');
        }, 10);
        
        setTimeout(function() {
            notification.classList.remove('presence-notification-show');
            setTimeout(function() {
                notification.remove();
            }, 300);
        }, 2000);
    }
    
    function disconnect() {
        if (ws) {
            ws.close();
            ws = null;
        }
    }
    
    return {
        init: init,
        connect: connect,
        disconnect: disconnect,
        sendCursorPosition: sendCursorPosition,
        getUsers: function() { return users; }
    };
})();

// Track mouse movement for cursor sharing
document.addEventListener('mousemove', function(e) {
    if (LivePresence.getUsers().length > 0) {
        LivePresence.sendCursorPosition(e.clientX, e.clientY);
    }
});

document.addEventListener('DOMContentLoaded', function() {
    LivePresence.init();
});
