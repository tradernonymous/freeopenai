package com.neura.os.app.ui

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp

/** Full-screen picture: pinch to zoom, drag to pan, double-tap to reset. */
@Composable
fun ImageViewer(bytes: ByteArray, onClose: () -> Unit, onSave: () -> Unit, onShare: () -> Unit) {
    BackHandler(onBack = onClose)
    // Decoded at roughly screen size rather than full size: a 12-megapixel
    // photo is 48 MB as a bitmap, which is an OutOfMemoryError on a small
    // phone and a visible freeze on a large one. A decode that fails is an
    // empty frame with a message, never a crash.
    val bitmap = remember(bytes) {
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (bounds.outWidth / sample > 2048 || bounds.outHeight / sample > 2048) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
        } catch (e: Throwable) {
            null
        }
    }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black)) {
        if (bitmap != null) {
            Image(
                bitmap, "Image", contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize()
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 5f)
                            offset = if (scale == 1f) Offset.Zero else offset + pan
                        }
                    }
                    .pointerInput(Unit) {
                        detectTapGestures(onDoubleTap = {
                            scale = if (scale > 1f) 1f else 2.5f
                            offset = Offset.Zero
                        })
                    }
                    .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
            )
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClose, Modifier.pressScale()) { Icon(Icons.Filled.Close, "Close", tint = Palette.text) }
            Row {
                IconButton(onSave, Modifier.pressScale()) { Icon(Icons.Filled.Download, "Save", tint = Palette.text) }
                IconButton(onShare, Modifier.pressScale()) { Icon(Icons.Filled.Share, "Share", tint = Palette.text) }
            }
        }
    }
}

/** A reply as plain selectable text, for copying just a part of it. */
@Composable
fun SelectTextDialog(text: String, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Select text") },
        text = {
            SelectionContainer {
                Text(text, color = Palette.text, modifier = Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()))
            }
        },
        confirmButton = { TextButton(onClose) { Text("Done") } },
    )
}
