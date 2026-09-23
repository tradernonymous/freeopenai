package com.neura.os.app.data

import org.json.JSONObject

// Puter sign-in through the phone's real browser. Google, Apple and Microsoft
// refuse to sign anyone in inside an app's WebView (Google answers
// disallowed_useragent), and disguising the WebView to get past that is what
// they ban. Puter's own SDK has a second sign-in path that needs no popup --
// the one it takes on a cross-origin-isolated page (Auth.js, signIn): the
// sign-in page carries a random session id, and the SDK polls POST
// /login/wait with that id until Puter answers with the account's token, then
// calls puter.setAuthToken. The desktop app drives the same path
// (desktop/src/puter.js). Here the page opens in a Custom Tab, so every
// sign-in button works, and PuterBridge does the polling and hands the token to
// the hidden bridge page. This file is the pure part of that.

const val PUTER_GUI_ORIGIN = "https://puter.com"
const val PUTER_API_ORIGIN = "https://api.puter.com"

/** Long enough to find the tab, type a password, maybe do 2FA. */
const val PUTER_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000L
const val PUTER_SIGN_IN_POLL_MS = 2000L

/** A token longer than this is not one Puter issued. */
private const val PUTER_TOKEN_MAX = 4096

private val SESSION_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
private val TOKEN_CHARS = Regex("^[\\x21-\\x7e]+$")

/** The session id is a random UUID, the same shape the SDK makes. */
fun isSignInSession(session: String?): Boolean = session != null && SESSION_ID.matches(session)

/** The sign-in page for [session], in the shape the SDK itself builds. */
fun puterSignInUrl(session: String): String {
    require(isSignInSession(session)) { "not a sign-in session" }
    return "$PUTER_GUI_ORIGIN/action/sign-in?embedded_in_popup=true&msg_id=1&cross_origin_isolated=true&signin_session=$session"
}

/** Where the token for a session is waited for. Pinned, never taken from a URL. */
const val PUTER_WAIT_URL = "$PUTER_API_ORIGIN/login/wait"

fun puterWaitBody(session: String): String = JSONObject().put("session", session).toString()

/** The token in a /login/wait answer, or null while there is none yet (or the
 * answer is not one). Only printable ASCII, so it can never break out of the
 * script it is placed in. */
fun puterTokenFrom(body: String?): String? {
    if (body.isNullOrBlank()) return null
    return try {
        val token = JSONObject(body).optString("auth_token", "")
        if (token.length in 1..PUTER_TOKEN_MAX && TOKEN_CHARS.matches(token)) token else null
    } catch (e: Exception) {
        null
    }
}

/** Hands the token to the bridge page's SDK, the step its own sign-in ends
 * with; answers "ok", "nosdk" or "error". */
fun setPuterTokenScript(token: String): String {
    require(TOKEN_CHARS.matches(token)) { "not a token" }
    return "(function(){ try { if (!window.puter || typeof puter.setAuthToken !== 'function') return 'nosdk';" +
        " puter.setAuthToken(" + JSONObject.quote(token) + "); return 'ok'; } catch (e) { return 'error'; } })()"
}
