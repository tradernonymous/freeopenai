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
        val state = NavState().pushed(Route.Agents)
        assertEquals(Tab.Agents, state.currentTab)
        assertEquals(Route.Agents, state.screen)
    }

    @Test fun `pushing a non-root screen stacks on top of the current tab`() {
        val state = NavState().pushed(Route.Agents).pushed(Route.Personas)
        assertEquals(Tab.Agents, state.currentTab)
        assertEquals(Route.Personas, state.screen)
    }

    @Test fun `pushing the same screen twice does not duplicate`() {
        val once = NavState().pushed(Route.Agents).pushed(Route.Personas)
        val twice = once.pushed(Route.Personas)
        assertEquals(once, twice)
    }

    @Test fun `back pops within a tab before leaving it`() {
        val deep = NavState().pushed(Route.Agents).pushed(Route.Personas)
        val popped = deep.poppedOrNull()
        assertTrue(popped != null)
        assertEquals(Tab.Agents, popped!!.currentTab)
        assertEquals(Route.Agents, popped.screen)
    }

    @Test fun `back from a tab root returns to chat`() {
        val atRoot = NavState().pushed(Route.Agents)
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
        val toolsDrilled = NavState().pushed(Route.Agents).pushed(Route.Personas)
        val onImages = toolsDrilled.pushed(Route.Images)
        assertEquals(Tab.Create, onImages.currentTab)
        val backOnTools = onImages.pushed(Route.Agents)
        assertEquals(Tab.Agents, backOnTools.currentTab)
        assertEquals(Route.Personas, backOnTools.screen)
    }

    @Test fun `switchedToChat clears only chat's own stack`() {
        val toolsDrilled = NavState().pushed(Route.Agents).pushed(Route.Personas)
        // A screen pushed after switching to chat lands on chat's own stack,
        // not on the tab it came from.
        val onChatWithBuilds = toolsDrilled.switchedToChat().pushed(Route.Builds)
        assertEquals(Route.Builds, onChatWithBuilds.screen)
        val backToChat = onChatWithBuilds.switchedToChat()
        assertEquals(Tab.Chat, backToChat.currentTab)
        assertNull(backToChat.screen)
        // Tools' drilled-in state must survive -- switching to chat is not a full reset.
        val backOnTools = backToChat.pushed(Route.Agents)
        assertEquals(Route.Personas, backOnTools.screen)
    }

    @Test fun `reset discards a space's drilled-in state`() {
        val drilled = NavState().pushed(Route.Agents).pushed(Route.Personas)
        val reset = drilled.reset(Tab.Activity)
        assertEquals(Tab.Activity, reset.currentTab)
        assertEquals(Route.Activity, reset.screen)
        // The space we reset was Activity, not Agents -- Agents' stack is untouched.
        val backOnAgents = reset.pushed(Route.Agents)
        assertEquals(Route.Personas, backOnAgents.screen)
    }

    @Test fun `settings, tools and builds are pages inside a space, not spaces`() {
        val fromAgents = NavState().pushed(Route.Agents).pushed(Route.Tools).pushed(Route.Settings)
        assertEquals(Tab.Agents, fromAgents.currentTab)
        assertEquals(Route.Settings, fromAgents.screen)
        val builds = NavState().pushed(Route.Activity).pushed(Route.Builds)
        assertEquals(Tab.Activity, builds.currentTab)
        assertEquals(Route.Builds, builds.screen)
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
            Route.Automation, Route.Reviews, Route.Agents, Route.Activity,
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

    @Test fun `the drawn stack is the current space's root, then what was pushed on it`() {
        assertEquals(listOf<Dest>(Dest.Root(Tab.Chat)), NavState().backStack())
        val deep = NavState().pushed(Route.Agents).pushed(Route.Tools).pushed(Route.Settings)
        assertEquals(
            listOf(Dest.Root(Tab.Agents), Dest.Page(Route.Tools), Dest.Page(Route.Settings)),
            deep.backStack(),
        )
        // Another space's stack is not drawn, and is still there when it comes back.
        val onCreate = deep.pushed(Route.Images)
        assertEquals(listOf<Dest>(Dest.Root(Tab.Create)), onCreate.backStack())
        assertEquals(deep.backStack(), onCreate.pushed(Route.Agents).backStack())
    }
}
