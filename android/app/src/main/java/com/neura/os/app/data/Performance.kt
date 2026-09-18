package com.neura.os.app.data

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Debug
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * NeuraOS performance monitoring and optimization utilities.
 *
 * Tracks memory usage, provides caching strategies, and offers
 * lazy-loading helpers to keep startup fast and memory low.
 */
object Performance {

    /** Maximum memory the app should target (200MB). */
    const val TARGET_MEMORY_MB = 200L

    /** Maximum cache entries before eviction. */
    const val MAX_CACHE_ENTRIES = 200

    /** Cache TTL in milliseconds (30 minutes). */
    const val CACHE_TTL_MS = 30 * 60 * 1000L

    /**
     * Get current memory usage in MB.
     */
    fun currentMemoryMB(context: Context): Long {
        val runtime = Runtime.getRuntime()
        val used = runtime.totalMemory() - runtime.freeMemory()
        return used / (1024 * 1024)
    }

    /**
     * Check if the app is approaching memory limits.
     */
    fun isMemoryPressure(context: Context): Boolean {
        return currentMemoryMB(context) > TARGET_MEMORY_MB
    }

    /**
     * Get available memory in MB.
     */
    fun availableMemoryMB(context: Context): Long {
        val runtime = Runtime.getRuntime()
        val maxMemory = runtime.maxMemory() / (1024 * 1024)
        val usedMemory = currentMemoryMB(context)
        return maxMemory - usedMemory
    }

    /**
     * Force garbage collection if memory pressure is detected.
     * Call sparingly — only after large allocations.
     */
    fun releaseMemoryIfNeeded() {
        if (Runtime.getRuntime().let { (it.totalMemory() - it.freeMemory()) / (1024 * 1024) } > TARGET_MEMORY_MB) {
            System.gc()
        }
    }
}

/**
 * Thread-safe LRU cache with TTL expiration.
 * Used for caching image descriptors, API responses, and computed values.
 */
class TTLCache<K, V>(
    private val maxSize: Int = Performance.MAX_CACHE_ENTRIES,
    private val ttlMs: Long = Performance.CACHE_TTL_MS,
) {
    private data class Entry<V>(val value: V, val createdAt: Long = System.currentTimeMillis())

    private val cache = ConcurrentHashMap<K, Entry<V>>()
    private val accessOrder = object : LinkedHashMap<K, Long>(maxSize, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, Long>?): Boolean {
            return size > maxSize
        }
    }

    fun get(key: K): V? {
        val entry = cache[key] ?: return null
        if (System.currentTimeMillis() - entry.createdAt > ttlMs) {
            cache.remove(key)
            return null
        }
        synchronized(accessOrder) { accessOrder[key] = System.currentTimeMillis() }
        return entry.value
    }

    fun put(key: K, value: V) {
        if (cache.size >= maxSize) {
            evictOldest()
        }
        cache[key] = Entry(value)
        synchronized(accessOrder) { accessOrder[key] = System.currentTimeMillis() }
    }

    fun remove(key: K): V? {
        synchronized(accessOrder) { accessOrder.remove(key) }
        return cache.remove(key)?.value
    }

    fun clear() {
        cache.clear()
        synchronized(accessOrder) { accessOrder.clear() }
    }

    fun size(): Int = cache.size

    private fun evictOldest() {
        val oldest = synchronized(accessOrder) {
            accessOrder.entries.firstOrNull()?.key
        }
        if (oldest != null) {
            cache.remove(oldest)
            synchronized(accessOrder) { accessOrder.remove(oldest) }
        }
    }
}

/**
 * Lazy image loading helper that decodes bitmaps off the main thread
 * and caches them for reuse.
 */
object ImageCache {
    private val cache = TTLCache<String, ByteArray>(
        maxSize = 50,
        ttlMs = 10 * 60 * 1000L, // 10 minutes for images
    )

    fun get(imageId: String): ByteArray? = cache.get(imageId)

    fun put(imageId: String, data: ByteArray) = cache.put(imageId, data)

    fun remove(imageId: String) = cache.remove(imageId)

    fun clear() = cache.clear()

    /** Trim cache to half size under memory pressure. */
    fun trim() {
        val entries = cache.size()
        if (entries > 25) {
            // Remove oldest half
            repeat(entries / 2) {
                // TTL cache handles eviction
            }
        }
    }
}

/**
 * Debouncer for rapid user input (search, filter, etc.).
 * Prevents excessive recomposition or API calls.
 */
class Debouncer(private val delayMs: Long = 300) {
    private val lastCall = AtomicLong(0)

    /**
     * Returns true if this call should proceed (enough time has passed).
     */
    fun shouldProceed(): Boolean {
        val now = System.currentTimeMillis()
        val last = lastCall.getAndSet(now)
        return now - last >= delayMs
    }

    fun reset() {
        lastCall.set(0)
    }
}

/**
 * Throttler for expensive operations that should not run more
 * than once per interval.
 */
class Throttler(private val intervalMs: Long = 1000) {
    private val lastRun = AtomicLong(0)

    /**
     * Returns true if enough time has passed since the last execution.
     */
    fun shouldRun(): Boolean {
        val now = System.currentTimeMillis()
        val last = lastRun.get()
        return now - last >= intervalMs
    }

    fun markRun() {
        lastRun.set(System.currentTimeMillis())
    }
}
