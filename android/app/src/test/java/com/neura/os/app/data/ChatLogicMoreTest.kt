package com.neura.os.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.StringReader

class ChatLogicMoreTest {
    private fun consume(sse: String): List<ChatEvent> {
        val events = mutableListOf<ChatEvent>()
        consumeSseChatStream(BufferedReader(StringReader(sse))) { events.add(it) }
        return events
    }

    @Test
    fun aStreamThatEndsWithDoneReportsExactlyWhatArrived() {
        val events = consume(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n" +
                "data: [DONE]\n",
        )
        assertEquals(3, events.size)
        assertTrue(events[2] == ChatEvent.Done)
    }

    @Test
    fun aStreamThatEndsWithAnErrorFrameReportsThatFailureAndNothingAfter() {
        val events = consume(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n" +
                "data: {\"error\":\"rate limited\"}\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"should not arrive\"}}]}\n",
        )
        assertEquals("the loop must stop at the first terminator, not read past it", 2, events.size)
        assertEquals("rate limited", (events[1] as ChatEvent.Failure).message)
    }

    // The regression this guards: a connection that closes on its own, with
    // neither [DONE] nor an error/partial frame ever seen, used to be
    // reported as a plain Done -- silently keeping whatever text had arrived
    // as if it were the model's whole answer, with no way to tell an early
    // network cut from the model actually finishing.
    @Test
    fun aStreamThatEndsWithNoTerminatorAtAllIsReportedAsAConnectivityFailure() {
        val events = consume("data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n")
        assertEquals(2, events.size)
        val failure = events[1] as ChatEvent.Failure
        assertTrue("an unexplained early close must be retryable/explainable like any other connectivity drop", failure.connectivity)
    }

    @Test
    fun aStreamWithNothingAtAllStillReportsTheSameConnectivityFailure() {
        val events = consume("")
        assertEquals(1, events.size)
        assertTrue((events[0] as ChatEvent.Failure).connectivity)
    }

    @Test
    fun aPartialSentinelIsNotTreatedAsATerminatorItself() {
        // Partial (the server's own deadline notice) is deliberately not one
        // of the two loop-stopping events -- AppViewModel decides what to do
        // with it -- so a well-behaved server still sends [DONE] after it.
        val events = consume(
            "data: {\"partial\":true,\"notice\":\"ran long\"}\n" +
                "data: [DONE]\n",
        )
        assertEquals(2, events.size)
        assertEquals("ran long", (events[0] as ChatEvent.Partial).notice)
        assertTrue(events[1] == ChatEvent.Done)
    }

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
    fun estimateTokensIsRoughlyFourCharsPerToken() {
        assertEquals(0, estimateTokens(""))
        assertEquals(1, estimateTokens("hi"))
        assertEquals(3, estimateTokens("twelve chars"))
    }

    @Test
    fun budgetChatHistoryKeepsTheNewestTurnRegardlessOfItsOwnSize() {
        val huge = ChatMessage("user", "x".repeat(HISTORY_TOKEN_BUDGET * 5))
        assertEquals(listOf(huge), budgetChatHistory(listOf(ChatMessage("assistant", "old"), huge)))
    }

    @Test
    fun budgetChatHistoryTrimsFromTheOldestEndUntilItFits() {
        // Four 4000-char turns (~1000 tokens each) fit comfortably inside a
        // 2500-token budget only two turns deep -- the two oldest must go.
        val turns = (1..4).map { ChatMessage(if (it % 2 == 0) "assistant" else "user", "x".repeat(4000)) }
        val kept = budgetChatHistory(turns, budget = 2500)
        assertEquals(turns.takeLast(2), kept)
    }

    @Test
    fun budgetChatHistoryLeavesALightHistoryUntouched() {
        val turns = listOf(ChatMessage("user", "hi"), ChatMessage("assistant", "hello"))
        assertEquals(turns, budgetChatHistory(turns))
    }

    // The regression this guards: Android capped history only by message
    // *count* (30), never by weight, while the web app (chatlib.js) also
    // caps by an estimated token budget -- so the same long, verbose
    // conversation could ride to the provider far heavier from the phone
    // than from a browser, crowding the reply itself out of the model's
    // context window.
    @Test
    fun buildChatBodySpendsTheTokenBudgetNotJustTheMessageCount() {
        val turns = (1..10).map { ChatMessage(if (it % 2 == 1) "user" else "assistant", "y".repeat(4000)) }
        val withBudget = JSONObject(buildChatBody("m", "", turns, historyBudget = 2500)).getJSONArray("messages")
        // Well under 30 messages, but each is ~1000 tokens, so a 2500-token
        // budget must keep only the newest handful, not all ten.
        assertTrue("expected far fewer than the full ten turns under a tight budget", withBudget.length() < 10)
        val uncapped = JSONObject(buildChatBody("m", "", turns, historyBudget = Int.MAX_VALUE)).getJSONArray("messages")
        assertEquals(10, uncapped.length())
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
