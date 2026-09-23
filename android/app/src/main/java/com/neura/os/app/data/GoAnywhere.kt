package com.neura.os.app.data

// Go anywhere (docs/android-master-plan.md, V4): one search that reaches every
// place and action in the app by name, and every chat by title. This file is
// the matching and ranking only, so it is JVM-tested; ui/GoAnywhere.kt draws
// it and turns a chosen hit into navigation.

enum class HitKind { PLACE, ACTION, CHAT }

/** One searchable thing. [id] is what the UI acts on (a route key, an action
 * name, a chat id); [keywords] are extra words it answers to. */
data class GoTarget(val kind: HitKind, val id: String, val title: String, val keywords: List<String> = emptyList())

/** At most this many results: a phone screen, not a report. */
const val GO_ANYWHERE_MAX = 12

private fun words(text: String): List<String> = text.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

/** How well [target] answers [query]: higher is better, 0 is no match.
 * A title that starts with the query beats a word that starts with it,
 * which beats a keyword, which beats a plain substring. */
fun goScore(target: GoTarget, query: String): Int {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return 0
    val title = target.title.lowercase()
    val titleWords = words(target.title)
    return when {
        title == q -> 100
        title.startsWith(q) -> 80
        titleWords.any { it.startsWith(q) } -> 60
        target.keywords.any { it.lowercase().startsWith(q) } -> 45
        title.contains(q) -> 30
        target.keywords.any { it.lowercase().contains(q) } -> 15
        else -> 0
    }
}

/** The results for [query], best first; places and actions win a tie over
 * chats, so "settings" finds Settings before a chat about settings. An empty
 * query lists the places and actions, which is what the sheet shows first. */
fun goAnywhere(query: String, targets: List<GoTarget>): List<GoTarget> {
    if (query.isBlank()) return targets.filter { it.kind != HitKind.CHAT }.take(GO_ANYWHERE_MAX)
    return targets
        .map { it to goScore(it, query) }
        .filter { it.second > 0 }
        .sortedWith(compareByDescending<Pair<GoTarget, Int>> { it.second }.thenBy { if (it.first.kind == HitKind.CHAT) 1 else 0 })
        .map { it.first }
        .take(GO_ANYWHERE_MAX)
}
