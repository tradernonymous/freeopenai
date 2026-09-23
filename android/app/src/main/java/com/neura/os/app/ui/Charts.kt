package com.neura.os.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.ChartSpec
import com.neura.os.app.data.ChartType
import com.neura.os.app.data.chartRange
import com.neura.os.app.data.chartX

/** Series colours: distinct on the app's dark surface, at most four. */
private val SERIES_COLORS = listOf(Color(0xFF3FB950), Color(0xFF58A6FF), Color(0xFFD29922), Color(0xFFF778BA))

/** One chart from a reply's ```chart block (master plan Phase 4), drawn in
 * Compose Canvas. The spec was already checked drawable by data/ChartSpec.kt. */
@Composable
fun ChartView(spec: ChartSpec) {
    val (low, high) = chartRange(spec)
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.code).padding(12.dp)) {
        if (spec.title.isNotBlank()) Text(spec.title, color = Palette.text, fontSize = 13.sp)
        Text(formatAxis(high), color = Palette.muted, fontSize = 10.sp)
        Canvas(Modifier.fillMaxWidth().height(180.dp).padding(vertical = 4.dp)) {
            val span = high - low
            fun y(value: Double): Float = (size.height * (1 - (value - low) / span)).toFloat()
            // Zero line, when zero is on the axis.
            if (low < 0 && high > 0) drawLine(Palette.surfaceHigh, Offset(0f, y(0.0)), Offset(size.width, y(0.0)), strokeWidth = 1.dp.toPx())
            val points = spec.labels.size
            when (spec.type) {
                ChartType.BAR -> {
                    val slot = size.width / points
                    val barWidth = slot * 0.8f / spec.series.size
                    spec.series.forEachIndexed { s, series ->
                        series.values.forEachIndexed { i, value ->
                            val top = y(maxOf(value, 0.0))
                            val bottom = y(minOf(value, 0.0))
                            drawRect(
                                SERIES_COLORS[s],
                                topLeft = Offset(i * slot + slot * 0.1f + s * barWidth, top),
                                size = Size(barWidth, maxOf(bottom - top, 1f)),
                            )
                        }
                    }
                }
                ChartType.LINE -> {
                    val step = if (points > 1) size.width / (points - 1) else 0f
                    spec.series.forEachIndexed { s, series ->
                        val path = Path()
                        series.values.forEachIndexed { i, value ->
                            val x = if (points > 1) i * step else size.width / 2
                            if (i == 0) path.moveTo(x, y(value)) else path.lineTo(x, y(value))
                        }
                        drawPath(path, SERIES_COLORS[s], style = Stroke(width = 2.dp.toPx()))
                    }
                }
                ChartType.SCATTER -> {
                    val xs = chartX(spec)
                    val xLow = xs.minOrNull() ?: 0.0
                    val xSpan = ((xs.maxOrNull() ?: 1.0) - xLow).takeIf { it > 0 } ?: 1.0
                    spec.series.forEachIndexed { s, series ->
                        series.values.forEachIndexed { i, value ->
                            val x = (size.width * (xs[i] - xLow) / xSpan).toFloat()
                            drawCircle(SERIES_COLORS[s], radius = 3.dp.toPx(), center = Offset(x, y(value)))
                        }
                    }
                }
            }
        }
        Text(formatAxis(low), color = Palette.muted, fontSize = 10.sp)
        Text(
            spec.labels.first() + if (spec.labels.size > 1) " … " + spec.labels.last() else "",
            color = Palette.muted, fontSize = 10.sp,
        )
        if (spec.series.size > 1 || spec.series.first().name.isNotBlank()) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 4.dp)) {
                spec.series.forEachIndexed { s, series ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).background(SERIES_COLORS[s]))
                        Text(" " + series.name, color = Palette.text, fontSize = 11.sp)
                    }
                }
            }
        }
    }
}

private fun formatAxis(value: Double): String =
    if (value == Math.rint(value) && kotlin.math.abs(value) < 1e12) value.toLong().toString() else "%.2f".format(value)
