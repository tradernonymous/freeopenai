package com.neura.os.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import com.neura.os.app.data.ChatMessage
import com.neura.os.app.data.TaskItem
import com.neura.os.app.data.parseChartSpec
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

// Screenshot baselines (docs/android-master-plan.md, V2). Every visual phase
// after this one is compared against these pictures, in both themes and at a
// phone and a tablet width, so a change nobody meant shows up as a diff in CI
// instead of on someone's phone. Only composables that need no view model are
// drawn here; screens grow into this file as V3 gives them state holders.
//
// Plain `testDebugUnitTest` runs these without capturing anything; CI runs
// recordRoborazziDebug or verifyRoborazziDebug (see android.yml).
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// Robolectric draws at an SDK it ships; it has none for the app's compileSdk
// (37), which failed the whole class before any picture was taken.
@Config(sdk = [35])
class ScreenshotTest {

    @After fun backToDark() {
        Palette.isDark = true
    }

    private fun shot(name: String, dark: Boolean, content: @Composable () -> Unit) {
        Palette.isDark = dark
        captureRoboImage("src/test/screenshots/${name}_${if (dark) "dark" else "light"}.png") {
            NeuraTheme {
                Column(Modifier.fillMaxSize().background(Palette.background).padding(16.dp)) { content() }
            }
        }
    }

    /** A chat's building blocks: a user bubble, a reply with code and a chart,
     * the plan panel, the AI-working pulse and the Build banners. */
    @Composable
    private fun ChatSample() {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            UserBubble(ChatMessage("user", "Plot this week's sign-ups and explain the dip."), onEdit = {}, onCopy = {})
            MarkdownText(
                "Sign-ups fell on **Wednesday** because the form was down for two hours.\n\n" +
                    "```chart\n{\"type\":\"bar\",\"title\":\"Sign-ups\",\"labels\":[\"Mon\",\"Tue\",\"Wed\",\"Thu\",\"Fri\"]," +
                    "\"series\":[{\"name\":\"2026\",\"values\":[42,51,18,47,55]}]}\n```\n\n" +
                    "```kotlin\nval dip = signups.minBy { it.count }\n```",
                onCopyCode = {},
            )
            TaskPanel(
                listOf(
                    TaskItem("1", "Read the sign-up log", "done"),
                    TaskItem("2", "Find the outage window", "in_progress"),
                    TaskItem("3", "Draft the note", "todo"),
                ),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NeuraPulse()
                Text("Thinking…", color = Palette.muted)
            }
            BuildModeBanner()
            PendingWritesBanner(count = 2, onOpen = {})
        }
    }

    /** The tools and empty-state surfaces. */
    @Composable
    private fun ToolsSample() {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionTitle("Tools")
            ToolCard("🖼️", "Images", "Draw with the free providers", onClick = {})
            ToolCard("🤖", "Automate", "Scheduled prompts and device actions", onClick = {})
            EmptyState("No builds yet", "Start a plan and approve each step from here.", actionLabel = "Start a plan", onAction = {})
            parseChartSpec("{\"type\":\"line\",\"labels\":[\"1\",\"2\",\"3\",\"4\"],\"series\":[{\"name\":\"a\",\"values\":[3,5,4,6]},{\"name\":\"b\",\"values\":[2,3,5,4]}]}")
                ?.let { ChartView(it) }
        }
    }

    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun chat_phone() {
        shot("chat_phone", dark = true) { ChatSample() }
        shot("chat_phone", dark = false) { ChatSample() }
    }

    @Test @Config(qualifiers = "w840dp-h1200dp-xhdpi")
    fun chat_tablet() {
        shot("chat_tablet", dark = true) { ChatSample() }
        shot("chat_tablet", dark = false) { ChatSample() }
    }

    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun tools_phone() {
        shot("tools_phone", dark = true) { ToolsSample() }
        shot("tools_phone", dark = false) { ToolsSample() }
    }

    /** A space's page with the dock under it (V4). */
    @Composable
    private fun SpaceSample() {
        Column(Modifier.fillMaxSize()) {
            SpaceHome(
                title = "Activity",
                tagline = "Everything running, or waiting for you.",
                items = listOf(
                    SpaceItem(androidx.compose.material.icons.Icons.Filled.Build, "Builds", "1 waiting for your approval", attention = true) {},
                    SpaceItem(androidx.compose.material.icons.Icons.Filled.History, "Queued replies", "Nothing waiting for the network") {},
                    SpaceItem(androidx.compose.material.icons.Icons.Filled.Schedule, "Scheduled prompts", "2 on") {},
                ),
                modifier = Modifier.weight(1f),
                initial = "Sam",
                onSearch = {},
                onAccount = {},
            )
            Dock(current = Tab.Activity, working = false, needsYou = 1, onSelect = {}, onOrb = {}, onOrbLong = {})
        }
    }

    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun agents_phone() {
        val sample: @Composable () -> Unit = {
            SpaceHome(
                title = "Agents",
                tagline = "Who works for you, and how.",
                items = listOf(SpaceItem(androidx.compose.material.icons.Icons.Filled.Build, "Library", "8 personas, 12 prompts") {}),
                header = { AgentGallery(com.neura.os.app.data.BUILT_IN_PERSONAS) {} },
                initial = "Sam",
                onSearch = {},
                onAccount = {},
            )
        }
        shot("agents_phone", dark = true, sample)
        shot("agents_phone", dark = false, sample)
    }

    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun space_phone() {
        shot("space_phone", dark = true) { SpaceSample() }
        shot("space_phone", dark = false) { SpaceSample() }
    }

    /** The AI-working edge glow over a chat (V6). */
    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun glow_phone() {
        val sample: @Composable () -> Unit = {
            androidx.compose.foundation.layout.Box(Modifier.fillMaxSize()) {
                ChatSample()
                AiEdgeGlow(active = true)
            }
        }
        shot("glow_phone", dark = true, sample)
        shot("glow_phone", dark = false, sample)
    }

    @Test @Config(qualifiers = "w411dp-h891dp-xxhdpi")
    fun lock_phone() {
        shot("lock_phone", dark = true) { LockScreen(error = null, onUnlock = {}) }
        shot("lock_phone", dark = false) { LockScreen(error = "Fingerprint not recognised", onUnlock = {}) }
    }
}
