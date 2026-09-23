package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// One chart from one file (master plan Phase 4): a reply's ```chart block is
// drawn in Compose Canvas when it parses into something drawable, and shown as
// plain code when it does not -- a half-streamed block or a bad spec never
// disappears, it just stays text.
class ChartSpecTest {

    @Test fun `a bar chart parses`() {
        val spec = parseChartSpec("""{"type":"bar","title":"Sales","labels":["Q1","Q2","Q3"],"series":[{"name":"2026","values":[3,5,4]}]}""")!!
        assertEquals(ChartType.BAR, spec.type)
        assertEquals("Sales", spec.title)
        assertEquals(listOf("Q1", "Q2", "Q3"), spec.labels)
        assertEquals(listOf(3.0, 5.0, 4.0), spec.series.single().values)
    }

    @Test fun `the type is case-insensitive and defaults nowhere`() {
        assertNotNull(parseChartSpec("""{"type":"LINE","labels":["a","b"],"series":[{"name":"s","values":[1,2]}]}"""))
        assertNull(parseChartSpec("""{"type":"pie","labels":["a"],"series":[{"name":"s","values":[1]}]}"""))
        assertNull(parseChartSpec("""{"labels":["a"],"series":[{"name":"s","values":[1]}]}"""))
    }

    @Test fun `a spec that cannot be drawn is refused rather than guessed at`() {
        // Half-streamed.
        assertNull(parseChartSpec("""{"type":"bar","labels":["a","b"],"series":[{"name":"s","values":[1"""))
        // A series whose length does not match the labels.
        assertNull(parseChartSpec("""{"type":"bar","labels":["a","b"],"series":[{"name":"s","values":[1]}]}"""))
        // No series, or no points.
        assertNull(parseChartSpec("""{"type":"bar","labels":[],"series":[]}"""))
        // A value that is not a number.
        assertNull(parseChartSpec("""{"type":"line","labels":["a"],"series":[{"name":"s","values":["x"]}]}"""))
        // Too many series to tell apart on a phone.
        val five = (1..5).joinToString(",") { """{"name":"s$it","values":[1]}""" }
        assertNull(parseChartSpec("""{"type":"bar","labels":["a"],"series":[$five]}"""))
    }

    @Test fun `too many points is refused`() {
        val labels = (1..(CHART_MAX_POINTS + 1)).joinToString(",") { "\"$it\"" }
        val values = (1..(CHART_MAX_POINTS + 1)).joinToString(",")
        assertNull(parseChartSpec("""{"type":"line","labels":[$labels],"series":[{"name":"s","values":[$values]}]}"""))
    }

    @Test fun `the value range includes zero for bars and pads a flat line`() {
        val bars = parseChartSpec("""{"type":"bar","labels":["a","b"],"series":[{"name":"s","values":[5,8]}]}""")!!
        assertEquals(0.0 to 8.0, chartRange(bars))
        val flat = parseChartSpec("""{"type":"line","labels":["a","b"],"series":[{"name":"s","values":[4,4]}]}""")!!
        val (low, high) = chartRange(flat)
        assertTrue(low < 4.0 && high > 4.0)
    }

    @Test fun `scatter uses numeric labels as x, and positions otherwise`() {
        val numeric = parseChartSpec("""{"type":"scatter","labels":["1","2.5","10"],"series":[{"name":"s","values":[1,2,3]}]}""")!!
        assertEquals(listOf(1.0, 2.5, 10.0), chartX(numeric))
        val named = parseChartSpec("""{"type":"scatter","labels":["a","b"],"series":[{"name":"s","values":[1,2]}]}""")!!
        assertEquals(listOf(0.0, 1.0), chartX(named))
    }
}
