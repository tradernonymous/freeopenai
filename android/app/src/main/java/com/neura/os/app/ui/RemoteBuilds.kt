package com.neura.os.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.neura.os.app.ApiException
import com.neura.os.app.data.BuildEvent
import com.neura.os.app.data.BuildList
import com.neura.os.app.data.BuildSession
import com.neura.os.app.data.NativeApi
import com.neura.os.app.data.applyBuildEvent
import java.net.HttpURLConnection
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/** A build is waiting on the user: shown as a notification when the app is in
 * the background. [requestId] is the dedup key, so one question notifies once. */
data class BuildAttention(val buildId: String, val requestId: String, val text: String)

/** State for remote builds, kept out of AppViewModel so the chat code stays
 * untouched. Network work runs on two single threads (one for requests, one for
 * the live stream); every Compose state write is posted to the main thread. */
class RemoteBuilds(private val api: NativeApi, private val post: (() -> Unit) -> Unit) {
    private val io = Executors.newSingleThreadExecutor()
    private val streamIo = Executors.newSingleThreadExecutor()
    private val stream = AtomicReference<HttpURLConnection?>(null)
    @Volatile private var watching: String? = null
    private var lastApplied = 0L

    var list by mutableStateOf<BuildList?>(null)
        private set
    var listBusy by mutableStateOf(false)
        private set
    var listError by mutableStateOf<String?>(null)
        private set
    var current by mutableStateOf<BuildSession?>(null)
        private set
    /** What happened, in order: messages, command output, diffs, answers, the end. */
    val timeline = mutableStateListOf<BuildEvent>()
    /** Empty while connected; a short line while reconnecting or offline. */
    var connection by mutableStateOf("")
        private set
    var actionBusy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    var attention by mutableStateOf<BuildAttention?>(null)
        private set

    val waitingCount: Int get() = list?.sessions?.count { it.waiting } ?: 0

    fun refresh() {
        listBusy = true
        io.execute {
            try {
                val fresh = api.builds()
                post {
                    list = fresh
                    listError = null
                    listBusy = false
                }
            } catch (e: ApiException) {
                post {
                    listError = e.message
                    listBusy = false
                }
            }
        }
    }

    fun start(chatId: String, plan: String, onStarted: () -> Unit, onFailed: (String) -> Unit) {
        actionBusy = true
        error = null
        io.execute {
            try {
                val session = api.startBuild(chatId, plan)
                post {
                    actionBusy = false
                    show(session)
                    onStarted()
                }
            } catch (e: ApiException) {
                post {
                    actionBusy = false
                    onFailed(e.message ?: "Could not start the build.")
                }
            }
        }
    }

    fun open(id: String) {
        error = null
        list?.sessions?.firstOrNull { it.id == id }?.let { if (current?.id != id) current = it }
        io.execute {
            try {
                val session = api.build(id)
                post { show(session) }
            } catch (e: ApiException) {
                post { error = e.message }
            }
        }
    }

    /** Approve or reject the pending change ([decision]), or answer a question (null). */
    fun answer(decision: String?, text: String) {
        val session = current ?: return
        val pending = session.pending ?: return
        actionBusy = true
        error = null
        io.execute {
            try {
                api.answerBuild(session.id, pending.requestId, decision, text)
                post {
                    actionBusy = false
                    // The stream may already have delivered the next question;
                    // only the answered one is cleared here.
                    val now = current
                    if (now != null && now.pending?.requestId == pending.requestId) current = now.copy(pending = null)
                }
            } catch (e: ApiException) {
                post {
                    actionBusy = false
                    error = e.message
                    open(session.id)
                }
            }
        }
    }

    fun cancel() {
        val session = current ?: return
        actionBusy = true
        io.execute {
            try {
                val updated = api.cancelBuild(session.id)
                post {
                    actionBusy = false
                    val now = current
                    if (now != null && now.id == updated.id) current = now.copy(status = updated.status, pending = null)
                }
            } catch (e: ApiException) {
                post {
                    actionBusy = false
                    error = e.message
                }
            }
        }
    }

    /** Stops following the build on screen (the build itself keeps running). */
    fun close() {
        watching = null
        stopStream()
        connection = ""
    }

    fun shutdown() {
        close()
        io.shutdownNow()
        streamIo.shutdownNow()
    }

    private fun show(session: BuildSession) {
        current = session
        timeline.clear()
        lastApplied = 0L
        list = list?.let { l -> l.copy(sessions = listOf(session) + l.sessions.filter { it.id != session.id }) }
        watch(session.id)
    }

    private fun stopStream() {
        val conn = stream.getAndSet(null) ?: return
        io.execute { conn.disconnect() }
    }

    // Follows the build from the first event (so the timeline is complete) and
    // reconnects from the last sequence number after a drop, with a capped,
    // growing pause, as deepseek-harness-mobile's connection loop does.
    private fun watch(id: String) {
        stopStream()
        watching = id
        streamIo.execute {
            var after = 0L
            var failures = 0
            while (watching == id) {
                try {
                    api.streamBuild(id, after, stream) { event ->
                        after = maxOf(after, event.seq)
                        failures = 0
                        post { if (watching == id) apply(event) }
                    }
                    break
                } catch (e: ApiException) {
                    if (watching != id) break
                    failures++
                    if (failures > MAX_RECONNECTS) {
                        post { if (watching == id) connection = "Offline. Open the build again to reconnect." }
                        break
                    }
                    post { if (watching == id) connection = "Reconnecting…" }
                    try {
                        Thread.sleep(minOf(1000L shl (failures - 1), 15000L))
                    } catch (interrupted: InterruptedException) {
                        break
                    }
                }
            }
        }
    }

    private fun apply(event: BuildEvent) {
        connection = ""
        val session = current ?: return
        if (event is BuildEvent.Gap) {
            open(session.id)
            return
        }
        if (event.seq in 1..lastApplied) return
        lastApplied = event.seq
        val updated = applyBuildEvent(session, event)
        current = updated
        when (event) {
            is BuildEvent.Message, is BuildEvent.Output, is BuildEvent.Diff, is BuildEvent.Answer,
            is BuildEvent.Done, is BuildEvent.Failed -> timeline.add(event)
            is BuildEvent.Approval -> attention = BuildAttention(session.id, event.requestId, event.summary.ifEmpty { "A change needs your approval" })
            is BuildEvent.Question -> attention = BuildAttention(session.id, event.requestId, event.question)
            else -> Unit
        }
        list = list?.let { l -> l.copy(sessions = l.sessions.map { if (it.id == updated.id) updated else it }) }
    }

    private companion object {
        const val MAX_RECONNECTS = 6
    }
}
