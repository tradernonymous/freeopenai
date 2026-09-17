package com.freeai4u.app.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Photo
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.freeai4u.app.data.GeneratedImage
import com.freeai4u.app.data.IMAGE_GENERATE_MODELS
import com.freeai4u.app.data.IMAGE_SIZES
import com.freeai4u.app.data.CHAT_COMMANDS
import com.freeai4u.app.data.Persona
import com.freeai4u.app.data.PromptTemplate
import com.freeai4u.app.data.Skill
import com.freeai4u.app.data.allPersonas
import com.freeai4u.app.data.allPrompts
import com.freeai4u.app.data.imageModelsFor
import com.freeai4u.app.data.imageSizeById
import java.util.UUID

/** A full page over the chat, with a back arrow. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Page(title: String, vm: AppViewModel, content: @Composable () -> Unit) {
    Scaffold(
        containerColor = Palette.background,
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = { IconButton({ vm.back() }, Modifier.pressScale()) { Icon(Icons.Filled.ArrowBack, "Back") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
            )
        },
    ) { padding -> Box(Modifier.padding(padding).fillMaxSize()) { content() } }
}

// --- Image studio -----------------------------------------------------------------

private val IMAGE_STYLES = listOf(
    "None" to "",
    "Photo" to ", photorealistic, natural lighting, 50mm lens, high detail",
    "Anime" to ", anime style, clean line art, vibrant colors",
    "3D" to ", 3D render, soft studio lighting, octane render",
    "Watercolor" to ", watercolor painting, soft edges, paper texture",
    "Logo" to ", minimal flat vector logo, simple shapes, white background",
    "Cinematic" to ", cinematic still, dramatic lighting, shallow depth of field",
)

/** Adds detail to a short idea without calling a model: subject + quality
 * words. The chat's Image prompt template does the model-written version. */
