package com.neura.os.app.data

// The phone's own sandboxed workspace for Build mode: edits to text the chat
// already owns (Conversation.files), never a real path, a process or a
// shell. Everything here is pure -- no java.io, no java.nio, no android.* --
// which is exactly what RatchetTest checks for, because that is what makes
// "this cannot reach a real filesystem" a fact about the code rather than a
// hope about the prompt.

/** A write the model proposed but the user has not approved yet, kept apart
 * from Conversation.files so nothing lands until a tap. [path] is the key --
 * a second stage of the same path replaces the first rather than queuing
 * both, so file_read/file_list always see at most one pending version. */
data class StagedWrite(val path: String, val content: String)

const val WORKSPACE_MAX_FILES = 32
const val WORKSPACE_MAX_FILE_BYTES = 64 * 1024
const val WORKSPACE_MAX_TOTAL_BYTES = 256 * 1024

/** How many proposals can sit unreviewed at once. Framed per-turn in the
 * design, enforced here as a standing ceiling instead: a strict per-turn
 * count would still let an unbounded pile build up over many turns the user
 * has not gotten around to reviewing, and "at most this many ever waiting"
 * is both simpler to reason about and the stricter of the two. */
const val WORKSPACE_MAX_PENDING = 8

/** Rejects an absolute path, a backslash, a NUL or control character, a
 * segment over 120 characters, more than 4 segments, or a `..` that would
 * climb above the workspace root; returns the resolved relative POSIX path
 * otherwise (so "a/../b.md" is fine and becomes "b.md" -- it never leaves
 * the root, it just doesn't go anywhere). */
fun normalizeWorkspacePath(raw: String): String? {
    if (raw.isBlank()) return null
    if (raw.any { it.code < 0x20 }) return null
    if (raw.contains('\\')) return null
    if (raw.startsWith("/")) return null
    val resolved = ArrayList<String>()
    for (segment in raw.split("/")) {
        when {
            segment.isEmpty() || segment == "." -> Unit
            segment == ".." -> {
                if (resolved.isEmpty()) return null
                resolved.removeAt(resolved.lastIndex)
            }
            segment.length > 120 -> return null
            else -> resolved.add(segment)
        }
    }
    if (resolved.isEmpty() || resolved.size > 4) return null
    return resolved.joinToString("/")
}

/** files with every staged write applied on top -- a staged version always
 * wins over a committed one. What file_read and file_list actually show, so
 * the model keeps working against a coherent view in the same turn it staged
 * a change, without that change being real yet. */
fun workspaceOverlay(files: Map<String, String>, staged: List<StagedWrite>): Map<String, String> =
    files + staged.associate { it.path to it.content }

/** Whether staging [content] at [path] keeps the workspace within its
 * quotas, measured against the overlay so a write that only replaces an
 * existing or already-staged path is never double-counted. */
fun workspaceCanStage(files: Map<String, String>, staged: List<StagedWrite>, path: String, content: String): Boolean {
    val bytes = content.toByteArray(Charsets.UTF_8).size
    if (bytes > WORKSPACE_MAX_FILE_BYTES) return false
    val overlay = workspaceOverlay(files, staged)
    val isNewFile = path !in overlay
    if (overlay.size + (if (isNewFile) 1 else 0) > WORKSPACE_MAX_FILES) return false
    val otherBytes = overlay.entries.filter { it.key != path }.sumOf { it.value.toByteArray(Charsets.UTF_8).size }
    return otherBytes + bytes <= WORKSPACE_MAX_TOTAL_BYTES
}

/** Approved paths merge into files; every other pending write is dropped,
 * approved or not -- a review is a decision on the whole batch on screen,
 * not a standing queue. Records exactly what happened as a message, so the
 * next turn's history says what the user actually accepted rather than what
 * was proposed. A no-op (nothing pending) returns the conversation as-is. */
fun commitWrites(conversation: Conversation, approvedPaths: Set<String>, now: Long = System.currentTimeMillis()): Conversation {
    if (conversation.pendingWrites.isEmpty()) return conversation
    val approved = conversation.pendingWrites.filter { it.path in approvedPaths }
    val rejected = conversation.pendingWrites.filter { it.path !in approvedPaths }
    val summary = buildString {
        if (approved.isNotEmpty()) append("Applied " + approved.joinToString(", ") { it.path } + ".")
        if (rejected.isNotEmpty()) {
            if (isNotEmpty()) append(" ")
            append("Rejected " + rejected.joinToString(", ") { it.path } + ".")
        }
    }
    return conversation.copy(
        files = conversation.files + approved.associate { it.path to it.content },
        pendingWrites = emptyList(),
        messages = conversation.messages + ChatMessage("tool", summary, createdAt = now, toolName = "file_write"),
    )
}
