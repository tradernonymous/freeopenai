package com.neura.os.app.ui
import com.neura.os.app.DeviceControlService

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.neura.os.app.data.DeviceControlService

/**
 * Device Automation screen — PhoneClaw-style automation.
 *
 * Features:
 *   - Natural language automation builder ("open Twitter and like every post")
 *   - Pre-built automation templates
 *   - Automation history and scheduling
 *   - One-tap execution with accessibility service integration
 *
 * Uses the existing DeviceControlService for accessibility-based control,
 * enhanced with vision-assisted targeting and ClawScript-like scripting.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AutomationScreen(
    vm: AppViewModel,
    onRunAutomation: (String) -> Unit = {},
) {
    var showBuilder by remember { mutableStateOf(false) }
    var automationPrompt by remember { mutableStateOf("") }
    val isDeviceControlEnabled = DeviceControlService.instance != null

    Column(modifier = Modifier.fillMaxSize().background(Palette.background)) {
        TopAppBar(
            title = { Text("Automate", color = Palette.text) },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = Palette.surface,
                titleContentColor = Palette.text,
            ),
            actions = {
                IconButton(onClick = { showBuilder = true }) {
                    Icon(Icons.Default.Add, "New automation", tint = Palette.green)
                }
            },
        )

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Device control status
            item {
                DeviceStatusCard(isDeviceControlEnabled)
            }

            // Quick automations
            item {
                SectionHeader("Quick Automations")
            }

            items(quickAutomations) { automation ->
                AutomationCard(
                    title = automation.title,
                    description = automation.description,
                    icon = automation.icon,
                    enabled = isDeviceControlEnabled,
                    onClick = { onRunAutomation(automation.prompt) },
                )
            }

            // History
            item {
                Spacer(Modifier.height(8.dp))
                SectionHeader("Recent Automations")
            }

            items(automationHistory) { entry ->
                HistoryCard(
                    prompt = entry.first,
                    status = entry.second,
                    onClick = { onRunAutomation(entry.first) },
                )
            }

            item { Spacer(Modifier.height(16.dp)) }
        }
    }

    if (showBuilder) {
        AlertDialog(
            onDismissRequest = { showBuilder = false },
            title = { Text("Build Automation", color = Palette.text) },
            text = {
                Column {
                    Text(
                        text = "Describe what you want automated in natural language.",
                        color = Palette.muted,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = automationPrompt,
                        onValueChange = { automationPrompt = it },
                        placeholder = { Text("Open Instagram and like the 5 most recent posts", color = Palette.muted) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Palette.green,
                            unfocusedBorderColor = Palette.outline,
                            focusedTextColor = Palette.text,
                            unfocusedTextColor = Palette.text,
                        ),
                        minLines = 3,
                    )
                    Spacer(Modifier.height(8.dp))
                    if (!isDeviceControlEnabled) {
                        Text(
                            text = "⚠️ Device control must be enabled in Settings to run automations.",
                            color = Palette.amber,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (automationPrompt.isNotBlank()) {
                            onRunAutomation(automationPrompt)
                            showBuilder = false
                            automationPrompt = ""
                        }
                    },
                    enabled = automationPrompt.isNotBlank() && isDeviceControlEnabled,
                ) {
                    Text("Run", color = Palette.green)
                }
            },
            dismissButton = {
                TextButton(onClick = { showBuilder = false }) {
                    Text("Cancel", color = Palette.muted)
                }
            },
            containerColor = Palette.surface,
        )
    }
}

@Composable
private fun DeviceStatusCard(enabled: Boolean) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Palette.surfaceHigh)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(if (enabled) Palette.green else Palette.red),
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = if (enabled) "Device Control Active" else "Device Control Off",
                color = Palette.text,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = if (enabled) "Accessibility service is running" else "Enable in Settings > Accessibility",
                color = Palette.muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        color = Palette.muted,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun AutomationCard(
    title: String,
    description: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Palette.surfaceHigh)
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (enabled) Palette.green else Palette.muted,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = title, color = Palette.text, fontWeight = FontWeight.Medium)
            Text(text = description, color = Palette.muted, style = MaterialTheme.typography.bodySmall)
        }
        if (enabled) {
            Icon(
                imageVector = Icons.Default.PlayArrow,
                contentDescription = "Run",
                tint = Palette.green,
            )
        }
    }
}

@Composable
private fun HistoryCard(prompt: String, status: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.surface)
            .clickable(onClick = onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Default.History,
            contentDescription = null,
            tint = Palette.muted,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = prompt, color = Palette.text, style = MaterialTheme.typography.bodySmall)
            Text(text = status, color = Palette.muted, style = MaterialTheme.typography.labelSmall)
        }
    }
}

// --- Data ------------------------------------------------------------------

private data class QuickAutomation(
    val title: String,
    val description: String,
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
    val prompt: String,
)

private val quickAutomations = listOf(
    QuickAutomation(
        title = "Read Screen",
        description = "Get a description of what's currently visible",
        icon = Icons.Default.SmartToy,
        prompt = "Take a snapshot of what's on screen and describe it",
    ),
    QuickAutomation(
        title = "Scroll Down",
        description = "Scroll the current page down",
        icon = Icons.Default.PlayArrow,
        prompt = "Scroll down on the current screen",
    ),
    QuickAutomation(
        title = "Scheduled Task",
        description = "Set up a recurring automation",
        icon = Icons.Default.Schedule,
        prompt = "I want to schedule a recurring automation",
    ),
)

private val automationHistory = listOf(
    "Opened Twitter and liked 3 posts" to "✅ Completed 2 hours ago",
    "Scrolled through Instagram feed" to "✅ Completed yesterday",
    "Read SMS for verification code" to "✅ Completed yesterday",
)
