package com.neura.os.app.data

import org.json.JSONObject

// One chart from one file (docs/android-master-plan.md, Phase 4): a reply may
// carry a fenced ```chart block of JSON, which ui/Charts.kt draws in Compose
// Canvas -- no chart library. Anything that does not parse into something
// drawable returns null here and the block stays ordinary code on screen, so
// a half-streamed or wrong spec is never silently lost.

enum class ChartType { BAR, LINE, SCATTER }

data class ChartSeries(val name: String, val values: List<Double>)

data class ChartSpec(val type: ChartType, val title: String, val labels: List<String>, val series: List<ChartSeries>)

/** More than this and a phone screen cannot tell the points apart. */
const val CHART_MAX_POINTS = 200

/** Series beyond this stop being tellable apart by colour. */
const val CHART_MAX_SERIES = 4

/** What the system prompt tells a model a chart block looks like. */
const val CHART_FORMAT_HINT =
    "Charts: when numbers (say, from an attached file) read better as a chart, add one fenced block tagged chart " +
        "holding JSON {\"type\":\"bar|line|scatter\",\"title\":\"...\",\"labels\":[...],\"series\":[{\"name\":\"...\",\"values\":[...]}]} " +
        "with every series as long as labels (at most 4 series, 200 points); the app draws it."

fun parseChartSpec(json: String): ChartSpec? = try {
    val obj = JSONObject(json)
    val type = when (obj.optString("type", "").lowercase()) {
        "bar" -> ChartType.BAR
        "line" -> ChartType.LINE
        "scatter" -> ChartType.SCATTER
        else -> null
    }
    val labelsJson = obj.optJSONArray("labels")
    val seriesJson = obj.optJSONArray("series")
    if (type == null || labelsJson == null || seriesJson == null) {
        null
    } else {
        val labels = (0 until labelsJson.length()).map { labelsJson.opt(it)?.toString().orEmpty() }
        val series = (0 until seriesJson.length()).map { index ->
            val item = seriesJson.getJSONObject(index)
            val values = item.getJSONArray("values")
            ChartSeries(
                name = item.optString("name", "Series ${index + 1}"),
                values = (0 until values.length()).map { values.getDouble(it) },
            )
        }
        val drawable = labels.isNotEmpty() &&
            labels.size <= CHART_MAX_POINTS &&
            series.size in 1..CHART_MAX_SERIES &&
            series.all { s -> s.values.size == labels.size && s.values.all { it.isFinite() } }
        if (drawable) ChartSpec(type, obj.optString("title", ""), labels, series) else null
    }
} catch (e: Exception) {
    null
}

/** The value axis: from the smallest to the largest value -- from zero for
 * bars, which start there -- padded when every value is the same. */
fun chartRange(spec: ChartSpec): Pair<Double, Double> {
    val values = spec.series.flatMap { it.values }
    var low = values.minOrNull() ?: 0.0
    var high = values.maxOrNull() ?: 1.0
    if (spec.type == ChartType.BAR) {
        low = minOf(low, 0.0)
        high = maxOf(high, 0.0)
    }
    if (high == low) {
        low -= 1.0
        high += 1.0
    }
    return low to high
}

/** Scatter x positions: the labels themselves when all are numbers, else
 * their positions 0, 1, 2... */
fun chartX(spec: ChartSpec): List<Double> {
    val numbers = spec.labels.map { it.trim().toDoubleOrNull() }
    return if (numbers.all { it != null && it.isFinite() }) numbers.map { it!! } else spec.labels.indices.map { it.toDouble() }
}
