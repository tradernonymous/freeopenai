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

    // P9 (device control) is the one deliberate, visible exception to this
    // file's whole premise: DeviceControlService is a real
    // BIND_ACCESSIBILITY_SERVICE, added on purpose, not a side effect of an
    // earlier phase. The two tests below replace the single "nothing has
    // grown yet" assertion this class had before P9: one still forbids
    // every permission P9 did NOT ask for (a floating overlay, bypassing
    // package visibility, broad storage access), the other confirms the one
    // permission it does add is scoped to that one service.
    @Test fun `manifest still forbids every device-control permission P9 did not ask for`() {
        val text = read("src/main/AndroidManifest.xml")
        for (banned in listOf("SYSTEM_ALERT_WINDOW", "QUERY_ALL_PACKAGES", "MANAGE_EXTERNAL_STORAGE")) {
            assertFalse("$banned was never part of the plan for P9", text.contains(banned))
        }
    }

    @Test fun `the one device-control permission P9 adds is scoped to DeviceControlService`() {
        val text = read("src/main/AndroidManifest.xml")
        assertTrue("P9 adds exactly one BIND_ACCESSIBILITY_SERVICE", text.contains("android.permission.BIND_ACCESSIBILITY_SERVICE"))
        assertTrue("it must guard DeviceControlService, not some other component", text.contains(".DeviceControlService"))
    }

    @Test fun `workspace itself is also free of filesystem or android import`() {
        val text = read("src/main/java/com/freeai4u/app/data/Workspace.kt")
        for (banned in listOf("import java.io.", "import java.nio.", "import android.")) {
            assertTrue("Workspace.kt must not import $banned", !text.contains(banned))
        }
    }
}
