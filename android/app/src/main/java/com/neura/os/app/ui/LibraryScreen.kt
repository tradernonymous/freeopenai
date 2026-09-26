package com.neura.os.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import com.neura.os.R
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.CHAT_COMMANDS
import com.neura.os.app.data.LibraryEntry
import com.neura.os.app.data.allPersonas
import com.neura.os.app.data.allPrompts
import com.neura.os.app.data.rankLibrary

/** The Library tab: browse Skills/Personas/Prompts/Gallery by card, or search
 * across all three at once. Replaces two overlapping hubs -- ToolsScreen used
 * to list the same three destinations a second time, and this screen used to
 * be a plain KnowledgesScreen with no search at all. */
@Composable
fun LibraryScreen(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadSkills() }
    var query by rememberSaveable { mutableStateOf("") }
    val needle = query.trim()
    // Localized once, in composable context, so buildList below (which is not
    // a composable lambda) can read plain values instead of calling
    // stringResource from inside a non-composable scope.
    val searchHint = stringResource(R.string.library_search_hint)
    val browseTitle = stringResource(R.string.library_browse)
    val commandsTitle = stringResource(R.string.library_commands)
    val skillsTitle = stringResource(R.string.library_skills)
    val personasTitle = stringResource(R.string.library_personas)
    val promptsTitle = stringResource(R.string.library_prompts)
    val galleryTitle = stringResource(R.string.library_gallery)
    val actionChat = stringResource(R.string.library_action_chat)
    val actionUse = stringResource(R.string.library_action_use)
    val noMatches = stringResource(R.string.library_no_matches)
    val noMatchesHint = stringResource(R.string.library_no_matches_hint)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 40.dp).clip(RoundedCornerShape(20.dp)).background(Palette.surfaceHigh).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Search, null, tint = Palette.muted, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                BasicTextField(
                    query, { query = it }, singleLine = true,
                    textStyle = TextStyle(color = Palette.text, fontSize = 15.sp),
                    cursorBrush = SolidColor(Palette.accent),
                    modifier = Modifier.weight(1f),
                    decorationBox = { inner -> if (query.isEmpty()) Text(searchHint, color = Palette.muted, fontSize = 15.sp); inner() },
                )
            }
        }
        if (needle.isEmpty()) {
            item { SectionTitle(browseTitle) }
            item { ToolCard("🧩", skillsTitle, stringResource(R.string.library_skills_subtitle, vm.skills.size)) { vm.push(Route.Skills) } }
            item { ToolCard("🎭", personasTitle, "${allPersonas(vm.library).size}") { vm.push(Route.Personas) } }
            item { ToolCard("📚", promptsTitle, stringResource(R.string.library_prompts_subtitle, allPrompts(vm.library).size)) { vm.push(Route.Prompts) } }
            item { ToolCard("🖼️", galleryTitle, stringResource(R.string.library_gallery_subtitle, vm.library.images.size)) { vm.push(Route.Images) } }
            item { SectionTitle(commandsTitle) }
            CHAT_COMMANDS.forEach { command ->
                item(key = command.name) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.surface).padding(horizontal = 14.dp, vertical = 10.dp)) {
                        Text(command.usage, color = Palette.accent, fontSize = 14.sp)
                        Text(command.desc, color = Palette.muted, fontSize = 12.sp)
                    }
                }
            }
        } else {
            val rows = buildList {
                allPersonas(vm.library).forEach { p -> add(LibrarySearchRow(LibraryEntry("persona", p.id, p.name, p.systemPrompt), "🎭", actionChat) { vm.newChat(p.id) }) }
                allPrompts(vm.library).forEach { p -> add(LibrarySearchRow(LibraryEntry("prompt", p.id, "/" + p.title, p.text), "📚", actionUse) { vm.newChat(draft = p.text) }) }
                vm.skills.forEach { s -> add(LibrarySearchRow(LibraryEntry("skill", s.name, s.name, s.description), "🧩", actionUse) { vm.newChatWithSkill(s.name) }) }
            }
            val ranked = rankLibrary(rows.map { it.entry }, needle)
            val results = ranked.mapNotNull { entry -> rows.firstOrNull { it.entry == entry } }
            if (results.isEmpty()) {
                item { EmptyState(noMatches, noMatchesHint) }
            } else {
                items(results, key = { it.entry.kind + ":" + it.entry.id }) { row ->
                    LibraryRow(leading = { Text(row.emoji, fontSize = 20.sp) }, actions = { TextButton(row.onAction) { Text(row.actionLabel) } }) {
                        Text(row.entry.title)
                        Text(row.entry.subtitle, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Palette.muted, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

private data class LibrarySearchRow(val entry: LibraryEntry, val emoji: String, val actionLabel: String, val onAction: () -> Unit)
