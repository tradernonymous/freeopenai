/**
 * Phase 4: Performance Optimization
 * Lazy loading and Web Worker for heavy computations
 */

var PerformanceOptimizer = (function() {
    var chatMessages = null;
    var observer = null;
    var lazyElements = [];
    var markdownWorker = null;
    
    function init() {
        chatMessages = document.getElementById('chatMessages');
        if (!chatMessages) return;
        
        // No virtual scrolling here on purpose: hiding off-screen messages
        // with display:none collapses the scroll height under the transcript
        // controller's feet (its pin/follow math assumes the content it put
        // there is still there), so jump-to-newest never settles and the pill
        // comes back. A fixed 80px item guess made it worse, never better.

        // Initialize lazy loading
        initLazyLoading();
        
        // Initialize Web Worker for markdown
        initMarkdownWorker();
        // No addMessage patch here on purpose: deferring appends a frame breaks
        // callers that read the transcript in the same tick (runCommandTool's
        // "Wrote …" acknowledgement), and a throttled page may never run the
        // frame at all. Batching would need a real queue, not a wrapper.
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
