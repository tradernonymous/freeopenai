package com.freeai4u.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Build mode's whole safety case rests on one fact: its file tools cannot
 * reach a real filesystem. That fact lived, before this phase, as "no file
 * tool exists at all" -- AgentTest asserted it directly. Now that file tools
 * exist, the invariant that replaces it can only be checked by reading the
 * actual source and manifest, not by calling a function: no amount of unit
 * testing runLocalTool proves it never imports java.io next year. This is
 * the assertion that would fail the build the moment someone did. */
class RatchetTest {
    private fun read(path: String): String {
        val fromModuleRoot = File(path)
        val file = if (fromModuleRoot.isFile) fromModuleRoot else File("android/app/$path")
        return file.readText()
    }

    @Test fun `agent has no filesystem or android import`() {
        val text = read("src/main/java/com/freeai4u/app/data/Agent.kt")
        for (banned in listOf("import java.io.", "import java.nio.", "import android.")) {
            assertFalse("Agent.kt must not import $banned -- a build tool must not be able to reach a real path", text.contains(banned))
        }
    }

    @Test fun `manifest has not grown a device-control permission yet`() {
        val text = read("src/main/AndroidManifest.xml")
        for (banned in listOf("SYSTEM_ALERT_WINDOW", "BIND_ACCESSIBILITY_SERVICE", "QUERY_ALL_PACKAGES", "MANAGE_EXTERNAL_STORAGE")) {
            assertFalse("$banned is P9's to add, deliberately and visibly -- not a side effect of an earlier phase", text.contains(banned))
        }
    }

    @Test fun `workspace itself is also free of filesystem or android import`() {
        val text = read("src/main/java/com/freeai4u/app/data/Workspace.kt")
        for (banned in listOf("import java.io.", "import java.nio.", "import android.")) {
            assertTrue("Workspace.kt must not import $banned", !text.contains(banned))
        }
    }
}
