package com.neura.os.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxTest {

    @Test fun `enqueue adds an entry`() {
        val outbox = Outbox().enqueued("c1")
        assertEquals(1, outbox.entries.size)
        assertEquals("c1", outbox.entries.single().chatId)
    }

    @Test fun `enqueue dedupes by chat id`() {
        val outbox = Outbox().enqueued("c1").enqueued("c1")
        assertEquals(1, outbox.entries.size)
    }

    @Test fun `enqueue keeps distinct chats`() {
        val outbox = Outbox().enqueued("c1").enqueued("c2")
        assertEquals(2, outbox.entries.size)
    }

    @Test fun `acked removes only the matching chat`() {
        val outbox = Outbox().enqueued("c1").enqueued("c2").acked("c1")
        assertEquals(listOf("c2"), outbox.entries.map { it.chatId })
    }

    @Test fun `acked on an unknown chat is a no-op`() {
        val outbox = Outbox().enqueued("c1")
        assertEquals(outbox, outbox.acked("nonexistent"))
    }

    @Test fun `attempted bumps the count and stamps the time`() {
        val outbox = Outbox().enqueued("c1").attempted("c1", at = 5_000L)
        val updated = outbox.entries.single()
        assertEquals(1, updated.attempts)
        assertEquals(5_000L, updated.lastAttemptAt)
    }

    @Test fun `attempted on an unknown chat is a no-op`() {
        val outbox = Outbox().enqueued("c1")
        assertEquals(outbox, outbox.attempted("nonexistent", at = 5_000L))
    }

    @Test fun `a fresh entry is due immediately`() {
        val outbox = Outbox().enqueued("c1")
        assertEquals(1, outbox.due(now = 0L).size)
    }

    @Test fun `backoff delays the next attempt`() {
        val outbox = Outbox().enqueued("c1").attempted("c1", at = 1_000L)
        // backoff(1) == 1000ms
        assertTrue(outbox.due(now = 1_500L).isEmpty())
        assertEquals(1, outbox.due(now = 2_000L).size)
    }

    @Test fun `backoff doubles per attempt and caps at 30 seconds`() {
        assertEquals(0L, Outbox.backoff(0))
        assertEquals(1_000L, Outbox.backoff(1))
        assertEquals(2_000L, Outbox.backoff(2))
        assertEquals(4_000L, Outbox.backoff(3))
        assertEquals(30_000L, Outbox.backoff(20))
    }

    @Test fun `due only returns entries whose backoff has elapsed`() {
        val outbox = Outbox()
            .enqueued("ready")
            .enqueued("waiting").attempted("waiting", at = 9_000L).attempted("waiting", at = 9_000L).attempted("waiting", at = 9_000L)
        val due = outbox.due(now = 10_000L).map { it.chatId }
        assertEquals(listOf("ready"), due)
    }

    @Test fun `entry json round trips`() {
        val original = OutboxEntry("c1", attempts = 2, lastAttemptAt = 12_345L)
        val restored = outboxEntryFromJson(original.toJson())
        assertEquals(original, restored)
    }

    @Test fun `outbox json round trips through toJson and outboxFromJson`() {
        val original = Outbox(listOf(OutboxEntry("c1"), OutboxEntry("c2", attempts = 4, lastAttemptAt = 99L)))
        val restored = outboxFromJson(original.toJson().toString())
        assertEquals(original, restored)
    }

    @Test fun `outboxFromJson tolerates blank or garbage input`() {
        assertEquals(Outbox(), outboxFromJson(null))
        assertEquals(Outbox(), outboxFromJson(""))
        assertEquals(Outbox(), outboxFromJson("not json"))
    }

    @Test fun `outboxEntryFromJson rejects an entry missing its chat id`() {
        assertNull(outboxEntryFromJson(JSONObject().put("attempts", 1)))
    }

    // Phase 3: the queue was working but invisible, so a turn that failed on
    // a dropped connection read as lost. The notice is what the chat shows.

    @Test fun `a chat that is not queued shows no notice`() {
        assertNull(outboxNotice(Outbox().enqueued("other"), "c1", 0L))
    }

    @Test fun `a queued chat with no attempt yet waits for the connection`() {
        assertEquals(
            "No connection when this was sent. The reply will be fetched when you're back online.",
            outboxNotice(Outbox().enqueued("c1"), "c1", 0L),
        )
    }

    @Test fun `a retried chat says how many tries and when the next one is`() {
        val outbox = Outbox().enqueued("c1").attempted("c1", 10_000L).attempted("c1", 20_000L)
        // Two attempts: the next one is due 2 s after the last.
        assertEquals("Tried 2 times. Next try in 1 s, or as soon as you're back online.", outboxNotice(outbox, "c1", 21_000L))
        assertEquals("Tried 2 times. Trying again as soon as you're back online.", outboxNotice(outbox, "c1", 30_000L))
    }

    @Test fun `one attempt reads in the singular`() {
        val outbox = Outbox().enqueued("c1").attempted("c1", 0L)
        assertTrue(outboxNotice(outbox, "c1", 0L)!!.startsWith("Tried once."))
    }
}
