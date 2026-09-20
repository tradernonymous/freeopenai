package com.neura.os.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

// Transport-failure retry policy only: no Android framework, no network.
// These run with plain JUnit on CI (testDebugUnitTest), which is why the
// policy is a pure function (retryNetwork + networkBackoffMs) rather than
// something tangled up in HttpURLConnection.
class ApiRetryTest {

    @Test
    fun retryNetwork_returnsOnFirstSuccess() {
        var calls = 0
        val result = retryNetwork(attempts = 3, backoffMs = 1L) { calls++; "ok" }
        assertEquals("ok", result)
        assertEquals(1, calls)
    }

    @Test
    fun retryNetwork_retriesTransientFailuresThenSucceeds() {
        var calls = 0
        val result = retryNetwork(attempts = 3, backoffMs = 1L) {
            calls++
            if (calls < 3) throw IOException("blip")
            "recovered"
        }
        assertEquals("recovered", result)
        assertEquals(3, calls)
    }

    @Test
    fun retryNetwork_givesUpAfterAttempts() {
        var calls = 0
        val e = assertThrows(ApiException::class.java) {
            retryNetwork(attempts = 2, backoffMs = 1L) { calls++; throw IOException("down") }
        }
        assertEquals(2, calls)
        assertTrue(e.message?.startsWith("Could not reach the server") == true)
    }

    @Test
    fun retryNetwork_neverRetriesServerDecidedFailure() {
        var calls = 0
        val e = assertThrows(ApiException::class.java) {
            retryNetwork(attempts = 3, backoffMs = 1L) {
                calls++
                throw ApiException("Invalid username or password.")
            }
        }
        assertEquals(1, calls)
        assertEquals("Invalid username or password.", e.message)
    }

    @Test
    fun retryNetwork_refusesInvalidBudget() {
        assertThrows(IllegalArgumentException::class.java) {
            retryNetwork(attempts = 0) { "unused" }
        }
    }

    @Test
    fun backoffIsLinearFromBase() {
        assertEquals(250L, networkBackoffMs(1, 250L))
        assertEquals(500L, networkBackoffMs(2, 250L))
        assertEquals(1500L, networkBackoffMs(3, 500L))
        assertEquals(0L, networkBackoffMs(0, 0L))
    }

    @Test
    fun chatApi_loginRetriesTransportFailures() {
        var calls = 0
        val api = ChatApi("https://x", attempts = 4, backoffMs = 1L) {
            calls++
            throw IOException("signal blip")
        }
        val e = assertThrows(ApiException::class.java) { api.login("u", "p") }
        assertEquals(4, calls)
        assertTrue(e.message?.startsWith("Could not reach the server") == true)
    }
}