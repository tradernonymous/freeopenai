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
import com.neura.os.app.data.StreamUpdate
import com.neura.os.app.data.resumable
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A build is waiting on the user: shown as a notification when the app is in
 * the background. [requestId] is the dedup key, so one question notifies once. */
/** A build waiting on the person. [approval] marks a change to approve (as
 * opposed to a question to answer), which is what may carry an Approve
 * button on its notification (master plan v2, V7). */
data class BuildAttention(val buildId: String, val requestId: String, val text: String, val approval: Boolean = false)

/** State for remote builds, kept out of AppViewModel so the chat code stays
 * untouched. Every job is a child of [scope] (the view model's): requests hop
 * to [io] for the blocking call and come back to write Compose state; the
 * live stream is one [Job] that closing the screen cancels, which closes its
 * connection (master plan v2, V3). */
class RemoteBuilds(
    private val api: NativeApi,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher,
) {
    private var watchJob: Job? = null
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
        scope.launch {
            try {
                list = withContext(io) { api.builds() }
                listError = null
            } catch (e: ApiException) {
                listError = e.message
            } finally {
                listBusy = false
            }
        }
    }

    fun start(chatId: String, plan: String, onStarted: () -> Unit, onFailed: (String) -> Unit) {
        actionBusy = true
        error = null
        scope.launch {
            try {
                val session = withContext(io) { api.startBuild(chatId, plan) }
                actionBusy = false
                show(session)
                onStarted()
            } catch (e: ApiException) {
                actionBusy = false
                onFailed(e.message ?: "Could not start the build.")
            }
        }
    }

    fun open(id: String) {
        error = null
        list?.sessions?.firstOrNull { it.id == id }?.let { if (current?.id != id) current = it }
        scope.launch {
            try {
                show(withContext(io) { api.build(id) })
            } catch (e: ApiException) {
                error = e.message
            }
        }
    }

    /** Approve or reject the pending change ([decision]), or answer a question (null). */
    fun answer(decision: String?, text: String) {
        val session = current ?: return
        val pending = session.pending ?: return
        actionBusy = true
        error = null
        scope.launch {
            try {
                withContext(io) { api.answerBuild(session.id, pending.requestId, decision, text) }
                actionBusy = false
                // The stream may already have delivered the next question;
                // only the answered one is cleared here.
                val now = current
                if (now != null && now.pending?.requestId == pending.requestId) current = now.copy(pending = null)
            } catch (e: ApiException) {
                actionBusy = false
                error = e.message
                open(session.id)
            }
        }
    }

    fun cancel() {
        val session = current ?: return
        actionBusy = true
        scope.launch {
            try {
                val updated = withContext(io) { api.cancelBuild(session.id) }
                val now = current
                if (now != null && now.id == updated.id) current = now.copy(status = updated.status, pending = null)
            } catch (e: ApiException) {
                error = e.message
            } finally {
                actionBusy = false
            }
        }
    }

    /** Stops following the build on screen (the build itself keeps running). */
    fun close() {
        watchJob?.cancel()
        watchJob = null
        connection = ""
    }

    private fun show(session: BuildSession) {
        current = session
        timeline.clear()
        lastApplied = 0L
        list = list?.let { l -> l.copy(sessions = listOf(session) + l.sessions.filter { it.id != session.id }) }
        watch(session.id)
    }

    // Follows the build from the first event (so the timeline is complete) and
    // reconnects from the last sequence number after a drop, with a capped,
    // growing pause, as deepseek-harness-mobile's connection loop does
    // (data/Streams.kt resumable). Watching another build cancels this one.
    private fun watch(id: String) {
        watchJob?.cancel()
        watchJob = scope.launch {
            resumable(MAX_RECONNECTS, positionOf = { it.seq }) { after -> api.buildEvents(id, after) }
                .collect { update ->
                    when (update) {
                        is StreamUpdate.Item -> apply(update.value)
                        is StreamUpdate.Reconnecting -> connection = "Reconnecting…"
                        StreamUpdate.Offline -> connection = "Offline. Open the build again to reconnect."
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
            is BuildEvent.Approval -> attention = BuildAttention(session.id, event.requestId, event.summary.ifEmpty { "A change needs your approval" }, approval = true)
            is BuildEvent.Question -> attention = BuildAttention(session.id, event.requestId, event.question)
            else -> Unit
        }
        list = list?.let { l -> l.copy(sessions = l.sessions.map { if (it.id == updated.id) updated else it }) }
    }

    private companion object {
        const val MAX_RECONNECTS = 6
    }
}
