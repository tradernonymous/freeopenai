package com.neura.os.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files

// Update-channel hardening: manifest parsing, URL policy, digests,
// redirect handling, capped reads, fetch outcomes, APK verification and the
// result cache. Pure JVM (testDebugUnitTest) -- no Android framework.
class UpdateSecurityTest {

    private val goodManifest = "{\"versionCode\":150,\"versionName\":\"2.0.150\"," +
        "\"url\":\"https://github.com/o/r/releases/download/apk-latest/neuraos.apk\"," +
        "\"notes\":\"Build 150\"}"
    private val manifestUrl = "https://github.com/o/r/releases/download/apk-latest/version.json"

    private class ManifestConnection(url: URL) : HttpURLConnection(url) {
        var code = 200
        var body = ""
        var headers: Map<String, String> = emptyMap()
        var failWith: java.io.IOException? = null

        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy(): Boolean = false
        override fun getResponseCode(): Int {
            failWith?.let { throw it }
            return code
        }
        override fun getHeaderField(name: String?): String? =
            if (name == null) null else headers[name]
        override fun getInputStream(): InputStream {
            failWith?.let { throw it }
            if (code !in 200..299) throw java.io.IOException("no body for HTTP $code")
            return ByteArrayInputStream(body.toByteArray(Charsets.UTF_8))
        }
    }

    private fun conn(code: Int = 200, body: String = goodManifest, headers: Map<String, String> = emptyMap()) =
        ManifestConnection(URL(manifestUrl)).apply {
            this.code = code
            this.body = body
            this.headers = headers
        }

    // --- Manifest URL policy --------------------------------------------

    @Test
    fun manifestUrl_githubVersionJsonAllowed() {
        assertTrue(isUpdateManifestUrl(manifestUrl))
    }

    @Test
    fun manifestUrl_objectStoreHostsAllowed() {
        assertTrue(isUpdateManifestUrl("https://objects.githubusercontent.com/u/12345"))
        assertTrue(isUpdateManifestUrl("https://release-assets.githubusercontent.com/x/y"))
        assertTrue(isUpdateManifestUrl("https://eu.objects.githubusercontent.com/x"))
    }

    @Test
    fun manifestUrl_evilHostRefused() {
        assertFalse(isUpdateManifestUrl("https://evil.com/version.json"))
        assertFalse(isUpdateManifestUrl("https://github.com.evil.com/o/r/version.json"))
    }

    @Test
    fun manifestUrl_httpDowngradeRefused() {
        assertFalse(isUpdateManifestUrl("http://github.com/o/r/releases/download/apk-latest/version.json"))
    }

    @Test
    fun manifestUrl_garbageRefused() {
        assertFalse(isUpdateManifestUrl(""))
        assertFalse(isUpdateManifestUrl("not a url"))
    }

    // --- Download URL policy --------------------------------------------

    @Test
    fun downloadUrl_releaseAssetAllowed() {
        assertTrue(isUpdateDownloadUrl("https://github.com/o/r/releases/download/apk-latest/neuraos.apk"))
    }

    @Test
    fun downloadUrl_nonReleaseGithubPageRefused() {
        assertFalse(isUpdateDownloadUrl("https://github.com/o/r/issues/1"))
        assertFalse(isUpdateDownloadUrl("https://github.com/o/r/blob/main/README.md"))
        assertFalse(isUpdateDownloadUrl("https://gist.github.com/o/abc"))
    }

    @Test
    fun downloadUrl_httpAndForeignHostsRefused() {
        assertFalse(isUpdateDownloadUrl("http://github.com/o/r/releases/download/apk-latest/neuraos.apk"))
        assertFalse(isUpdateDownloadUrl("https://evil.com/releases/download/apk-latest/neuraos.apk"))
        assertFalse(isUpdateDownloadUrl("https://github.com.evil.com/o/r/releases/download/x.apk"))
    }

