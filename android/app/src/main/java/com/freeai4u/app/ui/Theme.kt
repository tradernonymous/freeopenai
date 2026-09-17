package com.freeai4u.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Always dark with the web app's green accent (GitHub-dark palette), so the
// native screens and the web tools screen look like one app.
object Palette {
    val background = Color(0xFF0D1117)
    val surface = Color(0xFF161B22)
    val surfaceHigh = Color(0xFF21262D)
    // 3:1 against the surfaces it is drawn on: the old line (0xFF30363D) read
    // at about 1.3:1, which is below what a control's boundary needs to be
    // seen at all outdoors.
    val outline = Color(0xFF6B7683)
    val text = Color(0xFFE6EDF3)
    val muted = Color(0xFF8B949E)
    val green = Color(0xFF3FB950)
    val greenDark = Color(0xFF238636)
    val red = Color(0xFFF85149)
    val userBubble = Color(0xFF1F3A2A)
    val code = Color(0xFF0B0F14)
}

private val scheme = darkColorScheme(
    primary = Palette.green,
    onPrimary = Color(0xFF04260F),
    primaryContainer = Palette.greenDark,
    onPrimaryContainer = Color.White,
    secondary = Palette.green,
    onSecondary = Color(0xFF04260F),
    secondaryContainer = Palette.surfaceHigh,
    onSecondaryContainer = Palette.text,
    background = Palette.background,
    onBackground = Palette.text,
    surface = Palette.background,
    onSurface = Palette.text,
    surfaceVariant = Palette.surface,
    onSurfaceVariant = Palette.muted,
    surfaceContainer = Palette.surface,
    surfaceContainerHigh = Palette.surfaceHigh,
    surfaceContainerHighest = Palette.surfaceHigh,
    surfaceContainerLow = Palette.surface,
    outline = Palette.outline,
    outlineVariant = Palette.outline,
    error = Palette.red,
)

@Composable
fun FreeAITheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
}
