package com.freeai4u.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

class AgentTest {
    private fun chat(mode: String) = Conversation("c", "T", "assistant", "p", "m", emptyList(), 0, 0, mode = mode)
    private fun call(name: String, args: String) = ToolCall("id1", name, args)
    private fun names(mode: String): List<String> {
        val tools = toolsForMode(mode)
        return (0 until tools.length()).map { tools.getJSONObject(it).getJSONObject("function").getString("name") }
    }

    @Test
    fun modes_offerMoreToolsAsTheyGetMorePowerful() {
        assertFalse("chat cannot write files", names("chat").contains("file_write"))
        assertFalse("chat keeps no plan", names("chat").contains("task_add"))
        assertTrue(names("plan").contains("task_add"))
        assertFalse("plan never writes", names("plan").contains("file_write"))
        assertTrue(names("build").containsAll(listOf("task_update", "file_write", "generate_image", "phone_action")))
        assertEquals(names("chat"), names("nonsense"))
    }

    @Test
    fun systemPrompt_carriesPersonaInstructionsModeAndDate() {
        val prompt = systemPrompt("Be a pirate.", "I am a nurse.", "plan", now = 0)
        assertTrue(prompt.startsWith("Be a pirate."))
        assertTrue(prompt.contains("I am a nurse."))
        assertTrue(prompt.contains("MODE: PLAN"))
        assertTrue(prompt.contains("1970"))
    }

    @Test
    fun tasks_addListUpdate() {
        var c = chat("plan")
        c = runLocalTool(c, call("task_add", "{\"title\":\"Draft\"}"))!!.conversation
        c = runLocalTool(c, call("task_add", "{\"title\":\"Ship\",\"detail\":\"Friday\"}"))!!.conversation
        assertEquals(listOf("t1", "t2"), c.tasks.map { it.id })
        val updated = runLocalTool(c, call("task_update", "{\"id\":\"t2\",\"status\":\"done\"}"))!!
        assertEquals("done", updated.conversation.tasks[1].status)
        assertTrue(runLocalTool(updated.conversation, call("task_list", "{}"))!!.output.contains("t2 [done] Ship — Friday"))
        assertTrue(runLocalTool(c, call("task_update", "{\"id\":\"t9\",\"status\":\"done\"}"))!!.output.startsWith("Error"))
        assertTrue(runLocalTool(c, call("task_update", "{\"id\":\"t1\",\"status\":\"finished\"}"))!!.output.startsWith("Error"))
        assertTrue(runLocalTool(c, call("task_add", "not json"))!!.output.startsWith("Error"))
    }

    @Test
    fun files_areBuildOnlyForWritesAndPathsAreCleaned() {
        assertTrue(runLocalTool(chat("plan"), call("file_write", "{\"path\":\"a.md\",\"content\":\"x\"}"))!!.output.contains("not available"))
        val written = runLocalTool(chat("build"), call("file_write", "{\"path\":\"../../etc//notes.md\",\"content\":\"hello\"}"))!!
        assertEquals(mapOf("etc/notes.md" to "hello"), written.conversation.files)
        assertEquals("hello", runLocalTool(written.conversation, call("file_read", "{\"path\":\"etc/notes.md\"}"))!!.output)
        assertNull("network tools are not local", runLocalTool(chat("chat"), call("web_search", "{}")))
    }

    @Test
    fun phoneActions_validateEveryKind() {
        val alarm = parsePhoneAction("{\"kind\":\"alarm\",\"hour\":7,\"minute\":30,\"title\":\"Gym\"}").first
        assertEquals("Set alarm 07:30 · Gym", alarm!!.label())
        assertNull(parsePhoneAction("{\"kind\":\"alarm\",\"hour\":25}").first)
        assertNull("links must be https", parsePhoneAction("{\"kind\":\"open_url\",\"url\":\"javascript:alert(1)\"}").first)
        assertNull(parsePhoneAction("{\"kind\":\"dial\",\"number\":\"tel;rm -rf\"}").first)
        assertNotNull(parsePhoneAction("{\"kind\":\"dial\",\"number\":\"+60 12-345 6789\"}").first)
        assertNull(parsePhoneAction("{\"kind\":\"format_phone\"}").first)
        val event = parsePhoneAction("{\"kind\":\"event\",\"title\":\"Dentist\",\"start\":\"2026-09-20T15:00\"}").first!!
        assertEquals(event, phoneActionFromJson(event.toJson()))
        assertTrue(parsePhoneAction("{\"kind\":\"timer\",\"seconds\":90}").second.contains("Start timer 1m 30s"))
    }

