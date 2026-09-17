package com.freeai4u.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Palette as PaletteIcon
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Construction
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.freeai4u.app.VoiceSession
import com.freeai4u.app.data.Conversation
import com.freeai4u.app.data.PhoneAction
import com.freeai4u.app.data.allPrompts
import com.freeai4u.app.data.groupByDate
import com.freeai4u.app.data.matchPrompts
import com.freeai4u.app.data.modeLabel
import com.freeai4u.app.data.personaFor
import kotlinx.coroutines.launch

/** Everything the screens need from Android itself, implemented by the
 * activity: clipboard, share sheet, files, speech, intents. */
interface Platform {
    val version: String
    fun copy(text: String)
    fun shareText(subject: String, text: String)
    fun saveText(name: String, mime: String, text: String)
    fun exportPdf(title: String, markdown: String)
    fun saveImage(name: String, mime: String, bytes: ByteArray)
    fun shareImage(name: String, mime: String, bytes: ByteArray)
    fun viewImage(id: String, bytes: ByteArray, mime: String)
    fun selectText(text: String)
    fun speak(text: String)
    fun stopSpeaking()
    fun listen(onText: (String) -> Unit)
    fun pickPhotos(onPicked: (List<String>) -> Unit)
    fun pickTextFile(onPicked: (name: String, text: String) -> Unit)
    fun runAction(action: PhoneAction)
    fun startVoice()
    fun checkUpdates()
    fun appLockOn(): Boolean
    fun setAppLock(on: Boolean, onResult: (Boolean) -> Unit)
    fun copyCrashLog(): Boolean
}

@Composable
fun MainScreen(vm: AppViewModel, platform: Platform, voice: VoiceSession) {
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val chat = vm.currentChatId?.let { vm.conversation(it) }
    if (chat == null) {
        // Created outside composition, then shown on the next frame.
        LaunchedEffect(vm.currentChatId, vm.conversations.size) { vm.currentOrNew() }
        Box(Modifier.fillMaxSize().background(Palette.background))
        return
    }
    BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }
    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = Palette.surface, modifier = Modifier.width(304.dp)) {
                Drawer(vm, platform, chat.id) { scope.launch { drawer.close() } }
            }
        },
    ) {
        ChatSurface(vm, platform, chat, onMenu = { scope.launch { drawer.open() } })
    }
    if (voice.state != VoiceSession.State.IDLE || voice.error != null) {
        VoiceOverlay(voice)
    }
}

