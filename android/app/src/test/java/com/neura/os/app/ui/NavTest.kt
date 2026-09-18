package com.neura.os.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NavTest {

    @Test fun `fresh state shows chat`() {
        assertEquals(Tab.Chat, NavState().currentTab)
        assertNull(NavState().screen)
    }

    @Test fun `pushing a tab root switches tabs`() {
        val state = NavState().pushed(Route.Tools)
        assertEquals(Tab.Tools, state.currentTab)
        assertEquals(Route.Tools, state.screen)
    }

    @Test fun `pushing a non-root screen stacks on top of the current tab`() {
        val state = NavState().pushed(Route.Tools).pushed(Route.Personas)
        assertEquals(Tab.Tools, state.currentTab)
        assertEquals(Route.Personas, state.screen)
    }

    @Test fun `pushing the same screen twice does not duplicate`() {
        val once = NavState().pushed(Route.Tools).pushed(Route.Personas)
        val twice = once.pushed(Route.Personas)
        assertEquals(once, twice)
    }

    @Test fun `back pops within a tab before leaving it`() {
        val deep = NavState().pushed(Route.Tools).pushed(Route.Personas)
        val popped = deep.poppedOrNull()
        assertTrue(popped != null)
        assertEquals(Tab.Tools, popped!!.currentTab)
        assertEquals(Route.Tools, popped.screen)
    }

    @Test fun `back from a tab root returns to chat`() {
        val atRoot = NavState().pushed(Route.Tools)
        val popped = atRoot.poppedOrNull()
        assertTrue(popped != null)
        assertEquals(Tab.Chat, popped!!.currentTab)
        assertNull(popped.screen)
    }

    @Test fun `back from chat with nothing pushed returns null`() {
        assertNull(NavState().poppedOrNull())
    }

    @Test fun `back pops a stray screen pushed while already on chat`() {
        val stray = NavState().pushed(Route.Builds)
        assertEquals(Tab.Chat, stray.currentTab)
        assertEquals(Route.Builds, stray.screen)
        val popped = stray.poppedOrNull()
        assertTrue(popped != null)
        assertEquals(Tab.Chat, popped!!.currentTab)
        assertNull(popped.screen)
    }

    @Test fun `switching tabs preserves each tab's own stack`() {
        val toolsDrilled = NavState().pushed(Route.Tools).pushed(Route.Personas)
        val onImages = toolsDrilled.pushed(Route.Images)
        assertEquals(Tab.Images, onImages.currentTab)
        val backOnTools = onImages.pushed(Route.Tools)
        assertEquals(Tab.Tools, backOnTools.currentTab)
        assertEquals(Route.Personas, backOnTools.screen)
    }

    @Test fun `switchedToChat clears only chat's own stack`() {
        val toolsDrilled = NavState().pushed(Route.Tools).pushed(Route.Personas)
        // A screen pushed after switching to chat lands on chat's own stack,
        // not on the tab it came from.
        val onChatWithBuilds = toolsDrilled.switchedToChat().pushed(Route.Builds)
        assertEquals(Route.Builds, onChatWithBuilds.screen)
        val backToChat = onChatWithBuilds.switchedToChat()
        assertEquals(Tab.Chat, backToChat.currentTab)
        assertNull(backToChat.screen)
        // Tools' drilled-in state must survive -- switching to chat is not a full reset.
        val backOnTools = backToChat.pushed(Route.Tools)
        assertEquals(Route.Personas, backOnTools.screen)
    }

    @Test fun `reset discards a tab's drilled-in state`() {
        val drilled = NavState().pushed(Route.Tools).pushed(Route.Personas)
        val reset = drilled.reset(Tab.Settings)
        assertEquals(Tab.Settings, reset.currentTab)
        assertEquals(Route.Settings, reset.screen)
        // The tab we reset was Settings, not Tools -- Tools' stack is untouched.
        val backOnTools = reset.pushed(Route.Tools)
        assertEquals(Route.Personas, backOnTools.screen)
    }

    @Test fun `selectedTab on chat switches without clearing its stack`() {
        val withStray = NavState().pushed(Route.Builds)
        val selected = withStray.selectedTab(Tab.Chat)
        assertEquals(Tab.Chat, selected.currentTab)
        assertEquals(Route.Builds, selected.screen)
    }

    @Test fun `screenKey round trips through screenFromKey for every screen`() {
        val screens = listOf(
            Route.Images, Route.Tools, Route.Settings, Route.Personas, Route.Prompts,
            Route.Skills, Route.Knowledges, Route.Builds, Route.Build,
            Route.Detail("persona", "abc-123"),
        )
        for (screen in screens) {
            assertEquals(screen, screenFromKey(screen.screenKey()))
        }
    }

    @Test fun `screenFromKey rejects unknown or malformed keys`() {
        assertNull(screenFromKey("nonsense"))
        assertNull(screenFromKey(""))
        assertNull(screenFromKey("detail:onlyonepart"))
    }

    @Test fun `every tab's root maps back to that tab`() {
        for (tab in Tab.entries) {
            val root = tab.rootScreen() ?: continue
            assertEquals(tab, NavState().pushed(root).currentTab)
        }
    }
}
