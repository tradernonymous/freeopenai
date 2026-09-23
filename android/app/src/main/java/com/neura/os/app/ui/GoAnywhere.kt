package com.neura.os.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.GoTarget
import com.neura.os.app.data.HitKind
import com.neura.os.app.data.goAnywhere

// Go anywhere (docs/android-master-plan.md §2.1, V4): the command palette.
// Every place, a few actions, and every chat by title, found by typing; the
// matching lives in data/GoAnywhere.kt.

private fun places(vm: AppViewModel): List<GoTarget> = buildList {
    add(GoTarget(HitKind.PLACE, "chat", "Chat", listOf("home", "conversation")))
    add(GoTarget(HitKind.PLACE, "create", "Create", listOf("images", "draw", "picture")))
    add(GoTarget(HitKind.PLACE, "agents", "Agents", listOf("library", "assistants")))
    add(GoTarget(HitKind.PLACE, "activity", "Activity", listOf("running", "waiting", "queue")))
    add(GoTarget(HitKind.PLACE, "settings", "Settings", listOf("preferences", "account", "theme", "diagnostics")))
    add(GoTarget(HitKind.PLACE, "knowledges", "Library", listOf("personas", "prompts")))
    add(GoTarget(HitKind.PLACE, "personas", "Personas", listOf("agents", "characters")))
    add(GoTarget(HitKind.PLACE, "prompts", "Prompts", listOf("templates")))
    add(GoTarget(HitKind.PLACE, "skills", "Skills", listOf("instructions")))
    add(GoTarget(HitKind.PLACE, "tools", "Tools", listOf("search", "status")))
    add(GoTarget(HitKind.PLACE, "automation", "Automate", listOf("schedule", "device", "recipes")))
    add(GoTarget(HitKind.PLACE, "builds", "Builds", listOf("remote", "server", "approve")))
    if (vm.githubConnected) add(GoTarget(HitKind.PLACE, "reviews", "Pull requests", listOf("github", "review", "diff")))
    add(GoTarget(HitKind.ACTION, "new-chat", "New chat", listOf("start")))
    add(GoTarget(HitKind.ACTION, "voice", "Voice mode", listOf("talk", "speak", "listen")))
    add(GoTarget(HitKind.ACTION, "theme-dark", "Dark theme", listOf("night", "appearance")))
    add(GoTarget(HitKind.ACTION, "theme-light", "Light theme", listOf("day", "appearance")))
    add(GoTarget(HitKind.ACTION, "theme-system", "Theme follows the phone", listOf("system", "appearance")))
    add(GoTarget(HitKind.ACTION, "updates", "Check for updates", listOf("version", "apk")))
}

private fun chats(vm: AppViewModel): List<GoTarget> =
    vm.conversations.filter { it.messages.isNotEmpty() }.map { GoTarget(HitKind.CHAT, it.id, it.title) }

/** Carries out a chosen hit. */
private fun go(vm: AppViewModel, platform: Platform, hit: GoTarget) {
    when (hit.kind) {
        HitKind.CHAT -> vm.openChat(hit.id)
        HitKind.ACTION -> when (hit.id) {
            "new-chat" -> vm.newChat()
            "voice" -> platform.startVoice()
            "theme-dark" -> vm.setTheme("dark")
            "theme-light" -> vm.setTheme("light")
            "theme-system" -> vm.setTheme("system")
            "updates" -> platform.checkUpdates()
        }
        HitKind.PLACE -> when (hit.id) {
            "chat" -> vm.goToChat()
            "create" -> vm.selectTab(Tab.Create)
            "agents" -> vm.selectTab(Tab.Agents)
            "activity" -> vm.selectTab(Tab.Activity)
            "builds" -> vm.openBuilds()
            else -> screenFromKey(hit.id)?.let { vm.push(it) }
        }
    }
}

@Composable
fun GoAnywhereSheet(vm: AppViewModel, platform: Platform, onClose: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val all = remember(vm.conversations.size, vm.githubConnected) { places(vm) + chats(vm) }
    val hits = remember(query, all) { goAnywhere(query, all) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxSize().background(Palette.background.copy(alpha = 0.97f)).imePadding().padding(16.dp)) {
        Row(
            Modifier.fillMaxWidth().height(52.dp).glass(RoundedCornerShape(26.dp)).padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Search, null, tint = Palette.accent, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            BasicTextField(
                query, { query = it }, singleLine = true,
                textStyle = TextStyle(color = Palette.text, fontSize = 17.sp, fontFamily = NeuraSans),
                cursorBrush = SolidColor(Palette.accent),
                modifier = Modifier.weight(1f).focusRequester(focus),
                decorationBox = { inner ->
                    Box {
                        if (query.isEmpty()) Text("Go anywhere", color = Palette.muted, fontSize = 17.sp)
                        inner()
                    }
                },
            )
            IconButton(onClose) { Icon(Icons.Filled.Close, "Close", tint = Palette.muted) }
        }
        Spacer(Modifier.height(12.dp))
        LazyColumn {
            items(hits, key = { it.kind.name + it.id }) { hit ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                        .clickable { go(vm, platform, hit); onClose() }
                        .padding(horizontal = 12.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        when (hit.kind) {
                            HitKind.PLACE -> Icons.Filled.Explore
                            HitKind.ACTION -> Icons.Filled.Bolt
                            HitKind.CHAT -> Icons.AutoMirrored.Filled.Chat
                        },
                        null, tint = if (hit.kind == HitKind.CHAT) Palette.muted else Palette.accent, modifier = Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(14.dp))
                    Text(hit.title, color = Palette.text, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(
                        when (hit.kind) { HitKind.PLACE -> "Go"; HitKind.ACTION -> "Do"; HitKind.CHAT -> "Chat" },
                        color = Palette.muted, fontSize = 12.sp,
                    )
                }
            }
            if (hits.isEmpty()) item { Text("Nothing called that yet.", color = Palette.muted, modifier = Modifier.padding(12.dp)) }
        }
    }
}
