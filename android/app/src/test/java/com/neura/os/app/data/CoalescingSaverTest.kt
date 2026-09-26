package com.neura.os.app.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

// A real bug (master plan v2 review batch): a chat's streaming draft was
// persisted every STREAM_PERSIST_MS and again at turn end, both fired
// through launchIo, whose pool does not run jobs in submission order. A
// slow, stale periodic save could finish after the end-of-turn save and
// silently overwrite the finished reply on disk. CoalescingSaver is the
// fix: only the most recently queued value per key is ever written, and
// never two saves for the same key at once.
class CoalescingSaverTest {
    private fun scope() = CoroutineScope(Dispatchers.Default + SupervisorJob())

    @Test
    fun onlyTheLatestValueQueuedDuringASlowSave_isWrittenNext() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val saved = CopyOnWriteArrayList<Int>()
        val saver = CoalescingSaver<String, Int>(scope(), Dispatchers.Default) { value ->
            if (value == 1) {
                started.countDown()
                release.await(2, TimeUnit.SECONDS)
            }
            saved += value
        }

        saver.queue("chat-1", 1)
        assertTrue("the first save should have started", started.await(2, TimeUnit.SECONDS))
        // Queued while the first save (value 1) is still blocked inside `save`,
        // so both must coalesce into a single write of the newest value once
        // the first save releases.
        saver.queue("chat-1", 2)
        saver.queue("chat-1", 3)
        release.countDown()

        val deadline = System.currentTimeMillis() + 2_000
        while (saved.size < 2 && System.currentTimeMillis() < deadline) Thread.sleep(10)

        assertEquals(listOf(1, 3), saved)
    }

    @Test
    fun neverRunsTwoSavesForTheSameKeyAtOnce() {
        val overlap = AtomicBoolean(false)
        val active = AtomicInteger(0)
        val calls = AtomicInteger(0)
        val saver = CoalescingSaver<String, Int>(scope(), Dispatchers.Default) { _ ->
            if (active.incrementAndGet() > 1) overlap.set(true)
            Thread.sleep(3)
            active.decrementAndGet()
            calls.incrementAndGet()
        }
        // Ten threads racing to queue the same key concurrently -- this is
        // what a periodic persist tick and an end-of-turn save look like
        // when they happen to land close together.
        val threads = (0 until 10).map { i -> Thread { saver.queue("chat-1", i) } }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        val deadline = System.currentTimeMillis() + 2_000
        while (active.get() > 0 && System.currentTimeMillis() < deadline) Thread.sleep(5)
        Thread.sleep(50)

        assertFalse("save() must never run twice for the same key at once", overlap.get())
        assertTrue("at least one save should have run", calls.get() >= 1)
    }

    @Test
    fun differentKeys_saveIndependentlyAndBothComplete() {
        val saved = CopyOnWriteArrayList<String>()
        val done = CountDownLatch(2)
        val saver = CoalescingSaver<String, String>(scope(), Dispatchers.Default) { value ->
            saved += value
            done.countDown()
        }
        saver.queue("chat-1", "a")
        saver.queue("chat-2", "b")
        assertTrue(done.await(2, TimeUnit.SECONDS))
        assertEquals(setOf("a", "b"), saved.toSet())
    }
}