fun enhancePrompt(prompt: String): String {
    val base = prompt.trim().trimEnd('.')
    if (base.isEmpty()) return base
    if (base.contains("detailed", true) || base.length > 160) return base
    return "$base, highly detailed, sharp focus, balanced composition, beautiful lighting"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImageStudioScreen(vm: AppViewModel, platform: Platform) {
    var prompt by rememberSaveable { mutableStateOf("") }
    var style by rememberSaveable { mutableStateOf("None") }
    var sizeId by rememberSaveable { mutableStateOf("") }
    var model by rememberSaveable { mutableStateOf(IMAGE_GENERATE_MODELS.first()) }
    var source by remember { mutableStateOf<String?>(null) }
    var viewing by remember { mutableStateOf<GeneratedImage?>(null) }
    val editing = source != null
    val models = imageModelsFor(editing)
    LaunchedEffect(editing) { if (model !in models) model = models.first() }
    val size = imageSizeById(sizeId)

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp)) {
            OutlinedTextField(
                prompt, { prompt = it },
                placeholder = { Text(if (editing) "Describe the change" else "Describe an image") },
                modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp),
                maxLines = 4,
            )
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                IMAGE_STYLES.forEach { (name, _) -> FilterChip(style == name, { style = name }, label = { Text(name) }) }
            }
            Text(if (editing) "Edit a photo" else "Shape", color = Palette.muted, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (editing) {
                    source?.let { DataUrlThumb(it, 40) }
                    AssistChip(
                        { platform.pickPhotos { picked -> picked.firstOrNull()?.let { source = it } } },
                        label = { Text("Change") },
                        leadingIcon = { Icon(Icons.Filled.Photo, null, Modifier.size(16.dp)) },
                    )
                    AssistChip(
                        { source = null },
                        label = { Text("Start fresh") },
                        leadingIcon = { Icon(Icons.Filled.Close, null, Modifier.size(16.dp)) },
                    )
                } else {
                    IMAGE_SIZES.forEach { option ->
                        FilterChip(sizeId == option.id, { sizeId = if (sizeId == option.id) "" else option.id }, label = { Text(option.label) })
                    }
                    AssistChip(
                        { platform.pickPhotos { picked -> picked.firstOrNull()?.let { source = it } } },
                        label = { Text("Edit a photo") },
                        leadingIcon = { Icon(Icons.Filled.Photo, null, Modifier.size(16.dp)) },
                    )
                }
            }
            Text("Model", color = Palette.muted, fontSize = 12.sp)
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                models.forEach { id -> FilterChip(model == id, { model = id }, label = { Text(shortModel(id)) }) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton({ prompt = enhancePrompt(prompt) }, enabled = prompt.isNotBlank()) {
                    Icon(Icons.Filled.AutoAwesome, null)
                    Spacer(Modifier.size(6.dp))
                    Text("Enhance")
                }
                Spacer(Modifier.size(8.dp))
                Button(
                    {
                        val full = prompt + (IMAGE_STYLES.firstOrNull { it.first == style }?.second ?: "")
                        vm.generateImage(full, size, model, provider = "", editSource = source)
                    },
                    enabled = prompt.isNotBlank() && !vm.imageBusy,
                ) { Text(if (vm.imageBusy) "Working…" else if (editing) "Edit" else "Generate") }
                if (vm.imageBusy) {
                    Spacer(Modifier.size(12.dp))
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                }
            }
            vm.imageError?.let { Text(it, color = Palette.red, modifier = Modifier.padding(top = 6.dp)) }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                Text(if (vm.puterImages) "Puter draws first" else "Free server images", color = Palette.muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
                TextButton({ vm.signInToPuter() }, enabled = !vm.puterSigningIn, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                    Text(if (vm.puterSigningIn) "Signing in…" else "Sign in", fontSize = 12.sp)
                }
                Text("Puter", color = Palette.muted, fontSize = 12.sp)
                Switch(vm.puterImages, { vm.puterImages = it }, Modifier.padding(start = 6.dp).scale(0.8f))
            }
        }
        if (vm.library.images.isEmpty()) {
            EmptyState("No images yet", "Saved encrypted on this phone.")
        } else {
            LazyVerticalGrid(GridCells.Fixed(2), contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.library.images, key = { it.id }) { image ->
                    StoredImage(vm, image, Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(14.dp)).clickable { viewing = image }.enterUp())
                }
            }
        }
    }
    viewing?.let { image ->
        var bytes by remember(image.id) { mutableStateOf<ByteArray?>(null) }
        LaunchedEffect(image.id) { vm.loadImage(image.id) { bytes = it } }
        val name = "freeai4u-" + image.id.take(8) + if (image.mime.contains("png")) ".png" else ".jpg"
        AlertDialog(
            onDismissRequest = { viewing = null },
            title = { Text(image.prompt, maxLines = 3, overflow = TextOverflow.Ellipsis, fontSize = 14.sp) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    StoredImage(vm, image, Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(12.dp)).clickable { bytes?.let { platform.viewImage(image.id, it, image.mime) } })
                    Text("by " + image.provider.ifEmpty { "server" } + if (image.mime.isNotEmpty()) " · " + image.mime.substringAfter('/') else "", color = Palette.muted, fontSize = 12.sp)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({ bytes?.let { platform.saveImage(name, image.mime, it) } }, enabled = bytes != null, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Filled.Download, null, Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Save")
                        }
                        OutlinedButton({ bytes?.let { platform.shareImage(name, image.mime, it) } }, enabled = bytes != null, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Filled.Share, null, Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Share")
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            { prompt = image.prompt; sizeId = ""; viewing = null; vm.generateImage(image.prompt, null, model, provider = "") },
                            modifier = Modifier.weight(1f),
                        ) {
                            Icon(Icons.Filled.Refresh, null, Modifier.size(18.dp))
                            Spacer(Modifier.size(8.dp))
                            Text("Again")
                        }
                        OutlinedButton({ source = null; viewing = null; vm.deleteImage(image.id) }, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Filled.Delete, null, Modifier.size(18.dp), tint = Palette.red)
                            Spacer(Modifier.size(8.dp))
                            Text("Delete", color = Palette.red)
                        }
                    }
                }
            },
            confirmButton = { TextButton({ viewing = null }) { Text("Close") } },
        )
    }
}


