package com.neura.os.app.data

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

// One-shot messages for the snackbar (docs/android-master-plan.md, V3). They
// used to be a `notice` state field that the chat screen cleared by hand, so
// two notices in one frame showed as one, and a notice raised while another
// page covered the chat waited, invisible, until the chat came back.
//
// The contract, per the kotlin-concurrency-and-flow skill: exactly-once
// handoff to one consumer (the app root's snackbar host), buffered so a
// notice raised before that collector starts, or while it is showing the
// previous one, is delivered later rather than lost, and never replayed to
// a second collector. post() is safe from any thread.
class NoticeQueue(capacity: Int = 16) {
    private val channel = Channel<String>(capacity)

    val notices: Flow<String> = channel.receiveAsFlow()

    /** Queues [text]; blank text is ignored. False when the queue is full,
     * which only happens if nothing has shown a notice for a long time. */
    fun post(text: String?): Boolean {
        val clean = text?.trim().orEmpty()
        if (clean.isEmpty()) return false
        return channel.trySend(clean).isSuccess
    }
}
