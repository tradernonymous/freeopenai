package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

// The voice pill's bars: newest level on the right, never empty, never
// taller than the pill.
class WaveformTest {

    @Test fun `a new level enters on the right and the oldest leaves`() {
        val start = pushLevel(emptyList(), 0.5f, bars = 4)
        assertEquals(listOf(WAVE_FLOOR, WAVE_FLOOR, WAVE_FLOOR, 0.5f), start)
        val full = listOf(0.2f, 0.3f, 0.4f, 0.5f)
        assertEquals(listOf(0.3f, 0.4f, 0.5f, 0.9f), pushLevel(full, 0.9f, bars = 4))
    }

    @Test fun `levels are clamped between the floor and the top`() {
        assertEquals(listOf(WAVE_FLOOR, 1f), pushLevel(listOf(-3f), 7f, bars = 2))
        assertEquals(WAVE_BARS, pushLevel(emptyList(), 0f).size)
    }
}
