/**
 * Progress Indicators
 * Real-time progress for multi-step tasks
 */

var ProgressIndicators = (function() {
    var activeTasks = new Map();
    var progressBar = null;
    var statusText = null;
    var container = null;
    
    /**
     * Initialize progress UI
     */
    function init() {
        createProgressBar();
        createTaskList();
    }
    
    /**
     * Create progress bar in header
     */
    function createProgressBar() {
        if (document.getElementById('globalProgressBar')) return;
        
        var bar = document.createElement('div');
        bar.id = 'globalProgressBar';
        bar.className = 'progress-bar';
        bar.innerHTML = `
            <div class="progress-fill"></div>
            <div class="progress-text">Ready</div>
        `;
        bar.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: var(--surface-2);
            z-index: 1000;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(bar);
        
        progressBar = bar.querySelector('.progress-fill');
        statusText = bar.querySelector('.progress-text');
        
        progressBar.style.cssText = `
            height: 100%;
            background: linear-gradient(90deg, var(--accent), #4ecdc4);
            width: 0%;
            transition: width 0.3s ease;
        `;
        
        statusText.style.cssText = `
            position: absolute;
            right: 8px;
            top: 4px;
            font-size: 10px;
            color: var(--text-muted);
        `;
    }
    
    /**
     * Create task list panel
     */
    function createTaskList() {
        if (document.getElementById('taskListPanel')) return;
        
        var panel = document.createElement('div');
        panel.id = 'taskListPanel';
        panel.className = 'task-list-panel';
        panel.innerHTML = `
            <div class="task-list-header">
                <h3>Active Tasks</h3>
                <button class="task-list-close" onclick="ProgressIndicators.togglePanel()">×</button>
            </div>
            <div class="task-list-body" id="taskListBody"></div>
        `;
        panel.style.cssText = `
            position: fixed;
            bottom: 80px;
            right: 16px;
            width: 320px;
            max-height: 400px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--r);
            box-shadow: var(--lift-lg);
            z-index: 100;
            display: none;
            overflow: hidden;
        `;
        document.body.appendChild(panel);
        
        container = panel;
    }
    
    /**
     * Start tracking a task
     */
    function startTask(taskId, task) {
        var taskData = {
            id: taskId,
            name: task.name || 'Task',
            steps: task.steps || [],
            currentStep: 0,
            totalSteps: task.steps ? task.steps.length : 1,
            status: 'running',
            startTime: Date.now(),
            progress: 0
        };
        
        activeTasks.set(taskId, taskData);
        updateUI();
        showProgressBar();
        
        return taskData;
    }
    
    /**
     * Update task progress
     */
    function updateTask(taskId, updates) {
        var task = activeTasks.get(taskId);
        if (!task) return;
        
        Object.assign(task, updates);
        
        // Calculate progress percentage
        if (task.currentStep !== undefined && task.totalSteps) {
            task.progress = Math.round((task.currentStep / task.totalSteps) * 100);
        }
        
        updateUI();
    }
    
    /**
     * Complete a task
     */
    function completeTask(taskId, result) {
        var task = activeTasks.get(taskId);
        if (!task) return;
        
        task.status = 'completed';
        task.progress = 100;
        task.endTime = Date.now();
        task.result = result;
        
        updateUI();
        
        // Remove after delay
        setTimeout(function() {
            activeTasks.delete(taskId);
            updateUI();
            
            if (activeTasks.size === 0) {
                hideProgressBar();
            }
        }, 3000);
    }
    
    /**
     * Fail a task
     */
    function failTask(taskId, error) {
        var task = activeTasks.get(taskId);
        if (!task) return;
        
        task.status = 'failed';
        task.endTime = Date.now();
        task.error = error;
        
        updateUI();
        
        // Remove after delay
        setTimeout(function() {
            activeTasks.delete(taskId);
            updateUI();
            
            if (activeTasks.size === 0) {
                hideProgressBar();
            }
        }, 5000);
    }
    
    /**
     * Cancel a task
     */
    function cancelTask(taskId) {
        var task = activeTasks.get(taskId);
        if (!task) return;
        
        task.status = 'cancelled';
        task.endTime = Date.now();
        
        updateUI();
        
        setTimeout(function() {
            activeTasks.delete(taskId);
            updateUI();
        }, 1000);
    }
    
    /**
     * Update UI
     */
    function updateUI() {
        updateProgressBar();
        updateTaskList();
    }
    
    /**
     * Update progress bar
     */
    function updateProgressBar() {
        if (!progressBar || !statusText) return;
        
        var running = Array.from(activeTasks.values()).filter(function(t) {
            return t.status === 'running';
        });
        
        if (running.length === 0) {
            progressBar.style.width = '100%';
            statusText.textContent = 'Complete';
            return;
        }
        
        // Calculate average progress
        var totalProgress = running.reduce(function(sum, t) {
            return sum + (t.progress || 0);
        }, 0);
        var avgProgress = Math.round(totalProgress / running.length);
        
        progressBar.style.width = avgProgress + '%';
        statusText.textContent = running.length + ' task' + (running.length > 1 ? 's' : '') + ' running';
    }
    
    /**
     * Update task list panel
     */
    function updateTaskList() {
        var body = document.getElementById('taskListBody');
        if (!body) return;
        
        var tasks = Array.from(activeTasks.values());
        
        if (tasks.length === 0) {
            body.innerHTML = '<div class="task-list-empty">No active tasks</div>';
            return;
        }
        
        body.innerHTML = tasks.map(function(task) {
            var statusClass = 'task-status-' + task.status;
            var elapsed = task.endTime ? 
                Math.round((task.endTime - task.startTime) / 1000) + 's' :
                Math.round((Date.now() - task.startTime) / 1000) + 's';
            
            return `
                <div class="task-item ${statusClass}">
                    <div class="task-item-header">
                        <span class="task-name">${escapeHtml(task.name)}</span>
                        <span class="task-time">${elapsed}</span>
                    </div>
                    <div class="task-progress-bar">
                        <div class="task-progress-fill" style="width: ${task.progress || 0}%"></div>
                    </div>
                    <div class="task-step">${task.steps ? task.steps[task.currentStep] || '' : ''}</div>
                    ${task.status === 'running' ? '<button class="task-cancel" onclick="ProgressIndicators.cancelTask(\'' + task.id + '\')">Cancel</button>' : ''}
                    ${task.status === 'failed' ? '<div class="task-error">' + escapeHtml(task.error || 'Failed') + '</div>' : ''}
                </div>
            `;
        }).join('');
    }
    
    /**
     * Show progress bar
     */
    function showProgressBar() {
        var bar = document.getElementById('globalProgressBar');
        if (bar) bar.style.opacity = '1';
    }
    
    /**
     * Hide progress bar
     */
    function hideProgressBar() {
        var bar = document.getElementById('globalProgressBar');
        if (bar) bar.style.opacity = '0';
    }
    
    /**
     * Toggle task list panel
     */
    function togglePanel() {
        if (!container) return;
        
        var isVisible = container.style.display !== 'none';
        container.style.display = isVisible ? 'none' : 'block';
        
        if (!isVisible) {
            updateTaskList();
        }
    }
    
    /**
     * Get active tasks
     */
    function getActiveTasks() {
        return Array.from(activeTasks.values());
    }
    
    /**
     * Escape HTML
     */
    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    /**
     * Create a multi-step task helper
     */
    function createMultiStepTask(name, steps) {
        var taskId = 'task-' + Date.now().toString(36);
        
        var task = startTask(taskId, {
            name: name,
            steps: steps
        });
        
        return {
            id: taskId,
            nextStep: function() {
                task.currentStep++;
                updateTask(taskId, { currentStep: task.currentStep });
            },
            fail: function(error) {
                failTask(taskId, error);
            },
            complete: function(result) {
                completeTask(taskId, result);
            }
        };
    }
    
    return {
        init: init,
        startTask: startTask,
        updateTask: updateTask,
        completeTask: completeTask,
        failTask: failTask,
        cancelTask: cancelTask,
        togglePanel: togglePanel,
        getActiveTasks: getActiveTasks,
        createMultiStepTask: createMultiStepTask
    };
})();

// Auto-initialize
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
        ProgressIndicators.init();
    });
}
