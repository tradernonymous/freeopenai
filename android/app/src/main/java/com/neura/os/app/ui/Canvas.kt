package com.neura.os.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The canvas (docs/android-master-plan.md V8): a long reply opened full
// height, read-only, away from the chat's bubbles. The arrows step through
// this chat's replies; a reply asked again with Regenerate also has its
// earlier versions, one tap apart (data/Anatomy.kt canvasEntries). Nothing
// here sends anything, so an old ```ui block stays inert.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CanvasSheet(entries: List<List<String>>, start: Int, platform: Platform, onClose: () -> Unit) {
    if (entries.isEmpty()) return
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var index by remember(entries, start) { mutableIntStateOf(start.coerceIn(0, entries.lastIndex)) }
    val versions = entries[index]
    // Opens on the current version; picking another does not change the chat.
    var version by remember(entries, index) { mutableIntStateOf(versions.lastIndex) }
    val shown = versions[version.coerceIn(0, versions.lastIndex)]
    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheet, containerColor = Palette.surface) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Canvas", color = Palette.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                if (entries.size > 1) {
                    if (index > 0) SmallAction(Icons.AutoMirrored.Filled.ArrowBack, "Earlier reply") { index-- }
                    Text("${index + 1} of ${entries.size}", color = Palette.muted, fontSize = 12.sp)
                    if (index < entries.lastIndex) SmallAction(Icons.AutoMirrored.Filled.ArrowForward, "Later reply") { index++ }
                }
                SmallAction(Icons.Filled.ContentCopy, "Copy") { platform.copy(shown) }
                SmallAction(Icons.Filled.Share, "Share") { platform.shareText("NeuraOS", shown) }
            }
            if (versions.size > 1) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Versions", color = Palette.muted, fontSize = 12.sp)
                    versions.indices.forEach { v ->
                        val on = v == version
                        Text(
                            if (v == versions.lastIndex) "${v + 1} · now" else "${v + 1}",
                            color = if (on) Palette.onAccent else Palette.text,
                            fontSize = 12.sp,
                            modifier = Modifier.clip(RoundedCornerShape(12.dp))
                                .background(if (on) Palette.accent else Palette.surfaceHigh)
                                .clickable { version = v }
                                .padding(horizontal = 10.dp, vertical = 5.dp),
                        )
                    }
                }
            }
            AnimatedContent(
                targetState = index to version,
                transitionSpec = {
                    val forward = targetState.first > initialState.first ||
                        (targetState.first == initialState.first && targetState.second > initialState.second)
                    val dir = if (forward) 1 else -1
                    (slideInHorizontally { it * dir / 4 } + fadeIn()) togetherWith (slideOutHorizontally { -it * dir / 4 } + fadeOut())
                },
                label = "canvas",
            ) { (at, v) ->
                val text = entries[at].let { it[v.coerceIn(0, it.lastIndex)] }
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
                    MarkdownText(text) { platform.copy(it) }
                }
            }
        }
    }
}