// --- Drawer ------------------------------------------------------------------------

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun Drawer(vm: AppViewModel, platform: Platform, currentId: String, close: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var menuFor by remember { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Conversation?>(null) }
    val needle = query.trim().lowercase()
    val visible = vm.conversations.filter { it.messages.isNotEmpty() }
        .filter { chat -> needle.isEmpty() || chat.title.lowercase().contains(needle) || chat.messages.any { it.content.lowercase().contains(needle) } }
    Column(Modifier.fillMaxHeight()) {
        Row(Modifier.padding(start = 12.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(20.dp)).background(Palette.surfaceHigh).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Search, null, tint = Palette.muted, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                BasicTextField(
                    query, { query = it }, singleLine = true,
                    textStyle = TextStyle(color = Palette.text, fontSize = 15.sp),
                    cursorBrush = SolidColor(Palette.green),
                    modifier = Modifier.weight(1f),
                    decorationBox = { inner -> if (query.isEmpty()) Text("Search", color = Palette.muted, fontSize = 15.sp); inner() },
                )
            }
            IconButton({ vm.newChat(); close() }, Modifier.pressScale()) { Icon(Icons.Filled.EditNote, "New chat", tint = Palette.text) }
        }
        Spacer(Modifier.height(6.dp))
        DrawerRow(Icons.AutoMirrored.Filled.Chat, "New chat") { vm.newChat(); close() }
        DrawerRow(Icons.Filled.Image, "Images") { vm.push(Screen.Images); close() }
        DrawerRow(Icons.Filled.Construction, "Tools") { vm.push(Screen.Tools); close() }
        HorizontalDivider(color = Palette.outline, modifier = Modifier.padding(vertical = 6.dp))
        LazyColumn(Modifier.weight(1f)) {
            if (visible.isEmpty()) {
                item { Text(if (needle.isEmpty()) "No chats yet" else "No match", color = Palette.muted, modifier = Modifier.padding(16.dp)) }
            }
            groupByDate(visible).forEach { (label, chats) ->
                item(key = "h-$label") {
                    Text(label, color = Palette.muted, fontSize = 12.sp, modifier = Modifier.padding(start = 20.dp, top = 12.dp, bottom = 4.dp))
                }
                items(chats, key = { it.id }) { item ->
                    val selected = item.id == currentId
                    Box {
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(12.dp))
                                .background(if (selected) Palette.surfaceHigh else Palette.surface)
                                .combinedClickable(onClick = { vm.openChat(item.id); close() }, onLongClick = { menuFor = item.id })
                                .padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (vm.streamingId == item.id) {
                                Box(Modifier.size(8.dp).background(Palette.green, CircleShape))
                                Spacer(Modifier.width(8.dp))
                            }
                            if (item.pinned) Icon(Icons.Filled.PushPin, null, tint = Palette.muted, modifier = Modifier.size(14.dp).padding(end = 4.dp))
                            Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Palette.text, fontSize = 15.sp, modifier = Modifier.weight(1f))
                            if (item.mode != "chat") Text(modeLabel(item.mode), color = Palette.green, fontSize = 11.sp)
                        }
                        DropdownMenu(menuFor == item.id, { menuFor = null }) {
                            DropdownMenuItem({ Text(if (item.pinned) "Unpin" else "Pin") }, { vm.togglePin(item.id); menuFor = null })
                            DropdownMenuItem({ Text("Rename") }, { renaming = item; menuFor = null })
                            DropdownMenuItem({ Text("Share") }, {
                                platform.shareText(item.title, com.freeai4u.app.data.conversationMarkdown(item, personaFor(vm.library, item.personaId).name))
                                menuFor = null
                            })
                            DropdownMenuItem({ Text("Delete", color = Palette.red) }, { vm.delete(item.id); menuFor = null })
                        }
                    }
                }
            }
        }
        HorizontalDivider(color = Palette.outline)
        Row(
            Modifier.fillMaxWidth().clickable { vm.push(Screen.Settings); close() }.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(32.dp).background(Palette.greenDark, CircleShape), contentAlignment = Alignment.Center) {
                Text(vm.username.take(1).uppercase().ifEmpty { "?" }, color = Palette.text, fontSize = 14.sp)
            }
            Spacer(Modifier.width(10.dp))
            Text(vm.username.ifEmpty { "Account" }, color = Palette.text, modifier = Modifier.weight(1f))
            Icon(Icons.Filled.Settings, "Settings", tint = Palette.muted)
        }
    }
    renaming?.let { item ->
        var title by remember(item.id) { mutableStateOf(item.title) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Rename") },
            text = { OutlinedTextField(title, { title = it }, singleLine = true) },
            confirmButton = { TextButton({ vm.rename(item.id, title); renaming = null }) { Text("Save") } },
            dismissButton = { TextButton({ renaming = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun DrawerRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = Palette.text, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Text(label, color = Palette.text, fontSize = 15.sp)
    }
}

// --- Chat --------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatSurface(vm: AppViewModel, platform: Platform, chat: Conversation, onMenu: () -> Unit) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm.notice) {
        vm.notice?.let {
            snackbar.showSnackbar(it)
            vm.notice = null
        }
    }
    var modelSheet by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Int?>(null) }
    val streaming = vm.streamingId == chat.id
    // Keep the screen awake while a reply streams (from Mobile-Harness).
    val view = LocalView.current
    DisposableEffect(streaming) {
        view.keepScreenOn = streaming
        onDispose { view.keepScreenOn = false }
    }
    Scaffold(
        containerColor = Palette.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                TopAppBar(
                    navigationIcon = { IconButton(onMenu, Modifier.pressScale().testTag("drawer_button")) { Icon(Icons.Filled.Menu, "Menu") } },
                    title = {
                        Row(
                            Modifier.clip(RoundedCornerShape(12.dp)).clickable { modelSheet = true }.padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                shortModel(chat.model).ifEmpty { "Pick model" },
                                maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 17.sp,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            Icon(Icons.Filled.ExpandMore, "Change model", tint = Palette.muted)
                        }
                    },
                    actions = { IconButton({ vm.newChat() }, Modifier.pressScale()) { Icon(Icons.Filled.EditNote, "New chat") } },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
                )
                AnimatedVisibility(streaming) { LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = Palette.green, trackColor = Palette.background) }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            Box(Modifier.weight(1f)) {
                AnimatedContent(chat.messages.isEmpty(), transitionSpec = { fadeIn(tween(250)) togetherWith fadeOut(tween(150)) }, label = "home") { empty ->
                    if (empty) Home(vm, chat) else Transcript(vm, platform, chat, streaming, onEdit = { editing = it })
                }
            }
            if (chat.tasks.isNotEmpty()) {
                TaskPanel(chat.tasks)
                Spacer(Modifier.height(6.dp))
            }
            Composer(vm, platform, chat, streaming)
        }
    }
    if (modelSheet) ModelSheet(vm, chat) { modelSheet = false }
    editing?.let { index ->
        val original = chat.messages.getOrNull(index)
        if (original == null) {
            editing = null
            return@let
        }
        var text by remember(index) { mutableStateOf(original.content) }
        var branch by remember(index) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit") },
            text = {
                Column {
                    OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(branch, { branch = it })
                        Text("New branch")
                    }
                }
            },
            confirmButton = { TextButton({ vm.editMessage(chat.id, index, text, branch); editing = null }) { Text("Send") } },
            dismissButton = { TextButton({ editing = null }) { Text("Cancel") } },
        )
    }
}

