package com.neura.os.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The canvas (docs/android-master-plan.md V8): a long reply opened full
// height, read-only, away from the chat's bubbles. The arrows step through
// this chat's earlier replies (data/Anatomy.kt canvasReplies); nothing here
// sends anything, so an old ```ui block stays inert.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CanvasSheet(replies: List<String>, start: Int, platform: Platform, onClose: () -> Unit) {
    if (replies.isEmpty()) return
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var index by remember(replies, start) { mutableIntStateOf(start.coerceIn(0, replies.lastIndex)) }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheet, containerColor = Palette.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Canvas", color = Palette.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                if (replies.size > 1) {
                    if (index > 0) SmallAction(Icons.AutoMirrored.Filled.ArrowBack, "Earlier reply") { index-- }
                    Text("${index + 1} of ${replies.size}", color = Palette.muted, fontSize = 12.sp)
                    if (index < replies.lastIndex) SmallAction(Icons.AutoMirrored.Filled.ArrowForward, "Later reply") { index++ }
                }
                SmallAction(Icons.Filled.ContentCopy, "Copy") { platform.copy(replies[index]) }
                SmallAction(Icons.Filled.Share, "Share") { platform.shareText("NeuraOS", replies[index]) }
            }
            AnimatedContent(
                targetState = index,
                transitionSpec = {
                    val dir = if (targetState > initialState) 1 else -1
                    (slideInHorizontally { it * dir / 4 } + fadeIn()) togetherWith (slideOutHorizontally { -it * dir / 4 } + fadeOut())
                },
                label = "canvas",
            ) { shown ->
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
                    MarkdownText(replies[shown]) { platform.copy(it) }
                }
            }
        }
    }
}
