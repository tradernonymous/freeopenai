package com.neura.os.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import com.neura.os.R

// NeuraOS, Neural Violet (docs/neuraos-rebrand-plan.md, R2). Every colour comes
// from design/tokens.json through the generated Tokens.kt; nothing here picks a
// hex value of its own. The accent means the AI or a primary action; success,
// warning and danger are status colours and never stand in for it.
object Palette {
    /** Which token set is showing. Snapshot state, so every screen that reads
     * a colour follows a theme switch. NativeActivity.applyTheme() sets it,
     * outside composition, from Settings -> App -> Theme and the system mode. */
    var isDark by mutableStateOf(true)

    private val c: NeuraColors get() = if (isDark) NeuraTokens.Dark else NeuraTokens.Light

    val background: Color get() = c.bg
    val surface: Color get() = c.surface
    val surfaceHigh: Color get() = c.raised
    // A control's boundary: 3:1 on every surface (test/tokens.test.js).
    val outline: Color get() = c.line
    val text: Color get() = c.text
    val muted: Color get() = c.muted
    val code: Color get() = c.code

    val accent: Color get() = c.accent
    val onAccent: Color get() = c.onAccent
    val accentSoft: Color get() = c.accentSoft
    val accentDeep: Color get() = c.accentDeep
    val accentTint: Color get() = c.accent.copy(alpha = 0.16f)
    // Second stop of the AI-activity gradient: accent -> glow.
    val glow: Color get() = c.glow

    val success: Color get() = c.success
    val successTint: Color get() = c.success.copy(alpha = 0.14f)
    // Build status: amber is "needs you".
    val amber: Color get() = c.warning
    val amberTint: Color get() = c.warning.copy(alpha = 0.14f)
    val red: Color get() = c.danger
    val redTint: Color get() = c.danger.copy(alpha = 0.14f)
    val info: Color get() = c.info
}

/** Inter for everything the app writes; the phone's own fonts fill in any
 * script the bundled subset (Latin, Greek, Cyrillic) does not carry. */
val NeuraSans = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)

/** JetBrains Mono (no ligatures, so code reads exactly as written). */
val NeuraMono = FontFamily(Font(R.font.jetbrains_mono_regular, FontWeight.Normal))

private fun scheme(dark: Boolean) = if (dark) {
    darkColorScheme(
        primary = Palette.accent,
        onPrimary = Palette.onAccent,
        primaryContainer = Palette.accentDeep,
        onPrimaryContainer = Palette.text,
        secondary = Palette.accent,
        onSecondary = Palette.onAccent,
        secondaryContainer = Palette.surfaceHigh,
        onSecondaryContainer = Palette.text,
        tertiary = Palette.glow,
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
} else {
    lightColorScheme(
        primary = Palette.accent,
        onPrimary = Palette.onAccent,
        primaryContainer = Palette.accentDeep,
        onPrimaryContainer = Palette.text,
        secondary = Palette.accent,
        onSecondary = Palette.onAccent,
        secondaryContainer = Palette.surfaceHigh,
        onSecondaryContainer = Palette.text,
        tertiary = Palette.glow,
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
}

private fun TextStyle.neura(weight: FontWeight? = null) = copy(fontFamily = NeuraSans, fontWeight = weight ?: fontWeight)

private val NeuraTypography = Typography().run {
    copy(
        displayLarge = displayLarge.neura(), displayMedium = displayMedium.neura(), displaySmall = displaySmall.neura(),
        headlineLarge = headlineLarge.neura(FontWeight.SemiBold),
        headlineMedium = headlineMedium.neura(FontWeight.SemiBold),
        headlineSmall = headlineSmall.neura(FontWeight.SemiBold),
        titleLarge = titleLarge.neura(FontWeight.SemiBold),
        titleMedium = titleMedium.neura(), titleSmall = titleSmall.neura(),
        bodyLarge = bodyLarge.neura(), bodyMedium = bodyMedium.neura(), bodySmall = bodySmall.neura(),
        labelLarge = labelLarge.neura(), labelMedium = labelMedium.neura(), labelSmall = labelSmall.neura(),
    )
}

@Composable
fun NeuraTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme(Palette.isDark), typography = NeuraTypography, content = content)
}