fun shortModel(model: String): String = model.substringAfterLast('/').removePrefix("@cf/").removeSuffix(":free")

private data class Suggestion(val icon: ImageVector, val label: String, val prompt: String, val mode: String = "chat", val image: Boolean = false)

private val SUGGESTIONS = listOf(
    Suggestion(Icons.Filled.PaletteIcon, "Create image", "", image = true),
    Suggestion(Icons.Filled.AutoAwesome, "Brainstorm", "Brainstorm 10 ideas for "),
    Suggestion(Icons.Filled.Checklist, "Make a plan", "Plan how to ", mode = "plan"),
    Suggestion(Icons.Filled.EditNote, "Summarize", "Summarize this:\n\n"),
    Suggestion(Icons.Filled.Language, "Research", "Research the latest on "),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Home(vm: AppViewModel, chat: Conversation) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("What can I help with?", style = MaterialTheme.typography.headlineSmall, color = Palette.text, modifier = Modifier.enterUp())
        if (vm.providers.isEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(vm.catalogueError ?: "Loading models…", color = Palette.muted, fontSize = 13.sp, modifier = Modifier.enterUp(80))
            if (vm.catalogueError != null) TextButton({ vm.refreshCatalogue() }) { Text("Retry") }
        }
        Spacer(Modifier.height(20.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SUGGESTIONS.forEachIndexed { index, suggestion ->
                Row(
                    Modifier.enterUp(60 + index * 50).pressScale().clip(RoundedCornerShape(20.dp)).background(Palette.surface)
                        .clickable {
                            if (suggestion.mode != chat.mode) vm.setMode(chat.id, suggestion.mode)
                            if (suggestion.image) vm.imageArmed = true
                            vm.drafts[chat.id] = suggestion.prompt
                        }
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(suggestion.icon, null, tint = Palette.green, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(suggestion.label, color = Palette.text, fontSize = 14.sp)
                }
            }
        }
    }
}

@Composable
private fun Transcript(vm: AppViewModel, platform: Platform, chat: Conversation, streaming: Boolean, onEdit: (Int) -> Unit) {
    val state = rememberLazyListState()
    val turns = remember(chat.messages) { buildTurns(chat.messages) }
    val atBottom by remember { derivedStateOf { !state.canScrollForward } }
    val last = chat.messages.lastOrNull()
    LaunchedEffect(turns.size, last?.content?.length, last?.toolCalls?.size) {
        if (turns.isNotEmpty() && (atBottom || streaming)) state.animateScrollToItem(turns.lastIndex, Int.MAX_VALUE / 2)
    }
    val startedAt = remember(streaming) { System.currentTimeMillis() }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(state = state, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            items(turns, key = { it.key }, contentType = { it::class }) { turn ->
                when (turn) {
                    is Turn.User -> UserBubble(turn.message, onEdit = { onEdit(turn.index) }, onCopy = { platform.copy(turn.message.content) })
                    is Turn.Assistant -> AssistantTurn(
                        turn,
                        streaming = streaming && turn.lastIndex == chat.messages.lastIndex,
                        startedAt = startedAt,
                        isLast = turn.lastIndex == chat.messages.lastIndex,
                        vm = vm, platform = platform,
                        onRegenerate = { vm.regenerate(chat.id) },
                        onBranch = { vm.forkAt(chat.id, turn.lastIndex) },
                    )
                }
            }
            item { Spacer(Modifier.height(8.dp)) }
        }
        val scope = rememberCoroutineScope()
        AnimatedVisibility(
            !atBottom, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
            enter = fadeIn() + scaleIn(), exit = fadeOut() + scaleOut(),
        ) {
            Surface(
                color = Palette.surfaceHigh, shape = CircleShape,
                modifier = Modifier.size(38.dp).pressScale().clickable { scope.launch { state.animateScrollToItem(turns.lastIndex, Int.MAX_VALUE / 2) } },
            ) {
                Box(contentAlignment = Alignment.Center) { Icon(Icons.Filled.ArrowDownward, "Latest", tint = Palette.text, modifier = Modifier.size(20.dp)) }
            }
        }
    }
}

