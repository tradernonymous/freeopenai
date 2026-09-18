package com.freeai4u.app.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Construction
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.freeai4u.app.data.BuildEvent
import com.freeai4u.app.data.BuildPending
import com.freeai4u.app.data.BuildSession
import com.freeai4u.app.data.BuildStep
import com.freeai4u.app.data.buildStatusLabel

// Remote build screens: the list of builds, and one build with its steps, the
// change waiting for approval, and what has happened so far. The step list
// follows design-extract's StageTicker (numbered dots that fill as steps finish,
// a pulsing ring on the active one); approvals are cards that name exactly what
// will change, as deepseek-harness-mobile's approval sheet does.

private fun statusColor(status: String): Color = when (status) {
    "queued", "running" -> Palette.violet
    "awaiting_approval", "awaiting_input" -> Palette.amber
    "done" -> Palette.green
    "failed", "cancelled", "expired" -> Palette.red
    else -> Palette.muted
}

@Composable
private fun StatusPill(status: String) {
    val color = statusColor(status)
    val pulse = rememberInfiniteTransition(label = "pill")
    val dotAlpha by pulse.animateFloat(1f, 0.35f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "dot")
    Surface(color = color.copy(alpha = 0.14f), shape = RoundedCornerShape(50)) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(7.dp).alpha(if (status == "running" || status == "queued") dotAlpha else 1f)
                    .background(color, CircleShape),
            )
            Spacer(Modifier.width(6.dp))
            Text(buildStatusLabel(status).uppercase(), color = color, fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
    }
}

// --- The list ------------------------------------------------------------------

@Composable
fun BuildsScreen(vm: AppViewModel) {
    val builds = vm.builds
    LaunchedEffect(Unit) { builds.refresh() }
    val list = builds.list
    val listError = builds.listError
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Plans carried out on the server. Every file change and command waits for your approval.",
                    color = Palette.muted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f),
                )
                IconButton({ builds.refresh() }, Modifier.size(48.dp).pressScale()) {
                    if (builds.listBusy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Icon(Icons.Filled.Refresh, "Refresh builds", tint = Palette.text)
                }
            }
        }
        when {
            list == null && listError == null -> item {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
            list == null -> item { NoticeCard(listError ?: "", Palette.red, Palette.redTint) }
            !list.enabled -> item { NoticeCard(list.reason.ifEmpty { "Builds are off on this server." }, Palette.red, Palette.redTint) }
            else -> {
                if (!list.runEnabled) {
                    item { NoticeCard("Commands are off on the server (WORKSPACE_RUN=1 turns them on), so a build can write files but not run tests.", Palette.amber, Palette.amberTint) }
                }
                if (list.sessions.isEmpty()) {
                    item {
                        EmptyState(
                            "No builds yet",
                            "Switch to Plan mode, ask for a plan, then tap \"Build remotely\" under the reply. Builds started on the web app show up here too.",
                            actionLabel = "Start a plan",
                            onAction = { vm.newChat(mode = "plan") },
                        )
                    }
                }
                items(list.sessions, key = { it.id }) { session -> BuildRow(session) { vm.openBuild(session.id) } }
            }
        }
    }
}

@Composable
private fun NoticeCard(text: String, accent: Color, tint: Color) {
    Surface(color = tint, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row {
            Box(Modifier.width(3.dp).heightIn(min = 44.dp).background(accent))
            Text(text, color = Palette.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
        }
    }
}

@Composable
private fun BuildRow(session: BuildSession, onClick: () -> Unit) {
    val total = session.steps.size
    Card(
        colors = CardDefaults.cardColors(containerColor = Palette.surface),
        modifier = Modifier.fillMaxWidth().enterUp().pressScale(0.98f).clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusPill(session.status)
                Spacer(Modifier.weight(1f))
                Text(relativeTime(session.startedAt), color = Palette.muted, fontSize = 12.sp)
            }
            Text(
                session.steps.firstOrNull()?.title ?: "Build",
                style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            if (total > 0) {
                LinearProgressIndicator(
                    progress = { session.doneSteps / total.toFloat() },
                    color = statusColor(session.status), trackColor = Palette.surfaceHigh,
                    modifier = Modifier.fillMaxWidth().height(4.dp),
                )
                val model = session.model.substringAfterLast('/')
                Text("${session.doneSteps}/$total steps" + (if (model.isNotEmpty()) " · $model" else ""), color = Palette.muted, fontSize = 12.sp)
            }
        }
    }
}

