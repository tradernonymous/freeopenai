package com.neura.os.app.data

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/** Runs [save] for the latest value queued per key: never two saves for the
 * same key running at once, and never an older value written after a newer
 * one. A periodic save and an end-of-turn save racing for the same chat
 * used to be able to land in either order -- a coroutine pool does not run
 * jobs in the order they were launched -- so the stale, periodic write
 * could overwrite the finished reply on disk. Queuing while a save for that
 * key is already running just replaces the pending value; the running
 * save's own loop picks it up before it stops, so [queue] never needs to
 * start a second loop for a busy key. */
class CoalescingSaver<K : Any, V : Any>(
    private val scope: CoroutineScope,
    private val dispatcher: CoroutineDispatcher,
    private val save: suspend (V) -> Unit,
) {
    private val pending = ConcurrentHashMap<K, V>()
    private val running = ConcurrentHashMap.newKeySet<K>()

    fun queue(key: K, value: V) {
        pending[key] = value
        drain(key)
    }

    private fun drain(key: K) {
        if (!running.add(key)) return
        scope.launch(dispatcher) {
            try {
                while (true) {
                    val next = pending.remove(key) ?: break
                    save(next)
                }
            } finally {
                running.remove(key)
            }
            // A value queued between this loop's last empty check and
            // running.remove(key) above would see the key still marked
            // busy and skip starting a new loop; pick it up here.
            if (pending.containsKey(key)) drain(key)
        }
    }
}
