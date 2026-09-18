package com.freeai4u.app.ui

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Autorenew
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.freeai4u.app.data.ChatMessage
import com.freeai4u.app.data.Conversation
import com.freeai4u.app.data.TaskItem
import com.freeai4u.app.data.actionTicketFromJson
import com.freeai4u.app.data.looksLikePlan
import com.freeai4u.app.data.openAction
import com.freeai4u.app.data.safeFileName
import com.freeai4u.app.data.splitCodeBlocks
import com.freeai4u.app.data.toolCallSummary
import kotlinx.coroutines.delay

/** One visual block in the chat: a user message, an assistant turn (its text,
 * the tools it ran, pictures and action buttons), built from the stored
 * messages so tool results sit under the call that made them. */
sealed interface Turn {
    val key: String
    data class User(override val key: String, val index: Int, val message: ChatMessage) : Turn
    data class Assistant(
        override val key: String,
        val steps: List<Step>,
        val text: String,
        val reasoning: String,
        val error: Boolean,
        val model: String,
        val imageIds: List<String>,
        val actions: List<String>,
        val lastIndex: Int,
    ) : Turn
}

data class Step(val summary: String, val done: Boolean, val failed: Boolean, val output: String)

fun buildTurns(messages: List<ChatMessage>): List<Turn> {
    // One pass to index tool results, so each call's result is a map lookup
    // instead of a copy-and-scan of the rest of the chat.
    val results = HashMap<String, ChatMessage>()
    messages.forEach { if (it.role == "tool" && it.toolCallId.isNotEmpty()) results.putIfAbsent(it.toolCallId, it) }
    val turns = mutableListOf<Turn>()
    var index = 0
    while (index < messages.size) {
        val message = messages[index]
        if (message.role == "user") {
            turns.add(Turn.User("u$index-${message.createdAt}", index, message))
            index++
            continue
        }
        val steps = mutableListOf<Step>()
        val text = StringBuilder()
        val reasoning = StringBuilder()
        val images = mutableListOf<String>()
        val actions = mutableListOf<String>()
        var error = false
        var model = ""
        val start = index
        while (index < messages.size && messages[index].role != "user") {
            val part = messages[index]
            when (part.role) {
                "assistant" -> {
                    if (part.content.isNotBlank()) {
                        if (text.isNotEmpty()) text.append("\n\n")
                        text.append(part.content)
                    }
                    if (part.reasoning.isNotBlank()) reasoning.append(part.reasoning)
                    if (part.error) error = true
                    if (part.model.isNotEmpty()) model = part.model
                    part.toolCalls.forEach { call ->
                        val result = results[call.id]
                        steps.add(Step(toolCallSummary(call), result != null, result?.content?.startsWith("Error") == true, result?.content ?: ""))
                    }
                }
                "tool" -> {
                    images.addAll(part.imageIds)
                    if (part.action.isNotEmpty()) actions.add(part.action)
                }
            }
            index++
        }
        turns.add(Turn.Assistant("a$start-${messages[start].createdAt}", steps, text.toString(), reasoning.toString(), error, model, images, actions, index - 1))
    }
    return turns
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun UserBubble(message: ChatMessage, onEdit: () -> Unit, onCopy: () -> Unit, onSelect: () -> Unit = {}) {
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberHaptics()
    Row(Modifier.fillMaxWidth().enterUp(), horizontalArrangement = Arrangement.End) {
        Box {
            Surface(
                color = Palette.surfaceHigh,
                shape = RoundedCornerShape(22.dp),
                modifier = Modifier.widthIn(max = 300.dp).combinedClickable(onClick = {}, onLongClick = { haptics(HapticFeedbackType.LongPress); menu = true }),
            ) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (message.images.isNotEmpty()) {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            message.images.forEach { DataUrlThumb(it, 110) }
                        }
                    }
                    if (message.content.isNotBlank()) Text(message.content, color = Palette.text, style = MaterialTheme.typography.bodyLarge)
                }
            }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem({ Text("Copy") }, { onCopy(); menu = false }, leadingIcon = { Icon(Icons.Filled.ContentCopy, null) })
                if (message.content.isNotBlank()) {
                    DropdownMenuItem({ Text("Select text") }, { onSelect(); menu = false }, leadingIcon = { Icon(Icons.Filled.TextFields, null) })
                }
                DropdownMenuItem({ Text("Edit") }, { onEdit(); menu = false }, leadingIcon = { Icon(Icons.Filled.Edit, null) })
            }
        }
    }
}

