package com.freeai4u.app.ui

import com.freeai4u.app.data.ChatMessage
import com.freeai4u.app.data.ToolCall
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnsTest {
    @Test
    fun toolResultsAreMatchedToTheirCalls() {
        val turns = buildTurns(
            listOf(
                ChatMessage("user", "q"),
                ChatMessage("assistant", "", toolCalls = listOf(ToolCall("a", "web_search", "{}"), ToolCall("b", "web_fetch", "{}"))),
                ChatMessage("tool", "results", toolCallId = "a", toolName = "web_search"),
                ChatMessage("tool", "Error: blocked", toolCallId = "b", toolName = "web_fetch"),
                ChatMessage("assistant", "done"),
            ),
        )
        assertEquals(2, turns.size)
        val steps = (turns[1] as Turn.Assistant).steps
        assertEquals("results", steps[0].output)
        assertTrue(steps[0].done)
        assertFalse(steps[0].failed)
        assertTrue(steps[1].failed)
    }

    @Test
    fun aCallStillWaitingForItsResultIsNotDone() {
        val turns = buildTurns(
            listOf(
                ChatMessage("user", "q"),
                ChatMessage("assistant", "", toolCalls = listOf(ToolCall("a", "web_search", "{}"))),
            ),
        )
        val step = (turns[1] as Turn.Assistant).steps.single()
        assertFalse(step.done)
        assertEquals("", step.output)
    }

    @Test
    fun aLongChatBuildsEveryTurn() {
        val messages = (0 until 2000).flatMap { i ->
            listOf(
                ChatMessage("user", "q$i"),
                ChatMessage("assistant", "", toolCalls = listOf(ToolCall("c$i", "web_search", "{}"))),
                ChatMessage("tool", "r$i", toolCallId = "c$i", toolName = "web_search"),
            )
        }
        val turns = buildTurns(messages)
        assertEquals(4000, turns.size)
        assertEquals("r1999", (turns.last() as Turn.Assistant).steps.single().output)
    }
}
