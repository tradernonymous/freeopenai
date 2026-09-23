package com.neura.os.app.data

import com.neura.os.app.ApiException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// The cold streams under a reply and a build (master plan v2, V3): stopping
// really closes the connection, a new collection starts afresh, and a failure
// reaches the collector instead of vanishing on a worker thread.
class StreamsTest {

    /** A connection that "reads" until it is disconnected, like a socket. */
    private class FakeConnection : HttpURLConnection(URL("https://example.com/")) {
        val closed = CountDownLatch(1)
        override fun disconnect() = closed.countDown()
        override fun usingProxy() = false
        override fun connect() = Unit
    }

    /** Emits 1, 2, 3 … until the connection closes; then, like the real
     * readers, stays quiet if the handle was cleared (a Stop). */
    private fun endless(opened: MutableList<FakeConnection>) = connectionFlow<Int> { handle, emit ->
        val conn = FakeConnection()
        synchronized(opened) { opened += conn }
        handle.set(conn)
        var n = 0
        while (!conn.closed.await(5, TimeUnit.MILLISECONDS)) emit(++n)
    }

    @Test fun `stopping the collector closes the connection`() = runBlocking {
        val opened = mutableListOf<FakeConnection>()
        withTimeout(5_000) { endless(opened).first { it >= 3 } }
        assertEquals(1, opened.size)
        assertTrue("disconnected on Stop", opened[0].closed.await(2, TimeUnit.SECONDS))
    }

    @Test fun `a Stop before the connection was handed over still closes it`() = runBlocking {
        val conn = FakeConnection()
        val handedOver = CountDownLatch(1)
        val stream = connectionFlow<Int> { handle, emit ->
            emit(0) // the collector takes this and stops...
            handedOver.await(2, TimeUnit.SECONDS)
            handle.set(conn) // ...before the reader has set its connection
            var n = 0
            while (!conn.closed.await(5, TimeUnit.MILLISECONDS) && n < 400) emit(++n)
        }
        withTimeout(5_000) { stream.first() }
        handedOver.countDown()
        assertTrue("closed at the next emit", conn.closed.await(2, TimeUnit.SECONDS))
    }

    @Test fun `collecting again opens a new connection`() = runBlocking {
        val opened = mutableListOf<FakeConnection>()
        val stream = endless(opened)
        withTimeout(5_000) { stream.first() }
        withTimeout(5_000) { stream.first() }
        assertEquals(2, opened.size)
        assertTrue(opened.all { it.closed.await(2, TimeUnit.SECONDS) })
    }

    @Test fun `a reader that ends completes the flow, and its failure reaches the collector`() = runBlocking {
        val done = connectionFlow<Int> { _, emit -> emit(1); emit(2) }
        assertEquals(listOf(1, 2), withTimeout(5_000) { done.toList() })
        val broken = connectionFlow<Int> { _, emit -> emit(1); throw ApiException("Session expired.", true) }
        try {
            withTimeout(5_000) { broken.toList() }
            fail("expected the reader's failure")
        } catch (e: ApiException) {
            assertTrue(e.authRequired)
        }
    }

    @Test fun `a dropped stream resumes from the last position, with growing pauses`() = runTest {
        val asked = mutableListOf<Long>()
        var calls = 0
        val updates = resumable(maxReconnects = 3, positionOf = { it.toLong() }) { after ->
            asked += after
            calls++
            flow {
                when (calls) {
                    1 -> { emit(1); emit(2); throw ApiException("Connection lost") }
                    2 -> throw ApiException("Connection lost")
                    else -> { emit(3); emit(4) }
                }
            }
        }.toList()
        assertEquals(listOf(0L, 2L, 2L), asked)
        assertEquals(
            listOf(StreamUpdate.Item(1), StreamUpdate.Item(2), StreamUpdate.Reconnecting(1), StreamUpdate.Reconnecting(2), StreamUpdate.Item(3), StreamUpdate.Item(4)),
            updates,
        )
        // 1 s then 2 s of virtual time: the pauses really happened.
        assertEquals(3_000L, testScheduler.currentTime)
    }

    @Test fun `too many drops in a row ends offline`() = runTest {
        val updates = resumable<Int>(maxReconnects = 2, positionOf = { it.toLong() }) { flow { throw ApiException("down") } }.toList()
        assertEquals(listOf(StreamUpdate.Reconnecting(1), StreamUpdate.Reconnecting(2), StreamUpdate.Offline), updates)
    }

    @Test fun `the pause grows and is capped`() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L), (1..6).map(::reconnectDelayMs))
    }
}
