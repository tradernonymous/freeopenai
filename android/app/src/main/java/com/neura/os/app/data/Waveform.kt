package com.neura.os.app.data

// The voice waveform pill (docs/android-master-plan.md V6 gap): the last few
// microphone levels, newest on the right, as bar heights. Pure, so tested;
// ui/Effects.kt WaveformPill draws.

/** Bars in the pill. */
const val WAVE_BARS = 24

/** The quietest a bar gets, so the pill never looks empty or broken. */
const val WAVE_FLOOR = 0.08f

/** [history] with [level] added on the right and the oldest dropped, every
 * value clamped to [WAVE_FLOOR]..1, always [bars] long (padded with the
 * floor on the left while it fills up). */
fun pushLevel(history: List<Float>, level: Float, bars: Int = WAVE_BARS): List<Float> {
    val next = (history + level).map { it.coerceIn(WAVE_FLOOR, 1f) }.takeLast(bars)
    return List(bars - next.size) { WAVE_FLOOR } + next
}
