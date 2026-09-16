package com.freeai4u.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DataTest {

    private fun chat(vararg messages: ChatMessage) =
        Conversation("c1", "Title", "coder", "cloudflare", "@cf/x", messages.toList(), 1L, 2L, pinned = true)

    @Test
    fun conversation_roundTripsThroughJson() {
        val original = chat(
            ChatMessage("user", "hi", createdAt = 5, images = listOf("data:image/jpeg;base64,AAA")),
            ChatMessage("assistant", "hello", reasoning = "think", createdAt = 6, model = "@cf/x"),
            ChatMessage("assistant", "boom", error = true),
        )
        assertEquals(original, conversationFromJson(original.toJson().toString()))
    }

    @Test
    fun conversation_rejectsJunkAndNonImageAttachments() {
        assertNull(conversationFromJson("not json"))
        assertNull(conversationFromJson("{\"title\":\"no id\"}"))
        val sneaky = JSONObject(chat(ChatMessage("user", "x")).toJson().toString())
        sneaky.getJSONArray("messages").getJSONObject(0).put("images", org.json.JSONArray().put("https://evil/x.png"))
        assertTrue(conversationFromJson(sneaky.toString())!!.messages[0].images.isEmpty())
    }

    @Test
    fun library_roundTripsAndToleratesGarbage() {
        val lib = Library(
            personas = listOf(Persona("p", "Pirate", "🏴", "Talk like a pirate")),
            prompts = listOf(PromptTemplate("t", "Haiku", "Write a haiku about ")),
            images = listOf(GeneratedImage("i", "apple", "cloudflare", "image/jpeg", 9)),
            defaultProvider = "cloudflare",
            defaultModel = "@cf/x",
        )
        assertEquals(lib, libraryFromJson(lib.toJson().toString()))
        assertEquals(Library(), libraryFromJson("{broken"))
        assertEquals(Library(), libraryFromJson(null))
    }

    @Test
    fun sse_readsDeltasReasoningErrorsAndDone() {
        assertEquals(ChatEvent.Done, parseSseData(" [DONE]"))
        assertEquals(ChatEvent.Delta("Hi", ""), parseSseData("{\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}"))
        assertEquals(ChatEvent.Delta("", "hmm"), parseSseData("{\"choices\":[{\"delta\":{\"content\":null,\"reasoning_content\":\"hmm\"}}]}"))
        assertNull(parseSseData("{\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}"))
        assertEquals(ChatEvent.Failure("429: slow down"), parseSseData("{\"error\":\"429: slow down\"}"))
        assertEquals(ChatEvent.Failure("bad"), parseSseData("{\"error\":{\"message\":\"bad\"}}"))
        assertEquals(ChatEvent.Partial("stalled"), parseSseData("{\"partial\":true,\"notice\":\"stalled\"}"))
        assertNull(parseSseData(""))
        assertNull(parseSseData("garbage"))
    }

    @Test
    fun chatBody_personaFirstNoFailuresVisionParts() {
        val history = listOf(
            ChatMessage("user", "first"),
            ChatMessage("assistant", "oops", error = true),
            ChatMessage("user", "look", images = listOf("data:image/jpeg;base64,AAA")),
        )
        val body = JSONObject(buildChatBody("m", "Be brief.", history))
        assertEquals("m", body.getString("model"))
        assertTrue(body.getBoolean("stream"))
        val messages = body.getJSONArray("messages")
        assertEquals(3, messages.length())
        assertEquals("system", messages.getJSONObject(0).getString("role"))
        assertEquals("first", messages.getJSONObject(1).getString("content"))
        val parts = messages.getJSONObject(2).getJSONArray("content")
        assertEquals("text", parts.getJSONObject(0).getString("type"))
        assertEquals("data:image/jpeg;base64,AAA", parts.getJSONObject(1).getJSONObject("image_url").getString("url"))
    }

    @Test
    fun chatBody_capsHistory() {
        val history = (1..50).map { ChatMessage(if (it % 2 == 0) "assistant" else "user", "m$it") }
        val messages = JSONObject(buildChatBody("m", "", history, maxHistory = 10)).getJSONArray("messages")
        assertEquals(10, messages.length())
        assertEquals("m50", messages.getJSONObject(9).getString("content"))
    }

    @Test
    fun providersModelsAndImages_parse() {
        val providers = parseProviders("[{\"id\":\"cloudflare\",\"label\":\"CF\",\"configured\":true,\"kind\":\"chat\"},{\"id\":\"deepgram\",\"configured\":true,\"kind\":\"speech\"},{\"id\":\"nara\",\"configured\":false}]")
        assertEquals(listOf("cloudflare"), chatProviders(providers).map { it.id })
        assertEquals(listOf("a", "b"), parseModels("[{\"id\":\"a\",\"name\":\"A\"},\"b\",{}]").map { it.id })
        val (provider, images) = parseImageResult("{\"provider\":\"cloudflare\",\"data\":[{\"b64_json\":\"QUJD\",\"media_type\":\"image/jpeg\"},{}]}")
        assertEquals("cloudflare", provider)
        assertEquals(1, images.size)
        assertEquals("image/jpeg", images[0].mime)
        assertEquals("Server answered HTTP 502.", errorMessage("<html>", 502))
        assertEquals("nope", errorMessage("{\"error\":\"nope\"}", 400))
    }

    @Test
    fun titlesPromptsSearchAndFileNames() {
        assertEquals("New chat", deriveTitle("   \n "))
        assertEquals("Hello world", deriveTitle("\n  Hello   world \nmore"))
        assertEquals(48, deriveTitle("x".repeat(100)).length)
        val prompts = BUILT_IN_PROMPTS
        assertTrue(matchPrompts("/", prompts).isNotEmpty())
        assertTrue(matchPrompts("/summ", prompts).any { it.id == "summarize" })
        assertTrue(matchPrompts("hello", prompts).isEmpty())
        val a = chat(ChatMessage("user", "apples")).copy(id = "a", pinned = false, updatedAt = 10)
        val b = chat(ChatMessage("user", "bananas")).copy(id = "b", pinned = true, updatedAt = 1)
        assertEquals(listOf("b", "a"), filterConversations(listOf(a, b), "").map { it.id })
        assertEquals(listOf("a"), filterConversations(listOf(a, b), "APPLE").map { it.id })
        assertEquals("My-chat-2.md", safeFileName("My chat: 2?", "md"))
        assertEquals("chat.pdf", safeFileName("???", "pdf"))
    }

    @Test
    fun markdownExport_skipsFailures() {
        val text = conversationMarkdown(chat(ChatMessage("user", "Q"), ChatMessage("assistant", "bad", error = true), ChatMessage("assistant", "A")), "Coder", now = 0)
        assertTrue(text.startsWith("# Title"))
        assertTrue(text.contains("## You\n\nQ"))
        assertTrue(text.contains("## Assistant\n\nA"))
        assertFalse(text.contains("bad"))
    }

    @Test
    fun codeBlocks_splitIncludingUnclosedFence() {
        val segments = splitCodeBlocks("Intro\n```kotlin\nval x = 1\n```\nOutro\n```js\nlet y")
        assertEquals(listOf(false, true, false, true), segments.map { it.code })
        assertEquals("kotlin", segments[1].language)
        assertEquals("val x = 1", segments[1].text)
        assertEquals("let y", segments[3].text)
    }

    @Test
    fun personas_fallBackToDefault() {
        val lib = Library(personas = listOf(Persona("mine", "Mine", "🙂", "x")))
        assertEquals("Mine", personaFor(lib, "mine").name)
        assertEquals(DEFAULT_PERSONA_ID, personaFor(lib, "gone").id)
        assertEquals(BUILT_IN_PERSONAS.size + 1, allPersonas(lib).size)
    }
}
