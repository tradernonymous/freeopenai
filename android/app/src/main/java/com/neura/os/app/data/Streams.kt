package com.neura.os.app.data

import com.neura.os.app.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.CoroutineContext

// Cold streams over the blocking readers in NativeApi (docs/android-master-plan.md
// §3.1, V3). Collecting one opens the connection; cancelling the collector --
// Stop, leaving the build screen, the view model going away -- closes it, which
// is also what ends the blocking read. Nothing here keeps a scope.

/** Runs [read] on [dispatcher] and delivers what it emits as a Flow. [read]
 * puts its connection in the handle it is given; the flow disconnects it when
 * the collector goes away, and clears the handle first, so the reader can
 * tell a Stop (handle empty) from a dropped line (handle still set). An
 * exception from [read] fails the flow. */
fun <T> connectionFlow(
    dispatcher: CoroutineContext = Dispatchers.IO,
    read: (handle: AtomicReference<HttpURLConnection?>, emit: (T) -> Unit) -> Unit,
): Flow<T> = callbackFlow {
    val handle = AtomicReference<HttpURLConnection?>(null)
    launch(dispatcher) {
        try {
            read(handle) { value ->
                // Stopped before the reader had put its connection in the
                // handle: the first thing it hands over closes it instead.
                if (trySend(value).isClosed) handle.getAndSet(null)?.disconnect()
            }
            close()
        } catch (e: Throwable) {
            close(e)
        }
    }
    awaitClose { handle.getAndSet(null)?.disconnect() }
}.buffer(Channel.UNLIMITED) // a reader never waits on the screen

/** What a resumable stream says: an item, or how the line is doing. */
sealed interface StreamUpdate<out T> {
    data class Item<T>(val value: T) : StreamUpdate<T>
    /** The line dropped; trying again after a pause ([attempt] from 1). */
    data class Reconnecting(val attempt: Int) : StreamUpdate<Nothing>
    /** Gave up after too many drops in a row. The flow ends after this. */
    data object Offline : StreamUpdate<Nothing>
}

/** The pause before reconnect [attempt] (1-based): 1 s, 2 s, 4 s … capped at 15 s. */
fun reconnectDelayMs(attempt: Int): Long = minOf(1000L shl (attempt - 1).coerceIn(0, 4), 15_000L)

/** Follows a stream that can be resumed from a position: [open] starts it
 * after position `after`, [positionOf] says where an item sits. A drop (an
 * [ApiException]) reconnects from the last position seen after
 * [reconnectDelayMs]; an item resets the count; more than [maxReconnects]
 * drops in a row ends with [StreamUpdate.Offline]. The flow completes when a
 * stream ends normally. Other failures, and cancellation, pass through. */
fun <T> resumable(
    maxReconnects: Int,
    positionOf: (T) -> Long,
    pause: (Int) -> Long = ::reconnectDelayMs,
    open: (after: Long) -> Flow<T>,
): Flow<StreamUpdate<T>> = flow {
    var after = 0L
    var failures = 0
    while (true) {
        try {
            open(after).collect { item ->
                after = maxOf(after, positionOf(item))
                failures = 0
                emit(StreamUpdate.Item(item))
            }
            return@flow
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            failures++
            if (failures > maxReconnects) {
                emit(StreamUpdate.Offline)
                return@flow
            }
            emit(StreamUpdate.Reconnecting(failures))
            delay(pause(failures))
        }
    }
}
