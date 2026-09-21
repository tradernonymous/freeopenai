/**
 * Task Queue with Persistence
 * Long-running tasks survive page reloads and can be resumed
 */

var TaskQueue = (function() {
    var DB_NAME = 'neuraos-tasks';
    var DB_VERSION = 1;
    var db = null;
    var queue = [];
    var isProcessing = false;
    var currentTask = null;
    
    // Task states
    var STATES = {
        PENDING: 'pending',
        RUNNING: 'running',
        COMPLETED: 'completed',
        FAILED: 'failed',
        PAUSED: 'paused'
    };
    
    /**
     * Initialize IndexedDB for task persistence
     */
    function init() {
        return new Promise(function(resolve, reject) {
            if (typeof indexedDB === 'undefined') {
                console.warn('IndexedDB not available, task queue memory-only');
                resolve();
                return;
            }
            
            var request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onerror = function() {
                console.warn('Failed to open task DB');
                resolve();
            };
            
            request.onupgradeneeded = function(event) {
                var database = event.target.result;
                if (!database.objectStoreNames.contains('tasks')) {
                    var store = database.createObjectStore('tasks', { keyPath: 'id' });
                    store.createIndex('status', 'status', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                    store.createIndex('priority', 'priority', { unique: false });
                }
            };
            
            request.onsuccess = function(event) {
                db = event.target.result;
                loadPendingTasks().then(resolve);
            };
        });
    }
    
    /**
     * Add a task to the queue
     */
    function add(task) {
        var taskObj = {
            id: generateId(),
            type: task.type || 'chat',
            prompt: task.prompt,
            model: task.model || null,
            provider: task.provider || null,
            status: STATES.PENDING,
            priority: task.priority || 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            attempts: 0,
            maxAttempts: task.maxAttempts || 3,
            result: null,
            error: null,
            metadata: task.metadata || {}
        };
        
        queue.push(taskObj);
        saveTask(taskObj);
        
        // Start processing if not already
        if (!isProcessing) {
            processNext();
        }
        
        return taskObj.id;
    }
    
    /**
     * Load pending tasks from IndexedDB
     */
    function loadPendingTasks() {
        if (!db) return Promise.resolve();
        
        return new Promise(function(resolve) {
            var tx = db.transaction('tasks', 'readonly');
            var store = tx.objectStore('tasks');
            var index = store.index('status');
            var request = index.getAll(IDBKeyRange.bound(STATES.PENDING, STATES.RUNNING));
            
            request.onsuccess = function() {
                var tasks = request.result || [];
                // Sort by priority (higher first), then by creation time
                tasks.sort(function(a, b) {
                    if (b.priority !== a.priority) return b.priority - a.priority;
                    return a.createdAt - b.createdAt;
                });
                queue = tasks;
                resolve();
            };
            
            request.onerror = function() {
                resolve();
            };
        });
    }
    
    /**
     * Process next task in queue
     */
    function processNext() {
        if (isProcessing || queue.length === 0) return;
        
        // Find next pending task
        var task = queue.find(function(t) {
            return t.status === STATES.PENDING;
        });
        
        if (!task) {
            isProcessing = false;
            return;
        }
        
        isProcessing = true;
        currentTask = task;
        task.status = STATES.RUNNING;
        task.updatedAt = Date.now();
        saveTask(task);
        
        // Execute the task
        executeTask(task).then(function(result) {
            task.status = STATES.COMPLETED;
            task.result = result;
            task.updatedAt = Date.now();
            saveTask(task);
            
            currentTask = null;
            isProcessing = false;
            
            // Emit completion event
            emit('taskComplete', task);
            
            // Process next
            processNext();
        }).catch(function(error) {
            task.attempts++;
            task.error = error.message || String(error);
            task.updatedAt = Date.now();
            
            if (task.attempts >= task.maxAttempts) {
                task.status = STATES.FAILED;
                emit('taskFailed', task);
            } else {
                task.status = STATES.PENDING;
                // Re-queue with lower priority
                task.priority = Math.max(0, task.priority - 1);
            }
            
            saveTask(task);
            
            currentTask = null;
            isProcessing = false;
            
            // Process next
            processNext();
        });
    }
    
    /**
     * Execute a task
     */
    function executeTask(task) {
        return new Promise(function(resolve, reject) {
            // Route based on task type
            switch (task.type) {
                case 'chat':
                    executeChatTask(task).then(resolve).catch(reject);
                    break;
                case 'image':
                    executeImageTask(task).then(resolve).catch(reject);
                    break;
                case 'build':
                    executeBuildTask(task).then(resolve).catch(reject);
                    break;
                default:
                    reject(new Error('Unknown task type: ' + task.type));
            }
        });
    }
    
    /**
     * Execute a chat task
     */
    function executeChatTask(task) {
        return new Promise(function(resolve, reject) {
            // Use the existing chat infrastructure
            if (typeof sendMessage === 'function') {
                // Set the model/provider if specified
                if (task.model) selectedModel = task.model;
                if (task.provider) selectedProvider = task.provider;
                
                // Set the input and send
                chatInput.value = task.prompt;
                sendMessage().then(resolve).catch(reject);
            } else {
                reject(new Error('Chat system not ready'));
            }
        });
    }
    
    /**
     * Execute an image task
     */
    function executeImageTask(task) {
        return new Promise(function(resolve, reject) {
            // Use the existing image generation infrastructure
            if (typeof sendImageGeneration === 'function') {
                var controller = new AbortController();
                sendImageGeneration(task.prompt, 0, controller, {}).then(resolve).catch(reject);
            } else {
                reject(new Error('Image generation not ready'));
            }
        });
    }
    
    /**
     * Execute a build task
     */
    function executeBuildTask(task) {
        return new Promise(function(resolve, reject) {
            // Use the existing build infrastructure
            if (typeof handleBuildRoute === 'function') {
                // Build tasks are more complex, would need server-side handling
                reject(new Error('Build tasks not yet supported in queue'));
            } else {
                reject(new Error('Build system not ready'));
            }
        });
    }
    
    /**
     * Pause the current task
     */
    function pause() {
        if (currentTask) {
            currentTask.status = STATES.PAUSED;
            saveTask(currentTask);
            emit('taskPaused', currentTask);
        }
    }
    
    /**
     * Resume a paused task
     */
    function resume(taskId) {
        var task = queue.find(function(t) {
            return t.id === taskId && t.status === STATES.PAUSED;
        });
        
        if (task) {
            task.status = STATES.PENDING;
            task.updatedAt = Date.now();
            saveTask(task);
            
            if (!isProcessing) {
                processNext();
            }
        }
    }
    
    /**
     * Cancel a task
     */
    function cancel(taskId) {
        var idx = queue.findIndex(function(t) {
            return t.id === taskId;
        });
        
        if (idx !== -1) {
            var task = queue[idx];
            task.status = STATES.FAILED;
            task.error = 'Cancelled by user';
            task.updatedAt = Date.now();
            saveTask(task);
            
            emit('taskCancelled', task);
        }
    }
    
    /**
     * Get all tasks
     */
    function getAll() {
        return queue.slice();
    }
    
    /**
     * Get tasks by status
     */
    function getByStatus(status) {
        return queue.filter(function(t) {
            return t.status === status;
        });
    }
    
    /**
     * Save task to IndexedDB
     */
    function saveTask(task) {
        if (!db) return;
        
        var tx = db.transaction('tasks', 'readwrite');
        var store = tx.objectStore('tasks');
        store.put(task);
    }
    
    /**
     * Remove completed/failed tasks older than N days
     */
    function cleanup(daysToKeep) {
        var cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        
        queue = queue.filter(function(t) {
            if (t.status === STATES.COMPLETED || t.status === STATES.FAILED) {
                if (t.updatedAt < cutoff) {
                    // Remove from DB
                    if (db) {
                        var tx = db.transaction('tasks', 'readwrite');
                        tx.objectStore('tasks').delete(t.id);
                    }
                    return false;
                }
            }
            return true;
        });
    }
    
    /**
     * Generate a unique ID
     */
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }
    
    /**
     * Simple event emitter
     */
    var listeners = {};
    
    function on(event, callback) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(callback);
    }
    
    function emit(event, data) {
        if (listeners[event]) {
            listeners[event].forEach(function(cb) {
                try { cb(data); } catch (e) { console.error('Event error:', e); }
            });
        }
    }
    
    /**
     * Get queue stats
     */
    function getStats() {
        return {
            total: queue.length,
            pending: getByStatus(STATES.PENDING).length,
            running: getByStatus(STATES.RUNNING).length,
            completed: getByStatus(STATES.COMPLETED).length,
            failed: getByStatus(STATES.FAILED).length,
            paused: getByStatus(STATES.PAUSED).length,
            isProcessing: isProcessing,
            currentTask: currentTask ? currentTask.id : null
        };
    }
    
    return {
        init: init,
        add: add,
        pause: pause,
        resume: resume,
        cancel: cancel,
        getAll: getAll,
        getByStatus: getByStatus,
        cleanup: cleanup,
        getStats: getStats,
        on: on,
        STATES: STATES
    };
})();

// Auto-initialize
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
        TaskQueue.init().then(function() {
            console.log('Task queue initialized');
        });
    });
}
