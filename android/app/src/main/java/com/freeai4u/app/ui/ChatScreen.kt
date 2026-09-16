package com.freeai4u.app.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.freeai4u.app.data.ChatMessage
import com.freeai4u.app.data.Conversation
import com.freeai4u.app.data.allPersonas
import com.freeai4u.app.data.allPrompts
import com.freeai4u.app.data.conversationMarkdown
import com.freeai4u.app.data.matchPrompts
import com.freeai4u.app.data.personaFor
import com.freeai4u.app.data.safeFileName

private const val MAX_ATTACHED_TEXT = 60000

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: AppViewModel, platform: Platform, id: String) {
    val chat = vm.conversation(id)
    if (chat == null) {
        LaunchedEffect(id) { vm.back() }
        return
    }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm.notice) {
        vm.notice?.let {
            snackbar.showSnackbar(it)
            vm.notice = null
        }
    }
    var menu by remember { mutableStateOf(false) }
    var modelSheet by remember { mutableStateOf(false) }
    var personaSheet by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Int?>(null) }
    val streaming = vm.streamingId == chat.id
    val persona = personaFor(vm.library, chat.personaId)

    Scaffold(
        containerColor = Palette.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                TopAppBar(
                    navigationIcon = { IconButton({ vm.back() }) { Icon(Icons.Filled.ArrowBack, "Back") } },
                    title = {
                        Column(Modifier.clickable { modelSheet = true }) {
                            Text(chat.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                            Text(
                                (chat.model.ifEmpty { "Pick a model" }) + "  ▾",
                                maxLines = 1, overflow = TextOverflow.Ellipsis, color = Palette.green, fontSize = 12.sp,
                            )
                        }
                    },
                    actions = {
                        TextButton({ personaSheet = true }) { Text(persona.emoji + " " + persona.name, maxLines = 1) }
                        IconButton({ menu = true }) { Icon(Icons.Filled.MoreVert, "More") }
                        DropdownMenu(menu, { menu = false }) {
                            val markdown = { conversationMarkdown(chat, persona.name) }
                            DropdownMenuItem({ Text("Share as text") }, { platform.shareText(chat.title, markdown()); menu = false })
                            DropdownMenuItem({ Text("Save Markdown file") }, { platform.saveText(safeFileName(chat.title, "md"), "text/markdown", markdown()); menu = false })
                            DropdownMenuItem({ Text("Export PDF") }, { platform.exportPdf(chat.title, markdown()); menu = false })
                            DropdownMenuItem({ Text(if (chat.pinned) "Unpin" else "Pin") }, { vm.togglePin(chat.id); menu = false })
                            DropdownMenuItem({ Text("Delete chat", color = Palette.red) }, { menu = false; vm.delete(chat.id) })
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
                )
                if (streaming) LinearProgressIndicator(Modifier.fillMaxWidth(), color = Palette.green)
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            MessageList(vm, platform, chat, streaming, Modifier.weight(1f), onEdit = { editing = it })
            Composer(vm, platform, chat, streaming)
        }
    }

    if (modelSheet) ModelSheet(vm, chat) { modelSheet = false }
    if (personaSheet) {
        ModalBottomSheet(onDismissRequest = { personaSheet = false }, containerColor = Palette.surface) {
            Text("Persona", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
            LazyColumn(Modifier.heightIn(max = 480.dp)) {
                itemsIndexed(allPersonas(vm.library)) { _, option ->
                    Row(
                        Modifier.fillMaxWidth().clickable { vm.setPersona(chat.id, option.id); personaSheet = false }.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(option.emoji, fontSize = 22.sp)
                        Column(Modifier.padding(start = 12.dp).weight(1f)) {
                            Text(option.name, color = if (option.id == chat.personaId) Palette.green else Palette.text)
                            Text(option.systemPrompt, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Palette.muted, fontSize = 12.sp)
                        }
                    }
                }
            }
            TextButton({ personaSheet = false; vm.push(Screen.Personas) }, Modifier.padding(16.dp)) { Text("Manage personas") }
        }
    }
    editing?.let { index ->
        val original = chat.messages.getOrNull(index)
        if (original == null) {
            editing = null
            return@let
        }
        var text by remember(index) { mutableStateOf(original.content) }
        var branch by remember(index) { mutableStateOf(true) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit message") },
            text = {
                Column {
                    OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(branch, { branch = it })
                        Text("Keep the original chat (branch into a new one)")
                    }
                }
            },
            confirmButton = { TextButton({ vm.editMessage(chat.id, index, text, branch); editing = null }) { Text("Send") } },
            dismissButton = { TextButton({ editing = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageList(vm: AppViewModel, platform: Platform, chat: Conversation, streaming: Boolean, modifier: Modifier, onEdit: (Int) -> Unit) {
    val state = rememberLazyListState()
    val last = chat.messages.lastOrNull()
    LaunchedEffect(chat.messages.size, last?.content?.length) {
        if (chat.messages.isNotEmpty()) state.animateScrollToItem(chat.messages.lastIndex)
    }
    if (chat.messages.isEmpty()) {
        val persona = personaFor(vm.library, chat.personaId)
        Box(modifier.fillMaxWidth()) {
            EmptyState("${persona.emoji} ${persona.name}", "Ask anything. Type / for saved prompts, tap the mic to talk, or attach a photo or file.")
        }
        return
    }
    LazyColumn(modifier.fillMaxWidth(), state = state, contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        itemsIndexed(chat.messages, key = { index, message -> "$index-${message.createdAt}" }) { index, message ->
            MessageBubble(
                message, platform,
                isLast = index == chat.messages.lastIndex,
                streaming = streaming && index == chat.messages.lastIndex,
                onEdit = { onEdit(index) },
                onRegenerate = { vm.regenerate(chat.id) },
                onFork = { vm.forkAt(chat.id, index) },
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    message: ChatMessage,
    platform: Platform,
    isLast: Boolean,
    streaming: Boolean,
    onEdit: () -> Unit,
    onRegenerate: () -> Unit,
    onFork: () -> Unit,
) {
    val user = message.role == "user"
    var menu by remember { mutableStateOf(false) }
    var showReasoning by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        Box {
            Surface(
                color = when {
                    message.error -> Color_errorBubble
                    user -> Palette.userBubble
                    else -> Palette.surface
                },
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.widthIn(max = 340.dp).combinedClickable(onClick = {}, onLongClick = { menu = true }),
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (message.images.isNotEmpty()) {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            message.images.forEach { url -> DataUrlThumb(url, 120) }
                        }
                    }
                    if (message.reasoning.isNotBlank()) {
                        Text(
                            if (showReasoning) "▾ Thinking" else "▸ Thinking",
                            color = Palette.muted, fontSize = 12.sp,
                            modifier = Modifier.clickable { showReasoning = !showReasoning },
                        )
                        if (showReasoning) Text(message.reasoning, color = Palette.muted, fontSize = 13.sp)
                    }
                    when {
                        message.content.isEmpty() && streaming -> Text("…", color = Palette.muted)
                        message.error -> Text(message.content, color = Palette.red)
                        user -> Text(message.content, color = Palette.text)
                        else -> MarkdownText(message.content) { platform.copy(it) }
                    }
                    if (!user && message.model.isNotEmpty() && !streaming) {
                        Text(message.model.substringAfterLast('/'), color = Palette.muted, fontSize = 11.sp)
                    }
                }
            }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem({ Text("Copy") }, { platform.copy(message.content); menu = false })
                DropdownMenuItem({ Text("Share") }, { platform.shareText("FreeAI4U", message.content); menu = false })
                if (!user && !message.error) DropdownMenuItem({ Text("Read aloud") }, { platform.speak(message.content); menu = false })
                if (user) DropdownMenuItem({ Text("Edit & resend") }, { onEdit(); menu = false })
                if (!user && isLast && !streaming) DropdownMenuItem({ Text("Regenerate") }, { onRegenerate(); menu = false })
                DropdownMenuItem({ Text("Branch from here") }, { onFork(); menu = false })
            }
        }
    }
}

private val Color_errorBubble = androidx.compose.ui.graphics.Color(0xFF2D1517)

@Composable
fun DataUrlThumb(url: String, sizeDp: Int) {
    val bitmap = remember(url) {
        try {
            val bytes = java.util.Base64.getDecoder().decode(url.substringAfter(","))
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        } catch (e: Exception) {
            null
        }
    }
    if (bitmap != null) {
        Image(bitmap, null, contentScale = ContentScale.Crop, modifier = Modifier.size(sizeDp.dp).background(Palette.surfaceHigh, RoundedCornerShape(8.dp)))
    }
}

@Composable
private fun Composer(vm: AppViewModel, platform: Platform, chat: Conversation, streaming: Boolean) {
    val text = vm.drafts[chat.id] ?: ""
    val setText = { value: String -> vm.drafts[chat.id] = value }
    val photos = remember(chat.id) { mutableStateListOf<String>() }
    val shared = vm.pendingPhotos[chat.id]
    LaunchedEffect(shared) {
        if (shared != null) {
            photos.addAll(shared.take(4 - photos.size))
            vm.pendingPhotos.remove(chat.id)
        }
    }
    var attachMenu by remember { mutableStateOf(false) }
    val suggestions = matchPrompts(text, allPrompts(vm.library))
    Surface(color = Palette.surface) {
        Column(Modifier.fillMaxWidth().padding(8.dp)) {
            if (suggestions.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().heightIn(max = 220.dp)) {
                    LazyColumn {
                        itemsIndexed(suggestions) { _, prompt ->
                            Column(Modifier.fillMaxWidth().clickable { setText(prompt.text) }.padding(10.dp)) {
                                Text("/" + prompt.title, color = Palette.green)
                                Text(prompt.text, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Palette.muted, fontSize = 12.sp)
                            }
                        }
                    }
                }
                HorizontalDivider(color = Palette.outline)
            }
            if (photos.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    photos.forEachIndexed { index, url ->
                        Box {
                            DataUrlThumb(url, 64)
                            Icon(
                                Icons.Filled.Close, "Remove",
                                tint = Palette.text,
                                modifier = Modifier.align(Alignment.TopEnd).size(20.dp).background(Palette.background, RoundedCornerShape(10.dp))
                                    .clickable { photos.removeAt(index) },
                            )
                        }
                    }
                }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Box {
                    IconButton({ attachMenu = true }) { Icon(Icons.Filled.AttachFile, "Attach", tint = Palette.muted) }
                    DropdownMenu(attachMenu, { attachMenu = false }) {
                        DropdownMenuItem({ Text("Photo (vision models)") }, {
                            attachMenu = false
                            platform.pickPhotos { picked -> photos.addAll(picked.take(4 - photos.size)) }
                        }, leadingIcon = { Icon(Icons.Filled.PhotoCamera, null) })
                        DropdownMenuItem({ Text("Text or code file") }, {
                            attachMenu = false
                            platform.pickTextFile { name, content ->
                                val clipped = if (content.length > MAX_ATTACHED_TEXT) content.take(MAX_ATTACHED_TEXT) + "\n…(cut)" else content
                                setText(((vm.drafts[chat.id] ?: "") + "\n\nFile `$name`:\n```\n$clipped\n```\n").trimStart())
                            }
                        }, leadingIcon = { Icon(Icons.Filled.AttachFile, null) })
                    }
                }
                OutlinedTextField(
                    text, { setText(it) },
                    placeholder = { Text("Message  ·  / for prompts") },
                    modifier = Modifier.weight(1f).heightIn(max = 160.dp),
                    maxLines = 6,
                )
                IconButton({ platform.listen { heard -> setText(((vm.drafts[chat.id] ?: "") + " " + heard).trim()) } }) {
                    Icon(Icons.Filled.Mic, "Speak", tint = Palette.muted)
                }
                if (streaming) {
                    IconButton({ vm.stop() }) { Icon(Icons.Filled.Stop, "Stop", tint = Palette.red) }
                } else {
                    IconButton(
                        {
                            vm.send(chat.id, text, photos.toList())
                            photos.clear()
                        },
                        enabled = text.isNotBlank() || photos.isNotEmpty(),
                    ) { Icon(Icons.Filled.Send, "Send", tint = Palette.green) }
                }
            }
            Spacer(Modifier.height(2.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelSheet(vm: AppViewModel, chat: Conversation, onClose: () -> Unit) {
    var provider by remember { mutableStateOf(chat.provider.ifEmpty { vm.providers.firstOrNull()?.id ?: "" }) }
    var makeDefault by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf("") }
    LaunchedEffect(provider) { if (provider.isNotEmpty()) vm.loadModels(provider) }
    ModalBottomSheet(onDismissRequest = onClose, containerColor = Palette.surface) {
        Column(Modifier.padding(horizontal = 16.dp)) {
            Text("Model", style = MaterialTheme.typography.titleMedium)
            if (vm.providers.isEmpty()) {
                Text(vm.catalogueError ?: "Loading providers…", color = Palette.muted, modifier = Modifier.padding(vertical = 12.dp))
                TextButton({ vm.refreshCatalogue() }) { Text("Retry") }
            }
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                vm.providers.forEach { option ->
                    AssistChip(
                        onClick = { provider = option.id },
                        label = { Text(option.label, color = if (option.id == provider) Palette.green else Palette.text) },
                    )
                }
            }
            OutlinedTextField(filter, { filter = it }, placeholder = { Text("Filter models") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(makeDefault, { makeDefault = it })
                Text("Use for new chats")
            }
            val list = vm.models[provider]
            if (list == null) {
                Text("Loading models…", color = Palette.muted, modifier = Modifier.padding(12.dp))
            } else {
                LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    itemsIndexed(list.filter { filter.isBlank() || it.id.contains(filter, true) || it.name.contains(filter, true) }) { _, model ->
                        Column(
                            Modifier.fillMaxWidth().clickable {
                                vm.setModel(chat.id, provider, model.id, makeDefault)
                                onClose()
                            }.padding(vertical = 10.dp),
                        ) {
                            Text(model.name, color = if (model.id == chat.model && provider == chat.provider) Palette.green else Palette.text)
                            if (model.name != model.id) Text(model.id, color = Palette.muted, fontSize = 12.sp)
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
