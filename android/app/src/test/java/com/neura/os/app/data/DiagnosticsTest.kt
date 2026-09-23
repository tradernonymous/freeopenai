package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// "Copy diagnostics" is the text a person pastes into a bug report. Same
// contract as the desktop's (test/desktop-diagnostics.test.js): it has to say
// enough to find the problem, and contain nothing they would regret pasting.
class DiagnosticsTest {

    private val now = 1_000_000_000L

    private fun input(
        server: String = "https://neura.example.app",
        failures: List<FailureRecord> = emptyList(),
        startupMs: Long? = null,
        catalogueError: String? = null,
    ) = DiagnosticsInput(
        version = "2.0.218",
        versionCode = 218,
        androidRelease = "16",
        sdkInt = 36,
        device = "samsung SM-A515F",
        server = server,
        signedIn = true,
        providers = listOf(ProviderInfo("nara", "Nara", true, "chat"), ProviderInfo("kilocode", "Kilo Code", true, "chat")),
        catalogueError = catalogueError,
        outboxDepth = 2,
        deviceControl = false,
        puterImages = true,
        startupMs = startupMs,
        failures = failures,
        now = now,
    )

    @Test fun `the report carries what is needed to find a failure`() {
        val ring = FailureRing().record(now - 90_000, "chat", "nara/some-model: 502 upstream timed out")
        val report = buildDiagnostics(input(failures = ring.items, catalogueError = "The server has no chat provider configured."))
        assertTrue(report.startsWith("NeuraOS Android 2.0.218 (218)"))
        assertTrue(report.contains("server     https://neura.example.app"))
        assertTrue(report.contains("signed in  yes"))
        assertTrue(report.contains("android    16 (API 36) · samsung SM-A515F"))
        assertTrue(report.contains("providers  nara, kilocode"))
        assertTrue(report.contains("catalogue  The server has no chat provider configured."))
        assertTrue(report.contains("outbox     2 chats waiting to retry"))
        assertTrue(report.contains("device ctl off"))
        assertTrue(report.contains("--- recent problems, newest first ---"))
        assertTrue(report.contains("1 min ago  chat  nara/some-model: 502 upstream timed out"))
    }

    @Test fun `nothing credential-shaped survives into the report`() {
        val ring = FailureRing()
            .record(now, "chat", "Bearer abc.def.ghi rejected")
            .record(now, "github", "token ghp_ABCDEFGHIJKLMNOP and github_pat_ABCDEFGH_12345678 refused")
            .record(now, "provider", "key sk-ABCDEFGHIJKL and hf_ABCDEFGHIJKL leaked")
            .record(now, "session", "Cookie: fo_auth=s3cr3t.value; fo_gh=another")
        val report = buildDiagnostics(input(server = "https://neura.example.app/?token=secret#frag", failures = ring.items))
        for (secret in listOf("abc.def.ghi", "ghp_ABCDEFGHIJKLMNOP", "github_pat_ABCDEFGH_12345678", "sk-ABCDEFGHIJKL", "hf_ABCDEFGHIJKL", "s3cr3t.value", "another", "token=secret")) {
            assertFalse("$secret leaked into the report", report.contains(secret))
        }
        assertTrue(report.contains("server     https://neura.example.app/?<redacted>"))
    }

    @Test fun `a quiet app says so rather than printing an empty section`() {
        val report = buildDiagnostics(input())
        assertTrue(report.contains("--- recent problems, newest first ---"))
        assertTrue(report.contains("none since the app started"))
    }

    @Test fun `the ring keeps the newest fifty, newest first, and flattens each reason`() {
        var ring = FailureRing()
        for (i in 1..60) ring = ring.record(i.toLong(), "chat", "problem $i\n  on two lines")
        assertEquals(FAILURE_RING_MAX, ring.items.size)
        assertEquals("problem 60 on two lines", ring.items.first().reason)
        assertEquals("problem 11 on two lines", ring.items.last().reason)
    }

    @Test fun `a long reason is clipped and an empty one still says something`() {
        val ring = FailureRing().record(now, "image", "x".repeat(500)).record(now, "chat", "   ")
        assertEquals("failed", ring.items[0].reason)
        assertEquals(200, ring.items[1].reason.length)
    }

    @Test fun `startup time is reported against its target once measured`() {
        assertTrue(buildDiagnostics(input(startupMs = 840)).contains("startup    840 ms (target under 2000 ms: met)"))
        assertTrue(buildDiagnostics(input(startupMs = 2600)).contains("startup    2600 ms (target under 2000 ms: missed)"))
        assertFalse(buildDiagnostics(input()).contains("startup "))
    }

    @Test fun `ages read the way a person would say them`() {
        assertEquals("just now", agoLabel(10_000))
        assertEquals("1 min ago", agoLabel(90_000))
        assertEquals("2 h ago", agoLabel(2 * 3_600_000L + 5))
        assertEquals("3 d ago", agoLabel(3 * 86_400_000L))
    }
}
