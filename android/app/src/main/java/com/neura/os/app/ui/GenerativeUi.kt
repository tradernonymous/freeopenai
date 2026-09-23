package com.neura.os.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.neura.os.app.data.FieldKind
import com.neura.os.app.data.UiField
import com.neura.os.app.data.UiSpec
import com.neura.os.app.data.formAnswer

// Generative UI (docs/android-master-plan.md V8): a reply's ```ui block drawn
// with the app's own components. [onAnswer] is present only on the latest
// reply; older ones stay visible but read-only, so an old form cannot send
// an answer to a question nobody is asking any more. Every answer is an
// ordinary message, visible in the chat like one typed by hand.

@Composable
fun UiBlock(spec: UiSpec, onAnswer: ((String) -> Unit)?) {
    Column(
        Modifier.fillMaxWidth().glass(RoundedCornerShape(18.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        when (spec) {
            is UiSpec.Choices -> Choices(spec, onAnswer)
            is UiSpec.Form -> Form(spec, onAnswer)
            is UiSpec.Table -> Table(spec)
            is UiSpec.Card -> Card(spec, onAnswer)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Options(options: List<String>, onAnswer: ((String) -> Unit)?) {
    var chosen by remember(options) { mutableStateOf<String?>(null) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEachIndexed { index, option ->
            val picked = chosen == option
            Text(
                option,
                color = if (picked) Palette.onAccent else Palette.text,
                fontSize = 14.sp,
                modifier = Modifier.enterUp(index * 40).pressScale(0.95f).clip(RoundedCornerShape(18.dp))
                    .background(if (picked) Palette.accent else Palette.surfaceHigh)
                    .border(1.dp, Palette.accent.copy(alpha = if (onAnswer != null) 0.45f else 0.15f), RoundedCornerShape(18.dp))
                    .clickable(enabled = onAnswer != null && chosen == null) {
                        chosen = option
                        onAnswer?.invoke(option)
                    }
                    .padding(horizontal = 14.dp, vertical = 9.dp),
            )
        }
    }
}

@Composable
private fun Choices(spec: UiSpec.Choices, onAnswer: ((String) -> Unit)?) {
    if (spec.prompt.isNotEmpty()) Text(spec.prompt, color = Palette.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    Options(spec.options, onAnswer)
}

@Composable
private fun Form(spec: UiSpec.Form, onAnswer: ((String) -> Unit)?) {
    val values = remember(spec) { mutableStateMapOf<String, String>() }
    var error by remember(spec) { mutableStateOf<String?>(null) }
    var sent by remember(spec) { mutableStateOf(false) }
    if (spec.title.isNotEmpty()) Text(spec.title, color = Palette.text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
    spec.fields.forEach { field -> FormField(field, values[field.id].orEmpty(), enabled = onAnswer != null && !sent) { values[field.id] = it; error = null } }
    error?.let { Text(it, color = Palette.red, fontSize = 12.sp) }
    Text(
        if (sent) "Sent" else spec.submit,
        color = if (onAnswer != null && !sent) Palette.onAccent else Palette.muted,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.pressScale(0.96f).clip(RoundedCornerShape(20.dp))
            .background(if (onAnswer != null && !sent) Palette.accent else Palette.surfaceHigh)
            .clickable(enabled = onAnswer != null && !sent) {
                formAnswer(spec, values)
                    .onSuccess { answer ->
                        sent = true
                        onAnswer?.invoke(answer)
                    }
                    .onFailure { error = it.message }
            }
            .padding(horizontal = 18.dp, vertical = 10.dp),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FormField(field: UiField, value: String, enabled: Boolean, onChange: (String) -> Unit) {
    if (field.kind == FieldKind.SELECT) {
        Text(field.label + if (field.required) " *" else "", color = Palette.muted, fontSize = 12.sp)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            field.options.forEach { option ->
                val on = value == option
                Text(
                    option, color = if (on) Palette.onAccent else Palette.text, fontSize = 13.sp,
                    modifier = Modifier.clip(RoundedCornerShape(14.dp)).background(if (on) Palette.accent else Palette.surfaceHigh)
                        .clickable(enabled = enabled) { onChange(option) }.padding(horizontal = 12.dp, vertical = 7.dp),
                )
            }
        }
        return
    }
    val hint = when (field.kind) {
        FieldKind.DATE -> "YYYY-MM-DD"
        FieldKind.TIME -> "HH:MM"
        else -> ""
    }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        enabled = enabled,
        singleLine = true,
        label = { Text(field.label + if (field.required) " *" else "") },
        placeholder = { if (hint.isNotEmpty()) Text(hint, color = Palette.muted) },
        keyboardOptions = KeyboardOptions(
            keyboardType = when (field.kind) {
                FieldKind.NUMBER -> KeyboardType.Decimal
                FieldKind.DATE, FieldKind.TIME -> KeyboardType.Number
                else -> KeyboardType.Text
            },
        ),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Palette.accent,
            unfocusedBorderColor = Palette.outline,
            focusedTextColor = Palette.text,
            unfocusedTextColor = Palette.text,
        ),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Table(spec: UiSpec.Table) {
    Column(Modifier.horizontalScroll(rememberScrollState())) {
        Row(Modifier.clip(RoundedCornerShape(8.dp)).background(Palette.accentTint)) {
            spec.columns.forEach { column ->
                Text(column, color = Palette.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.width(128.dp).padding(8.dp))
            }
        }
        spec.rows.forEachIndexed { index, row ->
            Row(Modifier.background(if (index % 2 == 1) Palette.surfaceHigh.copy(alpha = 0.5f) else androidx.compose.ui.graphics.Color.Transparent)) {
                row.forEach { cell ->
                    Text(cell, color = Palette.text, fontSize = 13.sp, modifier = Modifier.width(128.dp).padding(8.dp))
                }
            }
        }
    }
}

@Composable
private fun Card(spec: UiSpec.Card, onAnswer: ((String) -> Unit)?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Spacer(Modifier.width(3.dp).height(20.dp).background(Palette.accent))
        Spacer(Modifier.width(10.dp))
        Text(spec.title, color = Palette.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
    if (spec.body.isNotEmpty()) Text(spec.body, color = Palette.text, fontSize = 14.sp)
    if (spec.actions.isNotEmpty()) Options(spec.actions, onAnswer)
}