@Composable
fun AssistantTurn(
    turn: Turn.Assistant,
    streaming: Boolean,
    startedAt: Long,
    isLast: Boolean,
    vm: AppViewModel,
    platform: Platform,
    onRegenerate: () -> Unit,
    onBranch: () -> Unit,
    onBuild: (() -> Unit)? = null,
) {
    Column(Modifier.fillMaxWidth().enterUp(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (turn.steps.isNotEmpty()) WorkLog(turn.steps, streaming, startedAt)
        if (turn.reasoning.isNotBlank()) Thought(turn.reasoning, streaming && turn.text.isEmpty())
        when {
            turn.text.isEmpty() && streaming -> Box(Modifier.padding(vertical = 8.dp)) { TypingDots(Palette.green) }
            turn.error -> ErrorCard(turn.text, onRetry = if (isLast) onRegenerate else null)
            turn.text.isNotEmpty() -> MarkdownText(turn.text) { platform.copy(it) }
        }
        if (turn.imageIds.isNotEmpty()) {
            turn.imageIds.forEach { id -> ChatImage(vm, platform, id) }
        }
        turn.actions.forEach { json ->
            val ticket = actionTicketFromJson(json)
            val action = ticket?.let { openAction(it, System.currentTimeMillis()) }
            when {
                action != null -> ActionButton(action.label()) { platform.runAction(action) }
                ticket != null -> ExpiredAction()
            }
        }
        AnimatedVisibility(!streaming && !turn.error && turn.text.isNotEmpty(), enter = fadeIn(), exit = fadeOut()) {
            ActionRow(turn, isLast, platform, onRegenerate, onBranch)
        }
        // A reply that reads like a plan can be handed to the server to build.
        val planLike = remember(turn.text) { looksLikePlan(turn.text) }
        val canBuild = onBuild != null && !streaming && !turn.error && planLike
        AnimatedVisibility(canBuild, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            BuildRemotelyChip { onBuild?.invoke() }
        }
    }
}

@Composable
private fun ActionRow(turn: Turn.Assistant, isLast: Boolean, platform: Platform, onRegenerate: () -> Unit, onBranch: () -> Unit) {
    var copied by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    val haptics = rememberHaptics()
    LaunchedEffect(copied) {
        if (copied) {
            delay(1800)
            copied = false
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        SmallAction(if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy, if (copied) "Copied" else "Copy") {
            platform.copy(turn.text)
            copied = true
            haptics(HapticFeedbackType.LongPress)
        }
        SmallAction(Icons.AutoMirrored.Filled.VolumeUp, "Read aloud") { platform.speak(turn.text) }
        if (isLast) SmallAction(Icons.Filled.Refresh, "Regenerate", onRegenerate)
        SmallAction(Icons.Filled.Share, "Share") { platform.shareText("FreeAI4U", turn.text) }
        Box {
            SmallAction(Icons.Filled.MoreHoriz, "More") { more = true }
            DropdownMenu(more, { more = false }) {
                DropdownMenuItem({ Text("Save as Markdown") }, { platform.saveText(safeFileName(turn.text, "md"), "text/markdown", turn.text); more = false })
                DropdownMenuItem({ Text("Export PDF") }, { platform.exportPdf(turn.text.take(60), turn.text); more = false })
                DropdownMenuItem({ Text("Branch") }, { onBranch(); more = false })
                DropdownMenuItem({ Text("Select text") }, { platform.selectText(turn.text); more = false })
            }
        }
        if (turn.model.isNotEmpty()) {
            Spacer(Modifier.width(6.dp))
            Text(turn.model.substringAfterLast('/'), color = Palette.muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
fun SmallAction(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.size(40.dp).pressScale()) {
        Icon(icon, contentDescription = label, tint = Palette.muted, modifier = Modifier.size(18.dp))
    }
}

/** The tools a turn ran, collapsed to one headline ("Worked · 3 steps · 12s")
 * with a live timer while running; tap to see each step. */
@Composable
private fun WorkLog(steps: List<Step>, streaming: Boolean, startedAt: Long) {
    var open by remember { mutableStateOf(false) }
    var elapsed by remember { mutableStateOf(0L) }
    LaunchedEffect(streaming, startedAt) {
        while (streaming) {
            elapsed = (System.currentTimeMillis() - startedAt) / 1000
            delay(1000)
        }
    }
    val rotation by animateFloatAsState(if (open) 180f else 0f, label = "chevron")
    val running = streaming && steps.any { !it.done }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Palette.surface)
            .clickable { open = !open }.padding(horizontal = 12.dp, vertical = 8.dp).animateContentSize(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (running) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = Palette.green)
            else Icon(Icons.Filled.CheckCircle, null, tint = Palette.green, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            val head = if (running) steps.lastOrNull { !it.done }?.summary ?: "Working" else "Worked"
            Text(
                head + " · " + steps.size + (if (steps.size == 1) " step" else " steps") + if (streaming && elapsed > 0) " · ${elapsed}s" else "",
                color = Palette.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Icon(Icons.Filled.ExpandMore, if (open) "Hide steps" else "Show steps", tint = Palette.muted, modifier = Modifier.rotate(rotation))
        }
        if (open) {
            steps.forEachIndexed { index, step ->
                var showOutput by remember(index) { mutableStateOf(false) }
                Row(
                    Modifier.padding(top = 6.dp).clickable(enabled = step.output.isNotBlank()) { showOutput = !showOutput },
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(
                        when {
                            step.failed -> Icons.Filled.ErrorOutline
                            step.done -> Icons.Filled.Check
                            else -> Icons.Filled.Autorenew
                        },
                        null, tint = if (step.failed) Palette.red else Palette.muted, modifier = Modifier.size(14.dp).padding(top = 2.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(step.summary, color = Palette.text, fontSize = 13.sp)
                        if (step.output.isNotBlank()) {
                            Text(
                                if (showOutput) step.output.take(4000) else step.output.take(140),
                                color = Palette.muted, fontSize = 11.sp,
                                maxLines = if (showOutput) 40 else 2, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Thought(reasoning: String, live: Boolean) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.animateContentSize()) {
        Row(Modifier.clip(RoundedCornerShape(8.dp)).clickable { open = !open }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (live) "Thinking" else "Thought", color = Palette.muted, fontSize = 13.sp)
            if (live) {
                Spacer(Modifier.width(6.dp))
                TypingDots(Palette.muted, 4.dp)
            }
            Icon(Icons.Filled.ExpandMore, null, tint = Palette.muted, modifier = Modifier.size(18.dp).rotate(if (open) 180f else 0f))
        }
        AnimatedVisibility(open, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Text(
                reasoning, color = Palette.muted, fontSize = 13.sp,
                modifier = Modifier.padding(start = 10.dp),
            )
        }
    }
}

@Composable
private fun ErrorCard(text: String, onRetry: (() -> Unit)?) {
    Surface(color = Color_error, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.ErrorOutline, null, tint = Palette.red)
            Spacer(Modifier.width(10.dp))
            Text(friendlyError(text), color = Palette.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
            if (onRetry != null) {
                IconButton(onRetry, Modifier.pressScale()) { Icon(Icons.Filled.Refresh, "Retry", tint = Palette.text) }
            }
        }
    }
}

private val Color_error = androidx.compose.ui.graphics.Color(0xFF2A1215)

/** Provider keys and bearer values hidden, so an error that echoes a key never
 * reaches the screen, the saved chat, a share or an export. Raw strings: in a
 * plain Kotlin literal "\b" is a backspace, not a word boundary. */
fun maskSecrets(raw: String): String = raw
    .replace(Regex("""(?i)\b(sk|cfat|cfut|nvapi|gsk|xai|hf|pplx)[-_][A-Za-z0-9_-]{8,}"""), "•••")
    .replace(Regex("""(?i)(bearer|authorization:|api[_-]?key[=:])\s*\S+"""), "$1 •••")

/** Short, plain error text: the status code's meaning first, secrets masked. */
fun friendlyError(raw: String): String {
    val masked = maskSecrets(raw)
    val code = Regex("^(\\d{3})").find(masked.trim())?.value?.toIntOrNull()
    val lead = when (code) {
        401, 403 -> "Not allowed. "
        404 -> "Model not found. "
        429 -> "Rate limited. Wait a bit or switch model. "
        in 500..599 -> "Provider error. Try again or switch model. "
        else -> ""
    }
    return (lead + masked).take(400)
}

/** A proposed action whose ticket has gone stale: shown, but inert. */
@Composable
private fun ExpiredAction() {
    Surface(color = Palette.surface, shape = RoundedCornerShape(20.dp)) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.ErrorOutline, null, tint = Palette.muted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Action expired", color = Palette.muted, fontSize = 14.sp)
        }
    }
}

@Composable
fun ActionButton(label: String, onClick: () -> Unit) {
    Surface(
        color = Palette.greenDark.copy(alpha = 0.25f),
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.pressScale().clip(RoundedCornerShape(20.dp)).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.TouchApp, null, tint = Palette.green, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(label, color = Palette.text, fontSize = 14.sp)
        }
    }
}

@Composable
fun ChatImage(vm: AppViewModel, platform: Platform, id: String) {
    var bitmap by remember(id) { mutableStateOf<ImageBitmap?>(null) }
    var bytes by remember(id) { mutableStateOf<ByteArray?>(null) }
    LaunchedEffect(id) {
        vm.loadBitmap(id) { data, image ->
            bytes = data
            bitmap = image
        }
    }
    val record = vm.library.images.firstOrNull { it.id == id }
    Box(Modifier.fillMaxWidth(0.85f).aspectRatio(1f).clip(RoundedCornerShape(18.dp))) {
        val shown = bitmap
        if (shown == null) {
            Box(Modifier.fillMaxSize().shimmer())
        } else {
            Image(
                shown, record?.prompt ?: "Generated image", contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize().enterUp().clickable { bytes?.let { platform.viewImage(id, it, record?.mime ?: "image/jpeg") } },
            )
        }
    }
}

@Composable
fun TaskPanel(tasks: List<TaskItem>) {
    if (tasks.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    val done = tasks.count { it.status == "done" }
    Surface(color = Palette.surface, shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).animateContentSize()) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth().clickable { open = !open }, verticalAlignment = Alignment.CenterVertically) {
                Text("Tasks $done/${tasks.size}", color = Palette.text, fontSize = 13.sp, modifier = Modifier.weight(1f))
                val progress = if (tasks.isEmpty()) 0f else done.toFloat() / tasks.size
                androidx.compose.material3.LinearProgressIndicator(
                    progress = { progress }, color = Palette.green, trackColor = Palette.surfaceHigh,
                    modifier = Modifier.width(72.dp).height(4.dp).clip(CircleShape),
                )
                Icon(Icons.Filled.ExpandMore, null, tint = Palette.muted, modifier = Modifier.rotate(if (open) 180f else 0f))
            }
            AnimatedVisibility(open) {
                Column(Modifier.padding(top = 4.dp)) {
                    tasks.forEach { task ->
                        Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                if (task.status == "done") Icons.Filled.CheckCircle else if (task.status == "doing") Icons.Filled.Autorenew else Icons.Filled.RadioButtonUnchecked,
                                null, tint = if (task.status == "done") Palette.green else Palette.muted, modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                task.title, fontSize = 13.sp,
                                color = if (task.status == "done") Palette.muted else Palette.text,
                                textDecoration = if (task.status == "done") TextDecoration.LineThrough else null,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun DataUrlThumb(url: String, sizeDp: Int) {
    // Decoded on a background dispatcher: decoding inside composition blocked
    // the UI thread for every photo in a bubble or the composer.
    val bitmap by androidx.compose.runtime.produceState<ImageBitmap?>(null, url) {
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
            try {
                val bytes = java.util.Base64.getDecoder().decode(url.substringAfter(","))
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            } catch (e: Exception) {
                null
            }
        }
    }
    val shown = bitmap
    if (shown != null) {
        Image(shown, null, contentScale = ContentScale.Crop, modifier = Modifier.size(sizeDp.dp).clip(RoundedCornerShape(12.dp)))
    } else {
        Box(Modifier.size(sizeDp.dp).clip(RoundedCornerShape(12.dp)).shimmer())
    }
}

/** Markdown with ChatGPT-style code blocks: language, Copy that turns into a
 * check mark, horizontal scroll. */
@Composable
fun MarkdownText(text: String, onCopyCode: (String) -> Unit) {
    // Split once per text rather than on every frame: during a stream this
    // composable is recomposed for each delta, and every visible turn was
    // re-parsed each time.
    val segments = remember(text) { splitCodeBlocks(text) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (segment in segments) {
            if (segment.code) {
                var copied by remember(segment.text) { mutableStateOf(false) }
                LaunchedEffect(copied) {
                    if (copied) {
                        delay(1800)
                        copied = false
                    }
                }
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.code)) {
                    Row(Modifier.fillMaxWidth().background(Palette.surfaceHigh).padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(segment.language.ifEmpty { "code" }, color = Palette.muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
                        IconButton({ onCopyCode(segment.text); copied = true }, Modifier.size(40.dp)) {
                            Icon(if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy, if (copied) "Copied" else "Copy code", tint = Palette.muted, modifier = Modifier.size(16.dp))
                        }
                    }
                    SelectionContainer {
                        Text(
                            segment.text, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Palette.text,
                            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
                        )
                    }
                }
            } else {
                SelectionContainer {
                    Text(inlineMarkdown(segment.text), color = Palette.text, style = MaterialTheme.typography.bodyLarge.copy(lineHeight = 24.sp))
                }
            }
        }
    }
}