    @Test
    fun downloadUrl_garbageRefused() {
        assertFalse(isUpdateDownloadUrl(""))
        assertFalse(isUpdateDownloadUrl("not a url"))
    }

    // --- SHA-256 helpers -------------------------------------------------

    @Test
    fun sha256Hex_knownVectors() {
        assertEquals(
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            sha256Hex("hello".toByteArray())
        )
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            sha256Hex(ByteArray(0))
        )
    }

    @Test
    fun normalizeSha256_uppercaseAndWhitespaceNormalised() {
        val upper = "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824"
        assertEquals(upper.lowercase(), normalizeSha256Hex("  $upper  "))
    }

    @Test
    fun normalizeSha256_badShapesRefused() {
        assertNull(normalizeSha256Hex("abc"))
        assertNull(normalizeSha256Hex("zz".repeat(32)))
        assertNull(normalizeSha256Hex("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824!"))
        assertNull(normalizeSha256Hex(null))
        assertNull(normalizeSha256Hex("   "))
    }

    @Test
    fun verifyBytesSha256_matchAndMismatch() {
        val bytes = "hello".toByteArray()
        val hex = sha256Hex(bytes)
        assertTrue(verifyBytesSha256(bytes, hex))
        assertTrue(verifyBytesSha256(bytes, hex.uppercase()))
        assertFalse(verifyBytesSha256("hellp".toByteArray(), hex))
        assertFalse(verifyBytesSha256(bytes, null))
        assertFalse(verifyBytesSha256(bytes, "not-hex"))
    }

    // --- Manifest parsing: sha256 + size --------------------------------

    @Test
    fun parseUpdate_shaValidKeptAndUpperNormalised() {
        val hex = sha256Hex("apk".toByteArray())
        val info = parseUpdateInfo(goodManifest.replace("}", ",\"sha256\":\"${hex.uppercase()}\"}"))!!
        assertEquals(hex, info.sha256)
    }

    @Test
    fun parseUpdate_shaMalformedFailsClosed() {
        assertNull(parseUpdateInfo(goodManifest.replace("}", ",\"sha256\":\"xyz\"}")))
        assertNull(parseUpdateInfo(goodManifest.replace("}", ",\"sha256\":\"${"ab".repeat(31)}\"}")))
    }

    @Test
    fun parseUpdate_sizeValidKeptAbsentNull() {
        assertEquals(30_000_000L, parseUpdateInfo(goodManifest.replace("}", ",\"size\":30000000}"))!!.size)
        assertNull(parseUpdateInfo(goodManifest)!!.size)
    }

    @Test
    fun parseUpdate_absurdSizeFailsClosed() {
        assertNull(parseUpdateInfo(goodManifest.replace("}", ",\"size\":100}")))
        assertNull(parseUpdateInfo(goodManifest.replace("}", ",\"size\":-5}")))
        assertNull(parseUpdateInfo(goodManifest.replace("}", ",\"size\":600000000}")))
    }

    @Test
    fun parseUpdate_versionCodeBoundsEnforced() {
        assertNull(parseUpdateInfo(goodManifest.replace("150,", "0,")))
        assertNull(parseUpdateInfo(goodManifest.replace("150,", "-3,")))
        assertNull(parseUpdateInfo(goodManifest.replace("150,", "10000001,")))
        assertNotNull(parseUpdateInfo(goodManifest.replace("150,", "10000000,")))
    }

    @Test
    fun parseUpdate_versionNameSanitisedAndCapped() {
        val dirty = goodManifest.replace("2.0.150", "2.0.150\u0000\u0007evil")
        assertEquals("2.0.150evil", parseUpdateInfo(dirty)!!.versionName)
        val long = goodManifest.replace("2.0.150", "v".repeat(60))
        assertEquals(32, parseUpdateInfo(long)!!.versionName.length)
    }

    @Test
    fun parseUpdate_notesCappedAt2000() {
        val info = parseUpdateInfo(goodManifest.replace("Build 150", "n".repeat(3000)))!!
        assertEquals(2000, info.notes.length)
    }

    @Test
    fun parseUpdate_oversizedBodyRejected() {
        assertNull(parseUpdateInfo(goodManifest + " ".repeat(70_000)))
        assertNull(parseUpdateInfo(null))
        assertNull(parseUpdateInfo("   "))
        assertNull(parseUpdateInfo("not json"))
    }

    @Test
    fun parseUpdate_downloadPathEnforced() {
        assertNull(parseUpdateInfo(goodManifest.replace("/releases/download/apk-latest/neuraos.apk", "/issues/1")))
        assertNull(parseUpdateInfo(goodManifest.replace("https://github.com", "https://evil.com")))
    }

    // --- Redirect resolution ---------------------------------------------

    @Test
    fun redirect_relativeLocationResolved() {
        val next = resolveUpdateRedirect(manifestUrl, "/u/123/version.json")
        assertEquals("https://github.com/u/123/version.json", next)
    }

    @Test
    fun redirect_objectStoreTargetAllowed() {
        val next = resolveUpdateRedirect(
            manifestUrl,
            "https://objects.githubusercontent.com/u/123?token=abc"
        )
        assertTrue(next!!.startsWith("https://objects.githubusercontent.com/"))
    }

    @Test
    fun redirect_evilHostRefused() {
        assertNull(resolveUpdateRedirect(manifestUrl, "https://evil.com/version.json"))
        assertNull(resolveUpdateRedirect(manifestUrl, "https://github.com.evil.com/x"))
    }

    @Test
    fun redirect_httpDowngradeRefused() {
        assertNull(resolveUpdateRedirect(manifestUrl, "http://github.com/o/r/version.json"))
    }

    @Test
    fun redirect_missingOrGarbageLocationRefused() {
        assertNull(resolveUpdateRedirect(manifestUrl, null))
        assertNull(resolveUpdateRedirect(manifestUrl, "   "))
        assertNull(resolveUpdateRedirect("not a url", "https://github.com/x"))
    }

    // --- Capped reads -----------------------------------------------------

    @Test
    fun cappedRead_underLimitReadsAll() {
        val bytes = "hello".byteInputStream()
        assertEquals("hello", String(readCappedBytes(bytes, 64_000)!!))
    }

    @Test
    fun cappedRead_overLimitIsNull() {
        assertNull(readCappedBytes("y".repeat(70_000).byteInputStream(), UPDATE_MANIFEST_MAX_BYTES))
    }

    @Test
    fun cappedRead_emptyReadsEmpty() {
        assertEquals(0, readCappedBytes(ByteArray(0).inputStream(), 64_000)!!.size)
    }

    // --- Fetch outcomes ---------------------------------------------------

    @Test
    fun fetchResult_badManifestUrlIsBadUrl() {
        val result = fetchUpdateInfoResult("https://evil.com/version.json", 1, opener = { conn() })
        assertTrue(result is UpdateCheckResult.Failed)
        assertEquals(UpdateCheckFailure.BAD_URL, (result as UpdateCheckResult.Failed).reason)
    }

    @Test
    fun fetchResult_http404IsHttpError() {
        val result = fetchUpdateInfoResult(manifestUrl, 1, opener = { conn(code = 404) })
        assertEquals(UpdateCheckResult.Failed(UpdateCheckFailure.HTTP_ERROR), result)
    }

    @Test
    fun fetchResult_junkBodyIsMalformed() {
        val result = fetchUpdateInfoResult(manifestUrl, 1, opener = { conn(body = "not json") })
        assertEquals(UpdateCheckResult.Failed(UpdateCheckFailure.MALFORMED), result)
    }

    @Test
    fun fetchResult_goodManifestIsAvailableWithSignals() {
        val hex = sha256Hex("apk".toByteArray())
        val body = goodManifest.replace("}", ",\"sha256\":\"$hex\",\"size\":30000000}")
        val result = fetchUpdateInfoResult(manifestUrl, 149, opener = { conn(body = body) })
        assertTrue(result is UpdateCheckResult.Available)
        val info = (result as UpdateCheckResult.Available).info
        assertEquals(150, info.versionCode)
        assertEquals(hex, info.sha256)
        assertEquals(30_000_000L, info.size)
    }

    @Test
    fun fetchResult_sameOrNewerInstalledIsCurrent() {
        assertTrue(fetchUpdateInfoResult(manifestUrl, 150, opener = { conn() }) is UpdateCheckResult.Current)
        assertTrue(fetchUpdateInfoResult(manifestUrl, 200, opener = { conn() }) is UpdateCheckResult.Current)
    }

    @Test
    fun fetchResult_redirectToObjectStoreFollowed() {
        val target = "https://objects.githubusercontent.com/u/1/version.json"
        val hops = mapOf(
            manifestUrl to conn(code = 302, headers = mapOf("Location" to target)),
            target to conn()
        )
        val result = fetchUpdateInfoResult(manifestUrl, 149, opener = { hops[it.toString()] ?: conn(code = 404) })
        assertTrue(result is UpdateCheckResult.Available)
        assertEquals(150, (result as UpdateCheckResult.Available).info.versionCode)
    }

    @Test
    fun fetchResult_redirectToEvilIsMalformed() {
        val hopping = conn(code = 302, headers = mapOf("Location" to "https://evil.com/x"))
        val result = fetchUpdateInfoResult(manifestUrl, 149, opener = { hopping })
        assertEquals(UpdateCheckResult.Failed(UpdateCheckFailure.MALFORMED), result)
    }

    @Test
    fun fetchResult_redirectLoopIsMalformed() {
        val loop = conn(code = 302, headers = mapOf("Location" to manifestUrl))
        val result = fetchUpdateInfoResult(manifestUrl, 149, opener = { loop })
        assertEquals(UpdateCheckResult.Failed(UpdateCheckFailure.MALFORMED), result)
    }

    @Test
    fun fetchResult_ioFailureIsOffline() {
        val down = conn().apply { failWith = java.io.IOException("down") }
        val result = fetchUpdateInfoResult(manifestUrl, 149, opener = { down })
        assertEquals(UpdateCheckResult.Failed(UpdateCheckFailure.OFFLINE_OR_NETWORK), result)
    }

    @Test
    fun fetchResult_oversizedBodyIsEmptyOrTooLarge() {
        val big = conn(body = goodManifest + " ".repeat(70_000))
        val result = fetchUpdateInfoResult(manifestUrl, 149, opener = { big })
        assertEquals(UpdateCheckResult.Failed(UpdateCheckFailure.EMPTY_OR_TOO_LARGE), result)
    }

    @Test
    fun fetchLegacy_stillNullOnFailure() {
        assertNull(fetchUpdateInfo(manifestUrl, opener = { conn(code = 500) }))
        assertNull(fetchUpdateInfo("https://evil.com/version.json", opener = { conn() }))
    }

    // --- APK verification -------------------------------------------------

    private fun apkInfo(bytes: ByteArray) = UpdateInfo(
        versionCode = 150,
        versionName = "2.0.150",
        url = "https://github.com/o/r/releases/download/apk-latest/neuraos.apk",
        notes = "",
        sha256 = sha256Hex(bytes),
        size = bytes.size.toLong()
    )

    @Test
    fun verifyApkBytes_allSignalsMatch() {
        val bytes = "fake-apk-bytes".toByteArray()
        assertTrue(verifyApkBytes(bytes, apkInfo(bytes)))
    }

    @Test
    fun verifyApkBytes_sizeMismatchFails() {
        val bytes = "fake-apk-bytes".toByteArray()
        assertFalse(verifyApkBytes(bytes.copyOf(bytes.size - 1), apkInfo(bytes)))
    }

    @Test
    fun verifyApkBytes_shaMismatchFails() {
        val bytes = "fake-apk-bytes".toByteArray()
        val tampered = bytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        // Same length, different content: size passes, digest must fail.
        assertEquals(bytes.size, tampered.size)
        assertFalse(verifyApkBytes(tampered, apkInfo(bytes)))
    }

    @Test
    fun verifyApkBytes_noSignalsPassesAsNothingKnownBad() {
        val info = UpdateInfo(150, "2.0.150", "https://github.com/o/r/releases/download/apk-latest/neuraos.apk", "")
        assertTrue(verifyApkBytes("anything".toByteArray(), info))
    }

    @Test
    fun verifyApkFile_roundTripPasses() {
        val dir = Files.createTempDirectory("apk-test").toFile()
        try {
            val bytes = ByteArray(300_000) { (it % 251).toByte() }
            val file = java.io.File(dir, "good.apk").apply { writeBytes(bytes) }
            assertTrue(verifyApkFile(file, apkInfo(bytes)))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun verifyApkFile_truncatedFails() {
        val dir = Files.createTempDirectory("apk-test").toFile()
        try {
            val bytes = ByteArray(300_000) { (it % 251).toByte() }
            val file = java.io.File(dir, "short.apk").apply { writeBytes(bytes.copyOf(bytes.size / 2)) }
            assertFalse(verifyApkFile(file, apkInfo(bytes)))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun verifyApkFile_tamperedFails() {
        val dir = Files.createTempDirectory("apk-test").toFile()
        try {
            val bytes = ByteArray(300_000) { (it % 251).toByte() }
            val tampered = bytes.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
            // Same size so only the digest can catch it.
            val file = java.io.File(dir, "tampered.apk").apply { writeBytes(tampered) }
            assertFalse(verifyApkFile(file, apkInfo(bytes)))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun verifyApkFile_missingFileFails() {
        val bytes = "fake-apk-bytes".toByteArray()
        assertFalse(verifyApkFile(java.io.File("/nonexistent-dir-xyz/missing.apk"), apkInfo(bytes)))
    }

    // --- Result cache ------------------------------------------------------

    @Test
    fun updateCache_putThenGetHits() {
        UpdateCache.clear()
        val info = parseUpdateInfo(goodManifest)!!
        UpdateCache.put(UpdateCheckResult.Available(info), now = 1_000L)
        assertEquals(UpdateCheckResult.Available(info), UpdateCache.get(now = 1_000L))
        UpdateCache.clear()
    }

    @Test
    fun updateCache_expiredEntryMisses() {
        UpdateCache.clear()
        UpdateCache.put(UpdateCheckResult.Current, now = 1_000L)
        assertNotNull(UpdateCache.get(now = 1_000L + UpdateCache.TTL_MS - 1))
        assertNull(UpdateCache.get(now = 1_000L + UpdateCache.TTL_MS + 1))
        UpdateCache.clear()
    }

    @Test
    fun updateCache_failuresAreNeverCached() {
        UpdateCache.clear()
        UpdateCache.put(UpdateCheckResult.Failed(UpdateCheckFailure.HTTP_ERROR), now = 1_000L)
        assertNull(UpdateCache.get(now = 1_000L))
        UpdateCache.clear()
    }

    @Test
    fun updateCache_clearDropsEntries() {
        UpdateCache.clear()
        UpdateCache.put(UpdateCheckResult.Current, now = 5_000L)
        UpdateCache.clear()
        assertNull(UpdateCache.get(now = 5_000L))
    }

    // --- Availability ------------------------------------------------------

    @Test
    fun updateAvailable_newerOlderAndNull() {
        val info = parseUpdateInfo(goodManifest)!!
        assertTrue(updateAvailable(info, 149))
        assertFalse(updateAvailable(info, 150))
        assertFalse(updateAvailable(info, 999))
        assertFalse(updateAvailable(null, 1))
    }
}
