package com.freeai4u.app.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.freeai4u.app.data.Conversation
import com.freeai4u.app.data.conversationMarkdown
import com.freeai4u.app.data.filterConversations
import com.freeai4u.app.data.personaFor

/** Everything the screens need from Android itself, implemented by the
 * activity: clipboard, share sheet, files, speech, the web tools screen. */
interface Platform {
    val version: String
    fun copy(text: String)
    fun shareText(subject: String, text: String)
    fun saveText(name: String, mime: String, text: String)
    fun exportPdf(title: String, markdown: String)
    fun saveImage(name: String, mime: String, bytes: ByteArray)
    fun shareImage(name: String, mime: String, bytes: ByteArray)
    fun speak(text: String)
    fun stopSpeaking()
    fun listen(onText: (String) -> Unit)
    fun pickPhotos(onPicked: (List<String>) -> Unit)
    fun pickTextFile(onPicked: (name: String, text: String) -> Unit)
    fun openWebTools()
    fun checkUpdates()
    fun appLockOn(): Boolean
    fun setAppLock(on: Boolean, onResult: (Boolean) -> Unit)
    fun copyCrashLog(): Boolean
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: AppViewModel, platform: Platform) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm.notice) {
        vm.notice?.let {
            snackbar.showSnackbar(it)
            vm.notice = null
        }
    }
    Scaffold(
        containerColor = Palette.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        when (vm.tab) {
                            Tab.CHATS -> "Chats"
                            Tab.IMAGES -> "Image studio"
                            Tab.TOOLS -> "Tools"
                            Tab.SETTINGS -> "Settings"
                        }
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
            )
        },
        floatingActionButton = {
            if (vm.tab == Tab.CHATS) {
                ExtendedFloatingActionButton(
                    onClick = { vm.newChat() },
                    icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    text = { Text("New chat") },
                    containerColor = Palette.greenDark,
                    contentColor = Palette.text,
                )
            }
        },
        bottomBar = {
            NavigationBar(containerColor = Palette.surface) {
                val colors = NavigationBarItemDefaults.colors(indicatorColor = Palette.greenDark, selectedIconColor = Palette.text)
                NavigationBarItem(vm.tab == Tab.CHATS, { vm.tab = Tab.CHATS }, { Icon(Icons.Filled.Chat, null) }, label = { Text("Chats") }, colors = colors)
                NavigationBarItem(vm.tab == Tab.IMAGES, { vm.tab = Tab.IMAGES }, { Icon(Icons.Filled.Image, null) }, label = { Text("Images") }, colors = colors)
                NavigationBarItem(vm.tab == Tab.TOOLS, { vm.tab = Tab.TOOLS }, { Icon(Icons.Filled.Build, null) }, label = { Text("Tools") }, colors = colors)
                NavigationBarItem(vm.tab == Tab.SETTINGS, { vm.tab = Tab.SETTINGS }, { Icon(Icons.Filled.Settings, null) }, label = { Text("Settings") }, colors = colors)
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (vm.tab) {
                Tab.CHATS -> ChatListScreen(vm, platform)
                Tab.IMAGES -> ImageStudioScreen(vm, platform)
                Tab.TOOLS -> ToolsScreen(vm, platform)
                Tab.SETTINGS -> SettingsScreen(vm, platform)
            }
        }
    }
}

@Composable
fun ChatListScreen(vm: AppViewModel, platform: Platform) {
    var query by rememberSaveable { mutableStateOf("") }
    var renaming by remember { mutableStateOf<Conversation?>(null) }
    var deleting by remember { mutableStateOf<Conversation?>(null) }
    val list = filterConversations(vm.conversations.filter { it.messages.isNotEmpty() }, query)
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, { query = it },
            placeholder = { Text("Search chats") },
            leadingIcon = { Icon(Icons.Filled.Search, null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        )
        if (!vm.loaded) return@Column
        if (list.isEmpty()) {
            EmptyState(
                if (query.isEmpty()) "No chats yet" else "Nothing matches",
                if (query.isEmpty()) "Tap New chat to start. Your chats are encrypted and stay on this phone." else "Try another word.",
            )
            return@Column
        }
        LazyColumn(contentPadding = PaddingValues(bottom = 96.dp)) {
            items(list, key = { it.id }) { chat ->
                ChatRow(
                    chat, vm,
                    onOpen = { vm.push(Screen.Chat(chat.id)) },
                    onRename = { renaming = chat },
                    onDelete = { deleting = chat },
                    onExport = {
                        platform.shareText(chat.title, conversationMarkdown(chat, personaFor(vm.library, chat.personaId).name))
                    },
                )
                HorizontalDivider(color = Palette.outline)
            }
        }
    }
    renaming?.let { chat ->
        var title by remember(chat.id) { mutableStateOf(chat.title) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename chat") },
            text = { OutlinedTextField(title, { title = it }, singleLine = true) },
            confirmButton = { TextButton({ vm.rename(chat.id, title); renaming = null }) { Text("Save") } },
            dismissButton = { TextButton({ renaming = null }) { Text("Cancel") } },
        )
    }
    deleting?.let { chat ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete chat?") },
            text = { Text("\"${chat.title}\" will be removed from this phone.") },
            confirmButton = { TextButton({ vm.delete(chat.id); deleting = null }) { Text("Delete", color = Palette.red) } },
            dismissButton = { TextButton({ deleting = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(chat: Conversation, vm: AppViewModel, onOpen: () -> Unit, onRename: () -> Unit, onDelete: () -> Unit, onExport: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val persona = personaFor(vm.library, chat.personaId)
    val preview = chat.messages.lastOrNull()?.content?.replace("\n", " ") ?: ""
    Box {
        Row(
            Modifier.fillMaxWidth().combinedClickable(onClick = onOpen, onLongClick = { menu = true }).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(persona.emoji, style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (chat.pinned) Icon(Icons.Filled.PushPin, null, tint = Palette.green, modifier = Modifier.padding(end = 4.dp))
                    Text(chat.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    Text(relativeTime(chat.updatedAt), color = Palette.muted, style = MaterialTheme.typography.labelSmall)
                }
                Text(preview, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Palette.muted, style = MaterialTheme.typography.bodySmall)
                Text(chat.model.substringAfterLast('/'), maxLines = 1, color = Palette.green, style = MaterialTheme.typography.labelSmall)
            }
        }
        DropdownMenu(menu, { menu = false }) {
            DropdownMenuItem({ Text(if (chat.pinned) "Unpin" else "Pin") }, { vm.togglePin(chat.id); menu = false })
            DropdownMenuItem({ Text("Rename") }, { onRename(); menu = false })
            DropdownMenuItem({ Text("Share as Markdown") }, { onExport(); menu = false })
            DropdownMenuItem({ Text("Delete", color = Palette.red) }, { onDelete(); menu = false })
        }
    }
}
