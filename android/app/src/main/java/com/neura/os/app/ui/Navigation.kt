package com.neura.os.app.ui

import kotlinx.serialization.Serializable

/**
 * NeuraOS navigation routes — type-safe with kotlinx.serialization.
 *
 * Each destination is a @Serializable data class/object, compatible with
 * Jetpack Navigation 3's NavDisplay. The existing multi-back-stack
 * (per-tab stacks with process-death-safe keys) is preserved.
 */
@Serializable sealed interface Route {
    @Serializable data object Images : Route
    @Serializable data object Tools : Route
    @Serializable data object Settings : Route
    @Serializable data object Personas : Route
    @Serializable data object Prompts : Route
    @Serializable data object Skills : Route
    @Serializable data object Knowledges : Route
    @Serializable data object Builds : Route
    @Serializable data object Build : Route
    @Serializable data class Detail(val kind: String, val id: String) : Route
    @Serializable data object Automation : Route
}

/** Legacy alias so existing call sites compile during migration. */
typealias Screen = Route

/** A key that survives process death, unlike [Route.toString] -- adding a
 * new [Route] case can never silently change another case's saved name. */
fun Route.screenKey(): String = when (this) {
    Route.Images -> "images"
    Route.Tools -> "tools"
    Route.Settings -> "settings"
    Route.Personas -> "personas"
    Route.Prompts -> "prompts"
    Route.Skills -> "skills"
    Route.Knowledges -> "knowledges"
    Route.Builds -> "builds"
    Route.Build -> "build"
    Route.Automation -> "automation"
    is Route.Detail -> "detail:$kind:$id"
}

fun screenFromKey(key: String): Route? = when {
    key == "images" -> Route.Images
    key == "tools" -> Route.Tools
    key == "settings" -> Route.Settings
    key == "personas" -> Route.Personas
    key == "prompts" -> Route.Prompts
    key == "skills" -> Route.Skills
    key == "knowledges" -> Route.Knowledges
    key == "builds" -> Route.Builds
    key == "build" -> Route.Build
    key == "automation" -> Route.Automation
    key.startsWith("detail:") -> key.removePrefix("detail:").split(":", limit = 2)
        .takeIf { it.size == 2 }?.let { (kind, id) -> Route.Detail(kind, id) }
    else -> null
}

/** The app's real peer destinations. Each owns its own back stack of
 * [Route]s pushed on top of its (implicit) root, so switching tabs resumes
 * wherever that tab was left -- unlike a single shared stack, where opening
 * an unrelated tab could land on top of whatever screen happened to be on
 * top already. */
enum class Tab(val label: String) {
    Chat("Chat"), Images("Images"), Tools("Tools"), Skills("Skills"), Knowledges("Library"), Automation("Automate"), Settings("Settings");
}

/** [Tab.Chat] has no root of its own -- chat itself isn't a [Route], it's
 * what shows when nothing is pushed. */
fun Tab.rootScreen(): Route? = when (this) {
    Tab.Chat -> null
    Tab.Images -> Route.Images
    Tab.Tools -> Route.Tools
    Tab.Skills -> Route.Skills
    Tab.Knowledges -> Route.Knowledges
    Tab.Automation -> Route.Automation
    Tab.Settings -> Route.Settings
}

private fun tabRootedAt(screen: Route): Tab? = Tab.entries.firstOrNull { it.rootScreen() == screen }

/** The navigation reducer, extracted out of AppViewModel so it can be tested
 * without an Android runtime. [stacks] holds only what's pushed *on top of*
 * each tab's root -- the root itself is implicit via [rootScreen], so an
 * untouched tab needs no entry at all. */
data class NavState(
    val currentTab: Tab = Tab.Chat,
    val stacks: Map<Tab, List<Route>> = emptyMap(),
) {
    val screen: Route? get() = stacks[currentTab]?.lastOrNull() ?: currentTab.rootScreen()

    /** Navigating to one of the six tab roots switches to that tab, resuming
     * whatever it was showing before. Any other screen stacks on top of the
     * *current* tab -- pushing from a drawer row or a card inside a hub
     * screen counts as drilling into whichever tab you were already on. */
    fun pushed(target: Route): NavState {
        tabRootedAt(target)?.let { rootTab -> return copy(currentTab = rootTab) }
        if (screen == target) return this
        val stack = stacks[currentTab].orEmpty()
        return copy(stacks = stacks + (currentTab to stack + target))
    }

    /** Pops one level; once a tab is back at its own root, one more back
     * leaves it for Chat (matching Android's own multi-back-stack guidance).
     * Returns null only when there is truly nothing left to do. */
    fun poppedOrNull(): NavState? {
        val stack = stacks[currentTab].orEmpty()
        if (stack.isNotEmpty()) return copy(stacks = stacks + (currentTab to stack.dropLast(1)))
        if (currentTab != Tab.Chat) return copy(currentTab = Tab.Chat)
        return null
    }

    /** Explicit "go to chat" -- opening or starting a chat should dismiss
     * whatever was floating over it, but must never reach into another
     * tab's stack to do it. */
    fun switchedToChat(): NavState = copy(currentTab = Tab.Chat, stacks = stacks + (Tab.Chat to emptyList()))

    /** Jumps straight to a tab's root, discarding anything drilled into it --
     * for entry points (a launcher shortcut) that mean "show me X", not
     * "resume where I left X". */
    fun reset(tab: Tab): NavState = copy(currentTab = tab, stacks = stacks + (tab to emptyList()))

    fun selectedTab(tab: Tab): NavState {
        val root = tab.rootScreen() ?: return copy(currentTab = Tab.Chat)
        return pushed(root)
    }
}
