package com.neura.os.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorsTest {
    @Test
    fun providerKeysAreMasked() {
        val masked = maskSecrets("401 Incorrect API key provided: sk-abcdefghijklmnop1234. Check nvapi-XYZ123456789 too.")
        assertFalse(masked.contains("sk-abcdefghijklmnop1234"))
        assertFalse(masked.contains("nvapi-XYZ123456789"))
        assertTrue(masked.contains("•••"))
    }

    @Test
    fun bearerValuesAreMasked() {
        assertEquals("Authorization: •••", maskSecrets("Authorization: Bearer abc.def.ghi").substringBefore(" •••") + " •••")
        assertFalse(maskSecrets("api_key=verysecretvalue").contains("verysecretvalue"))
    }

    @Test
    fun ordinaryTextIsUntouched() {
        val text = "429 Too many requests, skip this model for now"
        assertEquals(text, maskSecrets(text))
    }

    @Test
    fun friendlyErrorLeadsWithTheStatusMeaning() {
        assertTrue(friendlyError("429 slow down").startsWith("Rate limited."))
        assertTrue(friendlyError("503 upstream").startsWith("Provider error."))
        assertFalse(friendlyError("401 bad key sk-abcdefghijklmnop").contains("sk-abcdefghijklmnop"))
    }
}
