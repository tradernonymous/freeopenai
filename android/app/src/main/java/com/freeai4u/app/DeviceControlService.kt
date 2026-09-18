package com.freeai4u.app

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat

/** The one Android-specific place data/Agent.kt's tap_text/scroll_until
 * phone actions actually touch the screen. Deliberately small: read the
 * accessibility tree of whatever app is in front, find a node by the same
 * label the model was given, perform the one action named -- never a raw
 * coordinate, never a gesture the tree didn't already offer as an action.
 * Every call here only ever runs after the user tapped Approve on that
 * specific action in the chat (see ActionTicket in data/Agent.kt); this
 * file has no opinion about that, it only does the one thing it's told
 * once it's told to do it, and only to the app already on screen. */
class DeviceControlService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    // Every read happens on demand from tapText/scrollUntil/snapshot, not
    // from a stream of events, so there's nothing to do here.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    /** A short text description of what's on screen right now, for the
     * model to read before proposing an action -- never a screenshot. */
    fun snapshot(): String {
        val root = rootInActiveWindow ?: return "Nothing visible (no active window)."
        val lines = mutableListOf<String>()
        collect(root, lines, 0)
        return if (lines.isEmpty()) "Nothing labelled is visible." else lines.joinToString("\n")
    }

    private fun collect(node: AccessibilityNodeInfo, out: MutableList<String>, depth: Int) {
        if (out.size >= 120 || depth > 30) return
        val text = (node.text?.toString() ?: node.contentDescription?.toString() ?: "").trim()
        if (text.isNotEmpty()) {
            val role = if (node.isClickable) "button" else if (node.isScrollable) "scrollable" else "text"
            out.add("$role: \"${text.take(80)}\"")
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { collect(it, out, depth + 1) }
        }
    }

    /** Every node in the current window whose visible text or description
     * contains [label], case-insensitive. */
    private fun findMatches(label: String): List<AccessibilityNodeInfo> {
        val needle = label.trim().lowercase()
        val root = rootInActiveWindow
        if (needle.isEmpty() || root == null) return emptyList()
        val found = mutableListOf<AccessibilityNodeInfo>()
        search(root, needle, found, 0)
        return found
    }

    private fun search(node: AccessibilityNodeInfo, needle: String, out: MutableList<AccessibilityNodeInfo>, depth: Int) {
        if (out.size >= 20 || depth > 30) return
        val text = (node.text?.toString() ?: node.contentDescription?.toString() ?: "").lowercase()
        if (text.contains(needle)) out.add(node)
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { search(it, needle, out, depth + 1) }
        }
    }

    /** Walks up from [node] to the nearest clickable ancestor (including
     * itself) -- an on-screen label is usually plain text inside a
     * clickable container, not clickable itself. Capped at a few hops so
     * this can never end up tapping something unrelated further up the
     * screen. */
    private fun clickableSelfOrAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        var hops = 0
        while (current != null && hops < 5) {
            if (current.isClickable) return current
            current = current.parent
            hops++
        }
        return null
    }

    /** Taps the one element matching [label]. Fails on zero or on more than
     * one match rather than guessing which one was meant -- a wrong guess
     * here is exactly the failure mode this feature most needs to avoid. */
    fun tapText(label: String): Result<String> {
        val matches = findMatches(label)
        return when {
            matches.isEmpty() -> Result.failure(IllegalStateException("Nothing on screen matches \"$label\"."))
            matches.size > 1 -> Result.failure(IllegalStateException("${matches.size} things on screen match \"$label\" -- be more specific."))
            else -> {
                val target = clickableSelfOrAncestor(matches[0])
                when {
                    target == null -> Result.failure(IllegalStateException("\"$label\" is not tappable."))
                    target.performAction(AccessibilityNodeInfo.ACTION_CLICK) -> {
                        notifyDone("Tapped \"$label\".")
                        Result.success("Tapped \"$label\".")
                    }
                    else -> Result.failure(IllegalStateException("Tapping \"$label\" was refused by the app on screen."))
                }
            }
        }
    }

    private fun findScrollable(node: AccessibilityNodeInfo, depth: Int): AccessibilityNodeInfo? {
        if (depth > 30) return null
        if (node.isScrollable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findScrollable(child, depth + 1)?.let { return it }
        }
        return null
    }

    /** Scrolls the nearest scrollable container down, checking for [label]
     * after each scroll, up to [maxScrolls] times. Runs on a background
     * thread (see NativeActivity.runAction) so the short pause between
     * scrolls never blocks the UI. */
    fun scrollUntil(label: String, maxScrolls: Int): Result<String> {
        if (findMatches(label).isNotEmpty()) {
            notifyDone("\"$label\" was already visible.")
            return Result.success("\"$label\" was already visible.")
        }
        val cap = maxScrolls.coerceIn(1, 10)
        repeat(cap) {
            val root = rootInActiveWindow ?: return Result.failure(IllegalStateException("The screen changed; try again."))
            val scrollable = findScrollable(root, 0) ?: return Result.failure(IllegalStateException("Nothing on screen can be scrolled."))
            if (!scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) {
                return Result.failure(IllegalStateException("Scrolling was refused by the app on screen."))
            }
            Thread.sleep(300)
            if (findMatches(label).isNotEmpty()) {
                notifyDone("Scrolled to \"$label\".")
                return Result.success("Scrolled to \"$label\".")
            }
        }
        return Result.failure(IllegalStateException("\"$label\" was not found after $cap scroll(s)."))
    }

    private fun notifyDone(text: String) {
        try {
            val manager = getSystemService(NotificationManager::class.java) ?: return
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Device control", NotificationManager.IMPORTANCE_LOW))
            val notification = NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_app)
                .setContentTitle("FreeAI4U device control")
                .setContentText(text)
                .setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .build()
            manager.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            // Losing the notification must never fail the action it reports.
        }
    }

    companion object {
        /** Set while the service is bound; null when the person has not
         * turned it on in Settings, or has turned it off since. This is the
         * only way anything outside this file can tell whether the service
         * is actually running -- every caller checks it first. */
        @Volatile var instance: DeviceControlService? = null
            private set
        private const val CHANNEL = "device_control"
        private const val NOTIFICATION_ID = 51
    }
}
