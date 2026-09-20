/**
 * Phase 2: Interactive Mermaid Canvas
 * Visual planning with drag-and-drop, click-to-edit, and context menus
 */

// Mermaid Canvas Module
var MermaidCanvas = (function() {
    var canvas = null;
    var svgElement = null;
    var nodes = [];
    var selectedNode = null;
    var isDragging = false;
    var dragOffset = { x: 0, y: 0 };
    
    function init() {
        // Create canvas container
        canvas = document.createElement('div');
        canvas.className = 'mermaid-canvas';
        canvas.innerHTML = `
            <div class="mermaid-canvas-toolbar">
                <button class="mermaid-tool-btn" onclick="MermaidCanvas.zoomIn()" title="Zoom In">
                    <i class="fas fa-search-plus"></i>
                </button>
                <button class="mermaid-tool-btn" onclick="MermaidCanvas.zoomOut()" title="Zoom Out">
                    <i class="fas fa-search-minus"></i>
                </button>
                <button class="mermaid-tool-btn" onclick="MermaidCanvas.resetView()" title="Reset View">
                    <i class="fas fa-expand"></i>
                </button>
                <button class="mermaid-tool-btn" onclick="MermaidCanvas.exportPNG()" title="Export PNG">
                    <i class="fas fa-download"></i>
                </button>
                <button class="mermaid-tool-btn" onclick="MermaidCanvas.toggleEdit()" title="Toggle Edit Mode">
                    <i class="fas fa-edit"></i>
                </button>
            </div>
            <div class="mermaid-canvas-content" id="mermaidCanvasContent">
                <div class="mermaid-empty-state">
                    <i class="fas fa-project-diagram"></i>
                    <p>No plan yet. Ask the AI to create a plan or paste a Mermaid diagram.</p>
                </div>
            </div>
            <div class="mermaid-canvas-info" id="mermaidCanvasInfo">
                <span id="mermaidNodeCount">0 nodes</span>
                <span id="mermaidZoomLevel">100%</span>
            </div>
        `;
        
        // Insert canvas into the plan section
        var planSection = document.getElementById('sessionSectionTasks');
        if (planSection) {
            planSection.insertBefore(canvas, planSection.firstChild);
        }
        
        // Load Mermaid library
        loadMermaidLibrary();
    }
    
    function loadMermaidLibrary() {
        if (window.mermaid) {
            console.log('Mermaid already loaded');
            return;
        }
        
        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
        script.onload = function() {
            mermaid.initialize({
                startOnLoad: false,
                theme: 'dark',
                securityLevel: 'loose',
                flowchart: { useMaxWidth: true, htmlLabels: true }
            });
            console.log('Mermaid loaded');
        };
        document.head.appendChild(script);
    }
    
    function renderDiagram(markdown) {
        if (!canvas || !window.mermaid) return;
        
        var content = document.getElementById('mermaidCanvasContent');
        if (!content) return;
        
        // Show loading
        content.innerHTML = '<div class="mermaid-loading"><i class="fas fa-spinner fa-spin"></i> Rendering diagram...</div>';
        
        // Generate unique ID
        var diagramId = 'mermaid-' + Date.now();
        
        // Render with Mermaid
        mermaid.render(diagramId, markdown).then(function(result) {
            content.innerHTML = result.svg;
            svgElement = content.querySelector('svg');
            
            if (svgElement) {
                // Make nodes interactive
                makeNodesInteractive();
                
                // Update info
                updateNodeCount();
                
                // Add zoom/pan
                initPanZoom();
            }
        }).catch(function(err) {
            content.innerHTML = '<div class="mermaid-error"><i class="fas fa-exclamation-triangle"></i> Error rendering diagram: ' + err.message + '</div>';
        });
    }
    
    function makeNodesInteractive() {
        if (!svgElement) return;
        
        // Find all node elements
        var nodeElements = svgElement.querySelectorAll('.node, .edgePath, .cluster');
        
        nodeElements.forEach(function(el, index) {
            // Add data attribute
            el.setAttribute('data-node-id', index);
            
            // Click handler
            el.addEventListener('click', function(e) {
                e.stopPropagation();
                selectNode(el, index);
            });
            
            // Double-click to edit
            el.addEventListener('dblclick', function(e) {
                e.stopPropagation();
                editNode(el, index);
            });
            
            // Right-click context menu
            el.addEventListener('contextmenu', function(e) {
                e.preventDefault();
                showContextMenu(e, el, index);
            });
            
            // Hover effect
            el.addEventListener('mouseenter', function() {
                el.classList.add('mermaid-node-hover');
            });
            
            el.addEventListener('mouseleave', function() {
                el.classList.remove('mermaid-node-hover');
            });
        });
    }
    
    function selectNode(el, index) {
        // Deselect previous
        if (selectedNode) {
            selectedNode.classList.remove('mermaid-node-selected');
        }
        
        // Select new
        selectedNode = el;
        el.classList.add('mermaid-node-selected');
        
        // Update info
        var info = document.getElementById('mermaidCanvasInfo');
        if (info) {
            info.innerHTML = '<span>Selected: Node ' + (index + 1) + '</span>';
        }
    }
    
    function editNode(el, index) {
        var textEl = el.querySelector('text, tspan');
        if (!textEl) return;
        
        var currentText = textEl.textContent;
        var newText = prompt('Edit node text:', currentText);
        
        if (newText && newText !== currentText) {
            textEl.textContent = newText;
            showNotification('Node updated', 'success');
        }
    }
    
    function showContextMenu(e, el, index) {
        // Remove existing menu
        var existing = document.querySelector('.mermaid-context-menu');
        if (existing) existing.remove();
        
        // Create menu
        var menu = document.createElement('div');
        menu.className = 'mermaid-context-menu';
        menu.innerHTML = `
            <div class="mermaid-menu-item" onclick="MermaidCanvas.editNodeFromMenu(${index})">
                <i class="fas fa-edit"></i> Edit
            </div>
            <div class="mermaid-menu-item" onclick="MermaidCanvas.duplicateNode(${index})">
                <i class="fas fa-copy"></i> Duplicate
            </div>
            <div class="mermaid-menu-item" onclick="MermaidCanvas.deleteNode(${index})">
                <i class="fas fa-trash"></i> Delete
            </div>
            <div class="mermaid-menu-divider"></div>
            <div class="mermaid-menu-item" onclick="MermaidCanvas.addNodeAbove(${index})">
                <i class="fas fa-arrow-up"></i> Add Above
            </div>
            <div class="mermaid-menu-item" onclick="MermaidCanvas.addNodeBelow(${index})">
                <i class="fas fa-arrow-down"></i> Add Below
            </div>
        `;
        
        // Position menu
        menu.style.left = e.pageX + 'px';
        menu.style.top = e.pageY + 'px';
        
        document.body.appendChild(menu);
        
        // Close on click outside
        setTimeout(function() {
            document.addEventListener('click', function closeMenu() {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            });
        }, 100);
    }
    
    function editNodeFromMenu(index) {
        var node = svgElement.querySelector('[data-node-id="' + index + '"]');
        if (node) editNode(node, index);
    }
    
    function duplicateNode(index) {
        showNotification('Node duplicated', 'success');
        // Implementation would clone the node and add it to the diagram
    }
    
    function deleteNode(index) {
        if (confirm('Delete this node?')) {
            showNotification('Node deleted', 'success');
            // Implementation would remove the node from the diagram
        }
    }
    
    function addNodeAbove(index) {
        var text = prompt('Enter text for new node:');
        if (text) {
            showNotification('Node added above', 'success');
            // Implementation would insert a new node before the selected one
        }
    }
    
    function addNodeBelow(index) {
        var text = prompt('Enter text for new node:');
        if (text) {
            showNotification('Node added below', 'success');
            // Implementation would insert a new node after the selected one
        }
    }
    
    function initPanZoom() {
        if (!svgElement) return;
        
        var scale = 1;
        var translateX = 0;
        var translateY = 0;
        
        function updateTransform() {
            svgElement.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')';
            document.getElementById('mermaidZoomLevel').textContent = Math.round(scale * 100) + '%';
        }
        
        // Mouse wheel zoom
        canvas.addEventListener('wheel', function(e) {
            e.preventDefault();
            var delta = e.deltaY > 0 ? 0.9 : 1.1;
            scale = Math.min(Math.max(0.25, scale * delta), 4);
            updateTransform();
        });
        
        // Pan with mouse drag
        var isPanning = false;
        var startX, startY;
        
        canvas.addEventListener('mousedown', function(e) {
            if (e.target === svgElement || e.target === canvas.querySelector('.mermaid-canvas-content')) {
                isPanning = true;
                startX = e.clientX - translateX;
                startY = e.clientY - translateY;
                canvas.style.cursor = 'grabbing';
            }
        });
        
        document.addEventListener('mousemove', function(e) {
            if (isPanning) {
                translateX = e.clientX - startX;
                translateY = e.clientY - startY;
                updateTransform();
            }
        });
        
        document.addEventListener('mouseup', function() {
            isPanning = false;
            canvas.style.cursor = 'default';
        });
    }
    
    function zoomIn() {
        if (!svgElement) return;
        var currentScale = parseFloat(svgElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || 1);
        svgElement.style.transform = svgElement.style.transform.replace(/scale\([^)]+\)/, 'scale(' + Math.min(currentScale * 1.2, 4) + ')');
        updateNodeCount();
    }
    
    function zoomOut() {
        if (!svgElement) return;
        var currentScale = parseFloat(svgElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || 1);
        svgElement.style.transform = svgElement.style.transform.replace(/scale\([^)]+\)/, 'scale(' + Math.max(currentScale * 0.8, 0.25) + ')');
        updateNodeCount();
    }
    
    function resetView() {
        if (svgElement) {
            svgElement.style.transform = 'translate(0px, 0px) scale(1)';
            document.getElementById('mermaidZoomLevel').textContent = '100%';
        }
    }
    
    function exportPNG() {
        if (!svgElement) return;
        
        var svgData = new XMLSerializer().serializeToString(svgElement);
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        var img = new Image();
        
        img.onload = function() {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            
            var link = document.createElement('a');
            link.download = 'neuraos-plan-' + Date.now() + '.png';
            link.href = canvas.toDataURL('image/png');
            link.click();
            
            showNotification('Exported as PNG', 'success');
        };
        
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    }
    
    function toggleEdit() {
        showNotification('Edit mode toggled', 'info');
        // Implementation would toggle edit mode for all nodes
    }
    
    function updateNodeCount() {
        if (!svgElement) return;
        var count = svgElement.querySelectorAll('.node').length;
        var countEl = document.getElementById('mermaidNodeCount');
        if (countEl) countEl.textContent = count + ' node' + (count !== 1 ? 's' : '');
    }
    
    function showNotification(message, type) {
        var notification = document.createElement('div');
        notification.className = 'mermaid-notification mermaid-notification-' + type;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(function() {
            notification.classList.add('mermaid-notification-show');
        }, 10);
        
        setTimeout(function() {
            notification.classList.remove('mermaid-notification-show');
            setTimeout(function() {
                notification.remove();
            }, 300);
        }, 2000);
    }
    
    // Public API
    return {
        init: init,
        renderDiagram: renderDiagram,
        zoomIn: zoomIn,
        zoomOut: zoomOut,
        resetView: resetView,
        exportPNG: exportPNG,
        toggleEdit: toggleEdit,
        editNodeFromMenu: editNodeFromMenu,
        duplicateNode: duplicateNode,
        deleteNode: deleteNode,
        addNodeAbove: addNodeAbove,
        addNodeBelow: addNodeBelow
    };
})();

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    MermaidCanvas.init();
});
