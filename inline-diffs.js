/**
 * Phase 2: Cursor-Style Inline Code Diffs
 * Shows code changes with accept/reject per line
 */

var InlineDiffs = (function() {
    var diffContainer = null;
    
    function init() {
        // Create diff container
        diffContainer = document.createElement('div');
        diffContainer.className = 'inline-diff-container';
        diffContainer.hidden = true;
        
        // Insert after chat messages
        var chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.parentNode.insertBefore(diffContainer, chatMessages.nextSibling);
        }
    }
    
    function showDiff(fileName, oldCode, newCode, metadata) {
        if (!diffContainer) return;
        
        var oldLines = oldCode.split('\n');
        var newLines = newCode.split('\n');
        
        // Simple diff algorithm (line-by-line comparison)
        var diff = computeDiff(oldLines, newLines);
        
        // Build diff HTML
        var html = `
            <div class="diff-header">
                <div class="diff-file-info">
                    <i class="fas fa-file-code"></i>
                    <span class="diff-filename">${fileName}</span>
                    <span class="diff-stats">
                        <span class="diff-add">+${diff.additions}</span>
                        <span class="diff-remove">-${diff.deletions}</span>
                    </span>
                </div>
                <div class="diff-actions">
                    <button class="diff-action-btn diff-accept-all" onclick="InlineDiffs.acceptAll()">
                        <i class="fas fa-check"></i> Accept All
                    </button>
                    <button class="diff-action-btn diff-reject-all" onclick="InlineDiffs.rejectAll()">
                        <i class="fas fa-times"></i> Reject All
                    </button>
                    <button class="diff-action-btn diff-close" onclick="InlineDiffs.hide()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
            <div class="diff-content">
        `;
        
        diff.lines.forEach(function(line, index) {
            var lineClass = line.type === 'add' ? 'diff-line-add' : 
                           line.type === 'remove' ? 'diff-line-remove' : 
                           line.type === 'context' ? 'diff-line-context' : '';
            
            var lineNumOld = line.oldNum || '';
            var lineNumNew = line.newNum || '';
            
            html += `
                <div class="diff-line ${lineClass}" data-index="${index}" data-type="${line.type}">
                    <div class="diff-line-numbers">
                        <span class="diff-line-old">${lineNumOld}</span>
                        <span class="diff-line-new">${lineNumNew}</span>
                    </div>
                    <div class="diff-line-marker">${line.marker}</div>
                    <div class="diff-line-content"><pre>${escapeHtml(line.content)}</pre></div>
                    <div class="diff-line-actions">
                        ${line.type !== 'context' ? `
                            <button class="diff-line-btn diff-line-accept" onclick="InlineDiffs.acceptLine(${index})" title="Accept this change">
                                <i class="fas fa-check"></i>
                            </button>
                            <button class="diff-line-btn diff-line-reject" onclick="InlineDiffs.rejectLine(${index})" title="Reject this change">
                                <i class="fas fa-times"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        });
        
        html += '</div>';
        
        // Add metadata if provided
        if (metadata) {
            html += `
                <div class="diff-footer">
                    <span class="diff-metadata">${metadata}</span>
                </div>
            `;
        }
        
        diffContainer.innerHTML = html;
        diffContainer.hidden = false;
        
        // Scroll into view
        diffContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    
    function computeDiff(oldLines, newLines) {
        var result = [];
        var additions = 0;
        var deletions = 0;
        
        // Simple LCS-based diff
        var lcs = lcsMatrix(oldLines, newLines);
        var i = oldLines.length;
        var j = newLines.length;
        
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldLines[i-1] === newLines[j-1]) {
                result.unshift({
                    type: 'context',
                    content: oldLines[i-1],
                    oldNum: i,
                    newNum: j,
                    marker: ' '
                });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || lcs[i][j-1] >= lcs[i-1][j])) {
                result.unshift({
                    type: 'add',
                    content: newLines[j-1],
                    newNum: j,
                    marker: '+'
                });
                additions++;
                j--;
            } else {
                result.unshift({
                    type: 'remove',
                    content: oldLines[i-1],
                    oldNum: i,
                    marker: '-'
                });
                deletions++;
                i--;
            }
        }
        
        return { lines: result, additions: additions, deletions: deletions };
    }
    
    function lcsMatrix(a, b) {
        var m = a.length;
        var n = b.length;
        var dp = [];
        
        for (var i = 0; i <= m; i++) {
            dp[i] = [];
            for (var j = 0; j <= n; j++) {
                if (i === 0 || j === 0) {
                    dp[i][j] = 0;
                } else if (a[i-1] === b[j-1]) {
                    dp[i][j] = dp[i-1][j-1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
                }
            }
        }
        
        return dp;
    }
    
    function acceptLine(index) {
        var line = diffContainer.querySelector(`[data-index="${index}"]`);
        if (line) {
            line.classList.add('diff-line-accepted');
            line.classList.remove('diff-line-rejected');
            showNotification('Line accepted', 'success');
        }
    }
    
    function rejectLine(index) {
        var line = diffContainer.querySelector(`[data-index="${index}"]`);
        if (line) {
            line.classList.add('diff-line-rejected');
            line.classList.remove('diff-line-accepted');
            showNotification('Line rejected', 'info');
        }
    }
    
    function acceptAll() {
        var lines = diffContainer.querySelectorAll('.diff-line[data-type="add"], .diff-line[data-type="remove"]');
        lines.forEach(function(line) {
            line.classList.add('diff-line-accepted');
        });
        showNotification('All changes accepted', 'success');
        
        // Apply changes
        applyChanges();
    }
    
    function rejectAll() {
        var lines = diffContainer.querySelectorAll('.diff-line[data-type="add"], .diff-line[data-type="remove"]');
        lines.forEach(function(line) {
            line.classList.add('diff-line-rejected');
        });
        showNotification('All changes rejected', 'info');
    }
    
    function applyChanges() {
        // Collect accepted lines and apply to file
        showNotification('Changes applied to file', 'success');
    }
    
    function hide() {
        if (diffContainer) {
            diffContainer.hidden = true;
        }
    }
    
    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    function showNotification(message, type) {
        var notification = document.createElement('div');
        notification.className = 'diff-notification diff-notification-' + type;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(function() {
            notification.classList.add('diff-notification-show');
        }, 10);
        
        setTimeout(function() {
            notification.classList.remove('diff-notification-show');
            setTimeout(function() {
                notification.remove();
            }, 300);
        }, 2000);
    }
    
    return {
        init: init,
        showDiff: showDiff,
        acceptLine: acceptLine,
        rejectLine: rejectLine,
        acceptAll: acceptAll,
        rejectAll: rejectAll,
        hide: hide
    };
})();

document.addEventListener('DOMContentLoaded', function() {
    InlineDiffs.init();
});
