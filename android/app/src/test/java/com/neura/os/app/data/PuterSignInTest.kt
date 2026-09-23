package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

// Puter sign-in in the phone's browser: the page opened, the answer read, and
// the one line of script that hands the token over. A token reaches a script
// here, so what counts as one is checked tightly.
class PuterSignInTest {

    private val session = UUID.randomUUID().toString()

    @Test fun `the sign-in page carries the session the way the SDK builds it`() {
        val url = puterSignInUrl(session)
        assertTrue(url.startsWith("https://puter.com/action/sign-in?"))
        assertTrue(url.contains("cross_origin_isolated=true"))
        assertTrue(url.endsWith("&signin_session=$session"))
    }

    @Test fun `only a random UUID is a session`() {
        assertTrue(isSignInSession(session))
        assertFalse(isSignInSession(null))
        assertFalse(isSignInSession("abc"))
        assertFalse(isSignInSession("$session&x=1"))
        assertTrue(runCatching { puterSignInUrl("evil&redirect=x") }.isFailure)
    }

    @Test fun `the wait call asks for this session and nothing else`() {
        assertEquals("https://api.puter.com/login/wait", PUTER_WAIT_URL)
        assertEquals("{\"session\":\"$session\"}", puterWaitBody(session))
    }

    @Test fun `a token is read from the answer, and anything else is not one`() {
        assertEquals("abc.def-123", puterTokenFrom("""{"auth_token":"abc.def-123"}"""))
        assertNull(puterTokenFrom(null))
        assertNull(puterTokenFrom(""))
        assertNull(puterTokenFrom("not json"))
        assertNull(puterTokenFrom("""{"auth_token":""}"""))
        assertNull(puterTokenFrom("""{"other":"x"}"""))
        assertNull(puterTokenFrom("""{"auth_token":"has space"}"""))
        assertNull(puterTokenFrom("""{"auth_token":"line\nbreak"}"""))
        assertNull(puterTokenFrom("""{"auth_token":"${"x".repeat(5000)}"}"""))
    }

    @Test fun `the token lands in the script as one quoted string`() {
        val script = setPuterTokenScript("tok\"en')")
        assertTrue(script.contains("puter.setAuthToken(\"tok\\\"en')\")"))
        assertTrue(runCatching { setPuterTokenScript("a b") }.isFailure)
    }
}
