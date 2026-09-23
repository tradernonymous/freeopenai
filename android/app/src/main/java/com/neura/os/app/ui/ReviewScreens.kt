package com.neura.os.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.DiffLine
import com.neura.os.app.data.PullDetail
import com.neura.os.app.data.PullFile
import com.neura.os.app.data.ReviewEvent
import com.neura.os.app.data.diffLineKind
import com.neura.os.app.data.isRepoName

/** Pull request review from the phone (master plan Phase 4): pick a repo,
 * read an open PR's changes, then approve, comment or request changes --
 * each confirmed before it is sent, since it posts under your name. */
@Composable
fun ReviewsScreen(vm: AppViewModel) {
    var repo by rememberSaveable { mutableStateOf("") }
    var loadedRepo by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) { vm.loadReviewRepos() }
    val pull = vm.reviewPull
    BackHandler(enabled = pull != null) { vm.closePull() }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        vm.reviewError?.let { Text(it, color = Palette.red, fontSize = 13.sp, modifier = Modifier.padding(vertical = 6.dp)) }
        if (pull != null) {
            PullDetailView(vm, loadedRepo, pull)
        } else {
            PullList(vm, repo, loadedRepo, onRepo = { repo = it }, onLoad = {
                loadedRepo = repo
                vm.loadPulls(repo)
            })
        }
    }
}

@Composable
private fun PullList(vm: AppViewModel, repo: String, loadedRepo: String, onRepo: (String) -> Unit, onLoad: () -> Unit) {
    Column {
        OutlinedTextField(
            repo, { onRepo(it.trim()) },
            label = { Text("Repository (owner/name)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (vm.reviewRepos.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                vm.reviewRepos.take(20).forEach { name -> AssistChip({ onRepo(name) }, label = { Text(name, fontSize = 12.sp) }) }
            }
        }
        Button(
            onLoad,
            enabled = isRepoName(repo) && !vm.reviewBusy,
            modifier = Modifier.padding(vertical = 6.dp),
        ) { Text("Show open pull requests") }
        if (vm.reviewBusy) CircularProgressIndicator(Modifier.padding(8.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(vm.reviewPulls, key = { it.number }) { pr ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.surface)
                        .clickable { vm.openPull(loadedRepo, pr.number) }.padding(12.dp),
                ) {
                    Text("#${pr.number}  ${pr.title}", color = Palette.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOfNotNull(pr.author.ifEmpty { null }, "${pr.head} → ${pr.base}", if (pr.draft) "draft" else null).joinToString(" · "),
                        color = Palette.muted, fontSize = 12.sp,
                    )
                }
            }
        }
        if (!vm.reviewBusy && loadedRepo.isNotEmpty() && vm.reviewPulls.isEmpty() && vm.reviewError == null) {
            Text("No open pull requests in $loadedRepo.", color = Palette.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

@Composable
private fun PullDetailView(vm: AppViewModel, repo: String, pull: PullDetail) {
    var text by rememberSaveable(pull.number) { mutableStateOf("") }
    var confirming by remember { mutableStateOf<ReviewEvent?>(null) }
    val uri = LocalUriHandler.current
    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton({ vm.closePull() }) { Text("‹ All pull requests") }
            Text("#${pull.number}  ${pull.title}", style = MaterialTheme.typography.titleMedium, color = Palette.text)
            Text(
                listOfNotNull(pull.author.ifEmpty { null }, "${pull.head} → ${pull.base}", "+${pull.additions} −${pull.deletions}", if (pull.draft) "draft" else null).joinToString(" · "),
                color = Palette.muted, fontSize = 12.sp,
            )
            if (pull.url.startsWith("https://github.com/")) {
                TextButton({ uri.openUri(pull.url) }) { Text("Open on GitHub") }
            }
            if (pull.body.isNotBlank()) Text(pull.body, color = Palette.text, fontSize = 13.sp, modifier = Modifier.padding(vertical = 4.dp))
            if (pull.filesError.isNotEmpty()) Text("Changed files unavailable: ${pull.filesError}", color = Palette.red, fontSize = 12.sp)
        }
        items(pull.files, key = { it.filename }) { file -> FileDiff(file) }
        item {
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                text, { text = it.take(20000) },
                label = { Text("Review comment") },
                placeholder = { Text("Needed for Comment and Request changes") },
                modifier = Modifier.fillMaxWidth().heightIn(min = 90.dp),
            )
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ confirming = ReviewEvent.APPROVE }, enabled = !vm.reviewBusy) { Text("Approve") }
                OutlinedButton({ confirming = ReviewEvent.COMMENT }, enabled = !vm.reviewBusy && ReviewEvent.COMMENT.canSend(text)) { Text("Comment") }
            }
            OutlinedButton(
                { confirming = ReviewEvent.REQUEST_CHANGES },
                enabled = !vm.reviewBusy && ReviewEvent.REQUEST_CHANGES.canSend(text),
            ) { Text("Request changes") }
            Spacer(Modifier.height(24.dp))
        }
    }
    confirming?.let { event ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text("${event.label} #${pull.number}?") },
            text = { Text("This posts a review on GitHub under your name, in $repo.") },
            confirmButton = {
                TextButton({
                    vm.submitReview(repo, pull.number, event, text) { text = "" }
                    confirming = null
                }) { Text(event.label) }
            },
            dismissButton = { TextButton({ confirming = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun FileDiff(file: PullFile) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Palette.surface).padding(10.dp)) {
        Text(
            "${file.filename}  +${file.additions} −${file.deletions}" + (if (file.status.isNotEmpty()) "  (${file.status})" else ""),
            color = Palette.text, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
        )
        if (file.patch.isEmpty()) {
            Text("No text diff (binary, renamed, or too large).", color = Palette.muted, fontSize = 11.sp)
        } else {
            Column(Modifier.horizontalScroll(rememberScrollState()).padding(top = 6.dp)) {
                file.patch.lines().forEach { line ->
                    val kind = diffLineKind(line)
                    val tint = when (kind) {
                        DiffLine.ADDED -> Palette.green.copy(alpha = 0.18f)
                        DiffLine.REMOVED -> Palette.red.copy(alpha = 0.18f)
                        DiffLine.HUNK, DiffLine.CONTEXT -> Color.Transparent
                    }
                    Text(
                        line.ifEmpty { " " },
                        color = if (kind == DiffLine.HUNK) Palette.muted else Palette.text,
                        fontSize = 11.sp, fontFamily = FontFamily.Monospace, softWrap = false,
                        modifier = Modifier.background(tint),
                    )
                }
            }
            if (file.clipped) Text("Long diff: only the start is shown. Open on GitHub for the rest.", color = Palette.muted, fontSize = 11.sp)
        }
    }
}
