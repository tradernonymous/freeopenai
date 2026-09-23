package com.neura.os.app.data

import org.json.JSONArray
import org.json.JSONObject

// Pull request review from the phone (docs/android-master-plan.md, Phase 4):
// supervision, not editing -- read what changed, then approve, comment or ask
// for changes. The server shapes GitHub's answers (server.js githubListPulls,
// githubGetPull, githubReviewPull); this is the phone's half of that contract.

data class PullSummary(
    val number: Int,
    val title: String,
    val author: String,
    val draft: Boolean,
    val updatedAt: String,
    val head: String,
    val base: String,
)

data class PullFile(
    val filename: String,
    val status: String,
    val additions: Int,
    val deletions: Int,
    val patch: String,
    /** The server kept only the start of a long patch. */
    val clipped: Boolean,
)

data class PullDetail(
    val number: Int,
    val title: String,
    val body: String,
    val author: String,
    val state: String,
    val draft: Boolean,
    val head: String,
    val base: String,
    val additions: Int,
    val deletions: Int,
    val url: String,
    /** Why the changed files are missing, when they are; empty otherwise. */
    val filesError: String,
    val files: List<PullFile>,
)

/** GitHub's three review verdicts. Only an approval may go without text. */
enum class ReviewEvent(val label: String) {
    APPROVE("Approve"),
    COMMENT("Comment"),
    REQUEST_CHANGES("Request changes");

    fun canSend(text: String): Boolean = this == APPROVE || text.isNotBlank()
}

enum class DiffLine { ADDED, REMOVED, HUNK, CONTEXT }

/** How one line of a unified diff is drawn. "+++"/"---" are file headers,
 * not changes, even though they start with + and -. */
fun diffLineKind(line: String): DiffLine = when {
    line.startsWith("+++") || line.startsWith("---") -> DiffLine.CONTEXT
    line.startsWith("@@") -> DiffLine.HUNK
    line.startsWith("+") -> DiffLine.ADDED
    line.startsWith("-") -> DiffLine.REMOVED
    else -> DiffLine.CONTEXT
}

private val REPO_NAME = Regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

/** owner/name, checked the way the server checks it before it sends anything. */
fun isRepoName(text: String): Boolean =
    REPO_NAME.matches(text) && text.split('/').none { it == "." || it == ".." }

/** The server answers 401 both for a lapsed app session and for a GitHub
 * account that is not connected; only the body tells them apart, and only the
 * first should send the app to its sign-in screen. */
fun isGithubNotConnected(body: String): Boolean = try {
    JSONObject(body).optString("error") == "GitHub not connected"
} catch (e: Exception) {
    false
}

fun parsePulls(json: String): List<PullSummary> = try {
    val list = JSONArray(json)
    (0 until list.length()).mapNotNull { index ->
        val obj = list.optJSONObject(index) ?: return@mapNotNull null
        val number = obj.optInt("number", 0)
        if (number <= 0) return@mapNotNull null
        PullSummary(
            number = number,
            title = obj.optString("title", ""),
            author = obj.optString("author", ""),
            draft = obj.optBoolean("draft", false),
            updatedAt = obj.optString("updatedAt", ""),
            head = obj.optString("head", ""),
            base = obj.optString("base", ""),
        )
    }
} catch (e: Exception) {
    emptyList()
}

fun parsePull(json: String): PullDetail? = try {
    val obj = JSONObject(json)
    val number = obj.optInt("number", 0)
    if (number <= 0) {
        null
    } else {
        val files = obj.optJSONArray("files") ?: JSONArray()
        PullDetail(
            number = number,
            title = obj.optString("title", ""),
            body = obj.optString("body", ""),
            author = obj.optString("author", ""),
            state = obj.optString("state", ""),
            draft = obj.optBoolean("draft", false),
            head = obj.optString("head", ""),
            base = obj.optString("base", ""),
            additions = obj.optInt("additions", 0),
            deletions = obj.optInt("deletions", 0),
            url = obj.optString("url", ""),
            filesError = obj.optString("filesError", ""),
            files = (0 until files.length()).mapNotNull { index ->
                files.optJSONObject(index)?.let {
                    PullFile(
                        filename = it.optString("filename", ""),
                        status = it.optString("status", ""),
                        additions = it.optInt("additions", 0),
                        deletions = it.optInt("deletions", 0),
                        patch = it.optString("patch", ""),
                        clipped = it.optBoolean("clipped", false),
                    )
                }
            }.filter { it.filename.isNotEmpty() },
        )
    }
} catch (e: Exception) {
    null
}

fun reviewRequestBody(repo: String, number: Int, event: ReviewEvent, text: String): String =
    JSONObject()
        .put("repo", repo)
        .put("number", number)
        .put("event", event.name)
        .put("body", text.trim())
        .toString()
