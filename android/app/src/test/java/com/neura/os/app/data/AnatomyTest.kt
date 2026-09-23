package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The parts of a reply that say what the AI did: how long it thought, what it
// cited, and how much of the model's context the chat already fills.
class AnatomyTest {

    @Test fun `the thought label says how long, once it is over`() {
        assertEquals("Thinking…", thoughtLabel(0, live = true))
        assertEquals("Thought", thoughtLabel(0, live = false))
        assertEquals("Thought for a moment", thoughtLabel(400, live = false))
        assertEquals("Thought for 12 s", thoughtLabel(12_300, live = false))
        assertEquals("Thought for 2 min 5 s", thoughtLabel(125_000, live = false))
    }

    @Test fun `sources come from links, one chip per page, in order`() {
        val text = "See [the report](https://www.example.com/report) and https://docs.site.org/a/b. " +
            "Again: https://www.example.com/report/ and [x](http://insecure.net/page)."
        val sources = sourcesFrom(text)
        assertEquals(listOf("https://www.example.com/report", "https://docs.site.org/a/b"), sources.map { it.url })
        assertEquals(listOf("example.com", "docs.site.org"), sources.map { it.label })
    }

    @Test fun `odd links are not offered`() {
        assertTrue(sourcesFrom("https://localhost/x https://user@evil.com/ nothing here").isEmpty())
        val many = (1..10).joinToString(" ") { "https://site$it.com/p" }
        assertEquals(SOURCES_MAX, sourcesFrom(many).size)
    }

    @Test fun `the context meter reads like a person would say it`() {
        val chat = listOf(ChatMessage("user", "x".repeat(4000)), ChatMessage("assistant", "y".repeat(8000)))
        val tokens = estimateTokens(chat)
        assertEquals(3008, tokens)
        val (label, fraction) = contextLabel(tokens, 128_000)
        assertEquals("≈ 3k of 128k tokens", label)
        assertEquals(3008f / 128_000f, fraction!!, 0.0001f)
        assertEquals("≈ 3.2k tokens", contextLabel(3_200, 0).first)
        assertNull(contextLabel(3_200, 0).second)
        assertEquals(1f, contextLabel(500_000, 128_000).second!!, 0f)
        assertEquals("≈ 1M of 2M tokens", contextLabel(1_000_000, 2_000_000).first)
    }

    @Test fun `long prose or a long code block earns the canvas, a short answer does not`() {
        assertTrue(!canvasWorthy("A short answer."))
        assertTrue(canvasWorthy("x".repeat(CANVAS_MIN_CHARS)))
        val longCode = "Here:\n```kotlin\n" + (1..30).joinToString("\n") { "val a$it = $it" } + "\n```"
        assertTrue(canvasWorthy(longCode))
        val shortCode = "Here:\n```kotlin\nval a = 1\n```"
        assertTrue(!canvasWorthy(shortCode))
    }

    @Test fun `the canvas steps through finished replies only`() {
        val chat = listOf(
            ChatMessage("user", "hi"),
            ChatMessage("assistant", "one"),
            ChatMessage("assistant", "failed", error = true),
            ChatMessage("assistant", " "),
            ChatMessage("assistant", "two"),
        )
        assertEquals(listOf("one", "two"), canvasReplies(chat))
    }
}
