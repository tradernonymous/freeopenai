/**
 * Phase 2: Live Code Preview
 * Split-pane view with code on left, live preview on right
 */

var LivePreview = (function() {
    var container = null;
    var codeEditor = null;
    var previewFrame = null;
    var isHorizontal = true;
    var splitPosition = 50;
    
    function init() {
        // Create preview container
        container = document.createElement('div');
        container.className = 'live-preview-container';
        container.hidden = true;
        container.innerHTML = `
            <div class="preview-toolbar">
                <div class="preview-tabs">
                    <button class="preview-tab active" data-type="html" onclick="LivePreview.switchTab('html')">HTML</button>
                    <button class="preview-tab" data-type="css" onclick="LivePreview.switchTab('css')">CSS</button>
                    <button class="preview-tab" data-type="js" onclick="LivePreview.switchTab('js')">JS</button>
                </div>
                <div class="preview-actions">
                    <button class="preview-action-btn" onclick="LivePreview.toggleOrientation()" title="Toggle split orientation">
                        <i class="fas fa-columns"></i>
                    </button>
                    <button class="preview-action-btn" onclick="LivePreview.refresh()" title="Refresh preview">
                        <i class="fas fa-sync"></i>
                    </button>
                    <button class="preview-action-btn" onclick="LivePreview.openExternal()" title="Open in new tab">
                        <i class="fas fa-external-link-alt"></i>
                    </button>
                    <button class="preview-action-btn" onclick="LivePreview.close()" title="Close preview">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
            <div class="preview-content">
                <div class="preview-code-panel" id="previewCodePanel">
                    <textarea class="preview-code-editor" id="previewCodeEditor" spellcheck="false" placeholder="Write your code here..."></textarea>
                </div>
                <div class="preview-split-handle" id="previewSplitHandle"></div>
                <div class="preview-frame-panel">
                    <iframe class="preview-frame" id="previewFrame" sandbox="allow-scripts allow-same-origin" title="Live preview"></iframe>
                </div>
            </div>
            <div class="preview-status-bar">
                <span class="preview-status" id="previewStatus">Ready</span>
                <span class="preview-size" id="previewSize">100% x 100%</span>
            </div>
        `;
        
        // Insert into Build view
        var buildView = document.getElementById('viewBuild');
        if (buildView) {
            buildView.appendChild(container);
        }
        
        // Initialize split handle drag
        initSplitHandle();
    }
    
    function initSplitHandle() {
        var handle = document.getElementById('previewSplitHandle');
        var codePanel = document.getElementById('previewCodePanel');
        
        if (!handle || !codePanel) return;
        
        var isDragging = false;
        var startX, startWidth;
        
        handle.addEventListener('mousedown', function(e) {
            isDragging = true;
            startX = e.clientX;
            startWidth = codePanel.offsetWidth;
            document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
            document.body.style.userSelect = 'none';
        });
        
        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            
            var delta = e.clientX - startX;
            var containerWidth = container.offsetWidth;
            var newWidth = startWidth + delta;
            var percentage = (newWidth / containerWidth) * 100;
            
            percentage = Math.max(20, Math.min(80, percentage));
            codePanel.style.width = percentage + '%';
            splitPosition = percentage;
            
            updateSizeDisplay();
        });
        
        document.addEventListener('mouseup', function() {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }
    
    function show(html, css, js) {
        if (!container) return;
        
        container.hidden = false;
        
        // Set code
        var editor = document.getElementById('previewCodeEditor');
        if (editor) {
            editor.value = html || '';
            editor.dataset.type = 'html';
        }
        
        // Update preview
        updatePreview(html, css, js);
        
        // Update status
        var status = document.getElementById('previewStatus');
        if (status) status.textContent = 'Live';
        
        updateSizeDisplay();
    }
    
    function updatePreview(html, css, js) {
        var frame = document.getElementById('previewFrame');
        if (!frame) return;
        
        var content = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${css || ''}</style>
</head>
<body>
    ${html || ''}
    <script>${js || ''}<\/script>
</body>
</html>
        `;
        
        frame.srcdoc = content;
    }
    
    function switchTab(type) {
        // Update active tab
        var tabs = document.querySelectorAll('.preview-tab');
        tabs.forEach(function(tab) {
            tab.classList.toggle('active', tab.dataset.type === type);
        });
        
        // Update editor placeholder
        var editor = document.getElementById('previewCodeEditor');
        if (editor) {
            editor.dataset.type = type;
            var placeholders = {
                html: 'Write your HTML here...',
                css: 'Write your CSS here...',
                js: 'Write your JavaScript here...'
            };
            editor.placeholder = placeholders[type] || '';
        }
    }
    
    function toggleOrientation() {
        isHorizontal = !isHorizontal;
        container.classList.toggle('preview-vertical', !isHorizontal);
        updateSizeDisplay();
    }
    
    function refresh() {
        var editor = document.getElementById('previewCodeEditor');
        if (editor) {
            updatePreview(editor.value);
        }
        
        var status = document.getElementById('previewStatus');
        if (status) {
            status.textContent = 'Refreshed';
            setTimeout(function() {
                status.textContent = 'Live';
            }, 1000);
        }
    }
    
    function openExternal() {
        var frame = document.getElementById('previewFrame');
        if (frame && frame.srcdoc) {
            var blob = new Blob([frame.srcdoc], { type: 'text/html' });
            var url = URL.createObjectURL(blob);
            window.open(url, '_blank');
        }
    }
    
    function close() {
        if (container) {
            container.hidden = true;
        }
    }
    
    function updateSizeDisplay() {
        var sizeEl = document.getElementById('previewSize');
        if (!sizeEl) return;
        
        var frame = document.getElementById('previewFrame');
        if (frame) {
            sizeEl.textContent = frame.offsetWidth + ' x ' + frame.offsetHeight;
        }
    }
    
    return {
        init: init,
        show: show,
        switchTab: switchTab,
        toggleOrientation: toggleOrientation,
        refresh: refresh,
        openExternal: openExternal,
        close: close
    };
})();

document.addEventListener('DOMContentLoaded', function() {
    LivePreview.init();
});
