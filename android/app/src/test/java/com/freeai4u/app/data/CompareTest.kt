package com.freeai4u.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// defaultCompareTarget trusts its `providers` argument to already be the
// chat-capable, configured list NativeApi.providers()/chatProviders() hand
// out -- it does not re-filter by kind/configured itself, so these tests
// only exercise pair-selection, not that upstream filtering.
class CompareTest {
    private fun provider(id: String) = ProviderInfo(id, id, true, "chat")
    private fun model(id: String) = ModelInfo(id, id, 0)

    @Test fun `identical targets are invalid`() {
        val target = CompareTarget("cloudflare", "llama")
        assertFalse(compareTargetsValid(target, target.copy()))
    }

    @Test fun `different providers or models are valid`() {
        assertTrue(compareTargetsValid(CompareTarget("cloudflare", "llama"), CompareTarget("nvidia", "llama")))
        assertTrue(compareTargetsValid(CompareTarget("cloudflare", "llama"), CompareTarget("cloudflare", "mistral")))
    }

    @Test fun `default target prefers a different provider`() {
        val first = CompareTarget("cloudflare", "llama")
        val providers = listOf(provider("cloudflare"), provider("nvidia"))
        val models = mapOf("cloudflare" to listOf(model("llama")), "nvidia" to listOf(model("nemotron")))
        assertEquals(CompareTarget("nvidia", "nemotron"), defaultCompareTarget(first, providers, models))
    }

    @Test fun `a different provider with no models loaded yet is skipped`() {
        val first = CompareTarget("cloudflare", "llama")
        val providers = listOf(provider("cloudflare"), provider("nvidia"))
        val models = mapOf("cloudflare" to listOf(model("llama"), model("mistral")))
        assertEquals(CompareTarget("cloudflare", "mistral"), defaultCompareTarget(first, providers, models))
    }

    @Test fun `default target falls back to a different model on the same provider`() {
        val first = CompareTarget("cloudflare", "llama")
        val providers = listOf(provider("cloudflare"))
        val models = mapOf("cloudflare" to listOf(model("llama"), model("mistral")))
        assertEquals(CompareTarget("cloudflare", "mistral"), defaultCompareTarget(first, providers, models))
    }

    @Test fun `default target is null when nothing else is available`() {
        val first = CompareTarget("cloudflare", "llama")
        val providers = listOf(provider("cloudflare"))
        val models = mapOf("cloudflare" to listOf(model("llama")))
        assertNull(defaultCompareTarget(first, providers, models))
    }
}
