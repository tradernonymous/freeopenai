package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Phase 3's offline story (master plan section 2.2): an answer seen before can
// stand in when the connection is gone -- clearly marked, never in place of a
// live one. What makes that safe is the key: only the same model, the same
// mode and the same questions, word for word give or take case and spacing.
class ResponseCacheTest {

    private fun user(text: String) = ChatMessage("user", text)
    private fun bot(text: String) = ChatMessage("assistant", text)

    @Test fun `the key ignores case, spacing and trailing punctuation`() {
        assertEquals(
            responseCacheKey("m1", "chat", listOf(user("What is  Kotlin?"))),
            responseCacheKey("m1", "chat", listOf(user("  what is kotlin "))),
        )
    }

    @Test fun `a different model, mode or earlier question is a different key`() {
        val base = responseCacheKey("m1", "chat", listOf(user("hi")))
        assertNotEquals(base, responseCacheKey("m2", "chat", listOf(user("hi"))))
        assertNotEquals(base, responseCacheKey("m1", "plan", listOf(user("hi"))))
        // The same last question after a different conversation is a different
        // question: "and in French?" means nothing without what came before.
        assertNotEquals(
            responseCacheKey("m1", "chat", listOf(user("say hello"), bot("hello"), user("and in French?"))),
            responseCacheKey("m1", "chat", listOf(user("say goodbye"), bot("goodbye"), user("and in French?"))),
        )
    }

    @Test fun `only the user's own words count, not the replies`() {
        assertEquals(
            responseCacheKey("m1", "chat", listOf(user("a"), bot("x"), user("b"))),
            responseCacheKey("m1", "chat", listOf(user("a"), bot("y"), user("b"))),
        )
    }

    @Test fun `a conversation with no question has no key`() {
        assertNull(responseCacheKey("m1", "chat", emptyList()))
        assertNull(responseCacheKey("m1", "chat", listOf(user("   "))))
    }

    @Test fun `storing keeps the newest, replaces a repeat, and caps the size`() {
        var cache = ResponseCache()
        for (i in 1..(RESPONSE_CACHE_MAX + 5)) cache = cache.stored("k$i", "answer $i", "m1", i.toLong())
        assertEquals(RESPONSE_CACHE_MAX, cache.entries.size)
        assertEquals("k${RESPONSE_CACHE_MAX + 5}", cache.entries.first().key)
        assertNull(cache.lookup("k1"))
        cache = cache.stored("k10", "newer answer", "m1", 999L)
        assertEquals(RESPONSE_CACHE_MAX, cache.entries.size)
        assertEquals("newer answer", cache.lookup("k10")!!.content)
        assertEquals("k10", cache.entries.first().key)
    }

    @Test fun `an empty answer is never cached`() {
        assertEquals(0, ResponseCache().stored("k", "   ", "m1", 1L).entries.size)
    }

    @Test fun `it round-trips through JSON and survives garbage`() {
        val cache = ResponseCache().stored("k1", "one", "m1", 1L).stored("k2", "two", "m2", 2L)
        assertEquals(cache, responseCacheFromJson(cache.toJson()))
        assertEquals(ResponseCache(), responseCacheFromJson("not json"))
        assertEquals(ResponseCache(), responseCacheFromJson(null))
    }

    @Test fun `a cached flag on a message survives storage`() {
        val message = ChatMessage("assistant", "from before", cached = true)
        assertEquals(true, chatMessageFromJson(message.toJson()).cached)
        assertEquals(false, chatMessageFromJson(ChatMessage("assistant", "live").toJson()).cached)
    }
}
