package com.neura.os.app.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.Outbox
import com.neura.os.app.data.outboxNotice
import kotlinx.coroutines.delay
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.Flow

/** Above the composer while this chat's reply is queued for a retry: the
 * Outbox always retried, but silently, so a turn lost to a dropped
 * connection read as gone rather than pending (master plan Phase 3). The
 * text comes from data/Outbox.kt's outboxNotice, where it is tested. */
@Composable
fun OutboxBanner(outbox: Outbox, chatId: String, canRetry: Boolean, onRetry: () -> Unit) {
    if (outbox.entries.none { it.chatId == chatId }) return
    // Ticks once a second only while this chat is queued, so "Next try in
    // 3 s" counts down instead of freezing at whatever it first said.
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(outbox, chatId) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val text = outboxNotice(outbox, chatId, now) ?: return
    Surface(color = Palette.surfaceHigh, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.History, null, tint = Palette.muted, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(text, color = Palette.text, fontSize = 12.sp, modifier = Modifier.weight(1f))
            if (canRetry) TextButton(onRetry) { Text("Retry now") }
        }
    }
}

/** The one place notices appear (docs/android-master-plan.md, V3): at the app
 * root, over whatever page is open, one at a time, in the order they were
 * raised. Collects only while the app is on screen, so a notice raised in
 * the background waits for the person to come back instead of flashing past
 * unseen. */
@Composable
fun NoticeHost(notices: Flow<String>, modifier: Modifier = Modifier) {
    val host = remember { SnackbarHostState() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(notices, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            notices.collect { host.showSnackbar(it) }
        }
    }
    SnackbarHost(host, modifier)
}
