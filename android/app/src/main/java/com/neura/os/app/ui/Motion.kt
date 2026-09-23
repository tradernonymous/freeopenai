package com.neura.os.app.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Motion used across the app. Durations stay short (120-400 ms) so the app
// feels alive without making anyone wait for an animation.

/** One place to trigger a tap: `haptics(HapticFeedbackType.LongPress)` instead
 * of reading LocalHapticFeedback.current at every call site. */
@Composable
fun rememberHaptics(): (HapticFeedbackType) -> Unit {
    val haptics = LocalHapticFeedback.current
    return remember(haptics) { { type: HapticFeedbackType -> haptics.performHapticFeedback(type) } }
}

/** Shrinks slightly while pressed and springs back: tactile buttons. */
fun Modifier.pressScale(pressed: Float = 0.92f): Modifier = composed {
    var down by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        if (down) pressed else 1f,
        spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium),
        label = "press",
    )
    this
        .pointerInput(Unit) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false)
                down = true
                waitForUpOrCancellation()
                down = false
            }
        }
        .scale(scale)
}

/** Fades and lifts content in once, the first time it is composed. */
fun Modifier.enterUp(delayMs: Int = 0, distance: Dp = 14.dp): Modifier = composed {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        // A spring (rebrand plan §3.4) settles by physics rather than a fixed
        // duration, so content arrives with the same feel everywhere.
        if (delayMs > 0) kotlinx.coroutines.delay(delayMs.toLong())
        progress.animateTo(1f, spring(dampingRatio = NeuraTokens.SPRING_DAMPING, stiffness = NeuraTokens.SPRING_STIFFNESS))
    }
    val lift = distance.value
    this.graphicsLayer {
        alpha = progress.value
        translationY = (1f - progress.value) * lift * density
    }
}

/** A moving highlight for placeholders while something loads. */
fun Modifier.shimmer(): Modifier = composed {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val x by transition.animateFloat(
        -1f, 2f,
        infiniteRepeatable(tween(1300, easing = LinearEasing)),
        label = "shimmerX",
    )
    this
        .background(Palette.surfaceHigh)
        .drawWithContent {
            drawContent()
            val width = size.width
            drawRect(
                Brush.linearGradient(
                    listOf(Color.Transparent, Color.White.copy(alpha = 0.08f), Color.Transparent),
                    start = Offset(width * x - width / 2, 0f),
                    end = Offset(width * x + width / 2, size.height),
                )
            )
        }
}

/** True when the person turned animations off (Developer options or
 * Accessibility -> Remove animations): motion then holds still. */
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}

/** The NeuraOS pulse (rebrand plan §3.4): the one mark that means "the AI is
 * working" -- thinking, streaming, running a tool. A violet core breathes
 * while a ring fires outward and fades into the AI-activity cyan, like a node
 * of the emblem lighting up. Held still when animations are off. */
@Composable
fun NeuraPulse(size: Dp = 18.dp) {
    val still = rememberReducedMotion()
    val transition = rememberInfiniteTransition(label = "pulse")
    val phase by transition.animateFloat(
        0f, 1f,
        infiniteRepeatable(tween(NeuraTokens.PULSE_MS, easing = LinearEasing)),
        label = "pulsePhase",
    )
    val accent = Palette.accent
    val glow = Palette.glow
    Canvas(Modifier.size(size).semantics { contentDescription = "Working" }) {
        val radius = this.size.minDimension / 2
        val p = if (still) 0.4f else phase
        drawCircle(
            glow.copy(alpha = (1f - p) * 0.7f),
            radius = radius * (0.45f + 0.5f * p),
            style = Stroke(width = radius * 0.16f),
        )
        val breath = 0.85f + 0.15f * kotlin.math.sin(p * 2f * kotlin.math.PI.toFloat())
        drawCircle(
            Brush.linearGradient(listOf(accent, glow), start = Offset(0f, this.size.height), end = Offset(this.size.width, 0f)),
            radius = radius * 0.42f * breath,
        )
    }
}

/** Three dots that pulse in turn: something small is loading. The AI's own
 * work uses [NeuraPulse]. */
@Composable
fun TypingDots(color: Color = Palette.muted, dot: Dp = 7.dp) {
    val transition = rememberInfiniteTransition(label = "dots")
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(3) { index ->
            val phase by transition.animateFloat(
                0.25f, 1f,
                infiniteRepeatable(tween(520, delayMillis = index * 160, easing = FastOutSlowInEasing), RepeatMode.Reverse),
                label = "dot$index",
            )
            Box(
                Modifier.size(dot)
                    .graphicsLayer { scaleX = 0.7f + phase * 0.3f; scaleY = 0.7f + phase * 0.3f }
                    .alpha(phase)
                    .background(color, CircleShape)
            )
        }
    }
}

/** A breathing circle that swells with [level] (0..1): the voice mode orb. */
@Composable
fun VoiceOrb(level: Float, listening: Boolean, speaking: Boolean, size: Dp = 180.dp) {
    val transition = rememberInfiniteTransition(label = "orb")
    val breath by transition.animateFloat(
        0.92f, 1.06f,
        infiniteRepeatable(tween(if (speaking) 600 else 1600, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "breath",
    )
    val spin by transition.animateFloat(0f, 360f, infiniteRepeatable(tween(6000, easing = LinearEasing)), label = "spin")
    val boost by animateFloatAsState(if (listening) 1f + level.coerceIn(0f, 1f) * 0.25f else 1f, tween(120), label = "boost")
    Canvas(Modifier.size(size).graphicsLayer { rotationZ = spin; scaleX = breath * boost; scaleY = breath * boost }) {
        val radius = this.size.minDimension / 2
        drawCircle(
            Brush.sweepGradient(listOf(Palette.accent, Palette.glow, Palette.accentDeep, Palette.accent)),
            radius = radius,
        )
        drawCircle(Brush.radialGradient(listOf(Color.White.copy(alpha = 0.35f), Color.Transparent)), radius = radius * 0.9f)
    }
}