// --- One build --------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BuildScreen(vm: AppViewModel) {
    val builds = vm.builds
    val session = builds.current
    DisposableEffect(Unit) { onDispose { builds.close() } }
    var confirmCancel by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = Palette.background,
        topBar = {
            TopAppBar(
                title = { Text("Build") },
                navigationIcon = { IconButton({ vm.back() }, Modifier.pressScale()) { Icon(Icons.Filled.ArrowBack, "Back") } },
                actions = {
                    if (session != null && !session.finished) {
                        TextButton({ confirmCancel = true }, enabled = !builds.actionBusy) { Text("Cancel", color = Palette.red) }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
            )
        },
    ) { padding ->
        if (session == null) {
            Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) {
                val error = builds.error
                if (error != null) Text(error, color = Palette.red, modifier = Modifier.padding(24.dp)) else CircularProgressIndicator()
            }
        } else {
            BuildBody(builds, session, Modifier.padding(padding))
        }
    }
    if (confirmCancel) {
        AlertDialog(
            onDismissRequest = { confirmCancel = false },
            title = { Text("Cancel this build?") },
            text = { Text("Changes you already approved stay in the build folder on the server.") },
            confirmButton = {
                TextButton({
                    confirmCancel = false
                    builds.cancel()
                }) { Text("Cancel build", color = Palette.red) }
            },
            dismissButton = { TextButton({ confirmCancel = false }) { Text("Keep going") } },
        )
    }
}