// --- Composer ------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
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
    var plusSheet by remember { mutableStateOf(false) }
    val haptics = LocalHapticFeedback.current
    val suggestions = matchPrompts(text, allPrompts(vm.library))
    val canSend = text.isNotBlank() || photos.isNotEmpty()

    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp).padding(bottom = 8.dp)) {
        AnimatedVisibility(suggestions.isNotEmpty(), enter = slideInVertically { it / 2 } + fadeIn(), exit = fadeOut()) {
            Surface(color = Palette.surface, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp)) {
                LazyColumn(Modifier.heightIn(max = 220.dp)) {
                    items(suggestions, key = { it.id }) { prompt ->
                        Column(Modifier.fillMaxWidth().clickable { setText(prompt.text) }.padding(horizontal = 14.dp, vertical = 9.dp)) {
                            Text("/" + prompt.title, color = Palette.green, fontSize = 14.sp)
                            Text(prompt.text, maxLines = 1, overflow = TextOverflow.Ellipsis, color = Palette.muted, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
        Surface(color = Palette.surface, shape = RoundedCornerShape(26.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 6.dp, vertical = 6.dp)) {
                if (photos.isNotEmpty() || chat.mode != "chat" || vm.imageArmed) {
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (chat.mode == "plan") ModeChip(modeLabel(chat.mode), Icons.Filled.Checklist) { vm.setMode(chat.id, "chat") }
                        if (vm.imageArmed) ModeChip(if (vm.puterImages) "Image · Puter" else "Image", Icons.Filled.PaletteIcon) { vm.imageArmed = false }
                        photos.forEachIndexed { index, url ->
                            Box {
                                DataUrlThumb(url, 56)
                                Icon(
                                    Icons.Filled.Close, "Remove photo", tint = Palette.text,
                                    modifier = Modifier.align(Alignment.TopEnd).size(18.dp).background(Palette.background, CircleShape).clickable { photos.removeAt(index) },
                                )
                            }
                        }
                    }
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    IconButton({ plusSheet = true }, Modifier.pressScale()) { Icon(Icons.Filled.Add, "Add", tint = Palette.text) }
                    BasicTextField(
                        text, { setText(it) },
                        textStyle = TextStyle(color = Palette.text, fontSize = 16.sp),
                        cursorBrush = SolidColor(Palette.green),
                        maxLines = 6,
                        modifier = Modifier.weight(1f).padding(vertical = 12.dp).testTag("chat_input"),
                        decorationBox = { inner ->
                            if (text.isEmpty()) Text(if (vm.imageArmed) "Describe an image" else "Ask anything", color = Palette.muted, fontSize = 16.sp)
                            inner()
                        },
                    )
                    AnimatedVisibility(!canSend && !streaming) {
                        IconButton({ platform.listen { heard -> setText(((vm.drafts[chat.id] ?: "") + " " + heard).trim()) } }, Modifier.pressScale()) {
                            Icon(Icons.Filled.Mic, "Dictate", tint = Palette.muted)
                        }
                    }
                    Spacer(Modifier.width(4.dp))
                    AnimatedContent(
                        when { streaming -> 2; canSend -> 1; else -> 0 },
                        transitionSpec = { (scaleIn(tween(180)) + fadeIn()) togetherWith (scaleOut(tween(120)) + fadeOut()) },
                        label = "send",
                    ) { state ->
                        val (icon, label) = when (state) {
                            2 -> Icons.Filled.Stop to "Stop"
                            1 -> Icons.Filled.ArrowUpward to "Send"
                            else -> Icons.Filled.GraphicEq to "Voice mode"
                        }
                        Box(
                            Modifier.padding(4.dp).size(40.dp).pressScale(0.85f).clip(CircleShape)
                                .background(if (state == 0) Palette.surfaceHigh else Palette.text)
                                .clickable {
                                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    when (state) {
                                        2 -> vm.stop()
                                        1 -> {
                                            if (vm.imageArmed && text.isNotBlank()) {
                                                vm.drawInChat(chat.id, text)
                                                vm.imageArmed = false
                                            } else {
                                                vm.send(chat.id, text, photos.toList())
                                            }
                                            photos.clear()
                                        }
                                        else -> platform.startVoice()
                                    }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(icon, label, tint = if (state == 0) Palette.text else Palette.background, modifier = Modifier.size(22.dp))
                        }
                    }
                }
            }
        }
    }

    if (plusSheet) {
        ModalBottomSheet(onDismissRequest = { plusSheet = false }, containerColor = Palette.surface) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    SheetTile(Icons.Filled.Photo, "Photos", Modifier.weight(1f)) {
                        plusSheet = false
                        platform.pickPhotos { picked -> photos.addAll(picked.take(4 - photos.size)) }
                    }
                    SheetTile(Icons.Filled.AttachFile, "Files", Modifier.weight(1f)) {
                        plusSheet = false
                        platform.pickTextFile { name, content ->
                            val clipped = if (content.length > 60_000) content.take(60_000) + "\n…(cut)" else content
                            setText(((vm.drafts[chat.id] ?: "") + "\n\nFile `$name`:\n```\n$clipped\n```\n").trimStart())
                        }
                    }
                    SheetTile(Icons.Filled.PaletteIcon, "Image", Modifier.weight(1f)) {
                        plusSheet = false
                        vm.imageArmed = true
                    }
                }
                Spacer(Modifier.height(14.dp))
                Text("Mode", color = Palette.muted, fontSize = 12.sp)
                SheetOption(Icons.AutoMirrored.Filled.Chat, "Chat", "Answer and research", chat.mode == "chat") { vm.setMode(chat.id, "chat"); plusSheet = false }
                SheetOption(Icons.Filled.Checklist, "Plan", "Think first, write a task list", chat.mode == "plan") { vm.setMode(chat.id, "plan"); plusSheet = false }
                HorizontalDivider(color = Palette.outline, modifier = Modifier.padding(vertical = 8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Puter images", color = Palette.text)
                        Text("Your Puter account draws. Turns off by itself.", color = Palette.muted, fontSize = 12.sp)
                    }
                    Switch(vm.puterImages, { vm.puterImages = it })
                }
            }
        }
    }
}

