package com.neura.os.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.Construction
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush as GradientBrush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The four spaces and the dock (docs/android-master-plan.md §2.1, V4).
// Everything here takes plain values and callbacks, so the screenshot tests
// can draw it without a view model; the thin wrappers at the bottom read the
// view model and pass its state in.

private fun Tab.icon(): ImageVector = when (this) {
    Tab.Chat -> Icons.AutoMirrored.Filled.Chat
    Tab.Create -> Icons.Filled.Brush
    Tab.Agents -> Icons.Filled.SmartToy
    Tab.Activity -> Icons.Filled.Timeline
}

/** The floating dock: two spaces, the orb, two spaces. The orb is the AI
 * itself -- tap to talk, hold for a new chat -- and it pulses while the AI
 * works anywhere in the app. [needsYou] badges Activity. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Dock(
    current: Tab,
    working: Boolean,
    needsYou: Int,
    onSelect: (Tab) -> Unit,
    onOrb: () -> Unit,
    onOrbLong: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .shadow(16.dp, RoundedCornerShape(28.dp), clip = false)
            .glass(RoundedCornerShape(28.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        DockItem(Tab.Chat, current == Tab.Chat, 0, onSelect, Modifier.weight(1f))
        DockItem(Tab.Create, current == Tab.Create, 0, onSelect, Modifier.weight(1f))
        Box(
            Modifier
                .size(52.dp)
                .clip(CircleShape)
                .background(GradientBrush.linearGradient(listOf(Palette.accent, Palette.glow)))
                .combinedClickable(onClick = onOrb, onLongClick = onOrbLong)
                .semantics { contentDescription = "Talk to NeuraOS. Hold for a new chat." },
            contentAlignment = Alignment.Center,
        ) {
            if (working) {
                NeuraPulse(30.dp)
            } else {
                Icon(Icons.Filled.Mic, null, tint = Palette.onAccent, modifier = Modifier.size(24.dp))
            }
        }
        DockItem(Tab.Agents, current == Tab.Agents, 0, onSelect, Modifier.weight(1f))
        DockItem(Tab.Activity, current == Tab.Activity, needsYou, onSelect, Modifier.weight(1f))
    }
}

@Composable
private fun DockItem(tab: Tab, selected: Boolean, badge: Int, onSelect: (Tab) -> Unit, modifier: Modifier) {
    val tint by animateColorAsState(if (selected) Palette.accent else Palette.muted, label = "dockTint")
    Column(
        modifier
            .clip(RoundedCornerShape(20.dp))
            .clickable { onSelect(tab) }
            .semantics { this.selected = selected; contentDescription = tab.label + if (badge > 0) ", $badge need you" else "" }
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box {
            Icon(tab.icon(), null, tint = tint, modifier = Modifier.size(22.dp))
            if (badge > 0) {
                Box(
                    Modifier.align(Alignment.TopEnd).padding(start = 14.dp).size(16.dp).clip(CircleShape).background(Palette.amber),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (badge > 9) "9+" else badge.toString(), color = Palette.background, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
        Text(tab.label, color = tint, fontSize = 11.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
    }
}

/** One destination inside a space. */
data class SpaceItem(val icon: ImageVector, val title: String, val subtitle: String, val attention: Boolean = false, val onClick: () -> Unit)

/** A space's own page: a large title, one line on what the space is for,
 * and its destinations as cards. */
