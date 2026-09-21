/**
 * Auto-Failover with Task Continuation
 * When a provider fails mid-task, automatically retry with the next provider
 * and resume from where it left off
 */

var AutoFailover = (function() {
    var failoverChain = [];
    var currentIndex = 0;
    var currentTask = null;
    var isFailoverActive = false;
    var maxRetries = 3;
    var retryDelay = 1000;
    
    // Failover events
    var listeners = {};
    
    /**
     * Initialize failover chain
     */
    function init(chain) {
        failoverChain = chain || getDefaultChain();
        currentIndex = 0;
    }
    
    /**
     * Get default failover chain (free providers first)
     */
    function getDefaultChain() {
        return [
            { provider: 'nara', name: 'Nara (Free)', priority: 1 },
            { provider: 'openrouter', name: 'OpenRouter (Free)', priority: 2 },
            { provider: 'cliproxy', name: 'CLIProxyAPI', priority: 3 },
            { provider: 'kiro', name: 'Kiro Gateway', priority: 4 },
            { provider: 'puter', name: 'Puter', priority: 5 }
        ];
    }
    
    /**
     * Execute with failover
     */
    function executeWithFailover(taskFn, options) {
        options = options || {};
        currentTask = {
            id: generateId(),
            taskFn: taskFn,
            options: options,
            attempts: [],
            startTime: Date.now(),
            status: 'running'
        };
        
        isFailoverActive = true;
        currentIndex = 0;
        
        return attemptExecution();
    }
    
    /**
     * Attempt execution with current provider
     */
    function attemptExecution() {
        if (!isFailoverActive || currentIndex >= failoverChain.length) {
            // All providers failed
            currentTask.status = 'failed';
            emit('failoverComplete', {
                task: currentTask,
                success: false,
                attempts: currentTask.attempts
            });
            return Promise.reject(new Error('All providers failed'));
        }
        
        var provider = failoverChain[currentIndex];
        var attempt = {
            provider: provider.provider,
            startTime: Date.now(),
            status: 'attempting'
        };
        
        currentTask.attempts.push(attempt);
        emit('failoverAttempt', {
            task: currentTask,
            attempt: attempt,
            provider: provider
        });
        
        return Promise.resolve()
            .then(function() {
                // Call the task function with the current provider
                return currentTask.taskFn(provider, currentTask.options);
            })
            .then(function(result) {
                // Success!
                attempt.status = 'success';
                attempt.endTime = Date.now();
                attempt.duration = attempt.endTime - attempt.startTime;
                attempt.result = result;
                
                currentTask.status = 'completed';
                currentTask.result = result;
                currentTask.endTime = Date.now();
                currentTask.totalDuration = currentTask.endTime - currentTask.startTime;
                
                isFailoverActive = false;
                
                emit('failoverComplete', {
                    task: currentTask,
                    success: true,
                    result: result,
                    attempts: currentTask.attempts
                });
                
                // Record for smart selection
                if (typeof SmartModelSelect !== 'undefined') {
                    SmartModelSelect.recordResponse(
                        provider.provider,
                        currentTask.options.model || 'unknown',
                        attempt.duration,
                        true
                    );
                }
                
                return result;
            })
            .catch(function(error) {
                // Failure - try next provider
                attempt.status = 'failed';
                attempt.endTime = Date.now();
                attempt.duration = attempt.endTime - attempt.startTime;
                attempt.error = error.message || String(error);
                
                emit('failoverError', {
                    task: currentTask,
                    attempt: attempt,
                    error: error,
                    provider: provider
                });
                
                // Record failure for smart selection
                if (typeof SmartModelSelect !== 'undefined') {
                    SmartModelSelect.recordResponse(
                        provider.provider,
                        currentTask.options.model || 'unknown',
                        attempt.duration,
                        false,
                        error.message
                    );
                }
                
                // Move to next provider
                currentIndex++;
                
                // Delay before retry
                return new Promise(function(resolve) {
                    setTimeout(resolve, retryDelay);
                }).then(function() {
                    return attemptExecution();
                });
            });
    }
    
    /**
     * Execute with task continuation
     * If a task fails midway, save progress and resume with next provider
     */
    function executeWithContinuation(taskFn, options) {
        options = options || {};
        var continuationPoint = 0;
        var accumulatedResult = [];
        
        // Wrap task function to support continuation
        var wrappedTaskFn = function(provider, opts) {
            return taskFn(provider, {
                ...opts,
                continuationPoint: continuationPoint,
                previousResults: accumulatedResult
            }).then(function(result) {
                // Update continuation point
                if (result && result.continuationPoint !== undefined) {
                    continuationPoint = result.continuationPoint;
                }
                if (result && result.partialResult) {
                    accumulatedResult.push(result.partialResult);
                }
                return result;
            });
        };
        
        return executeWithFailover(wrappedTaskFn, options);
    }
    
    /**
     * Cancel current failover
     */
    function cancel() {
        isFailoverActive = false;
        if (currentTask) {
            currentTask.status = 'cancelled';
            emit('failoverCancelled', { task: currentTask });
        }
    }
    
    /**
     * Get current status
     */
    function getStatus() {
        return {
            isActive: isFailoverActive,
            currentProvider: currentIndex < failoverChain.length ? failoverChain[currentIndex] : null,
            attempts: currentTask ? currentTask.attempts.length : 0,
            maxRetries: failoverChain.length,
            task: currentTask
        };
    }
    
    /**
     * Generate unique ID
     */
    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }
    
    /**
     * Simple event emitter
     */
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
     * Update failover chain
     */
    function setChain(chain) {
        failoverChain = chain;
        currentIndex = 0;
    }
    
    /**
     * Get failover history
     */
    function getHistory() {
        // This would be persisted to IndexedDB in production
        return [];
    }
    
    return {
        init: init,
        executeWithFailover: executeWithFailover,
        executeWithContinuation: executeWithContinuation,
        cancel: cancel,
        getStatus: getStatus,
        setChain: setChain,
        getHistory: getHistory,
        on: on
    };
})();

// Auto-initialize with default chain
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
        AutoFailover.init();
    });
}
