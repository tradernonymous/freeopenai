package com.neura.os.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.sp

/**
 * Provider status dashboard showing the health and configuration
 * of all image generation providers.
 */
data class ProviderInfo(
    val name: String,
    val isAvailable: Boolean,
    val requiresKey: Boolean,
    val hasKey: Boolean,
    val isFree: Boolean,
    val speed: String = "",
    val error: String? = null,
)

@Composable
fun ProviderStatusDashboard(
    providers: List<ProviderInfo>,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Palette.surfaceHigh)
            .clickable { expanded = !expanded }
            .padding(12.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val activeCount = providers.count { it.isAvailable }
                Text(
                    text = "Providers",
                    color = Palette.text,
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "$activeCount/${providers.size} active",
                    color = if (activeCount > 0) Palette.green else Palette.red,
                    fontSize = 11.sp,
                )
            }
            Icon(
                imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                tint = Palette.muted,
                modifier = Modifier.size(18.dp),
            )
        }

        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier.padding(top = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (provider in providers) {
                    ProviderRow(provider)
                }
            }
        }
    }
}

@Composable
private fun ProviderRow(provider: ProviderInfo) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Palette.surface)
            .padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Status indicator
        Icon(
            imageVector = if (provider.isAvailable) Icons.Default.CheckCircle else Icons.Default.Error,
            contentDescription = null,
            tint = if (provider.isAvailable) Palette.green else Palette.red,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(8.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = provider.name,
                color = Palette.text,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
            )
            if (provider.error != null) {
                Text(
                    text = provider.error,
                    color = Palette.red,
                    fontSize = 10.sp,
                )
            } else if (!provider.isAvailable && provider.requiresKey && !provider.hasKey) {
                Text(
                    text = "API key required",
                    color = Palette.amber,
                    fontSize = 10.sp,
                )
            }
        }

        // Badges
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (provider.isFree) {
                Badge("FREE", Palette.green)
            }
            if (provider.speed.isNotEmpty()) {
                Badge(provider.speed, Palette.violet)
            }
            if (provider.requiresKey) {
                Icon(
                    Icons.Default.Key,
                    contentDescription = "Requires API key",
                    tint = Palette.muted,
                    modifier = Modifier.size(12.dp),
                )
            }
        }
    }
}

@Composable
private fun Badge(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text = text,
        color = color,
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

/**
 * Quick model selector with capability tags.
 */
data class ModelOption(
    val id: String,
    val displayName: String,
    val supportsVision: Boolean,
    val supportsTools: Boolean,
    val isFree: Boolean,
    val provider: String,
)

@Composable
fun ModelSelector(
    models: List<ModelOption>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }

    Column(modifier = modifier.fillMaxWidth()) {
        models.take(if (expanded) models.size else 4).forEach { model ->
            ModelOptionRow(
                model = model,
                isSelected = model.id == selected,
                onClick = { onSelect(model.id) },
            )
        }
        if (models.size > 4) {
            Text(
                text = if (expanded) "Show less" else "Show all ${models.size} models",
                color = Palette.green,
                fontSize = 12.sp,
                modifier = Modifier
                    .clickable { expanded = !expanded }
                    .padding(vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun ModelOptionRow(
    model: ModelOption,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (isSelected) Palette.green.copy(alpha = 0.1f) else Palette.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = model.displayName,
                color = if (isSelected) Palette.green else Palette.text,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (model.supportsVision) Badge("👁 Vision", Palette.violet)
                if (model.supportsTools) Badge("🔧 Tools", Palette.amber)
                if (model.isFree) Badge("FREE", Palette.green)
            }
        }
        if (isSelected) {
            Icon(
                Icons.Default.CheckCircle,
                contentDescription = "Selected",
                tint = Palette.green,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}
