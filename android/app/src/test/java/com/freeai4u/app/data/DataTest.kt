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
    fun conversation_roundTripsArchived() {
        val original = chat(ChatMessage("user", "hi")).copy(archived = true)
        assertTrue(conversationFromJson(original.toJson().toString())!!.archived)
        assertFalse(chat(ChatMessage("user", "hi")).toJson().let { conversationFromJson(it.toString()) }!!.archived)
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
    fun imageSizes_areOnlyTheDeclaredOnes() {
        assertEquals(5, IMAGE_SIZES.size)
        assertEquals("1024x1024", imageSizeById("square")!!.body())
        assertEquals("1536x864", imageSizeById("wide")!!.body())
        assertEquals("864x1536", imageSizeById("tall")!!.body())
        assertNull("an undeclared shape is never guessed", imageSizeById("huge"))
        assertNull(imageSizeById(""))
    }

    @Test
    fun imageRatio_isReducedForPuter() {
        assertNull(imageRatio(null))
        assertEquals(1 to 1, imageRatio(imageSizeById("square")))
        assertEquals(3 to 2, imageRatio(imageSizeById("landscape")))
        assertEquals(2 to 3, imageRatio(imageSizeById("portrait")))
        assertEquals(16 to 9, imageRatio(imageSizeById("wide")))
        assertEquals(9 to 16, imageRatio(imageSizeById("tall")))
    }

    @Test
    fun imageModels_splitDrawFromEdit() {
        assertTrue(IMAGE_GENERATE_MODELS.contains("gpt-image-2"))
        assertTrue(IMAGE_EDIT_MODELS.contains("gpt-image-2.5-sunburst"))
        assertFalse(IMAGE_EDIT_MODELS.contains("gpt-image-1.5"))
        assertEquals(IMAGE_GENERATE_MODELS, imageModelsFor(edit = false))
        assertEquals(IMAGE_EDIT_MODELS, imageModelsFor(edit = true))
    }

    @Test
    fun limits_parseTimeoutsAndRetries() {
        val body = "{\"timeouts\":{\"models\":20000,\"chat\":55000,\"image\":22000,\"headers\":25000,\"stall\":60000}," +
            "\"retries\":{\"maxAttempts\":3,\"baseDelayMs\":1000}}"
        val limits = parseLimits(body)!!
        assertEquals(55000, limits.timeoutsMs["chat"])
        assertEquals(3, limits.maxAttempts)
        assertEquals(1000, limits.baseDelayMs)
        assertTrue(limits.summary().contains("55s"))
        assertTrue(limits.detail().contains("image 22s"))
        assertNull("nothing useful is not limits", parseLimits("{}"))
        assertNull(parseLimits("not json"))
    }

    @Test
    fun parseImageResult_readsBase64UrlAndProvider() {
        val inline = parseImageResult("{\"provider\":\"puter\",\"data\":[{\"b64_json\":\"aGVsbG8=\",\"media_type\":\"image/png\"}]}")
        assertEquals("puter", inline.first)
        assertEquals("aGVsbG8=", inline.second.first().base64)
        assertEquals("image/png", inline.second.first().mime)
        val linked = parseImageResult("{\"data\":[{\"url\":\"https://x/y.png\"}]}")
        assertEquals("https://x/y.png", linked.second.first().url)
    }

    @Test
    fun personas_fallBackToDefault() {
        val lib = Library(personas = listOf(Persona("mine", "Mine", "🙂", "x")))
        assertEquals("Mine", personaFor(lib, "mine").name)
        assertEquals(DEFAULT_PERSONA_ID, personaFor(lib, "gone").id)
        assertEquals(BUILT_IN_PERSONAS.size + 1, allPersonas(lib).size)
    }

    @Test
    fun slash_resolvesCommandsSkillsChainsAndPlainText() {
        val skills = listOf("ponytail", "caveman", "review")
        assertEquals(SlashMatch.Known("help", ""), resolveSlash("/help", skills))
        assertEquals(SlashMatch.Known("skill", "off caveman"), resolveSlash("/skill off caveman", skills))
        assertEquals(SlashMatch.Skill("ponytail"), resolveSlash("/ponytail", skills))
        assertEquals(SlashMatch.Chain(listOf("review", "caveman")), resolveSlash("/review /caveman", skills))
        assertEquals(SlashMatch.Chain(listOf("review", "caveman")), resolveSlash("/review /caveman extra words", skills))
        val many = listOf("a", "b", "c", "d", "e")
        assertEquals(
            "a chat can pin more than a few skills at once",
            SlashMatch.Chain(listOf("a", "b", "c", "d", "e")),
            resolveSlash("/a /b /c /d /e", many),
        )
        assertNull("a path is a message", resolveSlash("/etc/hosts is broken", skills))
        assertNull("unknown slash word is a message", resolveSlash("/shrug", skills))
        assertNull(resolveSlash("hello", skills))
    }

    @Test
    fun slash_suggestionsFilterByPrefix() {
        val rows = slashSuggestions("/com", emptyList())
        assertEquals(1, rows.size)
        assertEquals("compact", rows.first().first)
        val withSkill = slashSuggestions("/pon", listOf("ponytail"))
        assertEquals("ponytail", withSkill.first().first)
        assertTrue("an argument finishes the name", slashSuggestions("/compact on", emptyList()).isEmpty())
        assertTrue(slashSuggestions("hello", listOf("ponytail")).isEmpty())
    }

    @Test
    fun skills_parseCatalogueAndContent() {
        val catalogue = parseSkills("[{\"source\":\"acme/skills\",\"name\":\"ponytail\",\"description\":\"Lazy senior dev\",\"allowedTools\":[\"read\"],\"userOnly\":true}]")
        assertEquals(1, catalogue.size)
        assertEquals("ponytail", catalogue[0].name)
        assertEquals(listOf("read"), catalogue[0].allowedTools)
        assertTrue(catalogue[0].userOnly)
        assertTrue("catalogue has no body", catalogue[0].body.isEmpty())
        assertEquals(emptyList<Skill>(), parseSkills("not json"))

        val one = parseSkill("{\"source\":\"acme/skills\",\"name\":\"ponytail\",\"description\":\"d\",\"body\":\"# Steps\"}")!!
        assertEquals("# Steps", one.body)
        assertNull(parseSkill("{}"))
    }

    @Test
    fun conversation_roundTripsSkillsAndCompact() {
        val original = chat(ChatMessage("user", "hi")).copy(skills = listOf("ponytail"), compact = true)
        val restored = conversationFromJson(original.toJson().toString())!!
        assertEquals(listOf("ponytail"), restored.skills)
        assertTrue(restored.compact)
        assertTrue(conversationFromJson("{\"id\":\"old\"}")!!.skills.isEmpty())
    }

    @Test
    fun prompt_carriesPinnedSkillsAndSkipsJunk() {
        val prompt = systemPrompt("Be a pirate.", "", "chat", now = 0, skills = listOf("Rule one.", "", "  "))
        assertTrue(prompt.contains("Active skills for this chat"))
        assertTrue(prompt.contains("Rule one."))
        assertFalse(systemPrompt("", "", "chat", now = 0).contains("Active skills"))
    }
}