@Composable
private fun StoredImage(vm: AppViewModel, image: GeneratedImage, modifier: Modifier) {
    var bitmap by remember(image.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(image.id) {
        vm.loadBitmap(image.id) { _, decoded -> bitmap = decoded }
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        val current = bitmap
        if (current == null) Box(Modifier.fillMaxSize().shimmer())
        else Image(current, image.prompt, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

// --- Tools ------------------------------------------------------------------------

private data class QuickTool(val emoji: String, val title: String, val personaId: String, val prompt: String, val mode: String = "chat")

private val QUICK_TOOLS = listOf(
    QuickTool("🌐", "Translate", "translator", ""),
    QuickTool("🔗", "Summarize link", "summarizer", "Read and summarize this page: "),
    QuickTool("✅", "Fix grammar", "writer", "Fix the grammar and spelling, keep my tone:\n\n"),
    QuickTool("💻", "Explain code", "coder", "Explain this code step by step:\n\n"),
    QuickTool("✍️", "Rewrite", "writer", "Rewrite this to be clearer and more engaging:\n\n"),
    QuickTool("📧", "Reply", "writer", "Write a polite, short reply to this message:\n\n"),
)

// Plan mode answers with a step-by-step plan rather than touching any file
// (see modeInstructions("plan") in Agent.kt) -- changes only happen after a
// separate tap on "Build remotely" -- so these ask for a plan, the same shape
// the built-in "Make a plan" prompt template already uses, rather than
// phrasing like a command Plan mode was never going to carry out itself.
private val PLAN_TEMPLATES = listOf(
    QuickTool("🐛", "Plan a bug fix", "coder", "Make a plan to fix this bug: ", mode = "plan"),
    QuickTool("➕", "Plan a feature", "coder", "Make a plan to add this feature: ", mode = "plan"),
    QuickTool("🧪", "Plan test coverage", "coder", "Make a plan to add tests for: ", mode = "plan"),
    QuickTool("🧹", "Plan a refactor", "coder", "Make a plan to refactor this, same behavior: ", mode = "plan"),
    QuickTool("🔍", "Plan a code review", "coder", "Make a plan to review the latest changes for bugs and cleanups: ", mode = "plan"),
)

@Composable
fun ToolsScreen(vm: AppViewModel) {
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { SectionTitle("Quick tools") }
        items(QUICK_TOOLS) { tool ->
            ToolCard(tool.emoji, tool.title, null) { vm.newChat(tool.personaId, tool.prompt) }
        }
        item { SectionTitle("Plan templates") }
        items(PLAN_TEMPLATES) { tool ->
            ToolCard(tool.emoji, tool.title, null) { vm.newChat(tool.personaId, tool.prompt, tool.mode) }
        }
        item { SectionTitle("Library") }
        item { ToolCard("🧩", "Knowledges", "Skills, personas, prompts and gallery") { vm.push(Screen.Knowledges) } }
        item { ToolCard("🎭", "Personas", "${allPersonas(vm.library).size}") { vm.push(Screen.Personas) } }
        item { ToolCard("📚", "Prompts", "${allPrompts(vm.library).size} · type / in chat") { vm.push(Screen.Prompts) } }
        item { SectionTitle("Server") }
        item {
            val waiting = vm.builds.waitingCount
            ToolCard("🛠️", "Builds", if (waiting > 0) "$waiting waiting for your approval" else "Plans carried out on the server") { vm.openBuilds() }
        }
        item { StatusCard(vm) }
        item { SectionTitle("More") }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, color = Palette.green, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun ToolCard(emoji: String, title: String, subtitle: String?, onClick: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Palette.surface),
        modifier = Modifier.fillMaxWidth().pressScale(0.97f).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(emoji, fontSize = 22.sp)
            Column(Modifier.padding(start = 12.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                if (subtitle != null) Text(subtitle, color = Palette.muted, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun StatusCard(vm: AppViewModel) {
    LaunchedEffect(Unit) { if (vm.healthText == null) vm.refreshHealth() }
    Card(colors = CardDefaults.cardColors(containerColor = Palette.surface), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("📡 Status", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                IconButton({ vm.refreshHealth(); vm.refreshCatalogue() }) { Icon(Icons.Filled.Refresh, "Refresh") }
            }
            Text(vm.healthText ?: "", color = if (vm.healthText?.startsWith("Online") == true) Palette.green else Palette.muted, fontSize = 13.sp)
            vm.catalogueError?.let { Text(it, color = Palette.red, fontSize = 13.sp) }
            HorizontalDivider(color = Palette.outline)
            Text("Tap Test to time a model", color = Palette.muted, fontSize = 12.sp)
            vm.providers.forEach { provider ->
                val model = vm.models[provider.id]?.firstOrNull()?.id
                LaunchedEffect(provider.id) { vm.loadModels(provider.id) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(provider.label)
                        Text(model ?: "Loading…", color = Palette.muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        vm.probes["${provider.id}/$model"]?.let {
                            Text(it, fontSize = 12.sp, color = if (it.startsWith("✓")) Palette.green else if (it.startsWith("✗")) Palette.red else Palette.muted)
                        }
                    }
                    TextButton({ if (model != null) vm.probe(provider.id, model) }, enabled = model != null) { Text("Test") }
                }
            }
        }
    }
}

// --- Settings -----------------------------------------------------------------------

@Composable
fun SettingsScreen(vm: AppViewModel, platform: Platform) {
    var lockOn by remember { mutableStateOf(platform.appLockOn()) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    // Seeded from the library each time it changes: the first composition can
    // run before the library is read from disk, and saving then wrote an empty
    // box over what was there.
    var instructions by remember(vm.library.instructions) { mutableStateOf(vm.library.instructions) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionTitle("Account")
        Text(vm.username.ifEmpty { "Signed out" }, style = MaterialTheme.typography.titleSmall)
        Text(vm.serverUrl, color = Palette.muted, fontSize = 12.sp)
        SectionTitle("Personalize")
        OutlinedTextField(
            instructions, { instructions = it.take(4000) },
            label = { Text("Custom instructions") },
            placeholder = { Text("About you, how to reply") },
            modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp),
        )
        AnimatedVisibility(instructions != vm.library.instructions) {
            TextButton({ vm.saveInstructions(instructions); vm.notice = "Saved" }) { Text("Save") }
        }
        // Read-only: the default is set with "Default" in a chat's model picker.
        SettingRow("Default model", shortModel(vm.library.defaultModel).ifEmpty { "Auto" }, onClick = null)
        Text("Change it from the model picker in any chat.", color = Palette.muted, fontSize = 12.sp, modifier = Modifier.padding(start = 14.dp))
        SectionTitle("Images")
        SettingSwitch("Puter images", "Your Puter account draws. Auto-off on failure or restart.", vm.puterImages) { vm.puterImages = it }
        SectionTitle("Server")
        LaunchedEffect(Unit) { if (vm.limits == null) vm.loadLimits() }
        SettingRow("Timeouts", vm.limits?.detail() ?: "Tap to load") { vm.loadLimits() }
        SettingRow("Retries", vm.limits?.let { it.maxAttempts.toString() + " × " + it.baseDelayMs + "ms" } ?: "—") { vm.loadLimits() }
        SectionTitle("Security")
        SettingSwitch("App lock", "Fingerprint or screen lock", lockOn) { wanted -> platform.setAppLock(wanted) { lockOn = it } }
        SectionTitle("Data")
        SettingRow("Delete all chats", null, danger = true) { confirmClear = true }
        SectionTitle("App")
        SettingRow("Check for updates", null) { platform.checkUpdates() }
        SettingRow("Copy crash log", null) { if (!platform.copyCrashLog()) vm.notice = "No crash recorded" }
        SettingRow("Version", platform.version, onClick = null)
        SettingRow("Sign out", null, danger = true) { confirmSignOut = true }
        Spacer(Modifier.height(32.dp))
    }
    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("Delete all chats?") },
            text = { Text("This cannot be undone.") },
            confirmButton = { TextButton({ vm.deleteAllChats(); confirmClear = false }) { Text("Delete", color = Palette.red) } },
            dismissButton = { TextButton({ confirmClear = false }) { Text("Cancel") } },
        )
    }
    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out") },
            text = { Text("Forgets the saved password. Keep or erase chats?") },
            confirmButton = {
                Column(horizontalAlignment = Alignment.End) {
                    TextButton({ vm.signOut(erase = false); confirmSignOut = false }) { Text("Keep chats") }
                    TextButton({ vm.signOut(erase = true); confirmSignOut = false }) { Text("Erase all", color = Palette.red) }
                }
            },
            dismissButton = { TextButton({ confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SettingRow(title: String, value: String?, danger: Boolean = false, onClick: (() -> Unit)?) {
    // A row with nothing to do shows no ripple, so it does not look tappable.
    val tap = if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.surface).then(tap).padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = if (danger) Palette.red else Palette.text, modifier = Modifier.weight(1f))
        if (value != null) Text(value, color = Palette.muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SettingSwitch(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.surface).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Palette.text)
            Text(subtitle, color = Palette.muted, fontSize = 12.sp)
        }
        Switch(checked, onChange, Modifier.semantics { contentDescription = title })
    }
}

// --- Library editors ------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonasScreen(vm: AppViewModel) {
    var editing by remember { mutableStateOf<Persona?>(null) }
    Scaffold(
        containerColor = Palette.background,
        topBar = {
            TopAppBar(
                title = { Text("Personas") },
                navigationIcon = { IconButton({ vm.back() }) { Icon(Icons.Filled.ArrowBack, "Back") } },
                actions = { TextButton({ editing = Persona(UUID.randomUUID().toString(), "", "🙂", "") }) { Text("New") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
            )
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(allPersonas(vm.library), key = { it.id }) { persona ->
                Card(colors = CardDefaults.cardColors(containerColor = Palette.surface), modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(persona.emoji, fontSize = 24.sp)
                        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                            Text(persona.name + if (persona.builtIn) "  · built-in" else "")
                            Text(persona.systemPrompt, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Palette.muted, fontSize = 12.sp)
                        }
                        TextButton({ vm.newChat(persona.id) }) { Text("Chat") }
                        if (!persona.builtIn) TextButton({ editing = persona }) { Text("Edit") }
                    }
                }
            }
        }
    }
    editing?.let { persona ->
        var name by remember(persona.id) { mutableStateOf(persona.name) }
        var emoji by remember(persona.id) { mutableStateOf(persona.emoji) }
        var system by remember(persona.id) { mutableStateOf(persona.systemPrompt) }
        val existing = vm.library.personas.any { it.id == persona.id }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(if (existing) "Edit persona" else "New persona") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row {
                        OutlinedTextField(emoji, { emoji = it.take(4) }, label = { Text("Icon") }, singleLine = true, modifier = Modifier.size(width = 80.dp, height = 64.dp))
                        Spacer(Modifier.size(8.dp))
                        OutlinedTextField(name, { name = it.take(40) }, label = { Text("Name") }, singleLine = true)
                    }
                    OutlinedTextField(system, { system = it }, label = { Text("Instructions (system prompt)") }, modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp))
                }
            },
            confirmButton = {
                TextButton({
                    if (name.isNotBlank()) vm.savePersona(persona.copy(name = name.trim(), emoji = emoji.ifBlank { "🙂" }, systemPrompt = system.trim()))
                    editing = null
                }) { Text("Save") }
            },
            dismissButton = {
                Row {
                    if (existing) TextButton({ vm.deletePersona(persona.id); editing = null }) { Text("Delete", color = Palette.red) }
                    TextButton({ editing = null }) { Text("Cancel") }
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromptsScreen(vm: AppViewModel) {
    var editing by remember { mutableStateOf<PromptTemplate?>(null) }
    Scaffold(
        containerColor = Palette.background,
        topBar = {
            TopAppBar(
                title = { Text("Prompt library") },
                navigationIcon = { IconButton({ vm.back() }) { Icon(Icons.Filled.ArrowBack, "Back") } },
                actions = { TextButton({ editing = PromptTemplate(UUID.randomUUID().toString(), "", "") }) { Text("New") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
            )
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(allPrompts(vm.library), key = { it.id }) { prompt ->
                Card(colors = CardDefaults.cardColors(containerColor = Palette.surface), modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("/" + prompt.title, color = Palette.green)
                            Text(prompt.text, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Palette.muted, fontSize = 12.sp)
                        }
                        TextButton({ vm.newChat(draft = prompt.text) }) { Text("Use") }
                        if (!prompt.builtIn) TextButton({ editing = prompt }) { Text("Edit") }
                    }
                }
            }
        }
    }
    editing?.let { prompt ->
        var title by remember(prompt.id) { mutableStateOf(prompt.title) }
        var text by remember(prompt.id) { mutableStateOf(prompt.text) }
        val existing = vm.library.prompts.any { it.id == prompt.id }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(if (existing) "Edit prompt" else "New prompt") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(title, { title = it.take(40) }, label = { Text("Name (typed after /)") }, singleLine = true)
                    OutlinedTextField(text, { text = it }, label = { Text("Prompt text") }, modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp))
                }
            },
            confirmButton = {
                TextButton({
                    if (title.isNotBlank() && text.isNotBlank()) vm.savePrompt(prompt.copy(title = title.trim(), text = text))
                    editing = null
                }) { Text("Save") }
            },
            dismissButton = {
                Row {
                    if (existing) TextButton({ vm.deletePrompt(prompt.id); editing = null }) { Text("Delete", color = Palette.red) }
                    TextButton({ editing = null }) { Text("Cancel") }
                }
            },
        )
    }
}