    @Test
    fun toolCalls_joinFromStreamedFragments() {
        val collector = ToolCallCollector()
        listOf(
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"web_search\",\"arguments\":\"\"}}]}}]}",
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"query\\\":\"}}]}}]}",
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"cats\\\"}\"}}]}}]}",
            "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"task_list\"}}]}}]}",
        ).forEach { collector.add(parseSseData(it) as ChatEvent.ToolDelta) }
        val calls = collector.calls()
        assertEquals(listOf("web_search", "task_list"), calls.map { it.name })
        assertEquals("cats", JSONObject(calls[0].arguments).getString("query"))
        assertEquals("{}", calls[1].arguments)
    }

    @Test
    fun chatBody_keepsToolPairsTogether() {
        val history = listOf(
            ChatMessage("user", "q"),
            ChatMessage("assistant", "", toolCalls = listOf(ToolCall("x", "web_search", "{}"))),
            ChatMessage("tool", "results", toolCallId = "x", toolName = "web_search"),
            ChatMessage("assistant", "answer"),
        )
        val body = JSONObject(buildChatBody("m", "", history, maxHistory = 3, tools = toolsForMode("chat")))
        val messages = body.getJSONArray("messages")
        assertEquals("assistant", messages.getJSONObject(0).getString("role"))
        assertEquals("x", messages.getJSONObject(0).getJSONArray("tool_calls").getJSONObject(0).getString("id"))
        assertEquals("x", messages.getJSONObject(1).getString("tool_call_id"))
        assertTrue(body.has("tools"))
        val cut = JSONObject(buildChatBody("m", "", history, maxHistory = 2)).getJSONArray("messages")
        assertEquals("a tool result never leads", "assistant", cut.getJSONObject(0).getString("role"))
        assertFalse(JSONObject(buildChatBody("m", "", history)).has("tools"))
    }

    @Test
    fun toolRefusals_areRecognised() {
        assertTrue(looksLikeToolsUnsupported("400: This model does not support tools"))
        assertTrue(looksLikeToolsUnsupported("tool use is not supported for this model"))
        assertFalse(looksLikeToolsUnsupported("429: rate limited"))
    }

    @Test
    fun conversation_roundTripsModeTasksFilesAndTools() {
        val original = chat("build").copy(
            tasks = listOf(TaskItem("t1", "Do", "doing", "x")),
            files = mapOf("a.md" to "hi"),
            messages = listOf(
                ChatMessage("assistant", "", toolCalls = listOf(ToolCall("x", "phone_action", "{}"))),
                ChatMessage("tool", "ok", toolCallId = "x", toolName = "phone_action", action = "{\"kind\":\"copy\"}", imageIds = listOf("img1")),
            ),
        )
        assertEquals(original, conversationFromJson(original.toJson().toString()))
    }

    @Test
    fun history_groupsByDay() {
        val utc = TimeZone.getTimeZone("UTC")
        val now = 1_789_600_000_000L
        val day = 86_400_000L
        fun at(id: String, time: Long, pinned: Boolean = false) = chat("chat").copy(id = id, updatedAt = time, pinned = pinned)
        val groups = groupByDate(listOf(at("old", now - 90 * day), at("y", now - day), at("t", now), at("p", now - 400 * day, pinned = true), at("w", now - 3 * day)), now, utc)
        assertEquals(listOf("Pinned", "Today", "Yesterday", "7 days"), groups.take(4).map { it.first })
        assertEquals("old", groups.last().second.single().id)
    }
}
