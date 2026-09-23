package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Go anywhere: typing a few letters of a place, an action or a chat title
// finds it, the most likely one first.
class GoAnywhereTest {

    private val targets = listOf(
        GoTarget(HitKind.PLACE, "settings", "Settings", listOf("preferences", "theme")),
        GoTarget(HitKind.PLACE, "images", "Images", listOf("draw", "picture")),
        GoTarget(HitKind.PLACE, "builds", "Builds", listOf("remote", "server")),
        GoTarget(HitKind.ACTION, "new-chat", "New chat"),
        GoTarget(HitKind.ACTION, "voice", "Voice mode", listOf("talk", "speak")),
        GoTarget(HitKind.CHAT, "c1", "Settings for the router"),
        GoTarget(HitKind.CHAT, "c2", "Draft the launch note"),
    )

    @Test fun `a title prefix wins, and places beat chats on a tie`() {
        val hits = goAnywhere("sett", targets)
        assertEquals(listOf("settings", "c1"), hits.map { it.id })
    }

    @Test fun `keywords find a place by what it does`() {
        assertEquals("images", goAnywhere("draw", targets).first().id)
        assertEquals("voice", goAnywhere("talk", targets).first().id)
        assertEquals("settings", goAnywhere("theme", targets).first().id)
    }

    @Test fun `a word inside a title matches`() {
        assertEquals(listOf("c2"), goAnywhere("launch", targets).map { it.id })
        assertEquals("new-chat", goAnywhere("chat", targets).first().id)
    }

    @Test fun `an empty query lists places and actions, never chats`() {
        val hits = goAnywhere("  ", targets)
        assertTrue(hits.none { it.kind == HitKind.CHAT })
        assertEquals(5, hits.size)
    }

    @Test fun `no match is no result, and results are capped`() {
        assertTrue(goAnywhere("zzz", targets).isEmpty())
        val many = (1..40).map { GoTarget(HitKind.CHAT, "c$it", "Chat $it") }
        assertEquals(GO_ANYWHERE_MAX, goAnywhere("chat", many).size)
    }
}