// --- Knowledges ---------------------------------------------------------------------

/** The hub the drawer opens: everything that teaches a chat something, in one
 * place, the way the web app groups Skills, Personas, Prompts and the gallery. */
@Composable
fun KnowledgesScreen(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadSkills() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { SectionTitle("Knowledges") }
        item { ToolCard("🧩", "Skills", "${vm.skills.size} installed · pin with /skill") { vm.push(Screen.Skills) } }
        item { ToolCard("🎭", "Personas", "${allPersonas(vm.library).size}") { vm.push(Screen.Personas) } }
        item { ToolCard("📚", "Prompts", "${allPrompts(vm.library).size} · type / in chat") { vm.push(Screen.Prompts) } }
        item { ToolCard("🖼️", "Gallery", "${vm.library.images.size} image(s)") { vm.push(Screen.Images) } }
        item { SectionTitle("Commands") }
        CHAT_COMMANDS.forEach { command ->
            item(key = command.name) {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Palette.surface).padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Text(command.usage, color = Palette.green, fontSize = 14.sp)
                    Text(command.desc, color = Palette.muted, fontSize = 12.sp)
                }
            }
        }
    }
}

/** The installed skill catalogue. "Use" starts a chat with the skill pinned. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SkillsScreen(vm: AppViewModel) {
    LaunchedEffect(Unit) { vm.loadSkills(force = vm.skills.isEmpty()) }
    var open by remember { mutableStateOf<Skill?>(null) }
    val detailBody = open?.let { skill -> vm.skillDetail?.takeIf { it.first == skill.name }?.second }
    Scaffold(
        containerColor = Palette.background,
        topBar = {
            TopAppBar(
                title = { Text("Skills") },
                navigationIcon = { IconButton({ vm.back() }) { Icon(Icons.Filled.ArrowBack, "Back") } },
                actions = { IconButton({ vm.loadSkills(force = true) }) { Icon(Icons.Filled.Refresh, "Refresh") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Palette.background),
            )
        },
    ) { padding ->
        if (vm.skills.isEmpty()) {
            Column(Modifier.padding(padding).fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("No skills installed.", color = Palette.text)
                Text("The server loads skills from its configured GitHub sources. Tap Refresh above, or check the server in Tools → Status.", color = Palette.muted, fontSize = 13.sp)
            }
        } else {
            LazyColumn(Modifier.padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.skills.distinctBy { it.source + "/" + it.name }, key = { it.source + "/" + it.name }) { skill ->
                    Card(colors = CardDefaults.cardColors(containerColor = Palette.surface), modifier = Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(skill.name + if (skill.userOnly) "  · user only" else "")
                                Text(skill.description, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Palette.muted, fontSize = 12.sp)
                                Text(skill.source, color = Palette.muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            TextButton({ open = skill; vm.loadSkillInstructions(skill.name) }) { Text("View") }
                            TextButton({ vm.newChatWithSkill(skill.name) }) { Text("Use") }
                        }
                    }
                }
            }
        }
    }
    open?.let { skill ->
        AlertDialog(
            onDismissRequest = { open = null },
            title = { Text(skill.name) },
            text = {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(skill.description, color = Palette.text)
                    if (skill.allowedTools.isNotEmpty()) Text("Tools: " + skill.allowedTools.joinToString(", "), color = Palette.muted, fontSize = 12.sp)
                    HorizontalDivider(color = Palette.outline)
                    when {
                        detailBody == null -> Text("Loading…", color = Palette.muted, fontSize = 12.sp)
                        detailBody.isBlank() -> Text("Could not load the skill text.", color = Palette.red, fontSize = 12.sp)
                        else -> Text(detailBody, color = Palette.muted, fontSize = 12.sp)
                    }
                }
            },
            confirmButton = { TextButton({ vm.newChatWithSkill(skill.name); open = null }) { Text("Use in a new chat") } },
            dismissButton = { TextButton({ open = null }) { Text("Close") } },
        )
    }
}

/** Reads a long client-side command reply (/help, /doctor) without putting it
 * into the transcript. */
@Composable
fun CommandInfoDialog(text: String, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("FreeAI4U") },
        text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) { Text(text, fontSize = 13.sp) } },
        confirmButton = { TextButton(onClose) { Text("Close") } },
    )
}
