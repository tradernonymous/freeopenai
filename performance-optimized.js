/**
 * Phase 4: Performance Optimization
 * Virtual scrolling, lazy loading, and Web Worker for heavy computations
 */

var PerformanceOptimizer = (function() {
    var chatMessages = null;
    var observer = null;
    var lazyElements = [];
    var markdownWorker = null;
    
    function init() {
        chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;
        
        // Initialize virtual scrolling
        initVirtualScrolling();
        
        // Initialize lazy loading
        initLazyLoading();
        
        // Initialize Web Worker for markdown
        initMarkdownWorker();
        
        // Optimize message rendering
        optimizeMessageRendering();
    }
    
    /**
     * Virtual scrolling for chat messages
     * Only renders visible messages + buffer, keeps DOM light
     */
    function initVirtualScrolling() {
        if (!chatMessages) return;
        
        var ITEM_HEIGHT = 80; // Average message height
        var BUFFER = 5; // Extra messages above/below viewport
        var visibleStart = 0;
        var visibleEnd = 0;
        
        function getVisibleRange() {
            var scrollTop = chatMessages.scrollTop;
            var viewportHeight = chatMessages.clientHeight;
            var startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
            var endIndex = Math.min(
                chatMessages.children.length,
                Math.ceil((scrollTop + viewportHeight) / ITEM_HEIGHT) + BUFFER
            );
            return { start: startIndex, end: endIndex };
        }
        
        function updateVisibility() {
            var range = getVisibleRange();
            var messages = chatMessages.children;
            
            for (var i = 0; i < messages.length; i++) {
                var msg = messages[i];
                if (i < range.start || i > range.end) {
                    // Off-screen: hide but keep in DOM
                    if (!msg.dataset.virtHidden) {
                        msg.style.display = 'none';
                        msg.dataset.virtHidden = '1';
                    }
                } else {
                    // On-screen: show
                    if (msg.dataset.virtHidden) {
                        msg.style.display = '';
                        delete msg.dataset.virtHidden;
                    }
                }
            }
            
            visibleStart = range.start;
            visibleEnd = range.end;
        }
        
        // Debounced scroll handler
        var scrollTimer = null;
        chatMessages.addEventListener('scroll', function() {
            if (scrollTimer) cancelAnimationFrame(scrollTimer);
            scrollTimer = requestAnimationFrame(updateVisibility);
        }, { passive: true });
        
        // Initial visibility
        updateVisibility();
        
        // Re-run when messages change
        var mutationObserver = new MutationObserver(function() {
            requestAnimationFrame(updateVisibility);
        });
        mutationObserver.observe(chatMessages, { childList: true });
    }
    
    /**
     * Lazy loading for heavy components
     * Uses IntersectionObserver to load images/code blocks on demand
     */
    function initLazyLoading() {
        if (!chatMessages) return;
        
        // Lazy load images
        var imageObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    var img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        imageObserver.unobserve(img);
                    }
                }
            });
        }, { rootMargin: '200px' }); // Load 200px before visible
        
        // Observe all images with data-src
        document.querySelectorAll('img[data-src]').forEach(function(img) {
            imageObserver.observe(img);
        });
        
        // Lazy load code blocks (syntax highlighting is expensive)
        var codeObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    var pre = entry.target;
                    if (!pre.dataset.highlighted) {
                        // Defer syntax highlighting
                        requestAnimationFrame(function() {
                            highlightCode(pre);
                            pre.dataset.highlighted = '1';
                        });
                    }
                    codeObserver.unobserve(pre);
                }
            });
        }, { rootMargin: '100px' });
        
        document.querySelectorAll('pre code').forEach(function(code) {
            codeObserver.observe(code.parentElement);
        });
    }
    
    /**
     * Web Worker for markdown parsing
     * Offloads heavy markdown→HTML conversion to background thread
     */
    function initMarkdownWorker() {
        // Create inline worker
        var workerCode = `
            self.onmessage = function(e) {
                var markdown = e.data;
                var html = parseMarkdown(markdown);
                self.postMessage(html);
            };
            
            function parseMarkdown(text) {
                // Basic markdown parsing (heading, bold, italic, code, links, lists)
                var html = text
                    // Code blocks
                    .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                    // Inline code
                    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                    // Headers
                    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                    // Bold and italic
                    .replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>')
                    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
                    // Links
                    .replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2" target="_blank">$1</a>')
                    // Line breaks
                    .replace(/\\n/g, '<br>');
                return html;
            }
        `;
        
        try {
            var blob = new Blob([workerCode], { type: 'application/javascript' });
            markdownWorker = new Worker(URL.createObjectURL(blob));
            
            markdownWorker.onmessage = function(e) {
                var target = document.querySelector('[data-parsing="true"]');
                if (target) {
                    target.innerHTML = e.data;
                    target.removeAttribute('data-parsing');
                }
            };
        } catch (err) {
            // Worker not supported, fall back to main thread
            markdownWorker = null;
        }
    }
    
    /**
     * Parse markdown using Web Worker if available, else main thread
     */
    function parseMarkdownAsync(text, targetElement) {
        if (markdownWorker && targetElement) {
            targetElement.dataset.parsing = 'true';
            markdownWorker.postMessage(text);
        } else {
            // Fallback: simple inline parsing
            targetElement.innerHTML = text
                .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                .replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>')
                .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
                .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
                .replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2" target="_blank">$1</a>')
                .replace(/\\n/g, '<br>');
        }
    }
    
    /**
     * Optimize message rendering
     * Uses DocumentFragment for batch DOM updates
     */
    function optimizeMessageRendering() {
        // Patch addMessage to use DocumentFragment for batch inserts
        if (typeof window.addMessage === 'function') {
            var originalAddMessage = window.addMessage;
            window.addMessage = function() {
                // Use requestAnimationFrame to batch DOM updates
                return requestAnimationFrame(function() {
                    return originalAddMessage.apply(this, arguments);
                });
            };
        }
    }
    
    /**
     * Simple syntax highlighting (lightweight, no library)
     */
    function highlightCode(pre) {
        if (!pre || !pre.querySelector('code')) return;
        var code = pre.querySelector('code');
        var text = code.textContent;
        
        // Basic keyword highlighting
        var keywords = ['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'export', 'default', 'from', 'async', 'await', 'try', 'catch', 'throw', 'new', 'this'];
        var highlighted = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/(\/\/.*$)/gm, '<span style="color:#6a9955">$1</span>')
            .replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color:#6a9955">$1</span>')
            .replace(/("(?:[^"\\]|\\.)*")/g, '<span style="color:#ce9178">$1</span>')
            .replace(/('(?:[^'\\]|\\.)*')/g, '<span style="color:#ce9178">$1</span>');
        
        // Highlight keywords
        keywords.forEach(function(kw) {
            var regex = new RegExp('\\b(' + kw + ')\\b', 'g');
            highlighted = highlighted.replace(regex, '<span style="color:#569cd6">$1</span>');
        });
        
        code.innerHTML = highlighted;
    }
    
    /**
     * Cleanup
     */
    function destroy() {
        if (markdownWorker) {
            markdownWorker.terminate();
            markdownWorker = null;
        }
        if (observer) {
            observer.disconnect();
        }
    }
    
    return {
        init: init,
        parseMarkdownAsync: parseMarkdownAsync,
        destroy: destroy
    };
})();

// Auto-initialize
document.addEventListener('DOMContentLoaded', function() {
    PerformanceOptimizer.init();
});
