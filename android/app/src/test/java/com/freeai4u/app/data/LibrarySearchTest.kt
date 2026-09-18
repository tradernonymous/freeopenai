package com.freeai4u.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LibrarySearchTest {

    private val coder = LibraryEntry("persona", "coder", "Coder", "Writes and explains code")
    private val writer = LibraryEntry("persona", "writer", "Writer", "Drafts and edits prose")
    private val summarize = LibraryEntry("prompt", "p1", "Summarize", "Summarize this: ")
    private val entries = listOf(coder, writer, summarize)

    @Test fun `empty query returns everything in the given order`() {
        assertEquals(entries, rankLibrary(entries, ""))
    }

    @Test fun `whitespace-only query is treated as empty`() {
        assertEquals(entries, rankLibrary(entries, "   "))
    }

    @Test fun `filters by title`() {
        // "riter" (not "writ") -- "Writes" in coder's own subtitle would
        // otherwise also match and make this test pass for the wrong reason.
        assertEquals(listOf(writer), rankLibrary(entries, "riter"))
    }

    @Test fun `filters by subtitle too`() {
        assertEquals(listOf(coder), rankLibrary(entries, "explains"))
    }

    @Test fun `matching is case insensitive`() {
        assertEquals(listOf(writer), rankLibrary(entries, "RITER"))
    }

    @Test fun `no matches returns an empty list`() {
        assertTrue(rankLibrary(entries, "nonexistent").isEmpty())
    }

    @Test fun `a title prefix match ranks ahead of a mere contains match`() {
        val startsWithQuery = LibraryEntry("skill", "s1", "search-web", "looks things up")
        val containsInSubtitleOnly = LibraryEntry("skill", "s2", "translate", "does a web search of dictionaries")
        val ranked = rankLibrary(listOf(containsInSubtitleOnly, startsWithQuery), "search")
        assertEquals(listOf(startsWithQuery, containsInSubtitleOnly), ranked)
    }

    @Test fun `ties keep their original relative order (stable sort)`() {
        val a = LibraryEntry("prompt", "a", "Alpha task", "")
        val b = LibraryEntry("prompt", "b", "Alpha plan", "")
        assertEquals(listOf(a, b), rankLibrary(listOf(a, b), "alpha"))
    }
}
