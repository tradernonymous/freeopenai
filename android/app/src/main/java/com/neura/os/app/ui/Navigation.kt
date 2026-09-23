package com.neura.os.app.ui

import kotlinx.serialization.Serializable

/**
 * NeuraOS navigation routes — type-safe with kotlinx.serialization.
 *
 * Each destination is a @Serializable data class/object. The multi-back-stack
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
    /** Pull request review (master plan Phase 4). */
    @Serializable data object Reviews : Route
    /** The Agents space's own page: Library, Skills, Tools, Automate (V4). */
    @Serializable data object Agents : Route
    /** The Activity space's own page: builds, reviews, queued replies (V4). */
    @Serializable data object Activity : Route
}

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
    Route.Reviews -> "reviews"
    Route.Agents -> "agents"
    Route.Activity -> "activity"
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
    key == "reviews" -> Route.Reviews
    key == "agents" -> Route.Agents
    key == "activity" -> Route.Activity
    key.startsWith("detail:") -> key.removePrefix("detail:").split(":", limit = 2)
        .takeIf { it.size == 2 }?.let { (kind, id) -> Route.Detail(kind, id) }
    else -> null
}

/** The four spaces of the dock (docs/android-master-plan.md §2.1, V4). Each
 * owns its own back stack of [Route]s pushed on top of its (implicit) root,
 * so switching spaces resumes wherever that space was left. Everything that
 * used to be a drawer destination now lives inside one of them: Library,
 * Skills, Tools and Automate under Agents; Builds and PR review under
 * Activity; Settings is pushed from the avatar onto whichever space is open. */
enum class Tab(val label: String) {
    Chat("Chat"), Create("Create"), Agents("Agents"), Activity("Activity");
}

/** [Tab.Chat] has no root of its own -- chat itself isn't a [Route], it's
 * what shows when nothing is pushed. */
fun Tab.rootScreen(): Route? = when (this) {
    Tab.Chat -> null
    Tab.Create -> Route.Images
    Tab.Agents -> Route.Agents
    Tab.Activity -> Route.Activity
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

/** One entry of the stack Navigation 3 draws (V4): a space's own root, or a
 * page pushed on top of it. */
sealed interface Dest {
    data class Root(val tab: Tab) : Dest
    data class Page(val route: Route) : Dest
}

/** The current space's stack, root first, as NavDisplay wants it. */
fun NavState.backStack(): List<Dest> =
    listOf<Dest>(Dest.Root(currentTab)) + stacks[currentTab].orEmpty().map { Dest.Page(it) }
