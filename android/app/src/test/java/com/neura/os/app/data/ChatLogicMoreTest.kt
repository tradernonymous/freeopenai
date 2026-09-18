package com.neura.os.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatLogicMoreTest {
    @Test
    fun aChunkWithSeveralToolCallsKeepsThemAll() {
        val chunk = "{\"choices\":[{\"delta\":{\"tool_calls\":[" +
            "{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"web_search\",\"arguments\":\"{}\"}}," +
            "{\"index\":1,\"id\":\"b\",\"function\":{\"name\":\"web_fetch\",\"arguments\":\"{\\\"url\\\":\\\"x\\\"}\"}}]}}]}"
        val event = parseSseData(chunk) as ChatEvent.ToolDeltas
        assertEquals(listOf("web_search", "web_fetch"), event.deltas.map { it.name })
        val collector = ToolCallCollector()
        event.deltas.forEach { collector.add(it) }
        assertEquals(listOf("a", "b"), collector.calls().map { it.id })

        val single = parseSseData("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"web_search\",\"arguments\":\"\"}}]}}]}")
        assertTrue(single is ChatEvent.ToolDelta)
    }

    @Test
    fun puterModelsAreReadFromTheListTheServerPublishes() {
        val body = "{\"provider\":\"puter\",\"defaultModel\":\"gpt-5.4-nano\",\"models\":[" +
            "{\"id\":\"gpt-6-astra\",\"name\":\"GPT-6 Astra\",\"description\":\"Newest\"}," +
            "{\"id\":\"\",\"name\":\"broken\"}," +
            "{\"id\":\"claude-opus-5\",\"name\":\"Claude Opus 5\"}]}"
        val models = parsePuterModels(body)
        assertEquals(listOf("gpt-6-astra", "claude-opus-5"), models.map { it.id })
        assertEquals("GPT-6 Astra", models[0].name)
        assertTrue(parsePuterModels("{broken").isEmpty())
        assertTrue(parsePuterModels("{}").isEmpty())
    }

    @Test
    fun onlyTheMostRecentPhotosRideAlongAsPictures() {
        val photo = "data:image/jpeg;base64,AAAA"
        val history = (1..4).flatMap { i ->
            listOf(ChatMessage("user", "look $i", images = listOf(photo)), ChatMessage("assistant", "seen $i"))
        }
        val messages = JSONObject(buildChatBody("m", "", history)).getJSONArray("messages")
        val users = (0 until messages.length()).map { messages.getJSONObject(it) }.filter { it.getString("role") == "user" }
        assertEquals(4, users.size)
        assertTrue(users[0].get("content") is String)
        assertTrue(users[1].get("content") is String)
        assertFalse(users[2].get("content") is String)
        assertFalse(users[3].get("content") is String)
        assertEquals("look 1", users[0].getString("content"))
    }
}
