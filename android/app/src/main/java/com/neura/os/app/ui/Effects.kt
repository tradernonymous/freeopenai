package com.neura.os.app.ui

import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import android.os.PowerManager
import androidx.annotation.RequiresApi
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.sin

// The futuristic layer (docs/android-master-plan.md §2.2, V6): quiet by
// default, alive only while the AI works. Every effect here has a still
// state -- Remove animations or battery saver turn motion off -- and draws
// nothing at all when its trigger is off, so an idle app costs nothing.

/** True in battery saver: effects hold still. */
@Composable
fun rememberPowerSave(): Boolean {
    val context = LocalContext.current
    return remember(context) { context.getSystemService(PowerManager::class.java)?.isPowerSaveMode == true }
}

/** Motion off: the person asked for it, or the battery did. */
@Composable
fun effectsStill(): Boolean = rememberReducedMotion() || rememberPowerSave()

/** Glass for floating surfaces (dock, composer, search): a translucent
 * surface, light along its top edge, and a fine border that leans violet.
 * No backdrop blur: Compose has none without a library, and this app adds
 * none for looks alone. */
fun Modifier.glass(shape: Shape): Modifier {
    val top = if (Palette.isDark) Color.White.copy(alpha = 0.06f) else Color.White.copy(alpha = 0.55f)
    return this
        .clip(shape)
        .background(Palette.surface.copy(alpha = if (Palette.isDark) 0.86f else 0.92f))
        .background(Brush.verticalGradient(listOf(top, Color.Transparent)))
        .border(1.dp, Brush.linearGradient(listOf(Palette.outline.copy(alpha = 0.45f), Palette.accent.copy(alpha = 0.35f))), shape)
}

/** A thin violet-to-cyan glow that breathes along the screen's edges while
 * the AI works, with a spark travelling along the top and bottom. Draws
 * nothing, and takes no touches, when [active] is false. */
@Composable
fun AiEdgeGlow(active: Boolean, modifier: Modifier = Modifier) {
    val presence by animateFloatAsState(if (active) 1f else 0f, tween(700), label = "edgeGlowIn")
    if (presence == 0f) return
    val still = effectsStill()
    val transition = rememberInfiniteTransition(label = "edgeGlow")
    val phase by transition.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(3200, easing = LinearEasing)),
        label = "edgeGlowPhase",
    )
    val accent = Palette.accent
    val glow = Palette.glow
    Canvas(modifier.fillMaxSize()) {
        val p = if (still) 0.25f else phase
        val breath = 0.6f + 0.4f * sin(p * 2f * PI.toFloat())
        val depth = 18.dp.toPx()
        val edge = accent.copy(alpha = 0.5f * presence * breath)
        val fade = Color.Transparent
        drawRect(Brush.verticalGradient(listOf(edge, fade), 0f, depth), size = Size(size.width, depth))
        drawRect(
            Brush.verticalGradient(listOf(fade, edge), size.height - depth, size.height),
            topLeft = Offset(0f, size.height - depth), size = Size(size.width, depth),
        )
        drawRect(Brush.horizontalGradient(listOf(edge, fade), 0f, depth), size = Size(depth, size.height))
        drawRect(
            Brush.horizontalGradient(listOf(fade, edge), size.width - depth, size.width),
            topLeft = Offset(size.width - depth, 0f), size = Size(depth, size.height),
        )
        val spark = depth * 3f
        val sparkColor = glow.copy(alpha = 0.55f * presence)
        val top = Offset(size.width * p, 0f)
        val bottom = Offset(size.width * (1f - p), size.height)
        drawCircle(Brush.radialGradient(listOf(sparkColor, fade), top, spark), spark, top)
        drawCircle(Brush.radialGradient(listOf(sparkColor, fade), bottom, spark), spark, bottom)
    }
}

// The aurora behind voice mode: two soft bands of light that drift and rise
// with the speaker's voice. AGSL on Android 13+; two drifting glows below.
private const val AURORA_AGSL = """
uniform float2 size;
uniform float time;
uniform float level;
layout(color) uniform half4 c1;
layout(color) uniform half4 c2;

half4 main(float2 p) {
    float2 uv = p / size;
    float lift = level * 0.12;
    float w1 = sin(uv.x * 3.1 + time * 0.55) * 0.08 + 0.62 - lift;
    float w2 = sin(uv.x * 5.3 - time * 0.42 + 1.3) * 0.06 + 0.70 - lift * 1.4;
    float a1 = (1.0 - smoothstep(0.0, 0.22, abs(uv.y - w1))) * (0.55 + level * 0.35);
    float a2 = (1.0 - smoothstep(0.0, 0.16, abs(uv.y - w2))) * (0.45 + level * 0.30);
    return c1 * a1 + c2 * a2;
}
"""

@RequiresApi(33)
private fun auroraShader(): Shader? = runCatching { RuntimeShader(AURORA_AGSL) }.getOrNull()

@RequiresApi(33)
private fun feedAurora(shader: Shader, width: Float, height: Float, time: Float, level: Float, c1: Color, c2: Color) {
    val runtime = shader as RuntimeShader
    runtime.setFloatUniform("size", width, height)
    runtime.setFloatUniform("time", time)
    runtime.setFloatUniform("level", level)
    runtime.setColorUniform("c1", c1.toArgb())
    runtime.setColorUniform("c2", c2.toArgb())
}

/** The voice-mode aurora; [level] is the microphone level, 0..1. A shader
 * that fails to compile on some phone falls back to the gradients instead
 * of taking voice mode down with it. */
@Composable
fun VoiceAurora(level: Float, modifier: Modifier = Modifier) {
    val still = effectsStill()
    val shader = remember { if (Build.VERSION.SDK_INT >= 33) auroraShader() else null }
    val transition = rememberInfiniteTransition(label = "aurora")
    val time by transition.animateFloat(
        0f, 120f,
        infiniteRepeatable(tween(120_000, easing = LinearEasing)),
        label = "auroraTime",
    )
    val accent = Palette.accent
    val glow = Palette.glow
    val clamped = level.coerceIn(0f, 1f)
    Canvas(modifier.fillMaxSize()) {
        val t = if (still) 0f else time
        if (shader != null && Build.VERSION.SDK_INT >= 33) {
            feedAurora(shader, size.width, size.height, t, clamped, accent, glow)
            drawRect(ShaderBrush(shader))
        } else {
            val drift = sin(t * 0.5f) * size.width * 0.15f
            val radius = size.minDimension * (0.55f + clamped * 0.15f)
            val c1 = Offset(size.width * 0.35f + drift, size.height * 0.62f)
            val c2 = Offset(size.width * 0.65f - drift, size.height * 0.72f)
            drawCircle(Brush.radialGradient(listOf(accent.copy(alpha = 0.35f + clamped * 0.2f), Color.Transparent), c1, radius), radius, c1)
            drawCircle(Brush.radialGradient(listOf(glow.copy(alpha = 0.25f + clamped * 0.2f), Color.Transparent), c2, radius * 0.8f), radius * 0.8f, c2)
        }
    }
}
