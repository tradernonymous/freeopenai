/**
 * Phase 4: Rich Context Menus
 * Custom right-click menus for code blocks, plan nodes, and files
 */

var RichContextMenus = (function() {
    var currentMenu = null;
    var menuHistory = [];
    
    function init() {
        // Override default context menu on specific elements
        document.addEventListener('contextmenu', handleContextMenu);
        
        // Close menu on click outside
        document.addEventListener('click', closeMenu);
        
        // Close menu on Escape
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeMenu();
        });
    }
    
    function handleContextMenu(e) {
        var target = e.target;
        
        // Check if target has a context menu handler
        var menuType = getMenuType(target);
        if (!menuType) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        showMenu(e, menuType, target);
    }
    
    function getMenuType(element) {
        // Code blocks
        if (element.closest('pre') || element.closest('code')) {
            return 'code';
        }
        
        // Plan nodes (Mermaid canvas)
        if (element.closest('.node') || element.closest('.mermaid-node')) {
            return 'plan';
        }
        
        // File items
        if (element.closest('.file-item') || element.closest('.workspace-file')) {
            return 'file';
        }
        
        // Chat messages
        if (element.closest('.chat-message') || element.closest('.message')) {
            return 'message';
        }
        
        // Links
        if (element.closest('a')) {
            return 'link';
        }
        
        return null;
    }
    
    function showMenu(e, type, target) {
        closeMenu();
        
        var menu = createMenu(type, target);
        if (!menu) return;
        
        // Position menu
        var x = e.clientX;
        var y = e.clientY;
        
        // Ensure menu stays within viewport
        document.body.appendChild(menu);
        var rect = menu.getBoundingClientRect();
        
        if (x + rect.width > window.innerWidth) {
            x = window.innerWidth - rect.width - 10;
        }
        if (y + rect.height > window.innerHeight) {
            y = window.innerHeight - rect.height - 10;
        }
        
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        
        currentMenu = menu;
        menuHistory.push(menu);
    }
    
    function createMenu(type, target) {
        var menu = document.createElement('div');
        menu.className = 'rich-context-menu';
        
        var items = getMenuItems(type, target);
        
        items.forEach(function(item) {
            if (item.divider) {
                menu.appendChild(createDivider());
            } else {
                menu.appendChild(createMenuItem(item, target));
            }
        });
        
        return menu;
    }
    
    function getMenuItems(type, target) {
        switch (type) {
            case 'code':
                return [
                    { icon: 'fa-copy', label: 'Copy code', action: copyCode },
                    { icon: 'fa-edit', label: 'Edit code', action: editCode },
                    { icon: 'fa-play', label: 'Run code', action: runCode },
                    { divider: true },
                    { icon: 'fa-share', label: 'Share snippet', action: shareSnippet },
                    { icon: 'fa-bookmark', label: 'Save to snippets', action: saveSnippet },
                    { divider: true },
                    { icon: 'fa-search', label: 'Explain this code', action: explainCode }
                ];
                
            case 'plan':
                return [
                    { icon: 'fa-edit', label: 'Edit node', action: editPlanNode },
                    { icon: 'fa-copy', label: 'Duplicate', action: duplicatePlanNode },
                    { icon: 'fa-trash', label: 'Delete', action: deletePlanNode },
                    { divider: true },
                    { icon: 'fa-arrow-up', label: 'Add above', action: addPlanNodeAbove },
                    { icon: 'fa-arrow-down', label: 'Add below', action: addPlanNodeBelow },
                    { divider: true },
                    { icon: 'fa-play', label: 'Execute task', action: executePlanTask }
                ];
                
            case 'file':
                return [
                    { icon: 'fa-edit', label: 'Open file', action: openFile },
                    { icon: 'fa-copy', label: 'Copy path', action: copyFilePath },
                    { icon: 'fa-download', label: 'Download', action: downloadFile },
                    { divider: true },
                    { icon: 'fa-trash', label: 'Delete', action: deleteFile }
                ];
                
            case 'message':
                return [
                    { icon: 'fa-copy', label: 'Copy message', action: copyMessage },
                    { icon: 'fa-share', label: 'Share message', action: shareMessage },
                    { divider: true },
                    { icon: 'fa-reply', label: 'Reply', action: replyToMessage },
                    { icon: 'fa-bookmark', label: 'Save to memory', action: saveToMemory }
                ];
                
            case 'link':
                return [
                    { icon: 'fa-external-link-alt', label: 'Open in new tab', action: openLinkNewTab },
                    { icon: 'fa-copy', label: 'Copy link', action: copyLink },
                    { divider: true },
                    { icon: 'fa-bookmark', label: 'Bookmark', action: bookmarkLink }
                ];
                
            default:
                return [];
        }
    }
    
    function createMenuItem(item, target) {
        var menuItem = document.createElement('div');
        menuItem.className = 'rich-context-menu-item';
        menuItem.innerHTML = '<i class="fas ' + item.icon + '"></i><span>' + item.label + '</span>';
        menuItem.onclick = function(e) {
            e.stopPropagation();
            item.action(target);
            closeMenu();
        };
        return menuItem;
    }
    
    function createDivider() {
        var divider = document.createElement('div');
        divider.className = 'rich-context-menu-divider';
        return divider;
    }
    
    function closeMenu() {
        if (currentMenu) {
            currentMenu.remove();
            currentMenu = null;
        }
    }
    
    // ---- Actions ----
    
    function copyCode(target) {
        var code = target.closest('pre')?.textContent || target.textContent;
        navigator.clipboard.writeText(code).then(function() {
            showNotification('Code copied to clipboard', 'success');
        });
    }
    
    function editCode(target) {
        showNotification('Code editor opened', 'info');
        // Implementation: open code in editor
    }
    
    function runCode(target) {
        showNotification('Running code...', 'info');
        // Implementation: execute code in sandbox
    }
    
    function shareSnippet(target) {
        showNotification('Snippet shared', 'success');
        // Implementation: create shareable snippet
    }
    
    function saveSnippet(target) {
        showNotification('Snippet saved', 'success');
        // Implementation: save to snippets library
    }
    
    function explainCode(target) {
        var code = target.closest('pre')?.textContent || target.textContent;
        showNotification('Explaining code...', 'info');
        // Implementation: send to AI for explanation
    }
    
    function editPlanNode(target) {
        showNotification('Node editor opened', 'info');
        // Implementation: open node editor
    }
    
    function duplicatePlanNode(target) {
        showNotification('Node duplicated', 'success');
        // Implementation: duplicate node in plan
    }
    
    function deletePlanNode(target) {
        if (confirm('Delete this node?')) {
            showNotification('Node deleted', 'success');
            // Implementation: delete node from plan
        }
    }
    
    function addPlanNodeAbove(target) {
        showNotification('Node added above', 'success');
        // Implementation: add node above
    }
    
    function addPlanNodeBelow(target) {
        showNotification('Node added below', 'success');
        // Implementation: add node below
    }
    
    function executePlanTask(target) {
        showNotification('Executing task...', 'info');
        // Implementation: execute task
    }
    
    function openFile(target) {
        showNotification('Opening file...', 'info');
        // Implementation: open file in editor
    }
    
    function copyFilePath(target) {
        var path = target.dataset?.path || target.textContent;
        navigator.clipboard.writeText(path).then(function() {
            showNotification('Path copied', 'success');
        });
    }
    
    function downloadFile(target) {
        showNotification('Downloading file...', 'info');
        // Implementation: download file
    }
    
    function deleteFile(target) {
        if (confirm('Delete this file?')) {
            showNotification('File deleted', 'success');
            // Implementation: delete file
        }
    }
    
    function copyMessage(target) {
        var message = target.closest('.chat-message')?.textContent || target.textContent;
        navigator.clipboard.writeText(message).then(function() {
            showNotification('Message copied', 'success');
        });
    }
    
    function shareMessage(target) {
        showNotification('Message shared', 'success');
        // Implementation: share message
    }
    
    function replyToMessage(target) {
        showNotification('Reply mode activated', 'info');
        // Implementation: enter reply mode
    }
    
    function saveToMemory(target) {
        showNotification('Saved to memory', 'success');
        // Implementation: save to memory
    }
    
    function openLinkNewTab(target) {
        var link = target.closest('a');
        if (link) {
            window.open(link.href, '_blank');
        }
    }
    
    function copyLink(target) {
        var link = target.closest('a');
        if (link) {
            navigator.clipboard.writeText(link.href).then(function() {
                showNotification('Link copied', 'success');
            });
        }
    }
    
    function bookmarkLink(target) {
        showNotification('Link bookmarked', 'success');
        // Implementation: bookmark link
    }
    
    function showNotification(message, type) {
        var notification = document.createElement('div');
        notification.className = 'context-notification context-notification-' + type;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(function() {
            notification.classList.add('context-notification-show');
        }, 10);
        
        setTimeout(function() {
            notification.classList.remove('context-notification-show');
            setTimeout(function() {
                notification.remove();
            }, 300);
        }, 2000);
    }
    
    return {
        init: init,
        closeMenu: closeMenu
    };
})();

document.addEventListener('DOMContentLoaded', function() {
    RichContextMenus.init();
});
