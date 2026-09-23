package com.neura.os.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.neura.os.app.data.PLAN_MAP_MAX
import com.neura.os.app.data.TaskItem
import com.neura.os.app.data.mapLabel
import com.neura.os.app.data.planMapNodes
import com.neura.os.app.data.radialPositions

/** Plan -> diagram (master plan Phase 4): the chat's task list as a radial
 * map, read-only. Node positions come from data/PlanLayout.kt. */
@Composable
fun PlanMapDialog(tasks: List<TaskItem>, onClose: () -> Unit) {
    val done = tasks.count { it.status == "done" }
    Dialog(onDismissRequest = onClose) {
        Surface(color = Palette.surface, shape = RoundedCornerShape(16.dp)) {
            Column(Modifier.padding(16.dp)) {
                Text("Plan map", color = Palette.text, style = MaterialTheme.typography.titleMedium)
                Text(
                    "$done of ${tasks.size} done" + (if (tasks.size > PLAN_MAP_MAX) " · first $PLAN_MAP_MAX shown" else ""),
                    color = Palette.muted, fontSize = 12.sp,
                )
                PlanMap(planMapNodes(tasks), Modifier.fillMaxWidth().aspectRatio(1f).padding(vertical = 12.dp))
                TextButton(onClose) { Text("Close") }
            }
        }
    }
}

private fun statusColor(status: String): Color = when (status) {
    "done" -> Palette.success
    "doing" -> Palette.text
    else -> Palette.muted
}

@Composable
private fun PlanMap(nodes: List<TaskItem>, modifier: Modifier) {
    val points = radialPositions(nodes.size)
    BoxWithConstraints(modifier) {
        val side = if (maxWidth < maxHeight) maxWidth else maxHeight
        val radius = side * 0.34f
        val centerX = maxWidth / 2
        val centerY = maxHeight / 2
        Canvas(Modifier.fillMaxSize()) {
            val center = Offset(size.width / 2, size.height / 2)
            val ring = minOf(size.width, size.height) * 0.34f
            points.forEachIndexed { index, (x, y) ->
                val at = Offset(center.x + ring * x.toFloat(), center.y + ring * y.toFloat())
                drawLine(Palette.surfaceHigh, center, at, strokeWidth = 2.dp.toPx())
                drawCircle(statusColor(nodes[index].status), radius = 7.dp.toPx(), center = at)
            }
            drawCircle(Palette.accent, radius = 10.dp.toPx(), center = center)
        }
        points.forEachIndexed { index, (x, y) ->
            val task = nodes[index]
            Text(
                mapLabel(task.title),
                color = if (task.status == "done") Palette.muted else Palette.text,
                fontSize = 10.sp,
                lineHeight = 12.sp,
                textAlign = TextAlign.Center,
                maxLines = 2,
                modifier = Modifier
                    .offset(x = centerX + radius * x.toFloat() - 44.dp, y = centerY + radius * y.toFloat() + 9.dp)
                    .width(88.dp),
            )
        }
    }
}
