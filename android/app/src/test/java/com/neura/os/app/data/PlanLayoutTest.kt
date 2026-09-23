package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Plan -> diagram (master plan Phase 4): a read-only radial map of a chat's
// task list. The drawing is Compose Canvas; where each node goes is here.
class PlanLayoutTest {

    private fun close(expected: Double, actual: Double) = assertEquals(expected, actual, 1e-9)

    @Test fun `nodes start at the top and go clockwise around the circle`() {
        val points = radialPositions(4)
        close(0.0, points[0].first); close(-1.0, points[0].second)
        close(1.0, points[1].first); close(0.0, points[1].second)
        close(0.0, points[2].first); close(1.0, points[2].second)
        close(-1.0, points[3].first); close(0.0, points[3].second)
    }

    @Test fun `every node sits on the unit circle`() {
        for ((x, y) in radialPositions(7)) close(1.0, x * x + y * y)
    }

    @Test fun `no tasks means no nodes, and the map caps how many it draws`() {
        assertEquals(0, radialPositions(0).size)
        assertEquals(PLAN_MAP_MAX, planMapNodes(List(40) { TaskItem("t$it", "task $it") }).size)
    }

    @Test fun `a long title is clipped on a word and marked`() {
        assertEquals("Write tests", mapLabel("Write tests"))
        val long = mapLabel("Refactor the provider failover so it respects cooldowns")
        assertTrue(long.length <= 24)
        assertTrue(long.endsWith("…"))
        assertTrue(long.startsWith("Refactor the provider"))
    }
}