@Composable
fun SpaceHome(
    title: String,
    tagline: String,
    items: List<SpaceItem>,
    modifier: Modifier = Modifier,
    initial: String = "",
    onSearch: (() -> Unit)? = null,
    onAccount: (() -> Unit)? = null,
    header: (@Composable () -> Unit)? = null,
) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp)) {
        // Reading, not doing, at the top: the search and the account (which
        // holds Settings) are the only two things up here.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.weight(1f))
            onSearch?.let {
                IconButton(it) { Icon(Icons.Filled.Search, "Go anywhere", tint = Palette.muted) }
            }
            onAccount?.let {
                Box(
                    Modifier.size(36.dp).clip(CircleShape).background(Palette.accentDeep).clickable(onClick = it)
                        .semantics { contentDescription = "Account and settings" },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(initial.take(1).uppercase().ifEmpty { "?" }, color = Palette.text, fontSize = 14.sp)
                }
            }
        }
        Text(title, color = Palette.text, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.enterUp())
        Spacer(Modifier.height(4.dp))
        Text(tagline, color = Palette.muted, fontSize = 14.sp, modifier = Modifier.enterUp(60))
        Spacer(Modifier.height(20.dp))
        header?.let {
            it()
            Spacer(Modifier.height(20.dp))
        }
        items.forEachIndexed { index, item ->
            SpaceCard(item, Modifier.enterUp(90 + index * 40))
            Spacer(Modifier.height(10.dp))
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SpaceCard(item: SpaceItem, modifier: Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .pressScale(0.97f)
            .clip(RoundedCornerShape(18.dp))
            .background(Palette.surface)
            .border(1.dp, if (item.attention) Palette.amber.copy(alpha = 0.6f) else Palette.outline.copy(alpha = 0.25f), RoundedCornerShape(18.dp))
            .clickable(onClick = item.onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(if (item.attention) Palette.amberTint else Palette.accentTint),
            contentAlignment = Alignment.Center,
        ) {
            Icon(item.icon, null, tint = if (item.attention) Palette.amber else Palette.accent, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(item.title, color = Palette.text, fontSize = 16.sp, fontWeight = FontWeight.Medium, modifier = Modifier.sharedTitle(item.title))
            Text(item.subtitle, color = if (item.attention) Palette.amber else Palette.muted, fontSize = 13.sp)
        }
    }
}

// --- The two spaces that are new pages ---------------------------------------

/** Agents: who works for you, and how. */
@Composable
fun AgentsSpace(vm: AppViewModel) {
    val schedules = vm.schedules.size
    SpaceHome(
        title = "Agents",
        tagline = "Who works for you, and how.",
        initial = vm.username,
        onSearch = { vm.goAnywhereOpen = true },
        onAccount = { vm.push(Route.Settings) },
        header = {
            AgentGallery(com.neura.os.app.data.allPersonas(vm.library)) { persona ->
                vm.newChat(personaId = persona.id)
                vm.goToChat()
            }
        },
        items = listOf(
            SpaceItem(Icons.Filled.Person, "Library", "${vm.library.personas.size} personas, ${vm.library.prompts.size} prompts") { vm.push(Route.Knowledges) },
            SpaceItem(Icons.Filled.Extension, "Skills", if (vm.skills.isEmpty()) "Instructions a chat can pin" else "${vm.skills.size} skills") { vm.push(Route.Skills) },
            SpaceItem(Icons.Filled.Construction, "Tools", "Search, status, files and more") { vm.push(Route.Tools) },
            SpaceItem(Icons.Filled.AutoAwesome, "Automate", if (schedules == 0) "Scheduled prompts and phone actions" else "$schedules scheduled") { vm.push(Route.Automation) },
        ),
    )
}

/** Activity: everything running or waiting for you. */
@Composable
fun ActivitySpace(vm: AppViewModel) {
    val sessions = vm.builds.list?.sessions.orEmpty()
    val waiting = sessions.count { it.waiting }
    val running = sessions.count { !it.finished && !it.waiting }
    val queued = vm.outbox.entries.size
    val items = buildList {
        add(
            SpaceItem(
                Icons.Filled.Construction, "Builds",
                when {
                    waiting > 0 -> "$waiting waiting for your approval"
                    running > 0 -> "$running running on the server"
                    sessions.isEmpty() -> "Plan in a chat, build on your server"
                    else -> "${sessions.size} recent"
                },
                attention = waiting > 0,
            ) { vm.openBuilds() },
        )
        if (vm.githubConnected) add(SpaceItem(Icons.Filled.Timeline, "Pull requests", "Read diffs, approve or ask for changes") { vm.push(Route.Reviews) })
        add(
            SpaceItem(Icons.Filled.History, "Queued replies", if (queued == 0) "Nothing waiting for the network" else "$queued will be fetched when you're online", attention = queued > 0) {
                vm.outbox.entries.firstOrNull()?.let { vm.openChat(it.chatId) } ?: vm.goToChat()
            },
        )
        add(SpaceItem(Icons.Filled.Schedule, "Scheduled prompts", if (vm.schedules.isEmpty()) "None yet" else "${vm.schedules.count { it.enabled }} on") { vm.push(Route.Automation) })
    }
    SpaceHome(
        title = "Activity",
        tagline = "Everything running, or waiting for you.",
        items = items,
        initial = vm.username,
        onSearch = { vm.goAnywhereOpen = true },
        onAccount = { vm.push(Route.Settings) },
    )
}

/** How many things need the person: builds waiting for approval, and
 * replies waiting for the network. Badges the dock's Activity. */
fun needsYouCount(vm: AppViewModel): Int =
    vm.builds.list?.sessions.orEmpty().count { it.waiting } + (if (vm.builds.attention != null) 1 else 0)

/** The agents gallery (rebrand plan §4.3): every persona as a card with its
 * avatar; one tap starts a chat with it. */
@Composable
fun AgentGallery(personas: List<com.neura.os.app.data.Persona>, onStart: (com.neura.os.app.data.Persona) -> Unit) {
    Column {
        Text("Start with", color = Palette.muted, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(personas.size, key = { personas[it].id }) { index ->
                val persona = personas[index]
                Column(
                    Modifier.width(112.dp).enterUp(index * 40).pressScale(0.95f).clip(RoundedCornerShape(18.dp))
                        .background(Palette.surface)
                        .border(1.dp, Palette.outline.copy(alpha = 0.25f), RoundedCornerShape(18.dp))
                        .clickable { onStart(persona) }
                        .padding(12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier.size(48.dp).clip(CircleShape)
                            .background(GradientBrush.linearGradient(listOf(Palette.accentTint, Palette.glow.copy(alpha = 0.18f)))),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(persona.emoji.ifBlank { "✨" }, fontSize = 22.sp)
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(persona.name, color = Palette.text, fontSize = 13.sp, maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}
