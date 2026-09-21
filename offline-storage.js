/**
 * Offline Storage Module
 * IndexedDB integration for caching chats, messages, and settings
 */

var OfflineStorage = (function() {
  var DB_NAME = 'neuraos-offline';
  var DB_VERSION = 1;
  var db = null;
  
  function init() {
    return new Promise(function(resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = function() {
        console.warn('IndexedDB not available, offline storage disabled');
        resolve(null);
      };
      
      request.onupgradeneeded = function(event) {
        var database = event.target.result;
        
        // Conversations store
        if (!database.objectStoreNames.contains('conversations')) {
          var convStore = database.createObjectStore('conversations', { keyPath: 'id' });
          convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          convStore.createIndex('userId', 'userId', { unique: false });
        }
        
        // Messages store
        if (!database.objectStoreNames.contains('messages')) {
          var msgStore = database.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('conversationId', 'conversationId', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Settings store
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings', { keyPath: 'key' });
        }
        
        // Sync queue for offline changes
        if (!database.objectStoreNames.contains('syncQueue')) {
          var syncStore = database.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
          syncStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      
      request.onsuccess = function(event) {
        db = event.target.result;
        resolve(db);
      };
    });
  }
  
  /**
   * Save a conversation for offline access
   */
  function saveConversation(conversation) {
    if (!db) return Promise.resolve();
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('conversations', 'readwrite');
      var store = tx.objectStore('conversations');
      
      var data = {
        id: conversation.id,
        title: conversation.title || 'Untitled',
        messages: conversation.messages || [],
        updatedAt: Date.now(),
        userId: conversation.userId || null,
        model: conversation.model || null,
        provider: conversation.provider || null
      };
      
      store.put(data);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }
  
  /**
   * Get a conversation from offline storage
   */
  function getConversation(id) {
    if (!db) return Promise.resolve(null);
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('conversations', 'readonly');
      var store = tx.objectStore('conversations');
      var request = store.get(id);
      
      request.onsuccess = function() {
        resolve(request.result || null);
      };
      request.onerror = function() {
        resolve(null);
      };
    });
  }
  
  /**
   * Get all conversations (sorted by updatedAt)
   */
  function getAllConversations() {
    if (!db) return Promise.resolve([]);
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('conversations', 'readonly');
      var store = tx.objectStore('conversations');
      var index = store.index('updatedAt');
      var request = index.openCursor(null, 'prev'); // newest first
      
      var results = [];
      
      request.onsuccess = function(event) {
        var cursor = event.target.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      
      request.onerror = function() {
        resolve([]);
      };
    });
  }
  
  /**
   * Save a single message
   */
  function saveMessage(message) {
    if (!db) return Promise.resolve();
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('messages', 'readwrite');
      var store = tx.objectStore('messages');
      
      store.put({
        id: message.id || generateId(),
        conversationId: message.conversationId,
        type: message.type,
        content: message.content,
        timestamp: message.timestamp || Date.now(),
        model: message.model || null,
        provider: message.provider || null
      });
      
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }
  
  /**
   * Get messages for a conversation
   */
  function getMessages(conversationId) {
    if (!db) return Promise.resolve([]);
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('messages', 'readonly');
      var store = tx.objectStore('messages');
      var index = store.index('conversationId');
      var request = index.getAll(conversationId);
      
      request.onsuccess = function() {
        var messages = request.result || [];
        messages.sort(function(a, b) { return a.timestamp - b.timestamp; });
        resolve(messages);
      };
      
      request.onerror = function() {
        resolve([]);
      };
    });
  }
  
  /**
   * Save a setting
   */
  function saveSetting(key, value) {
    if (!db) return Promise.resolve();
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('settings', 'readwrite');
      var store = tx.objectStore('settings');
      
      store.put({ key: key, value: value, updatedAt: Date.now() });
      
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }
  
  /**
   * Get a setting
   */
  function getSetting(key) {
    if (!db) return Promise.resolve(null);
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('settings', 'readonly');
      var store = tx.objectStore('settings');
      var request = store.get(key);
      
      request.onsuccess = function() {
        resolve(request.result ? request.result.value : null);
      };
      request.onerror = function() {
        resolve(null);
      };
    });
  }
  
  /**
   * Add to sync queue (for offline changes that need syncing)
   */
  function addToSyncQueue(action) {
    if (!db) return Promise.resolve();
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('syncQueue', 'readwrite');
      var store = tx.objectStore('syncQueue');
      
      store.add({
        action: action.type,
        data: action.data,
        timestamp: Date.now(),
        synced: false
      });
      
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }
  
  /**
   * Get pending sync items
   */
  function getPendingSync() {
    if (!db) return Promise.resolve([]);
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('syncQueue', 'readonly');
      var store = tx.objectStore('syncQueue');
      var request = store.getAll();
      
      request.onsuccess = function() {
        var items = (request.result || []).filter(function(item) {
          return !item.synced;
        });
        resolve(items);
      };
      
      request.onerror = function() {
        resolve([]);
      };
    });
  }
  
  /**
   * Mark sync item as synced
   */
  function markSynced(id) {
    if (!db) return Promise.resolve();
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('syncQueue', 'readwrite');
      var store = tx.objectStore('syncQueue');
      var request = store.get(id);
      
      request.onsuccess = function() {
        var item = request.result;
        if (item) {
          item.synced = true;
          store.put(item);
        }
      };
      
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }
  
  /**
   * Clear old data (keep last N days)
   */
  function clearOldData(daysToKeep) {
    if (!db) return Promise.resolve();
    
    var cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(['conversations', 'messages'], 'readwrite');
      var convStore = tx.objectStore('conversations');
      var msgStore = tx.objectStore('messages');
      
      // Clear old conversations
      var convIndex = convStore.index('updatedAt');
      var convRequest = convIndex.openCursor(IDBKeyRange.upperBound(cutoff));
      
      convRequest.onsuccess = function(event) {
        var cursor = event.target.result;
        if (cursor) {
          convStore.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      
      // Clear old messages
      var msgIndex = msgStore.index('timestamp');
      var msgRequest = msgIndex.openCursor(IDBKeyRange.upperBound(cutoff));
      
      msgRequest.onsuccess = function(event) {
        var cursor = event.target.result;
        if (cursor) {
          msgStore.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }
  
  /**
   * Generate a simple ID
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }
  
  /**
   * Check if offline storage is available
   */
  function isAvailable() {
    return typeof indexedDB !== 'undefined' && db !== null;
  }
  
  return {
    init: init,
    saveConversation: saveConversation,
    getConversation: getConversation,
    getAllConversations: getAllConversations,
    saveMessage: saveMessage,
    getMessages: getMessages,
    saveSetting: saveSetting,
    getSetting: getSetting,
    addToSyncQueue: addToSyncQueue,
    getPendingSync: getPendingSync,
    markSynced: markSynced,
    clearOldData: clearOldData,
    isAvailable: isAvailable
  };
})();

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function() {
    OfflineStorage.init().then(function(db) {
      if (db) {
        console.log('Offline storage initialized');
        // Sync pending changes when online
        window.addEventListener('online', syncPendingChanges);
      }
    });
  });
}

/**
 * Sync pending offline changes when back online
 */
function syncPendingChanges() {
  OfflineStorage.getPendingSync().then(function(items) {
    items.forEach(function(item) {
      // Here you would send the change to the server
      // For now, just mark as synced
      OfflineStorage.markSynced(item.id);
    });
  });
}
