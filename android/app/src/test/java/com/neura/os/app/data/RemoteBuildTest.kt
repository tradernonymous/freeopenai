package com.neura.os.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteBuildTest {

    private val sessionJson = """
        {"id":"abc123","status":"awaiting_approval","chatId":"c1","provider":"nvidia","model":"qwen/x",
         "repo":"me/app","startedAt":1700000000000,"summary":"","error":"","lastSeq":7,
         "steps":[{"id":"1","title":"Write hello","status":"in_progress","note":""},{"id":"2","title":"Test it","status":"pending","note":""}],
         "pending":{"requestId":"r1","kind":"approval","tool":"write_file","summary":"Create hello.txt","preview":"+hi","expiresAt":1}}
    """.trimIndent()

    @Test
    fun plan_isRecognisedByItsSteps() {
        assertTrue(looksLikePlan("1. Add a test\n2. Write the code"))
        assertTrue(looksLikePlan("- one\n- two\n- [ ] three"))
        assertFalse(looksLikePlan("The answer is 42."))
        assertFalse(looksLikePlan("1. only one step"))
    }

    @Test
    fun session_parsesEveryField() {
        val session = parseBuildSession(sessionJson)!!
        assertEquals("abc123", session.id)
        assertEquals("awaiting_approval", session.status)
        assertEquals(2, session.steps.size)
        assertEquals("in_progress", session.steps[0].status)
        assertEquals("r1", session.pending!!.requestId)
        assertEquals("write_file", session.pending!!.tool)
        assertEquals(7L, session.lastSeq)
        assertTrue(session.waiting)
        assertFalse(session.finished)
    }

    @Test
    fun session_rejectsJunk() {
        assertNull(parseBuildSession("not json"))
        assertNull(parseBuildSession("{\"status\":\"done\"}"))
    }

    @Test
    fun list_readsFlagsAndRows() {
        val body = JSONObject()
            .put("enabled", true).put("reason", "").put("runEnabled", false).put("runReason", "off")
            .put("sessions", org.json.JSONArray().put(JSONObject(sessionJson)))
            .toString()
        val list = parseBuildList(body)
        assertTrue(list.enabled)
        assertFalse(list.runEnabled)
        assertEquals("off", list.runReason)
        assertEquals("abc123", list.sessions.single().id)
        assertFalse(parseBuildList("garbage").enabled)
    }

    @Test
    fun sseFrames_dispatchOnBlankLine() {
        val frames = SseFrames()
        assertNull(frames.feed("retry: 3000"))
        assertNull(frames.feed(""))
        assertNull(frames.feed(": ping"))
        assertNull(frames.feed("id: 4"))
        assertNull(frames.feed("event: step"))
        assertNull(frames.feed("data: {\"seq\":4,\"type\":\"step\",\"id\":\"1\",\"phase\":\"done\",\"title\":\"Write\",\"text\":\"ok\"}"))
        val frame = frames.feed("")!!
        assertEquals("step", frame.first)
        val event = buildEventFrom(frame.first, frame.second) as BuildEvent.StepChange
        assertEquals(4L, event.seq)
        assertEquals("done", event.phase)
        assertEquals(4L, frames.lastId)
    }

    @Test
    fun events_ofEveryKindParse() {
        assertTrue(buildEventFrom("status", "{\"seq\":1,\"status\":\"running\"}") is BuildEvent.Status)
        assertTrue(buildEventFrom("step", "{\"seq\":2,\"phase\":\"output\",\"title\":\"\$ ls\",\"text\":\"exit 0\"}") is BuildEvent.Output)
        assertTrue(buildEventFrom("diff", "{\"seq\":3,\"path\":\"a.txt\",\"patch\":\"+a\",\"bytes\":1,\"created\":true}") is BuildEvent.Diff)
        assertTrue(buildEventFrom("approval", "{\"seq\":4,\"requestId\":\"r\",\"tool\":\"run_command\",\"summary\":\"Run\",\"preview\":\"\$ ls\"}") is BuildEvent.Approval)
        assertTrue(buildEventFrom("question", "{\"seq\":5,\"requestId\":\"q\",\"question\":\"Which?\"}") is BuildEvent.Question)
        assertTrue(buildEventFrom("answer", "{\"seq\":6,\"decision\":\"approve\",\"text\":\"\"}") is BuildEvent.Answer)
        assertTrue(buildEventFrom("message", "{\"seq\":7,\"text\":\"hi\"}") is BuildEvent.Message)
        assertTrue(buildEventFrom("done", "{\"seq\":8,\"status\":\"done\",\"summary\":\"ok\"}") is BuildEvent.Done)
        assertTrue(buildEventFrom("failed", "{\"seq\":9,\"status\":\"cancelled\",\"error\":\"x\"}") is BuildEvent.Failed)
        assertTrue(buildEventFrom("gap", "{\"seq\":1}") is BuildEvent.Gap)
        assertNull(buildEventFrom("unknown", "{\"seq\":1}"))
        assertNull(buildEventFrom("status", "not json"))
    }

    @Test
    fun reducer_tracksStepsPendingAndEnd() {
        var session = parseBuildSession(sessionJson)!!
        session = applyBuildEvent(session, BuildEvent.Answer(8, "approve", ""))
        assertNull(session.pending)
        session = applyBuildEvent(session, BuildEvent.StepChange(9, "1", "done", "Write hello", "written"))
        assertEquals("done", session.steps[0].status)
        assertEquals("written", session.steps[0].note)
        session = applyBuildEvent(session, BuildEvent.StepChange(10, "2", "started", "Test it", ""))
        assertEquals("in_progress", session.steps[1].status)
        session = applyBuildEvent(session, BuildEvent.Question(11, "q1", "Which port?"))
        assertEquals("question", session.pending!!.kind)
        session = applyBuildEvent(session, BuildEvent.Status(12, "running"))
        assertNull(session.pending)
        session = applyBuildEvent(session, BuildEvent.Failed(13, "cancelled", "Cancelled by the user."))
        assertEquals("cancelled", session.status)
        assertTrue(session.finished)
        assertEquals(13L, session.lastSeq)
    }

    @Test
    fun inputBody_namesTheRequest() {
        val approve = JSONObject(buildInputBody("r1", "approve", ""))
        assertEquals("r1", approve.getString("requestId"))
        assertEquals("approve", approve.getString("decision"))
        assertFalse(approve.has("text"))
        val answer = JSONObject(buildInputBody("q1", null, "8080"))
        assertFalse(answer.has("decision"))
        assertEquals("8080", answer.getString("text"))
    }

    @Test
    fun statusLabels_readAsWords() {
        assertEquals("Needs approval", buildStatusLabel("awaiting_approval"))
        assertEquals("Done", buildStatusLabel("done"))
        assertEquals("mystery", buildStatusLabel("mystery"))
    }

    @Test fun `only server-shaped ids reach an approval from a notification`() {
        assertTrue(isApprovalTarget("0123456789abcdef", "a1b2c3d4e5f6a7b8c9d0e1f2"))
        assertTrue(!isApprovalTarget("0123456789abcdef", null))
        assertTrue(!isApprovalTarget("short", "a1b2c3d4e5f6a7b8c9d0e1f2"))
        assertTrue(!isApprovalTarget("0123456789abcdef", "../../input"))
        assertTrue(!isApprovalTarget("0123456789ABCDEF", "a1b2c3d4e5f6a7b8c9d0e1f2"))
    }
}
