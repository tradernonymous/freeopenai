package com.neura.os.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Pull request review from the phone (master plan Phase 4). The server shapes
// GitHub's answers (server.js githubListPulls/githubGetPull/githubReviewPull,
// test/github-pulls.test.js); this is the phone's side of that contract.
class PullRequestsTest {

    @Test fun `a list of open pull requests parses, and junk is skipped`() {
        val pulls = parsePulls("""[{"number":7,"title":"Add dark mode","author":"mona","draft":true,"updatedAt":"2026-09-20T10:00:00Z","head":"dark","base":"main"},{"title":"no number"},"junk"]""")
        assertEquals(1, pulls.size)
        val pr = pulls.single()
        assertEquals(7, pr.number)
        assertEquals("Add dark mode", pr.title)
        assertEquals("mona", pr.author)
        assertTrue(pr.draft)
        assertEquals("dark", pr.head)
        assertEquals("main", pr.base)
        assertEquals(emptyList<PullSummary>(), parsePulls("not json"))
    }

    @Test fun `one pull request parses with its files`() {
        val pr = parsePull(
            """{"number":7,"title":"T","body":"Why","author":"mona","state":"open","draft":false,"head":"dark","base":"main","additions":12,"deletions":3,"url":"https://github.com/o/r/pull/7","filesError":"","files":[{"filename":"a.kt","status":"modified","additions":1,"deletions":1,"patch":"@@ -1 +1 @@\n-a\n+b","clipped":true}]}""",
        )!!
        assertEquals(12, pr.additions)
        assertEquals("https://github.com/o/r/pull/7", pr.url)
        assertEquals("a.kt", pr.files.single().filename)
        assertTrue(pr.files.single().clipped)
        assertNull(parsePull("[]"))
        assertNull(parsePull("""{"title":"no number"}"""))
    }

    @Test fun `a review body carries exactly what is asked`() {
        val body = JSONObject(reviewRequestBody("octocat/demo", 7, ReviewEvent.REQUEST_CHANGES, "  Rename the flag.  "))
        assertEquals("octocat/demo", body.getString("repo"))
        assertEquals(7, body.getInt("number"))
        assertEquals("REQUEST_CHANGES", body.getString("event"))
        assertEquals("Rename the flag.", body.getString("body"))
    }

    @Test fun `only an approval may go without text`() {
        assertTrue(ReviewEvent.APPROVE.canSend(""))
        assertFalse(ReviewEvent.COMMENT.canSend("   "))
        assertFalse(ReviewEvent.REQUEST_CHANGES.canSend(""))
        assertTrue(ReviewEvent.COMMENT.canSend("Looks good"))
    }

    @Test fun `a repo name is checked the same way the server checks it`() {
        assertTrue(isRepoName("octocat/demo"))
        assertTrue(isRepoName("my-org/my.repo_2"))
        assertFalse(isRepoName("octocat"))
        assertFalse(isRepoName("a/b/c"))
        assertFalse(isRepoName("../x"))
        assertFalse(isRepoName("octocat/.."))
        assertFalse(isRepoName("octo cat/demo"))
    }

    @Test fun `diff lines are told apart for colouring`() {
        assertEquals(DiffLine.ADDED, diffLineKind("+val x = 1"))
        assertEquals(DiffLine.REMOVED, diffLineKind("-val x = 0"))
        assertEquals(DiffLine.HUNK, diffLineKind("@@ -1,3 +1,4 @@ fun main"))
        assertEquals(DiffLine.CONTEXT, diffLineKind(" unchanged"))
        // File headers are not changes, even though they start with + or -.
        assertEquals(DiffLine.CONTEXT, diffLineKind("+++ b/a.kt"))
        assertEquals(DiffLine.CONTEXT, diffLineKind("--- a/a.kt"))
    }

    @Test fun `a missing GitHub connection is told apart from a lapsed app session`() {
        assertTrue(isGithubNotConnected("""{"error":"GitHub not connected"}"""))
        assertFalse(isGithubNotConnected("""{"error":"Not signed in"}"""))
        assertFalse(isGithubNotConnected("not json"))
    }
}
