package com.neura.os.app.data

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

// Plan -> diagram (docs/android-master-plan.md, Phase 4): a read-only radial
// map of a chat's task list, drawn in Compose Canvas (ui/PlanMap.kt). A viewer,
// not an editor. Where each node goes is decided here, where it is tested.

/** More than this and the ring stops being readable on a phone. */
const val PLAN_MAP_MAX = 16

/** [count] points on the unit circle, the first at the top, then clockwise
 * (screen coordinates: y grows downward). */
fun radialPositions(count: Int): List<Pair<Double, Double>> =
    if (count <= 0) emptyList() else (0 until count).map { index ->
        val angle = -PI / 2 + 2 * PI * index / count
        cos(angle) to sin(angle)
    }

/** The tasks the map draws: the first [PLAN_MAP_MAX], in plan order. */
fun planMapNodes(tasks: List<TaskItem>): List<TaskItem> = tasks.take(PLAN_MAP_MAX)

/** A node's label: the title, clipped on a word boundary with an ellipsis
 * when it would crowd its neighbours. */
fun mapLabel(title: String, max: Int = 24): String {
    val text = title.trim().replace(Regex("\\s+"), " ")
    if (text.length <= max) return text
    val cut = text.take(max - 1)
    val space = cut.lastIndexOf(' ')
    return (if (space > max / 2) cut.substring(0, space) else cut).trimEnd() + "…"
}
