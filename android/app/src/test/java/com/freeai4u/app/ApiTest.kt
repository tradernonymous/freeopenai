package com.freeai4u.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Protocol parsing only: no Android framework, no network. These run with
// plain JUnit on CI (testDebugUnitTest), which is why the HTTP layer above is
// kept thin and everything decidable lives in pure functions.
class ApiTest {

    @Test
    fun baseUrl_gainsHttpsWhenBare() {
        val result = normalizeBaseUrl("abc.up.railway.app")
        assertTrue(result is BaseUrlResult.Ok)
        assertEquals("https://abc.up.railway.app", (result as BaseUrlResult.Ok).url)
    }

    @Test
    fun baseUrl_trimsAndKeepsHttps() {
        val result = normalizeBaseUrl("  https://abc.up.railway.app/ ")
        assertEquals("https://abc.up.railway.app", (result as BaseUrlResult.Ok).url)
    }

    @Test
    fun baseUrl_refusesCleartextOffDevice() {
        val result = normalizeBaseUrl("http://evil.example.com")
        assertTrue(result is BaseUrlResult.Problem)
    }

    @Test
    fun baseUrl_allowsLoopbackHttpForLocalTesting() {
        assertEquals("http://127.0.0.1:11434", (normalizeBaseUrl("http://127.0.0.1:11434") as BaseUrlResult.Ok).url)
        assertEquals("http://192.168.1.10:8080", (normalizeBaseUrl("http://192.168.1.10:8080") as BaseUrlResult.Ok).url)
        assertTrue(normalizeBaseUrl("http://172.15.0.9") is BaseUrlResult.Problem)
        assertEquals("http://172.20.0.9", (normalizeBaseUrl("http://172.20.0.9") as BaseUrlResult.Ok).url)
    }

    @Test
    fun baseUrl_emptyIsAProblem() {
        assertTrue(normalizeBaseUrl("   ") is BaseUrlResult.Problem)
    }

    @Test
    fun freePricing_missingOrZeroIsFree() {
        assertTrue(isFreePricing(null))
        assertTrue(isFreePricing(JSONObject()))
        assertTrue(isFreePricing(JSONObject("{\"prompt\":\"0\",\"completion\":\"0\"}")))
        assertTrue(isFreePricing(JSONObject("{\"prompt\":0,\"completion\":0}")))
    }

    @Test
    fun freePricing_pricedIsNotFree() {
        assertTrue(!isFreePricing(JSONObject("{\"prompt\":\"0.000003\",\"completion\":\"0.000009\"}")))
        assertTrue(!isFreePricing(JSONObject("{\"prompt\":0}")))
    }

    @Test
    fun sse_deltaFrameYieldsText() {
        val event = parseSseLine("data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}")
        assertTrue(event is SseEvent.Delta)
        assertEquals("Hel", (event as SseEvent.Delta).text)
    }

    @Test
    fun sse_leadingSpaceBelongsToTheMessage() {
        // The spec strips exactly one space after the colon; a second one is
        // message content, and eating it would glue words together mid-stream.
        val event = parseSseLine("data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}")
        assertEquals(" world", (event as SseEvent.Delta).text)
    }

    @Test
    fun sse_doneAndNoise() {
        assertTrue(parseSseLine("data: [DONE]") is SseEvent.Done)
        assertTrue(parseSseLine("") is SseEvent.Skip)
        assertTrue(parseSseLine(":keepalive") is SseEvent.Skip)
        assertTrue(parseSseLine("data: not-json{{{") is SseEvent.Skip)
    }

    @Test
    fun sse_errorShapesBecomeFailures() {
        assertEquals("boom", ((parseSseLine("data: {\"error\":\"boom\"}") as SseEvent.Failure).message))
        assertEquals("nope", ((parseSseLine("data: {\"error\":{\"message\":\"nope\"}}") as SseEvent.Failure).message))
        assertEquals("half there", ((parseSseLine("data: {\"partial\":true,\"notice\":\"half there\"}") as SseEvent.Failure).message))
    }
}