@Composable
private fun BuildBody(builds: RemoteBuilds, session: BuildSession, modifier: Modifier) {
    val state = rememberLazyListState()
    val timelineSize = builds.timeline.size
    LaunchedEffect(timelineSize) {
        val info = state.layoutInfo
        val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
        if (timelineSize > 0 && last >= info.totalItemsCount - 3) state.animateScrollToItem(maxOf(0, info.totalItemsCount - 1))
    }
    LazyColumn(
        state = state,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = modifier.fillMaxSize(),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusPill(session.status)
                Spacer(Modifier.width(8.dp))
                Text(
                    listOf(session.repo, session.model.substringAfterLast('/'), relativeTime(session.startedAt)).filter { it.isNotEmpty() }.joinToString(" · "),
                    color = Palette.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (builds.connection.isNotEmpty()) item { NoticeCard(builds.connection, Palette.amber, Palette.amberTint) }
        builds.error?.let { error -> item { NoticeCard(error, Palette.red, Palette.redTint) } }
        item { StepTicker(session.steps) }
        session.pending?.let { pending ->
            item(key = "pending-" + pending.requestId) {
                if (pending.kind == "question") {
                    QuestionCard(pending, builds.actionBusy) { builds.answer(null, it) }
                } else {
                    ApprovalCard(pending, builds.actionBusy, onApprove = { builds.answer("approve", "") }, onReject = { builds.answer("reject", it) })
                }
            }
        }
        items(builds.timeline, key = { "e" + it.seq }) { event -> TimelineItem(event) }
        if (session.finished && builds.timeline.none { it is BuildEvent.Done || it is BuildEvent.Failed }) {
            item {
                if (session.status == "done") ResultCard(session.summary.ifEmpty { "Build finished." }, Palette.green, Palette.greenTint)
                else ResultCard(session.error.ifEmpty { buildStatusLabel(session.status) }, Palette.red, Palette.redTint)
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

private data class StepLook(val fill: Color, val edge: Color, val mark: String, val markColor: Color)

@Composable
private fun StepTicker(steps: List<BuildStep>) {
    val pulse = rememberInfiniteTransition(label = "ticker")
    val ring by pulse.animateFloat(0.35f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "ring")
    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.animateContentSize()) {
        steps.forEachIndexed { index, step ->
            val look = when (step.status) {
                "done" -> StepLook(Palette.green, Palette.green, "✓", Color(0xFF04260F))
                "failed" -> StepLook(Palette.red, Palette.red, "!", Color.White)
                "in_progress" -> StepLook(Palette.violetTint, Palette.violet.copy(alpha = ring), "${index + 1}", Palette.violet)
                "skipped" -> StepLook(Color.Transparent, Palette.outline, "–", Palette.muted)
                else -> StepLook(Color.Transparent, Palette.outline, "${index + 1}", Palette.muted)
            }
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp)
                    .semantics { contentDescription = "Step ${index + 1}: ${step.title}, ${step.status.replace('_', ' ')}" },
            ) {
                Box(
                    Modifier.size(24.dp).background(look.fill, CircleShape).border(1.5.dp, look.edge, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Text(look.mark, color = look.markColor, fontSize = 11.sp, fontWeight = FontWeight.Bold) }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        step.title,
                        color = when (step.status) {
                            "in_progress", "pending" -> Palette.text
                            else -> Palette.muted
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (step.note.isNotEmpty()) Text(step.note, color = Palette.muted, fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(pending: BuildPending, busy: Boolean, onApprove: () -> Unit, onReject: (String) -> Unit) {
    var reason by rememberSaveable(pending.requestId) { mutableStateOf("") }
    val haptics = rememberHaptics()
    Surface(
        color = Palette.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Palette.amber),
        modifier = Modifier.fillMaxWidth().enterUp(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Needs your approval", color = Palette.amber, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text(pending.summary.ifEmpty { pending.tool }, style = MaterialTheme.typography.titleSmall)
            CodeBlock(pending.tool.replace('_', ' '), pending.preview)
            OutlinedTextField(
                reason, { reason = it },
                placeholder = { Text("Why not? (optional, the agent reads this)") },
                modifier = Modifier.fillMaxWidth(), maxLines = 3,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    {
                        haptics(HapticFeedbackType.LongPress)
                        onApprove()
                    },
                    enabled = !busy,
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                ) { Text(if (pending.tool == "run_command") "Approve & run" else "Approve") }
                OutlinedButton(
                    { onReject(reason) },
                    enabled = !busy,
                    border = BorderStroke(1.dp, Palette.red),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Palette.red),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                ) { Text("Reject") }
            }
        }
    }
}

@Composable
private fun QuestionCard(pending: BuildPending, busy: Boolean, onAnswer: (String) -> Unit) {
    var answer by rememberSaveable(pending.requestId) { mutableStateOf("") }
    Surface(
        color = Palette.surface, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, Palette.amber),
        modifier = Modifier.fillMaxWidth().enterUp(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("The build agent asks", color = Palette.amber, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            SelectionContainer { Text(pending.question, style = MaterialTheme.typography.bodyLarge) }
            OutlinedTextField(answer, { answer = it }, placeholder = { Text("Your answer") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
            Button({ onAnswer(answer) }, enabled = !busy && answer.isNotBlank(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text("Send answer")
            }
        }
    }
}

@Composable
private fun TimelineItem(event: BuildEvent) {
    when (event) {
        is BuildEvent.Message -> Surface(color = Palette.surfaceHigh, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth().enterUp()) {
            SelectionContainer {
                Text(event.text, color = Palette.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
            }
        }
        is BuildEvent.Output -> CodeBlock(event.title, event.text)
        is BuildEvent.Diff -> CodeBlock((if (event.created) "Created " else "Changed ") + event.path + " · " + event.bytes + " bytes", event.patch)
        is BuildEvent.Answer -> Text(
            when (event.decision) {
                "approve" -> "✓ You approved it."
                "answer" -> "↩ You answered: " + event.text
                else -> "✕ You rejected it" + (if (event.text.isNotEmpty()) ": " + event.text else ".")
            },
            color = Palette.muted, fontSize = 13.sp,
        )
        is BuildEvent.Done -> ResultCard(event.summary.ifEmpty { "Build finished." }, Palette.green, Palette.greenTint)
        is BuildEvent.Failed -> ResultCard(event.error.ifEmpty { buildStatusLabel(event.status) }, Palette.red, Palette.redTint)
        else -> Unit
    }
}

@Composable
private fun ResultCard(text: String, accent: Color, tint: Color) {
    Surface(color = tint, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().enterUp()) {
        Row {
            Box(Modifier.width(3.dp).heightIn(min = 44.dp).background(accent))
            SelectionContainer {
                Text(text, color = Palette.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(12.dp))
            }
        }
    }
}

/** Command output or a diff: monospace, scrolls sideways, added lines green and
 * removed lines red, long blocks folded behind "Show all". */
@Composable
private fun CodeBlock(title: String, text: String) {
    val lines = remember(text) { text.trimEnd('\n').lines() }
    var expanded by remember(text) { mutableStateOf(false) }
    val shown = if (expanded) lines else lines.take(FOLDED_LINES)
    Surface(color = Palette.code, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, Palette.outline), modifier = Modifier.fillMaxWidth()) {
        Column {
            Text(
                title, color = Palette.muted, fontFamily = FontFamily.Monospace, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().background(Palette.surface).padding(horizontal = 10.dp, vertical = 8.dp),
            )
            SelectionContainer {
                Column(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 6.dp)) {
                    shown.forEach { line ->
                        val lineColor = when {
                            line.startsWith("+") -> Palette.green
                            line.startsWith("-") -> Palette.red
                            else -> Palette.text
                        }
                        val lineBackground = when {
                            line.startsWith("+") -> Palette.greenTint
                            line.startsWith("-") -> Palette.redTint
                            else -> Color.Transparent
                        }
                        Text(
                            line.ifEmpty { " " }, color = lineColor, fontFamily = FontFamily.Monospace, fontSize = 12.sp, softWrap = false,
                            modifier = Modifier.background(lineBackground).padding(horizontal = 10.dp),
                        )
                    }
                }
            }
            if (lines.size > FOLDED_LINES) {
                TextButton({ expanded = !expanded }, Modifier.padding(start = 4.dp)) {
                    Text(if (expanded) "Show less" else "Show all ${lines.size} lines", color = Palette.green, fontSize = 13.sp)
                }
            }
        }
    }
}

/** The chip under a plan reply that hands the plan to the server. */
@Composable
fun BuildRemotelyChip(onClick: () -> Unit) {
    Surface(
        color = Palette.violetTint, shape = RoundedCornerShape(50), border = BorderStroke(1.dp, Palette.violet.copy(alpha = 0.6f)),
        modifier = Modifier.heightIn(min = 48.dp).pressScale(0.95f).clickable(onClickLabel = "Build this plan on the server", onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Construction, null, tint = Palette.violet, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Build remotely", color = Palette.violet, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

private const val FOLDED_LINES = 14
