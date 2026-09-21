package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AutomationsTest {

    @Test
    fun `record adds a new prompt at the front`() {
        val entries = recordAutomation(emptyList(), "Open Twitter", 1000L)
        assertEquals(listOf(AutomationEntry("Open Twitter", 1000L)), entries)
    }

    @Test
    fun `record moves a repeat to the front with the new time`() {
        val first = recordAutomation(emptyList(), "Open Twitter", 1000L)
        val second = recordAutomation(first, "Open Twitter", 5000L)
        assertEquals(listOf(AutomationEntry("Open Twitter", 5000L)), second)
    }

    @Test
    fun `record keeps other entries when one is re-run`() {
        val a = recordAutomation(emptyList(), "A", 1000L)
        val b = recordAutomation(a, "B", 2000L)
        val reRun = recordAutomation(b, "A", 3000L)
        assertEquals(listOf("A", "B"), reRun.map { it.prompt })
        assertEquals(3000L, reRun[0].ranAt)
        assertEquals(2000L, reRun[1].ranAt)
    }

    @Test
    fun `record ignores blank prompts`() {
        assertTrue(recordAutomation(emptyList(), "   ", 1000L).isEmpty())
    }

    @Test
    fun `history never grows past the cap`() {
        var entries = emptyList<AutomationEntry>()
        for (index in 0 until AUTOMATION_HISTORY_MAX + 5) {
            entries = recordAutomation(entries, "Prompt $index", 1000L + index)
        }
        assertEquals(AUTOMATION_HISTORY_MAX, entries.size)
        // Newest survives; the oldest five fell off.
        assertEquals("Prompt ${AUTOMATION_HISTORY_MAX + 4}", entries.first().prompt)
    }

    @Test
    fun `json round trip keeps entries`() {
        val entries = recordAutomation(emptyList(), "Scroll Instagram", 42L)
        val back = automationsFromJson(automationsToJson(entries))
        assertEquals(entries, back)
    }

    @Test
    fun `json from garbage is empty never a crash`() {
        assertTrue(automationsFromJson(null).isEmpty())
        assertTrue(automationsFromJson("").isEmpty())
        assertTrue(automationsFromJson("not json").isEmpty())
    }

    @Test
    fun `json entries without a prompt are dropped`() {
        val back = automationsFromJson("""{"v":1,"entries":[{"prompt":"  ","ranAt":1},{"prompt":"ok","ranAt":2}]}""")
        assertEquals(listOf(AutomationEntry("ok", 2L)), back)
    }
}
