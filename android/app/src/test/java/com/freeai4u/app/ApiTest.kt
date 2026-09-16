package com.freeai4u.app

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

// Protocol and policy only: no Android framework, no network. These run with
// plain JUnit on CI (testDebugUnitTest), which is why the HTTP layer is kept
// thin and everything decidable lives in pure functions.
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
        assertTrue(normalizeBaseUrl("http://evil.example.com") is BaseUrlResult.Problem)
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

    // --- Where the shell lets a navigation go -----------------------------

    @Test
    fun origin_dropsPathAndDefaultPort() {
        assertEquals("https://abc.up.railway.app", originOf("https://ABC.up.railway.app/chat?x=1"))
        assertEquals("https://abc.up.railway.app", originOf("https://abc.up.railway.app:443/"))
        assertEquals("http://192.168.1.10:8080", originOf("http://192.168.1.10:8080/login.html"))
    }

    @Test
    fun sameOrigin_isSchemeHostAndPort() {
        val origin = "https://abc.up.railway.app"
        assertTrue(sameOrigin(origin, "https://abc.up.railway.app/api/llm/chat"))
        assertFalse(sameOrigin(origin, "http://abc.up.railway.app/"))
        assertFalse(sameOrigin(origin, "https://abc.up.railway.app.evil.com/"))
        assertFalse(sameOrigin(origin, "https://evil.com/abc.up.railway.app"))
        assertFalse(sameOrigin(origin, "not a url"))
        assertFalse(sameOrigin("", "https://abc.up.railway.app/"))
    }

    @Test
    fun staysInShell_ownOriginAndGithubSignInOnly() {
        val origin = "https://abc.up.railway.app"
        assertTrue(staysInShell(origin, "https://abc.up.railway.app/"))
        assertTrue(staysInShell(origin, "https://github.com/login/oauth/authorize?client_id=x"))
        assertFalse(staysInShell(origin, "http://github.com/login"))
        assertFalse(staysInShell(origin, "https://gist.github.com/x"))
        assertFalse(staysInShell(origin, "https://example.com/"))
    }

    @Test
    fun popupAllowed_puterAndOwnOriginOnly() {
        val origin = "https://abc.up.railway.app"
        assertTrue(popupAllowed(origin, "https://puter.com/action/sign-in"))
        assertTrue(popupAllowed(origin, "https://api.puter.com/x"))
        assertTrue(popupAllowed(origin, "https://abc.up.railway.app/x"))
        assertFalse(popupAllowed(origin, "https://notputer.com/"))
        assertFalse(popupAllowed(origin, "https://puter.com.evil.com/"))
        assertFalse(popupAllowed(origin, "http://puter.com/"))
        assertFalse(popupAllowed(origin, null))
    }

    // --- What happens at launch -------------------------------------------

    @Test
    fun launch_asksForTheServerFirst() {
        assertEquals(Launch.ASK_SERVER, launchStep(null, "u", "p", "s"))
        assertEquals(Launch.ASK_SERVER, launchStep("  ", "u", "p", "s"))
    }

    @Test
    fun launch_checksAStoredSessionBeforeAnythingElse() {
        assertEquals(Launch.CHECK_SESSION, launchStep("https://x", null, null, "sess"))
        assertEquals(Launch.CHECK_SESSION, launchStep("https://x", "u", "p", "sess"))
    }

    @Test
    fun launch_signsInFromTheStoredPasswordWhenThereIsNoSession() {
        assertEquals(Launch.SIGN_IN, launchStep("https://x", "u", "p", null))
        assertEquals(Launch.ASK_PASSWORD, launchStep("https://x", "u", null, null))
        assertEquals(Launch.ASK_PASSWORD, launchStep("https://x", null, "p", ""))
    }

    // --- Downloads --------------------------------------------------------

    @Test
    fun dataUrl_base64AndPlain() {
        val png = decodeDataUrl("data:image/png;base64,aGVsbG8=")
        assertEquals("image/png", png!!.first)
        assertArrayEquals("hello".toByteArray(), png.second)
        val text = decodeDataUrl("data:text/plain,hi%20there")
        assertEquals("text/plain", text!!.first)
        assertEquals("hi there", String(text.second))
        assertEquals("application/octet-stream", decodeDataUrl("data:,x")!!.first)
        assertNull(decodeDataUrl("blob:https://x/abc"))
        assertNull(decodeDataUrl("data:image/png;base64"))
    }

    // --- The session contract, over HTTP-shaped fakes ---------------------

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
    fun login_throttleIsNotAWrongPassword() {
        val fake = FakeConnection(URL("http://x/api/login"))
        fake.code = 429
        val api = ChatApi("http://x", opener = { fake })
        val thrown = assertThrows(ApiException::class.java) { api.login("a", "b") }
        assertFalse("a throttle must not make the app forget the password", thrown.authRequired)
    }

    @Test
    fun session_carriesTheCookieAndReadsWhoIsSignedIn() {
        val fake = FakeConnection(URL("http://x/api/session"))
        fake.code = 200
        fake.body = "{\"gate\":true,\"user\":\"phone\",\"expiresAt\":1}"
        val api = ChatApi("http://x", opener = { fake })
        api.sessionCookie = "sess.123"
        val state = api.session()
        assertEquals("fo_auth=sess.123", fake.sentHeaders["Cookie"])
        assertTrue(state.gated)
        assertEquals("phone", state.user)
        assertNull("no renewal offered, none taken", api.renewedCookie)
    }

    @Test
    fun session_keepsARenewedCookie() {
        val fake = FakeConnection(URL("http://x/api/session"))
        fake.code = 200
        fake.body = "{\"gate\":true,\"user\":\"phone\"}"
        fake.setCookie = "fo_auth=fresh.token; HttpOnly; Path=/; Max-Age=604800"
        val api = ChatApi("http://x", opener = { fake })
        api.sessionCookie = "old.token"
        api.session()
        assertEquals("fresh.token", api.renewedCookie)
    }

    @Test
    fun session_openDeploymentIsUngated() {
        val fake = FakeConnection(URL("http://x/api/session"))
        fake.code = 200
        fake.body = "{\"gate\":false,\"user\":null}"
        val state = ChatApi("http://x", opener = { fake }).session()
        assertFalse(state.gated)
        assertNull(state.user)
    }

    @Test
    fun session_expiredSurfacesAuthRequired() {
        val fake = FakeConnection(URL("http://x/api/session"))
        fake.code = 401
        val api = ChatApi("http://x", opener = { fake })
        api.sessionCookie = "stale"
        val thrown = assertThrows(ApiException::class.java) { api.session() }
        assertTrue(thrown.authRequired)
    }
}
