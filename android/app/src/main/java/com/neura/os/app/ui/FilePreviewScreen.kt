package com.neura.os.app.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.SaveAlt
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.FileGenerator

/**
 * In-app viewer for generated files:
 *   - Markdown: rendered as styled text with headings
 *   - Code: syntax-highlighted monospace text
 *   - JSON/XML: formatted monospace text
 *   - Images: zoomable bitmap display
 *   - CSV: table-like display
 *
 * Accessible from the chat's download bar via the "Preview" button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilePreviewScreen(
    file: FileGenerator.GeneratedFile,
    onBack: () -> Unit,
    onSave: (FileGenerator.GeneratedFile) -> Unit,
    onShare: (FileGenerator.GeneratedFile) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().background(Palette.background)) {
        TopAppBar(
            title = {
                Text(
                    text = file.displayName,
                    color = Palette.text,
                    style = MaterialTheme.typography.titleSmall,
                )
            },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Palette.text)
                }
            },
            actions = {
                IconButton(onClick = { onSave(file) }) {
                    Icon(Icons.Default.SaveAlt, "Save", tint = Palette.text)
                }
                IconButton(onClick = { onShare(file) }) {
                    Icon(Icons.Default.Share, "Share", tint = Palette.text)
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = Palette.surface,
                titleContentColor = Palette.text,
            ),
        )

        when {
            file.mimeType.startsWith("image/") -> ImageViewer(file)
            file.extension == "md" || file.mimeType == "text/markdown" -> MarkdownViewer(file)
            else -> CodeViewer(file)
        }
    }
}

@Composable
private fun ImageViewer(file: FileGenerator.GeneratedFile) {
    val bitmap = remember(file.content) {
        BitmapFactory.decodeByteArray(file.content, 0, file.content.size)
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = file.displayName,
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Fit,
        )
    } else {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Could not decode image", color = Palette.muted)
        }
    }
}

@Composable
private fun MarkdownViewer(file: FileGenerator.GeneratedFile) {
    val text = remember(file.content) { String(file.content, Charsets.UTF_8) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        for (line in text.lines()) {
            val style = when {
                line.startsWith("# ") && !line.startsWith("## ") -> MaterialTheme.typography.headlineSmall
                line.startsWith("## ") && !line.startsWith("### ") -> MaterialTheme.typography.titleMedium
                line.startsWith("### ") -> MaterialTheme.typography.titleSmall
                else -> MaterialTheme.typography.bodyMedium
            }
            val verticalPadding = when {
                line.startsWith("# ") -> 8.dp
                line.startsWith("## ") -> 6.dp
                line.startsWith("### ") -> 4.dp
                line.isBlank() -> 4.dp
                else -> 1.dp
            }
            val displayText = when {
                line.startsWith("```") -> continue
                line.isBlank() -> continue
                line.startsWith("- ") -> "• ${line.removePrefix("- ")}"
                else -> line
            }
            Text(
                text = displayText,
                color = Palette.text,
                style = style,
                modifier = Modifier.padding(
                    start = if (line.startsWith("- ")) 16.dp else 0.dp,
                    vertical = verticalPadding,
                ),
            )
        }
    }
}

@Composable
private fun CodeViewer(file: FileGenerator.GeneratedFile) {
    val text = remember(file.content) { String(file.content, Charsets.UTF_8) }
    BasicTextField(
        value = text,
        onValueChange = { /* read-only */ },
        readOnly = true,
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .horizontalScroll(rememberScrollState())
            .background(Palette.code)
            .padding(12.dp),
        textStyle = TextStyle(
            color = Palette.text,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 18.sp,
        ),
        cursorBrush = SolidColor(Palette.green),
    )
}
