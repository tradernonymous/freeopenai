package com.neura.os.app.data

// The text behind Settings -> "Copy diagnostics": what a person pastes into a
// bug report. The Android twin of desktop/src/diagnostics.js, with the same
// contract (see its test): enough to find the problem, nothing anyone would
// regret pasting -- no chat text, no keys, no tokens, no session cookies, and
// no query string on the server address.
//
// It exists because of docs/android-master-plan.md section 2.4: a failure that
// reaches the user as "timed out" or "failed" and nothing else cost four builds
// to diagnose. Pure, so the redaction is proven on the JVM rather than hoped.

/** One failure the user saw: when, which part of the app, and why. */
data class FailureRecord(val at: Long, val where: String, val reason: String)

/** How many failures the ring keeps. Memory only, never written to disk. */
const val FAILURE_RING_MAX = 50

/** The last [FAILURE_RING_MAX] failures, newest first. Each reason is
 * redacted, flattened to one line and clipped as it goes in, so nothing
 * credential-shaped is ever held, let alone copied out. */
data class FailureRing(val items: List<FailureRecord> = emptyList()) {
    fun record(at: Long, where: String, reason: String?): FailureRing {
        val text = redactSecrets(reason.orEmpty()).replace(Regex("\\s+"), " ").trim().take(200)
        val entry = FailureRecord(at, where.trim().take(40).ifEmpty { "app" }, text.ifEmpty { "failed" })
        return copy(items = (listOf(entry) + items).take(FAILURE_RING_MAX))
    }
}

/** Anything shaped like a provider key, a GitHub token, an Authorization
 * header or this app's own session cookies. */
fun redactSecrets(text: String): String = text
    .replace(Regex("hf_[A-Za-z0-9]{8,}"), "hf_<redacted>")
    .replace(Regex("sk-[A-Za-z0-9_-]{8,}"), "sk-<redacted>")
    .replace(Regex("github_pat_[A-Za-z0-9_]{8,}"), "github_pat_<redacted>")
    .replace(Regex("gh[pousr]_[A-Za-z0-9]{8,}"), "gh_<redacted>")
    .replace(Regex("(?i)(Bearer\\s+)[A-Za-z0-9._~+/-]+=*"), "$1<redacted>")
    .replace(Regex("(?i)(fo_(?:auth|gh)=)[^;\\s]+"), "$1<redacted>")

/** A server address can carry a key in its query string; the origin and path
 * are all a report needs. */
fun redactUrl(value: String?): String {
    val raw = value.orEmpty().trim()
    if (raw.isEmpty()) return ""
    val cut = raw.substringBefore('#')
    val query = cut.indexOf('?')
    return if (query < 0) redactSecrets(cut) else redactSecrets(cut.substring(0, query)) + "?<redacted>"
}

/** How long ago, the way a person would say it. */
fun agoLabel(elapsedMs: Long): String {
    val seconds = maxOf(0L, elapsedMs) / 1000
    return when {
        seconds < 60 -> "just now"
        seconds < 3_600 -> "${seconds / 60} min ago"
        seconds < 86_400 -> "${seconds / 3_600} h ago"
        else -> "${seconds / 86_400} d ago"
    }
}

/** The cold-start target the desktop already holds itself to (NEURA-035). */
const val STARTUP_TARGET_MS = 2000L

fun startupLabel(ms: Long, targetMs: Long = STARTUP_TARGET_MS): String =
    "$ms ms (target under $targetMs ms: " + (if (ms < targetMs) "met" else "missed") + ")"

/** Everything the report reads, gathered by the screen that copies it. */
data class DiagnosticsInput(
    val version: String,
    val versionCode: Int,
    val androidRelease: String,
    val sdkInt: Int,
    val device: String,
    val server: String,
    val signedIn: Boolean,
    val providers: List<ProviderInfo>,
    val catalogueError: String?,
    val outboxDepth: Int,
    val deviceControl: Boolean,
    val puterImages: Boolean,
    /** Process start to first frame, once measured; null until then. */
    val startupMs: Long?,
    val failures: List<FailureRecord>,
    val now: Long,
)

fun buildDiagnostics(input: DiagnosticsInput): String {
    val lines = mutableListOf<String>()
    lines += "NeuraOS Android ${input.version} (${input.versionCode})"
    lines += ""
    fun row(label: String, value: String?) {
        val text = value?.trim().orEmpty()
        if (text.isNotEmpty()) lines += label.padEnd(10) + " " + text
    }
    row("server", redactUrl(input.server).ifEmpty { "not set" })
    row("signed in", if (input.signedIn) "yes" else "no")
    row("android", "${input.androidRelease} (API ${input.sdkInt}) · ${input.device}")
    val configured = input.providers.filter { it.configured }.map { it.id }
    row("providers", if (configured.isEmpty()) "none loaded" else configured.joinToString(", "))
    row("catalogue", input.catalogueError?.let { redactSecrets(it).take(200) })
    row("outbox", when (input.outboxDepth) {
        0 -> "empty"
        1 -> "1 chat waiting to retry"
        else -> "${input.outboxDepth} chats waiting to retry"
    })
    row("device ctl", if (input.deviceControl) "on" else "off")
    row("puter imgs", if (input.puterImages) "on" else "off")
    row("startup", input.startupMs?.let { startupLabel(it) })
    lines += ""
    lines += "--- recent problems, newest first ---"
    if (input.failures.isEmpty()) {
        lines += "none since the app started"
    } else {
        input.failures.forEach { lines += agoLabel(input.now - it.at) + "  " + it.where + "  " + redactSecrets(it.reason) }
    }
    return lines.joinToString("\n")
}