@Composable
private fun ModeChip(label: String, icon: ImageVector, onClear: () -> Unit) {
    Row(
        Modifier.clip(RoundedCornerShape(14.dp)).background(Palette.greenDark.copy(alpha = 0.35f)).clickable(onClick = onClear)
            .padding(start = 10.dp, end = 6.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = Palette.green, modifier = Modifier.size(15.dp))
        Spacer(Modifier.width(5.dp))
        Text(label, color = Palette.text, fontSize = 13.sp)
        Spacer(Modifier.width(3.dp))
        Icon(Icons.Filled.Close, "Clear $label", tint = Palette.muted, modifier = Modifier.size(14.dp))
    }
}

@Composable
private fun SheetTile(icon: ImageVector, label: String, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier.pressScale().clip(RoundedCornerShape(16.dp)).background(Palette.surfaceHigh).clickable(onClick = onClick).padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, tint = Palette.text)
        Spacer(Modifier.height(6.dp))
        Text(label, color = Palette.text, fontSize = 13.sp)
    }
}

@Composable
private fun SheetOption(icon: ImageVector, title: String, subtitle: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(vertical = 10.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (selected) Palette.green else Palette.text)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, color = if (selected) Palette.green else Palette.text)
            Text(subtitle, color = Palette.muted, fontSize = 12.sp)
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Model", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Text("Default", color = Palette.muted, fontSize = 13.sp)
                Switch(makeDefault, { makeDefault = it }, Modifier.padding(start = 6.dp))
            }
            if (vm.providers.isEmpty()) {
                Text(vm.catalogueError ?: "Loading…", color = Palette.muted, modifier = Modifier.padding(vertical = 12.dp))
                TextButton({ vm.refreshCatalogue() }) { Text("Retry") }
            }
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                vm.providers.forEach { option ->
                    val selected = option.id == provider
                    Text(
                        option.label, color = if (selected) Palette.background else Palette.text, fontSize = 14.sp,
                        modifier = Modifier.clip(RoundedCornerShape(16.dp)).background(if (selected) Palette.green else Palette.surfaceHigh)
                            .clickable { provider = option.id }.padding(horizontal = 12.dp, vertical = 7.dp),
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(20.dp)).background(Palette.surfaceHigh).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Search, null, tint = Palette.muted, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                BasicTextField(filter, { filter = it }, singleLine = true, textStyle = TextStyle(color = Palette.text, fontSize = 15.sp), cursorBrush = SolidColor(Palette.green), modifier = Modifier.weight(1f))
            }
            val list = vm.models[provider]
            if (list == null) {
                Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    repeat(4) { Box(Modifier.fillMaxWidth().height(36.dp).clip(RoundedCornerShape(10.dp)).shimmer()) }
                }
            } else {
                LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(list.filter { filter.isBlank() || it.id.contains(filter, true) || it.name.contains(filter, true) }, key = { it.id }) { model ->
                        val selected = model.id == chat.model && provider == chat.provider
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable {
                                vm.setModel(chat.id, provider, model.id, makeDefault)
                                onClose()
                            }.padding(vertical = 11.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(shortModel(model.name), color = if (selected) Palette.green else Palette.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (selected) Icon(Icons.Filled.CheckCircle, "Selected", tint = Palette.green, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

// --- Voice mode ------------------------------------------------------------------------

@Composable
private fun VoiceOverlay(voice: VoiceSession) {
    Box(Modifier.fillMaxSize().background(Palette.background.copy(alpha = 0.97f)).clickable(enabled = false) {}) {
        Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            VoiceOrb(voice.level, voice.state == VoiceSession.State.LISTENING, voice.state == VoiceSession.State.SPEAKING)
            Spacer(Modifier.height(28.dp))
            AnimatedContent(voice.state, label = "voiceState") { state ->
                Text(
                    when (state) {
                        VoiceSession.State.LISTENING -> "Listening"
                        VoiceSession.State.THINKING -> "Thinking"
                        VoiceSession.State.SPEAKING -> "Speaking"
                        VoiceSession.State.IDLE -> voice.error ?: "Paused"
                    },
                    color = Palette.text, fontSize = 18.sp,
                )
            }
            if (voice.state == VoiceSession.State.THINKING) {
                Spacer(Modifier.height(10.dp))
                TypingDots(Palette.green)
            }
            Spacer(Modifier.height(10.dp))
            Text(voice.partial, color = Palette.muted, fontSize = 15.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 48.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
            Box(
                Modifier.size(64.dp).pressScale().clip(CircleShape).background(Palette.surfaceHigh).clickable { if (voice.state == VoiceSession.State.IDLE) voice.start() else voice.stop() },
                contentAlignment = Alignment.Center,
            ) { Icon(if (voice.state == VoiceSession.State.IDLE) Icons.Filled.Mic else Icons.Filled.MicOff, "Pause or resume", tint = Palette.text) }
            Box(
                Modifier.size(64.dp).pressScale().clip(CircleShape).background(Palette.red).clickable { voice.release() },
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Close, "End voice", tint = Palette.text) }
        }
    }
}
