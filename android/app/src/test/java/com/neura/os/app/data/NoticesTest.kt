package com.neura.os.app.data

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Notices are one-shot: each is shown once, in order, even if it was posted
// before anything was listening, and none is shown twice.
class NoticesTest {

    @Test fun `notices posted before anyone listens arrive later, in order`() = runTest {
        val queue = NoticeQueue()
        queue.post("Saved")
        queue.post("Connected to GitHub")
        assertEquals(listOf("Saved", "Connected to GitHub"), queue.notices.take(2).toList())
    }

    @Test fun `a notice is delivered once, never replayed`() = runTest {
        val queue = NoticeQueue()
        queue.post("Saved")
        assertEquals("Saved", queue.notices.first())
        assertNull(withTimeoutOrNull(50) { queue.notices.first() })
    }

    @Test fun `blank notices are ignored and a full queue refuses instead of blocking`() = runTest {
        val queue = NoticeQueue(capacity = 1)
        assertFalse(queue.post(null))
        assertFalse(queue.post("   "))
        assertTrue(queue.post("one"))
        assertFalse(queue.post("two"))
        assertEquals("one", queue.notices.first())
    }
}
