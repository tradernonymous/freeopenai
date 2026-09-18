package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceTest {

    private fun chat(files: Map<String, String> = emptyMap(), pending: List<StagedWrite> = emptyList()) =
        Conversation("c", "T", "assistant", "p", "m", emptyList(), 0, 0, mode = "build", files = files, pendingWrites = pending)

    // --- normalizeWorkspacePath -------------------------------------------------

    @Test fun `a plain relative path is unchanged`() {
        assertEquals("src/app.js", normalizeWorkspacePath("src/app.js"))
    }

    @Test fun `a leading dot-slash is stripped`() {
        assertEquals("app.js", normalizeWorkspacePath("./app.js"))
    }

    @Test fun `a dot-dot that stays within the root resolves`() {
        assertEquals("b.md", normalizeWorkspacePath("a/../b.md"))
        assertEquals("a/c.md", normalizeWorkspacePath("a/b/../c.md"))
    }

    @Test fun `a dot-dot that would climb above the root is rejected`() {
        assertNull(normalizeWorkspacePath(".."))
        assertNull(normalizeWorkspacePath("../x"))
        assertNull(normalizeWorkspacePath("a/../../b"))
    }

    @Test fun `an absolute path is rejected`() {
        assertNull(normalizeWorkspacePath("/etc/passwd"))
    }

    @Test fun `a backslash is rejected`() {
        assertNull(normalizeWorkspacePath("a\\b"))
    }

    @Test fun `control characters including NUL are rejected`() {
        assertNull(normalizeWorkspacePath("a" + 0.toChar() + "b"))
        assertNull(normalizeWorkspacePath("a\nb"))
    }

    @Test fun `blank input is rejected`() {
        assertNull(normalizeWorkspacePath(""))
        assertNull(normalizeWorkspacePath("   "))
    }

    @Test fun `a segment name over 120 characters is rejected`() {
        assertNull(normalizeWorkspacePath("a".repeat(121)))
        assertEquals("a".repeat(120), normalizeWorkspacePath("a".repeat(120)))
    }

    @Test fun `more than 4 segments is rejected`() {
        assertNull(normalizeWorkspacePath("a/b/c/d/e"))
        assertEquals("a/b/c/d", normalizeWorkspacePath("a/b/c/d"))
    }

    // --- workspaceOverlay --------------------------------------------------------

    @Test fun `overlay merges files and staged writes`() {
        val overlay = workspaceOverlay(mapOf("a.md" to "committed"), listOf(StagedWrite("b.md", "staged")))
        assertEquals(mapOf("a.md" to "committed", "b.md" to "staged"), overlay)
    }

    @Test fun `a staged write wins over a committed one at the same path`() {
        val overlay = workspaceOverlay(mapOf("a.md" to "old"), listOf(StagedWrite("a.md", "new")))
        assertEquals("new", overlay["a.md"])
    }

    // --- workspaceCanStage -------------------------------------------------------

    @Test fun `a small write to an empty workspace fits`() {
        assertTrue(workspaceCanStage(emptyMap(), emptyList(), "a.md", "hello"))
    }

    @Test fun `a write over the per-file byte limit does not fit`() {
        assertFalse(workspaceCanStage(emptyMap(), emptyList(), "a.md", "x".repeat(WORKSPACE_MAX_FILE_BYTES + 1)))
        assertTrue(workspaceCanStage(emptyMap(), emptyList(), "a.md", "x".repeat(WORKSPACE_MAX_FILE_BYTES)))
    }

    @Test fun `a new file beyond the file-count limit does not fit`() {
        val full = (1..WORKSPACE_MAX_FILES).associate { "f$it" to "x" }
        assertFalse(workspaceCanStage(full, emptyList(), "new", "x"))
    }

    @Test fun `replacing an existing file at the file-count limit still fits`() {
        val full = (1..WORKSPACE_MAX_FILES).associate { "f$it" to "x" }
        assertTrue(workspaceCanStage(full, emptyList(), "f1", "replaced"))
    }

    @Test fun `replacing an already-staged path is not double counted`() {
        val staged = listOf(StagedWrite("a.md", "x".repeat(1000)))
        assertTrue(workspaceCanStage(emptyMap(), staged, "a.md", "y".repeat(1000)))
    }

    @Test fun `the total byte budget is enforced across files and staged writes`() {
        val files = mapOf("a.md" to "x".repeat(WORKSPACE_MAX_TOTAL_BYTES - 10))
        assertFalse(workspaceCanStage(files, emptyList(), "b.md", "y".repeat(20)))
        assertTrue(workspaceCanStage(files, emptyList(), "b.md", "y".repeat(5)))
    }

    // --- commitWrites --------------------------------------------------------------

    @Test fun `committing with nothing pending is a no-op`() {
        val c = chat()
        assertEquals(c, commitWrites(c, setOf("anything"), now = 0))
    }

    @Test fun `approved writes merge into files and pending is cleared`() {
        val c = chat(pending = listOf(StagedWrite("a.md", "1"), StagedWrite("b.md", "2")))
        val committed = commitWrites(c, setOf("a.md", "b.md"), now = 0)
        assertEquals(mapOf("a.md" to "1", "b.md" to "2"), committed.files)
        assertTrue(committed.pendingWrites.isEmpty())
    }

    @Test fun `rejecting everything leaves files untouched`() {
        val c = chat(pending = listOf(StagedWrite("a.md", "1")))
        val committed = commitWrites(c, emptySet(), now = 0)
        assertTrue(committed.files.isEmpty())
        assertTrue(committed.pendingWrites.isEmpty())
    }

    @Test fun `a mixed approval only applies the approved half`() {
        val c = chat(pending = listOf(StagedWrite("keep.md", "yes"), StagedWrite("drop.md", "no")))
        val committed = commitWrites(c, setOf("keep.md"), now = 0)
        assertEquals(mapOf("keep.md" to "yes"), committed.files)
    }

    @Test fun `commit records what happened as a message`() {
        val c = chat(pending = listOf(StagedWrite("a.md", "1")))
        val committed = commitWrites(c, setOf("a.md"), now = 5000)
        val recorded = committed.messages.last()
        assertEquals("tool", recorded.role)
        assertTrue(recorded.content.contains("a.md"))
        assertEquals(5000L, recorded.createdAt)
    }
}
