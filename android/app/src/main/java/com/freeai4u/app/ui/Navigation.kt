package com.freeai4u.app.ui

/** Pages that open over the chat, ChatGPT-style: the chat is always the base.
 * [Detail] is a parameterized route for a single item within a future list
 * screen (a persona, a workspace file, ...) -- nothing pushes it yet, but
 * [screenKey] already round-trips it so later phases don't need another
 * restore-format migration. */
sealed interface Screen {
    data object Images : Screen
    data object Tools : Screen
    data object Settings : Screen
    data object Personas : Screen
    data object Prompts : Screen
    data object Skills : Screen
    data object Knowledges : Screen
    data object Builds : Screen
    data object Build : Screen
    data class Detail(val kind: String, val id: String) : Screen
}

/** A key that survives process death, unlike [Screen.toString] -- adding a
 * new [Screen] case can never silently change another case's saved name. */
fun Screen.screenKey(): String = when (this) {
    Screen.Images -> "images"
    Screen.Tools -> "tools"
    Screen.Settings -> "settings"
    Screen.Personas -> "personas"
    Screen.Prompts -> "prompts"
    Screen.Skills -> "skills"
    Screen.Knowledges -> "knowledges"
    Screen.Builds -> "builds"
    Screen.Build -> "build"
    is Screen.Detail -> "detail:$kind:$id"
}

fun screenFromKey(key: String): Screen? = when {
    key == "images" -> Screen.Images
    key == "tools" -> Screen.Tools
    key == "settings" -> Screen.Settings
    key == "personas" -> Screen.Personas
    key == "prompts" -> Screen.Prompts
    key == "skills" -> Screen.Skills
    key == "knowledges" -> Screen.Knowledges
    key == "builds" -> Screen.Builds
    key == "build" -> Screen.Build
    key.startsWith("detail:") -> key.removePrefix("detail:").split(":", limit = 2)
        .takeIf { it.size == 2 }?.let { (kind, id) -> Screen.Detail(kind, id) }
    else -> null
}

/** The app's real peer destinations. Each owns its own back stack of
 * [Screen]s pushed on top of its (implicit) root, so switching tabs resumes
 * wherever that tab was left -- unlike a single shared stack, where opening
 * an unrelated tab could land on top of whatever screen happened to be on
 * top already. */
enum class Tab(val label: String) {
    Chat("Chat"), Images("Images"), Tools("Tools"), Skills("Skills"), Knowledges("Library"), Settings("Settings");
}

/** [Tab.Chat] has no root of its own -- chat itself isn't a [Screen], it's
 * what shows when nothing is pushed. */
fun Tab.rootScreen(): Screen? = when (this) {
    Tab.Chat -> null
    Tab.Images -> Screen.Images
    Tab.Tools -> Screen.Tools
    Tab.Skills -> Screen.Skills
    Tab.Knowledges -> Screen.Knowledges
    Tab.Settings -> Screen.Settings
}

private fun tabRootedAt(screen: Screen): Tab? = Tab.entries.firstOrNull { it.rootScreen() == screen }

/** The navigation reducer, extracted out of AppViewModel so it can be tested
 * without an Android runtime. [stacks] holds only what's pushed *on top of*
 * each tab's root -- the root itself is implicit via [rootScreen], so an
 * untouched tab needs no entry at all. */
data class NavState(
    val currentTab: Tab = Tab.Chat,
    val stacks: Map<Tab, List<Screen>> = emptyMap(),
) {
    val screen: Screen? get() = stacks[currentTab]?.lastOrNull() ?: currentTab.rootScreen()

    /** Navigating to one of the six tab roots switches to that tab, resuming
     * whatever it was showing before. Any other screen stacks on top of the
     * *current* tab -- pushing from a drawer row or a card inside a hub
     * screen counts as drilling into whichever tab you were already on. */
    fun pushed(target: Screen): NavState {
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
