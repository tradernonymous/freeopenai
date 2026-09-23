package com.neura.os.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

// Scheduled recipes (master plan Phase 5): when a saved prompt next comes due,
// how it reads in the list, and what survives a round trip through storage.
// The alarm itself is Android's; the arithmetic that feeds it is all here.
class SchedulesTest {

    private val zone = ZoneId.of("Europe/Berlin")

    private fun at(text: String): Long = LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli()

    private fun schedule(days: Set<Int>, hour: Int = 8, minute: Int = 0, enabled: Boolean = true) =
        RecipeSchedule("abcd1234", "Summarise my day", hour, minute, days, enabled)

    @Test fun `later today when the time has not passed, else the next chosen day`() {
        // 2026-09-23 is a Wednesday.
        assertEquals(at("2026-09-23T08:00"), nextFireAt(schedule(EVERY_DAY), at("2026-09-23T07:59"), zone))
        assertEquals(at("2026-09-24T08:00"), nextFireAt(schedule(EVERY_DAY), at("2026-09-23T08:00"), zone))
        // Weekdays only: Friday evening -> Monday morning.
        assertEquals(at("2026-09-28T08:00"), nextFireAt(schedule(WEEKDAYS), at("2026-09-25T09:00"), zone))
        // One day a week, already past this week -> a week later.
        assertEquals(at("2026-09-30T08:00"), nextFireAt(schedule(setOf(3)), at("2026-09-23T08:30"), zone))
    }

    @Test fun `switched off or dayless never comes due`() {
        assertNull(nextFireAt(schedule(EVERY_DAY, enabled = false), at("2026-09-23T07:00"), zone))
        assertNull(nextFireAt(schedule(emptySet()), at("2026-09-23T07:00"), zone))
    }

    @Test fun `a time the clock skips moves to the first minute that exists`() {
        // Berlin springs forward on 2027-03-28: 02:00 -> 03:00.
        val due = nextFireAt(schedule(EVERY_DAY, hour = 2, minute = 30), at("2027-03-28T01:00"), zone)
        assertNotNull(due)
        assertEquals(at("2027-03-28T03:30"), due)
    }

    @Test fun `labels read like a person wrote them`() {
        assertEquals("Every day at 08:00", scheduleLabel(schedule(EVERY_DAY)))
        assertEquals("Weekdays at 18:30", scheduleLabel(schedule(WEEKDAYS, 18, 30)))
        assertEquals("Weekends at 09:05", scheduleLabel(schedule(WEEKEND, 9, 5)))
        assertEquals("Mon, Thu at 07:00", scheduleLabel(schedule(setOf(4, 1), 7)))
    }

    @Test fun `what the person typed is checked before it is saved`() {
        assertNull(validateSchedule("Plan my week", 8, 0, WEEKDAYS))
        assertNotNull(validateSchedule("   ", 8, 0, WEEKDAYS))
        assertNotNull(validateSchedule("x".repeat(SCHEDULE_PROMPT_MAX + 1), 8, 0, WEEKDAYS))
        assertNotNull(validateSchedule("Plan", 24, 0, WEEKDAYS))
        assertNotNull(validateSchedule("Plan", 8, 60, WEEKDAYS))
        assertNotNull(validateSchedule("Plan", 8, 0, emptySet()))
        assertNotNull(validateSchedule("Plan", 8, 0, setOf(0)))
    }

    @Test fun `ids that arrive in an intent are checked`() {
        assertTrue(isScheduleId("abcd1234"))
        assertFalse(isScheduleId(null))
        assertFalse(isScheduleId("short"))
        assertFalse(isScheduleId("../../etc/passwd"))
        assertFalse(isScheduleId("ABCD1234"))
    }

    @Test fun `upsert replaces by id and stops at the cap`() {
        val one = schedule(EVERY_DAY)
        val changed = one.copy(prompt = "Plan tomorrow")
        assertEquals(listOf(changed), upsertSchedule(listOf(one), changed))
        val full = (1..SCHEDULE_MAX).map { one.copy(id = "id%06d".format(it)) }
        assertEquals(full, upsertSchedule(full, one.copy(id = "another1")))
    }

    @Test fun `storage keeps good schedules and drops bad ones`() {
        val good = schedule(setOf(1, 3, 5), 7, 45, enabled = false)
        assertEquals(listOf(good), schedulesFromJson(schedulesToJson(listOf(good))))
        val bad = """{"v":1,"schedules":[{"id":"BAD","prompt":"x","hour":1,"minute":1,"days":[1]},""" +
            """{"id":"abcd1234","prompt":"","hour":1,"minute":1,"days":[1]},""" +
            """{"id":"abcd5678","prompt":"ok","hour":1,"minute":1,"days":[]}]}"""
        assertTrue(schedulesFromJson(bad).isEmpty())
        assertTrue(schedulesFromJson("not json").isEmpty())
        assertTrue(schedulesFromJson(null).isEmpty())
    }
}
