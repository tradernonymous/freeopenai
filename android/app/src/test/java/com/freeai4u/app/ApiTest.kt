package com.freeai4u.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

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

    // A fake transport: the login/session contract is HTTP-shaped, so it is
    // tested over HTTP-shaped fakes rather than described.
    private class FakeConnection(url: URL) : HttpURLConnection(url) {
        var code = 200
        var body = ""
        var errorBody = ""
        var setCookie: String? = null
        val sentHeaders = mutableMapOf<String, String>()
        val sentBody = StringBuilder()

        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy(): Boolean = false
        override fun getResponseCode(): Int = code
        override fun getHeaderField(name: String?): String? =
            if (name == "Set-Cookie") setCookie else null

        override fun getInputStream(): InputStream = body.byteInputStream()
        override fun getErrorStream(): InputStream = errorBody.byteInputStream()
        override fun getOutputStream(): OutputStream = object : ByteArrayOutputStream() {
            override fun close() {
                sentBody.append(toString("UTF-8"))
            }
        }

        override fun setRequestProperty(key: String, value: String?) {
            if (value != null) sentHeaders[key] = value
        }
    }

    @Test
    fun parseSessionCookie_readsFirstPair() {
        assertEquals("abc.def", parseSessionCookie("fo_auth=abc.def; HttpOnly; Path=/; Max-Age=999"))
        assertEquals("v", parseSessionCookie("other=1, fo_auth=v; Path=/"))
        assertEquals(null, parseSessionCookie(null))
        assertEquals(null, parseSessionCookie("other=1"))
        assertEquals(null, parseSessionCookie("fo_auth=; Path=/"))
    }

    @Test
    fun login_postsCredentialsAndKeepsTheSession() {
        val fake = FakeConnection(URL("http://x/api/login"))
        fake.code = 200
        fake.setCookie = "fo_auth=abc.def; HttpOnly; Path=/; Max-Age=999"
        val api = ChatApi("http://x", opener = { fake })
        assertEquals("abc.def", api.login("jack", "s3cret"))
        val sent = JSONObject(fake.sentBody.toString())
        assertEquals("jack", sent.getString("username"))
        assertEquals("s3cret", sent.getString("password"))
    }

    @Test
    fun login_refusalCarriesTheServerMessage() {
        val fake = FakeConnection(URL("http://x/api/login"))
        fake.code = 401
        fake.errorBody = "{\"error\":\"Invalid username or password.\"}"
        val api = ChatApi("http://x", opener = { fake })
        val thrown = assertThrows(ApiException::class.java) { api.login("a", "b") }
        assertTrue(thrown.authRequired)
        assertEquals("Invalid username or password.", thrown.message)
    }

    @Test
    fun authedCallsCarryTheCookie() {
        val fake = FakeConnection(URL("http://x/api/llm/models"))
        fake.code = 200
        fake.body = "[]"
        val api = ChatApi("http://x", opener = { fake })
        api.sessionCookie = "sess.123"
        api.models("nara")
        assertEquals("fo_auth=sess.123", fake.sentHeaders["Cookie"])
    }

    @Test
    fun expiredSessionSurfacesAuthRequired() {
        val fake = FakeConnection(URL("http://x/api/llm/models"))
        fake.code = 401
        val api = ChatApi("http://x", opener = { fake })
        api.sessionCookie = "stale"
        val thrown = assertThrows(ApiException::class.java) { api.models("nara") }
        assertTrue(thrown.authRequired)
    }

    @Test
    fun sse_errorShapesBecomeFailures() {
        assertEquals("boom", ((parseSseLine("data: {\"error\":\"boom\"}") as SseEvent.Failure).message))
        assertEquals("nope", ((parseSseLine("data: {\"error\":{\"message\":\"nope\"}}") as SseEvent.Failure).message))
        assertEquals("half there", ((parseSseLine("data: {\"partial\":true,\"notice\":\"half there\"}") as SseEvent.Failure).message))
    }
}
