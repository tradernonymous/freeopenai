package com.freeai4u.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Construction
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.freeai4u.app.data.Conversation

/** Shown above the composer the whole time a chat is in Build mode -- the
 * boundary is stated once, plainly, rather than left to be discovered the
 * first time a file tool refuses to run a command. */
@Composable
fun BuildModeBanner() {
    Surface(color = Palette.surfaceHigh, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Construction, null, tint = Palette.muted, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text("Edits stay in this chat. Tap Build remotely to run them on your server.", color = Palette.muted, fontSize = 12.sp)
        }
    }
}

/** The one-line, tappable summary of what's waiting for a decision. Opens
 * WorkspaceReviewSheet, where the decision is actually made. */
@Composable
fun PendingWritesBanner(count: Int, onOpen: () -> Unit) {
    Surface(
        color = Palette.greenDark.copy(alpha = 0.25f), shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).clickable(onClick = onOpen),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Description, null, tint = Palette.green, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                if (count == 1) "1 change waiting for your approval" else "$count changes waiting for your approval",
                color = Palette.text, fontSize = 13.sp, modifier = Modifier.weight(1f),
            )
            TextButton(onOpen) { Text("Review") }
        }
    }
}

/** Per-write approve/reject, modelled on BuildScreens' ApprovalCard: every
 * change is named before anything happens to it. Checking a box only edits
 * local UI state -- files does not move until Apply commits the batch, which
 * is the one moment any of this becomes real. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceReviewSheet(vm: AppViewModel, chat: Conversation, onClose: () -> Unit) {
    var approved by remember(chat.id, chat.pendingWrites) { mutableStateOf(chat.pendingWrites.map { it.path }.toSet()) }
    ModalBottomSheet(onDismissRequest = onClose, containerColor = Palette.surface) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Text("Review changes", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text("Nothing here is real until you tap Apply.", color = Palette.muted, fontSize = 12.sp)
            Spacer(Modifier.height(8.dp))
            chat.pendingWrites.forEach { write ->
                val checked = write.path in approved
                Row(
                    Modifier.fillMaxWidth().clickable { approved = if (checked) approved - write.path else approved + write.path }
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked, { on -> approved = if (on) approved + write.path else approved - write.path })
                    Column(Modifier.weight(1f)) {
                        Text(write.path, color = Palette.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${write.content.toByteArray(Charsets.UTF_8).size} bytes", color = Palette.muted, fontSize = 12.sp)
                    }
                }
            }
            HorizontalDivider(color = Palette.outline, modifier = Modifier.padding(vertical = 10.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TextButton(
                    { vm.commitPendingWrites(chat.id, emptySet()); onClose() },
                    modifier = Modifier.weight(1f),
                ) { Text("Reject all", color = Palette.red) }
                Button(
                    { vm.commitPendingWrites(chat.id, approved); onClose() },
                    modifier = Modifier.weight(1f),
                ) { Text(if (approved.isEmpty()) "Reject all" else "Apply " + approved.size + "/" + chat.pendingWrites.size) }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}
