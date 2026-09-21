/**
 * Smart Model Selection
 * Auto-picks the best available model based on provider health, latency, and limits
 */

var SmartModelSelect = (function() {
    var providerHealth = {};
    var modelLatency = {};
    var modelLimits = {};
    var selectionHistory = [];
    var maxHistory = 100;
    
    /**
     * Initialize with provider data
     */
    function init() {
        // Load saved health data
        loadHealthData();
        
        // Start monitoring
        startMonitoring();
    }
    
    /**
     * Record provider response
     */
    function recordResponse(provider, model, latencyMs, success, error) {
        // Update latency tracking
        if (!modelLatency[model]) {
            modelLatency[model] = { samples: [], avg: 0, p95: 0 };
        }
        
        var samples = modelLatency[model].samples;
        samples.push({ latency: latencyMs, success: success, time: Date.now() });
        
        // Keep last 50 samples
        if (samples.length > 50) samples.shift();
        
        // Calculate stats
        var successfulSamples = samples.filter(function(s) { return s.success; });
        if (successfulSamples.length > 0) {
            var latencies = successfulSamples.map(function(s) { return s.latency; });
            modelLatency[model].avg = latencies.reduce(function(a, b) { return a + b; }, 0) / latencies.length;
            latencies.sort(function(a, b) { return a - b; });
            modelLatency[model].p95 = latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1];
        }
        
        // Update provider health
        if (!providerHealth[provider]) {
            providerHealth[provider] = { success: 0, fail: 0, lastFail: 0 };
        }
        
        if (success) {
            providerHealth[provider].success++;
        } else {
            providerHealth[provider].fail++;
            providerHealth[provider].lastFail = Date.now();
        }
        
        // Record in history
        selectionHistory.push({
            provider: provider,
            model: model,
            latency: latencyMs,
            success: success,
            error: error,
            time: Date.now()
        });
        
        if (selectionHistory.length > maxHistory) selectionHistory.shift();
        
        // Save health data
        saveHealthData();
    }
    
    /**
     * Get best model for a task
     */
    function selectModel(options) {
        options = options || {};
        var taskType = options.taskType || 'chat';
        var requireVision = options.requireVision || false;
        var preferFree = options.preferFree !== false; // Default true
        
        // Get available models from the existing model list
        var availableModels = getAvailableModels();
        
        // Filter by requirements
        var candidates = availableModels.filter(function(m) {
            if (requireVision && !m.vision) return false;
            if (preferFree && !m.free) return false;
            return true;
        });
        
        // If no free models, allow paid
        if (candidates.length === 0 && preferFree) {
            candidates = availableModels.filter(function(m) {
                if (requireVision && !m.vision) return false;
                return true;
            });
        }
        
        // Score each candidate
        var scored = candidates.map(function(m) {
            return {
                model: m,
                score: scoreModel(m, taskType)
            };
        });
        
        // Sort by score (higher is better)
        scored.sort(function(a, b) { return b.score - a.score; });
        
        if (scored.length === 0) {
            return null;
        }
        
        return scored[0].model;
    }
    
    /**
     * Score a model for selection
     */
    function scoreModel(model, taskType) {
        var score = 100; // Base score
        
        // Latency penalty (lower is better)
        var latency = modelLatency[model.id];
        if (latency) {
            // Penalize high latency
            if (latency.avg > 5000) score -= 30;
            else if (latency.avg > 2000) score -= 15;
            else if (latency.avg > 1000) score -= 5;
            
            // Penalize high p95 (inconsistency)
            if (latency.p95 > latency.avg * 2) score -= 10;
        }
        
        // Provider health bonus/penalty
        var provider = model.provider;
        if (providerHealth[provider]) {
            var health = providerHealth[provider];
            var total = health.success + health.fail;
            if (total > 0) {
                var successRate = health.success / total;
                if (successRate > 0.95) score += 10;
                else if (successRate > 0.8) score += 5;
                else if (successRate < 0.5) score -= 20;
                
                // Penalize recently failed providers
                if (health.lastFail > Date.now() - 60000) {
                    score -= 15;
                }
            }
        }
        
        // Free tier bonus
        if (model.free) score += 5;
        
        // Model capability bonus for task type
        if (taskType === 'code' && model.capabilities && model.capabilities.includes('code')) {
            score += 10;
        }
        if (taskType === 'creative' && model.capabilities && model.capabilities.includes('creative')) {
            score += 10;
        }
        
        // Recency penalty (prefer less recently used models for diversity)
        var recentUse = selectionHistory.filter(function(h) {
            return h.model === model.id && h.time > Date.now() - 300000; // Last 5 minutes
        }).length;
        score -= recentUse * 2;
        
        return score;
    }
    
    /**
     * Get available models (wrapper around existing model list)
     */
    function getAvailableModels() {
        // This would integrate with the existing model catalogue
        // For now, return a basic list
        if (typeof MODELS !== 'undefined') {
            return Object.keys(MODELS).map(function(id) {
                return {
                    id: id,
                    provider: MODELS[id].provider || 'unknown',
                    free: MODELS[id].free || false,
                    vision: MODELS[id].vision || false,
                    capabilities: MODELS[id].capabilities || []
                };
            });
        }
        
        // Fallback: read from picker
        var models = [];
        var modelOptions = document.querySelectorAll('.model-option, .model-card');
        modelOptions.forEach(function(el) {
            var id = el.dataset.modelId || el.textContent.trim();
            models.push({
                id: id,
                provider: el.dataset.provider || 'unknown',
                free: el.classList.contains('free') || el.dataset.free === 'true',
                vision: el.dataset.vision === 'true',
                capabilities: (el.dataset.capabilities || '').split(',')
            });
        });
        
        return models;
    }
    
    /**
     * Get model recommendations
     */
    function getRecommendations(taskType) {
        var models = getAvailableModels();
        var scored = models.map(function(m) {
            return {
                model: m,
                score: scoreModel(m, taskType),
                reasons: getScoreReasons(m, taskType)
            };
        });
        
        scored.sort(function(a, b) { return b.score - a.score; });
        
        return scored.slice(0, 5);
    }
    
    /**
     * Get scoring reasons for explanation
     */
    function getScoreReasons(model, taskType) {
        var reasons = [];
        
        var latency = modelLatency[model.id];
        if (latency) {
            if (latency.avg < 1000) reasons.push('Fast response');
            else if (latency.avg > 3000) reasons.push('Slow response');
        }
        
        var health = providerHealth[model.provider];
        if (health) {
            var total = health.success + health.fail;
            if (total > 0) {
                var successRate = health.success / total;
                if (successRate > 0.95) reasons.push('Highly reliable');
                else if (successRate < 0.7) reasons.push('Unreliable');
            }
        }
        
        if (model.free) reasons.push('Free tier');
        
        return reasons;
    }
    
    /**
     * Load health data from localStorage
     */
    function loadHealthData() {
        try {
            var saved = localStorage.getItem('neuraos-model-health');
            if (saved) {
                var data = JSON.parse(saved);
                providerHealth = data.providerHealth || {};
                modelLatency = data.modelLatency || {};
            }
        } catch (e) {
            console.warn('Failed to load model health data');
        }
    }
    
    /**
     * Save health data to localStorage
     */
    function saveHealthData() {
        try {
            localStorage.setItem('neuraos-model-health', JSON.stringify({
                providerHealth: providerHealth,
                modelLatency: modelLatency,
                savedAt: Date.now()
            }));
        } catch (e) {
            console.warn('Failed to save model health data');
        }
    }
    
    /**
     * Start monitoring (periodic health checks)
     */
    function startMonitoring() {
        // Clean old data every hour
        setInterval(function() {
            cleanOldData();
        }, 3600000);
    }
    
    /**
     * Clean old health data
     */
    function cleanOldData() {
        var cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
        
        // Clean latency samples
        Object.keys(modelLatency).forEach(function(model) {
            var samples = modelLatency[model].samples;
            modelLatency[model].samples = samples.filter(function(s) {
                return s.time > cutoff;
            });
        });
        
        // Clean selection history
        selectionHistory = selectionHistory.filter(function(h) {
            return h.time > cutoff;
        });
        
        saveHealthData();
    }
    
    /**
     * Get health dashboard data
     */
    function getHealthDashboard() {
        var dashboard = {
            providers: {},
            models: {},
            history: selectionHistory.slice(-20)
        };
        
        // Provider health summary
        Object.keys(providerHealth).forEach(function(provider) {
            var health = providerHealth[provider];
            var total = health.success + health.fail;
            dashboard.providers[provider] = {
                successRate: total > 0 ? (health.success / total * 100).toFixed(1) + '%' : 'N/A',
                totalRequests: total,
                lastFail: health.lastFail ? new Date(health.lastFail).toISOString() : null
            };
        });
        
        // Model latency summary
        Object.keys(modelLatency).forEach(function(model) {
            dashboard.models[model] = {
                avgLatency: Math.round(modelLatency[model].avg) + 'ms',
                p95Latency: Math.round(modelLatency[model].p95) + 'ms',
                samples: modelLatency[model].samples.length
            };
        });
        
        return dashboard;
    }
    
    return {
        init: init,
        recordResponse: recordResponse,
        selectModel: selectModel,
        getRecommendations: getRecommendations,
        getHealthDashboard: getHealthDashboard
    };
})();

// Auto-initialize
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
        SmartModelSelect.init();
    });
}
