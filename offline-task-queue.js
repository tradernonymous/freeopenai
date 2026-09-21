/**
 * Offline Task Queue
 * Queue tasks when offline and execute when back online
 */

var OfflineTaskQueue = (function() {
    var DB_NAME = 'neuraos-offline-tasks';
    var DB_VERSION = 1;
    var db = null;
    var queue = [];
    var isOnline = true;
    var syncInterval = null;
    
    /**
     * Initialize
     */
    function init() {
        // Check online status
        isOnline = navigator.onLine;
        
        // Listen for online/offline events
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        
        // Open IndexedDB
        return openDB().then(function() {
            return loadQueue();
        }).then(function() {
            // Start sync interval
            startSyncInterval();
            
            // Try to sync if online
            if (isOnline) {
                syncQueue();
            }
        });
    }
    
    /**
     * Open IndexedDB
     */
    function openDB() {
        return new Promise(function(resolve, reject) {
            if (typeof indexedDB === 'undefined') {
                console.warn('IndexedDB not available');
                resolve();
                return;
            }
            
            var request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onerror = function() {
                console.warn('Failed to open offline tasks DB');
                resolve();
            };
            
            request.onupgradeneeded = function(event) {
                var database = event.target.result;
                if (!database.objectStoreNames.contains('tasks')) {
                    var store = database.createObjectStore('tasks', { keyPath: 'id' });
                    store.createIndex('status', 'status', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
            
            request.onsuccess = function(event) {
                db = event.target.result;
                resolve();
            };
        });
    }
    
    /**
     * Load queue from IndexedDB
     */
    function loadQueue() {
        if (!db) return Promise.resolve();
        
        return new Promise(function(resolve) {
            var tx = db.transaction('tasks', 'readonly');
            var store = tx.objectStore('tasks');
            var request = store.getAll();
            
            request.onsuccess = function() {
                queue = request.result || [];
                // Sort by creation time
                queue.sort(function(a, b) { return a.createdAt - b.createdAt; });
                resolve();
            };
            
            request.onerror = function() {
                resolve();
            };
        });
    }
    
    /**
     * Add task to offline queue
     */
    function add(task) {
        var taskObj = {
            id: generateId(),
            type: task.type || 'chat',
            data: task.data,
            status: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            attempts: 0,
            maxAttempts: task.maxAttempts || 3,
            result: null,
            error: null
        };
        
        queue.push(taskObj);
        saveTask(taskObj);
        
        // Try to sync if online
        if (isOnline) {
            syncQueue();
        }
        
        return taskObj.id;
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
     * Delete task from IndexedDB
     */
    function deleteTask(taskId) {
        if (!db) return;
        
        var tx = db.transaction('tasks', 'readwrite');
        var store = tx.objectStore('tasks');
        store.delete(taskId);
        
        queue = queue.filter(function(t) { return t.id !== taskId; });
    }
    
    /**
     * Handle going online
     */
    function handleOnline() {
        isOnline = true;
        console.log('Back online, syncing tasks...');
        syncQueue();
    }
    
    /**
     * Handle going offline
     */
    function handleOffline() {
        isOnline = false;
        console.log('Went offline, tasks will be queued');
    }
    
    /**
     * Sync queue with server
     */
    function syncQueue() {
        if (!isOnline) return;
        
        var pendingTasks = queue.filter(function(t) {
            return t.status === 'pending';
        });
        
        if (pendingTasks.length === 0) return;
        
        console.log('Syncing ' + pendingTasks.length + ' offline tasks...');
        
        // Process each task
        Promise.all(pendingTasks.map(function(task) {
            return processTask(task);
        })).then(function() {
            console.log('Offline tasks synced');
        }).catch(function(error) {
            console.error('Failed to sync offline tasks:', error);
        });
    }
    
    /**
     * Process a single task
     */
    function processTask(task) {
        task.status = 'processing';
        task.updatedAt = Date.now();
        saveTask(task);
        
        return executeTask(task).then(function(result) {
            task.status = 'completed';
            task.result = result;
            task.updatedAt = Date.now();
            saveTask(task);
            
            // Delete after successful completion
            setTimeout(function() {
                deleteTask(task.id);
            }, 5000);
            
            return result;
        }).catch(function(error) {
            task.attempts++;
            task.error = error.message || String(error);
            task.updatedAt = Date.now();
            
            if (task.attempts >= task.maxAttempts) {
                task.status = 'failed';
            } else {
                task.status = 'pending';
            }
            
            saveTask(task);
            throw error;
        });
    }
    
    /**
     * Execute task
     */
    function executeTask(task) {
        return new Promise(function(resolve, reject) {
            // Route based on task type
            switch (task.type) {
                case 'chat':
                    executeChatTask(task.data).then(resolve).catch(reject);
                    break;
                case 'comment':
                    executeCommentTask(task.data).then(resolve).catch(reject);
                    break;
                case 'fork':
                    executeForkTask(task.data).then(resolve).catch(reject);
                    break;
                default:
                    reject(new Error('Unknown task type: ' + task.type));
            }
        });
    }
    
    /**
     * Execute chat task
     */
    function executeChatTask(data) {
        return fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(function(res) {
            if (!res.ok) throw new Error('Chat request failed');
            return res.json();
        });
    }
    
    /**
     * Execute comment task
     */
    function executeCommentTask(data) {
        return fetch('/api/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(function(res) {
            if (!res.ok) throw new Error('Comment request failed');
            return res.json();
        });
    }
    
    /**
     * Execute fork task
     */
    function executeForkTask(data) {
        return fetch('/api/fork', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(function(res) {
            if (!res.ok) throw new Error('Fork request failed');
            return res.json();
        });
    }
    
    /**
     * Start sync interval
     */
    function startSyncInterval() {
        if (syncInterval) clearInterval(syncInterval);
        
        syncInterval = setInterval(function() {
            if (isOnline) {
                syncQueue();
            }
        }, 30000); // Every 30 seconds
    }
    
    /**
     * Stop sync interval
     */
    function stopSyncInterval() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }
    
    /**
     * Get queue status
     */
    function getStatus() {
        return {
            isOnline: isOnline,
            pending: queue.filter(function(t) { return t.status === 'pending'; }).length,
            processing: queue.filter(function(t) { return t.status === 'processing'; }).length,
            completed: queue.filter(function(t) { return t.status === 'completed'; }).length,
            failed: queue.filter(function(t) { return t.status === 'failed'; }).length,
            total: queue.length
        };
    }
    
    /**
     * Get all tasks
     */
    function getAll() {
        return queue.slice();
    }
    
    /**
     * Clear completed tasks
     */
    function clearCompleted() {
        var completed = queue.filter(function(t) {
            return t.status === 'completed' || t.status === 'failed';
        });
        
        completed.forEach(function(t) {
            deleteTask(t.id);
        });
    }
    
    /**
     * Generate unique ID
     */
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }
    
    /**
     * Cleanup
     */
    function destroy() {
        stopSyncInterval();
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
    }
    
    return {
        init: init,
        add: add,
        getAll: getAll,
        getStatus: getStatus,
        clearCompleted: clearCompleted,
        syncQueue: syncQueue,
        destroy: destroy
    };
})();

// Auto-initialize
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
        OfflineTaskQueue.init().then(function() {
            console.log('Offline task queue initialized');
        });
    });
}
