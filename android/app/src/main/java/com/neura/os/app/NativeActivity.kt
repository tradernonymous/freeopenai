package com.neura.os.app
import androidx.compose.runtime.remember
import com.neura.os.BuildConfig
import com.neura.os.R

import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Parcelable
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import com.neura.os.app.ui.NoticeHost
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.Composable
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.ui.NavDisplay
import com.neura.os.app.ui.Dest
import com.neura.os.app.ui.backStack
import com.neura.os.app.ui.Dock
import com.neura.os.app.ui.needsYouCount
import com.neura.os.app.ui.AgentsSpace
import com.neura.os.app.ui.ActivitySpace
import com.neura.os.app.ui.GoAnywhereSheet
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.runtime.CompositionLocalProvider
import com.neura.os.app.ui.LocalSharedScope
import com.neura.os.app.ui.AiEdgeGlow
import androidx.compose.ui.Modifier
import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.pm.PackageManager
import android.provider.AlarmClock
import android.provider.CalendarContract
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.ui.graphics.toArgb
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import com.neura.os.app.data.buildLive
import com.neura.os.app.data.isApprovalTarget
import com.neura.os.app.data.isScheduleId
import com.neura.os.app.data.PhoneAction
import com.neura.os.app.data.parseLocalDateTime
import com.neura.os.app.ui.AppViewModel
import com.neura.os.app.ui.BuildScreen
import com.neura.os.app.ui.AutomationScreen
import com.neura.os.app.ui.ReviewsScreen
import com.neura.os.app.ui.BuildsScreen
import com.neura.os.app.ui.CommandInfoDialog
import com.neura.os.app.ui.NeuraTheme
import com.neura.os.app.ui.LibraryScreen
import com.neura.os.app.ui.SkillsScreen
import com.neura.os.app.ui.ImageViewer
import com.neura.os.app.ui.ImageStudioScreen
import com.neura.os.app.ui.LockScreen
import com.neura.os.app.ui.MainScreen
import com.neura.os.app.ui.Page
import com.neura.os.app.ui.Palette
import com.neura.os.app.ui.PersonasScreen
import com.neura.os.app.ui.Platform
import com.neura.os.app.ui.PromptsScreen
import com.neura.os.app.ui.Route
import com.neura.os.app.ui.SelectTextDialog
import com.neura.os.app.ui.Tab
import kotlinx.coroutines.CancellationException
import com.neura.os.app.ui.SettingsScreen
import com.neura.os.app.ui.SignInScreen
import com.neura.os.app.ui.ToolsScreen
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Locale

/** The launcher: native chats, images, tools and settings. */
class NativeActivity : ComponentActivity(), Platform {
    private val vm: AppViewModel by viewModels()
    private var locked by mutableStateOf(false)
    private var lockError by mutableStateOf<String?>(null)
    private var prompting = false
    private lateinit var voice: VoiceSession
    private lateinit var puter: PuterBridge
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var viewer by mutableStateOf<Triple<String, ByteArray, String>?>(null)
    private var selecting by mutableStateOf<String?>(null)
    /** Highlights of this build, shown once after an update (not on a fresh install). */
    private var whatsNew by mutableStateOf(false)
    private var resumed = false
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pendingSpeech: String? = null

    private var onPhotos: ((List<String>) -> Unit)? = null
    private var onTextFile: ((String, String) -> Unit)? = null
    private var onSpeech: ((String) -> Unit)? = null
    /** Guards the async update check (findings: cancellation / lifecycle):
     * every check captures the current generation; onDestroy bumps it so a
     * late IO result is dropped instead of touching a dead Activity. */
    private var updateCheckSeq = 0
    private var updateDialog: AlertDialog? = null
    /** In-app update download (findings: truncated browser downloads):
     * DownloadManager owns resume/retry across process death; the completion
     * receiver verifies size + SHA-256 before the installer ever sees it. */
    private var updateDownloadId: Long = -1L
    private var updateDownloadInfo: UpdateInfo? = null
    private var updateReceiver: BroadcastReceiver? = null

    private val photoPicker = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris ->
        val callback = onPhotos ?: return@registerForActivityResult
        onPhotos = null
        if (uris.isEmpty()) return@registerForActivityResult
        vm.runOnIo {
            val urls = uris.mapNotNull { photoDataUrl(it) }
            vm.runOnMain {
                if (urls.isEmpty()) toast("Could not read that photo.") else callback(urls)
            }
        }
    }

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val callback = onTextFile ?: return@registerForActivityResult
        onTextFile = null
        if (uri == null) return@registerForActivityResult
        vm.runOnIo {
            val result = try {
                val name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
                val bytes = contentResolver.openInputStream(uri)?.use { stream -> stream.readNBytesCompat(MAX_TEXT_FILE_BYTES + 1) }
                if (bytes == null) null
                else if (bytes.size > MAX_TEXT_FILE_BYTES) "too-big" to ""
                else if (bytes.take(4096).any { it == 0.toByte() }) "binary" to ""
                else name to String(bytes, Charsets.UTF_8)
            } catch (e: Exception) {
                null
            }
            vm.runOnMain {
                when {
                    result == null -> toast("Could not read that file.")
                    result.first == "too-big" -> toast("That file is over 1 MB. Paste the part you need instead.")
                    result.first == "binary" -> toast("That is not a text file. For PDFs and Word files use the full web app.")
                    else -> callback(result.first, result.second)
                }
            }
        }
    }

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startVoice() else toast("Mic permission needed for voice mode.")
    }

    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val speech = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = onSpeech ?: return@registerForActivityResult
        onSpeech = null
        val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!heard.isNullOrBlank()) callback(heard)
    }

    @OptIn(ExperimentalSharedTransitionApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        // Before the first frame, so a light theme never flashes dark.
        applyTheme()
        CrashLog.install(this)
        publishShortcuts()
        if (savedInstanceState == null) takeIntent(intent)
        lockIfDue()
        voice = VoiceSession(this) { heard ->
            val chat = vm.currentOrNew()
            if (Regex("^(stop|cancel|that's all|bye|goodbye)[.!]*$", RegexOption.IGNORE_CASE).matches(heard.trim())) {
                voice.release()
            } else if (!vm.send(chat.id, heard)) {
                // A refused message (no model picked, a reply still running)
                // would otherwise leave voice mode thinking forever.
                voice.listenAgain()
            }
        }
        puter = PuterBridge(this) { vm.serverUrl }
        vm.puterDraw = { prompt, model, ratio, source, done -> puter.draw(prompt, model, ratio, source, done) }
        vm.puterChat = { body, onDelta, done -> puter.chat(body, onDelta, done) }
        vm.puterSignIn = { done -> puter.signIn(done) }
        registerForPush()
        observeConnectivity()
        // Cold start (master plan Phase 3): process start to the first frame,
        // once per process and only on a fresh launch -- a rotation or a
        // restore would measure from a process start long gone.
        val measureStartup = savedInstanceState == null && vm.startupMs == null
        setContent {
            // A change in Settings -> App -> Theme.
            LaunchedEffect(vm.themeMode) { applyTheme() }
            NeuraTheme {
                if (measureStartup) {
                    LaunchedEffect(Unit) {
                        // Resumes on the frame after the first composition,
                        // i.e. once something is actually on screen.
                        withFrameNanos { }
                        if (vm.startupMs == null) {
                            vm.startupMs = android.os.SystemClock.uptimeMillis() - android.os.Process.getStartUptimeMillis()
                        }
                    }
                }
                LaunchedEffect(vm.finishedReply) {
                    val (chatId, text, _) = vm.finishedReply ?: return@LaunchedEffect
                    if (voice.state != VoiceSession.State.IDLE) voice.speak(text)
                    else if (!resumed && text.isNotBlank()) notifyReply(chatId, text)
                }
                // A followed build's Live Update tracks its steps while the app
                // is out of sight, and goes when the build ends.
                LaunchedEffect(vm.builds.current) { updateBuildLive() }
                LaunchedEffect(vm.builds.attention) {
                    val attention = vm.builds.attention ?: return@LaunchedEffect
                    if (!resumed) notifyBuild(attention.buildId, attention.requestId, attention.text, attention.approval)
                }
                @OptIn(ExperimentalComposeUiApi::class)
                Box(Modifier.fillMaxSize().background(Palette.background).safeDrawingPadding().semantics { testTagsAsResourceId = true }) {
                    when {
                        locked -> LockScreen(lockError) { unlock() }
                        !vm.signedIn -> SignInScreen(vm)
                        else -> {
                            // Navigation 3 (master plan v2, V4): the current space's stack,
                            // with the system's predictive-back preview on every page above
                            // a space's root. At the root itself, back returns to Chat.
                            val stack = vm.nav.backStack()
                            val chat = vm.currentChatId?.let { vm.conversation(it) }
                            val imeOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
                            val showDock = stack.size == 1 && !imeOpen &&
                                (vm.currentTab != Tab.Chat || chat == null || chat.messages.isEmpty())
                            BackHandler(enabled = stack.size == 1 && vm.currentTab != Tab.Chat) { vm.back() }
                            Column(Modifier.fillMaxSize()) {
                                // Shared elements between pages (V5): a card's title
                                // grows into the page it opens (Modifier.sharedTitle).
                                SharedTransitionLayout(Modifier.weight(1f)) {
                                    CompositionLocalProvider(LocalSharedScope provides this) {
                                        NavDisplay(
                                            backStack = stack,
                                            onBack = { vm.back() },
                                            entryProvider = { dest -> NavEntry(dest) { Destination(it) } },
                                        )
                                    }
                                }
                                AnimatedVisibility(
                                    showDock,
                                    enter = slideInVertically { it } + fadeIn(),
                                    exit = slideOutVertically { it } + fadeOut(),
                                ) {
                                    Dock(
                                        current = vm.currentTab,
                                        working = vm.streamingId != null,
                                        needsYou = needsYouCount(vm),
                                        onSelect = { tab -> if (tab == Tab.Chat) vm.goToChat() else vm.selectTab(tab) },
                                        onOrb = { startVoice() },
                                        onOrbLong = { vm.newChat(); vm.goToChat() },
                                    )
                                }
                            }
                        }
                    }
                    // The screen's edges glow while a reply streams (V6).
                    if (vm.signedIn && !locked) AiEdgeGlow(active = vm.streamingId != null)
                    if (vm.signedIn && !locked) {
                        NoticeHost(
                            vm.notices,
                            Modifier.align(androidx.compose.ui.Alignment.BottomCenter)
                                .imePadding()
                                .padding(bottom = 88.dp),
                        )
                    }
                    if (vm.goAnywhereOpen && vm.signedIn && !locked) {
                        BackHandler { vm.goAnywhereOpen = false }
                        GoAnywhereSheet(vm, this@NativeActivity) { vm.goAnywhereOpen = false }
                    }
                    viewer?.let { (id, bytes, mime) ->
                        ImageViewer(bytes, onClose = { viewer = null }, onSave = { saveImage("neuraos-" + id.take(8) + ext(mime), mime, bytes) }, onShare = { shareImage("neuraos-" + id.take(8) + ext(mime), mime, bytes) })
                    }
                    selecting?.let { text -> SelectTextDialog(text) { selecting = null } }
                    vm.commandInfo?.let { text -> CommandInfoDialog(text) { vm.commandInfo = null } }
                    if (whatsNew && vm.signedIn && !locked) {
                        androidx.compose.material3.AlertDialog(
                            onDismissRequest = { whatsNew = false },
                            title = { androidx.compose.material3.Text("What's new") },
                            text = { androidx.compose.material3.Text(WHATS_NEW) },
                            confirmButton = { androidx.compose.material3.TextButton({ whatsNew = false }) { androidx.compose.material3.Text("Got it") } },
                        )
                    }
                }
            }
        }
        whatsNew = markVersionSeen()
        checkForUpdate(manual = false)
        if (android.os.Build.VERSION.SDK_INT >= 33 && savedInstanceState == null &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !vm.store.askedNotifications
        ) {
            vm.store.askedNotifications = true
            notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /** What one entry of the Navigation 3 stack draws (V4). */
    @Composable
    private fun Destination(dest: Dest) {
        when (dest) {
            is Dest.Root -> when (dest.tab) {
                Tab.Chat -> MainScreen(vm, this, voice)
                Tab.Create -> Page("Create", vm) { ImageStudioScreen(vm, this) }
                Tab.Agents -> AgentsSpace(vm)
                Tab.Activity -> ActivitySpace(vm)
            }
            is Dest.Page -> when (dest.route) {
                Route.Images -> Page("Images", vm) { ImageStudioScreen(vm, this) }
                Route.Tools -> Page("Tools", vm) { ToolsScreen(vm) }
                Route.Settings -> Page("Settings", vm) { SettingsScreen(vm, this) }
                Route.Personas -> PersonasScreen(vm)
                Route.Prompts -> PromptsScreen(vm)
                Route.Skills -> SkillsScreen(vm)
                Route.Knowledges -> Page("Library", vm) { LibraryScreen(vm) }
                Route.Builds -> Page("Builds", vm) { BuildsScreen(vm) }
                Route.Build -> BuildScreen(vm)
                is Route.Detail -> Unit
                Route.Automation -> Page("Automate", vm) { AutomationScreen(vm) }
                Route.Reviews -> Page("Pull requests", vm) { ReviewsScreen(vm) }
                Route.Agents -> AgentsSpace(vm)
                Route.Activity -> ActivitySpace(vm)
            }
        }
    }

    /** Settings -> App -> Theme, and the phone's own mode for "System":
     * which token set Palette shows, the window behind it, and whether the
     * status and navigation bar icons are drawn dark or light (the default
     * follows the system and vanishes on the wrong background). Called
     * outside composition, so a switch is one ordinary state change. */
    private fun applyTheme() {
        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        val dark = when (vm.themeMode) {
            "light" -> false
            "system" -> night
            else -> true
        }
        Palette.isDark = dark
        val clear = android.graphics.Color.TRANSPARENT
        val bars = if (dark) SystemBarStyle.dark(clear) else SystemBarStyle.light(clear, clear)
        enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Palette.background.toArgb()))
    }

    // uiMode is in the manifest's configChanges, so the phone switching
    // between dark and light arrives here instead of recreating the screen.
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        applyTheme()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        lockIfDue()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        // Covers the window between the network returning and this activity
        // resuming, when a killed process never had a callback to fire.
        vm.drainOutbox()
        vm.resumeTick++
        updateBuildLive()
    }

    /** A chat left waiting on a connectivity failure (see AppViewModel.outbox)
     * retries the moment the network is back, instead of sitting on an error
     * until the user notices and taps regenerate themselves. */
    private fun observeConnectivity() {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                runOnUiThread { vm.drainOutbox() }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: SecurityException) {
            // ACCESS_NETWORK_STATE is a normal permission and always granted,
            // but an OEM restriction is a missed retry opportunity, not a crash.
        }
    }

    override fun onPause() {
        resumed = false
        updateBuildLive()
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        if (!isChangingConfigurations) AppLock.backgroundedAt = System.currentTimeMillis()
        // A prompt interrupted by leaving the app may never call back; without
        // this the Unlock button stayed dead until the process restarted.
        prompting = false
    }

    override fun onDestroy() {
        updateCheckSeq++
        try {
            updateDialog?.dismiss()
        } catch (e: Exception) {
            // Dismiss is cleanup; a window that is already gone is fine.
        }
        updateDialog = null
        updateReceiver?.let { receiver ->
            try {
                unregisterReceiver(receiver)
            } catch (e: Exception) {
                // Already unregistered or never registered; cleanup only.
            }
            updateReceiver = null
        }
        updateDownloadId = -1L
        updateDownloadInfo = null
        if (::voice.isInitialized) voice.release()
        if (::puter.isInitialized) puter.close()
        vm.puterDraw = null
        vm.puterChat = null
        vm.puterSignIn = null
        tts?.shutdown()
        tts = null
        networkCallback?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
        networkCallback = null
        super.onDestroy()
    }

    // --- Intents ---------------------------------------------------------------

    private fun takeIntent(intent: Intent?) {
        when (intent?.action) {
            ACTION_NEW_CHAT -> vm.newChat()
            ACTION_SETTINGS -> vm.push(Route.Settings)
            ACTION_OPEN_CHAT -> intent.getStringExtra(EXTRA_CHAT_ID)?.let { id -> if (vm.conversation(id) != null) vm.openChat(id) }
            // A scheduled recipe's notification: the id is checked, the prompt
            // comes from the phone's own storage, and it only becomes a draft.
            ACTION_RUN_RECIPE -> intent.getStringExtra(RecipeAlarms.EXTRA_SCHEDULE_ID)
                ?.takeIf { isScheduleId(it) }
                ?.let { id -> vm.openScheduledRecipe(id) }
            ACTION_OPEN_BUILD -> intent.getStringExtra(EXTRA_BUILD_ID)
                ?.takeIf { it.matches(Regex("^[a-f0-9]{16,64}$")) }
                ?.let { id -> vm.openBuild(id) }
            Intent.ACTION_PROCESS_TEXT -> {
                val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.take(MAX_SHARED_TEXT_CHARS)
                if (!text.isNullOrBlank()) vm.newChat(draft = "\"$text\"\n\nExplain this: ")
            }
            Intent.ACTION_VIEW -> {
                val uri = intent.data
                if (uri?.scheme == "neuraos" && uri.host == "github-connected") {
                    val code = uri.getQueryParameter("code")
                    if (!code.isNullOrBlank()) vm.connectGithub(code, uri.getQueryParameter("login") ?: "")
                }
            }
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> {
                val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                val draft = listOfNotNull(subject?.trim()?.ifEmpty { null }, text?.trim()?.ifEmpty { null })
                    .distinct().joinToString("\n\n").take(MAX_SHARED_TEXT_CHARS)
                val uris = streamUris(intent)
                val chatId = vm.newChat(draft = draft)
                if (uris.isNotEmpty()) {
                    vm.runOnIo {
                        val urls = uris.mapNotNull { photoDataUrl(it) }
                        vm.runOnMain { if (urls.isNotEmpty()) vm.pendingPhotos[chatId] = urls }
                    }
                }
            }
        }
    }

    private fun streamUris(intent: Intent): List<Uri> {
        if (intent.type?.startsWith("image/") != true) return emptyList()
        val found = mutableListOf<Uri>()
        @Suppress("DEPRECATION")
        (intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? Uri)?.let { found.add(it) }
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<Parcelable>(Intent.EXTRA_STREAM)?.forEach { (it as? Uri)?.let(found::add) }
        return found.filter { it.scheme == "content" }.take(4)
    }

    /** A photo as a JPEG data URL no larger than 1280px on its long side:
     * vision models do not need more, and it keeps the chat file small. */
    private fun photoDataUrl(uri: Uri): String? = try {
        val source = ImageDecoder.createSource(contentResolver, uri)
        val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            val longest = maxOf(info.size.width, info.size.height)
            if (longest > MAX_PHOTO_EDGE) {
                val scale = MAX_PHOTO_EDGE.toFloat() / longest
                decoder.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out)
        bitmap.recycle()
        "data:image/jpeg;base64," + java.util.Base64.getEncoder().encodeToString(out.toByteArray())
    } catch (e: Exception) {
        null
    }

    private fun publishShortcuts() {
        try {
            val manager = getSystemService(ShortcutManager::class.java) ?: return
            val icon = Icon.createWithResource(this, R.drawable.ic_app)
            fun shortcut(id: String, label: String, action: String) = ShortcutInfo.Builder(this, id)
                .setShortLabel(label).setIcon(icon)
                .setIntent(Intent(this, NativeActivity::class.java).setAction(action))
                .build()
            manager.dynamicShortcuts = listOf(
                shortcut("new_chat", getString(R.string.shortcut_new_chat), ACTION_NEW_CHAT),
                shortcut("settings", getString(R.string.app_settings), ACTION_SETTINGS),
            )
        } catch (ignored: Exception) {
        }
    }

    // --- App lock ------------------------------------------------------------------

    private fun lockIfDue() {
        if (locked) return
        val enabled = vm.store.appLock && AppLock.available(this)
        if (!lockDue(enabled, AppLock.unlocked, AppLock.backgroundedAt, System.currentTimeMillis(), AppLock.GRACE_MS)) return
        AppLock.unlocked = false
        locked = true
        window.decorView.post { unlock() }
    }

    private fun unlock() {
        if (prompting) return
        prompting = true
        AppLock.prompt(this, onUnlocked = {
            prompting = false
            AppLock.unlocked = true
            AppLock.backgroundedAt = 0L
            lockError = null
            locked = false
        }, onFailed = { reason ->
            prompting = false
            lockError = reason
        })
    }

    // --- Updates ---------------------------------------------------------------------

    private fun checkForUpdate(manual: Boolean) {
        val url = BuildConfig.UPDATE_URL
        if (url.isEmpty() || !isUpdateManifestUrl(url)) {
            if (manual) toast(getString(R.string.update_unavailable))
            return
        }
        val now = System.currentTimeMillis()
        if (!manual && now - vm.store.lastUpdateCheck < UPDATE_CHECK_THROTTLE_MS) return
        // Automatic checks reuse a fresh in-memory result (findings: caching
        // / network optimisation); manual checks always hit the network.
        if (!manual && !isFinishing && !isDestroyed) {
            when (val cached = UpdateCache.get(now)) {
                is UpdateCheckResult.Available ->
                    if (updateAvailable(cached.info, BuildConfig.VERSION_CODE)) {
                        vm.store.lastUpdateCheck = now
                        showUpdateDialog(cached.info)
                        return
                    }
                is UpdateCheckResult.Current -> {
                    vm.store.lastUpdateCheck = now
                    return
                }
                else -> Unit
            }
        }
        vm.store.lastUpdateCheck = now
        val generation = ++updateCheckSeq
        vm.runOnIo {
            val result = fetchUpdateInfoResult(url, BuildConfig.VERSION_CODE)
            if (!manual) UpdateCache.put(result)
            vm.runOnMain {
                // Dropped when the Activity died or a newer check superseded
                // this one (findings: cancellation / background-foreground
                // lifecycle): never touch views after onDestroy.
                if (generation != updateCheckSeq || isFinishing || isDestroyed) return@runOnMain
                when (result) {
                    is UpdateCheckResult.Available -> showUpdateDialog(result.info)
                    is UpdateCheckResult.Current -> {
                        if (manual) toast(getString(R.string.update_current, BuildConfig.VERSION_NAME))
                    }
                    is UpdateCheckResult.Failed -> {
                        if (!manual) return@runOnMain
                        toast(
                            when (result.reason) {
                                UpdateCheckFailure.OFFLINE_OR_NETWORK -> getString(R.string.update_no_connection)
                                UpdateCheckFailure.HTTP_ERROR -> getString(R.string.update_server_error)
                                UpdateCheckFailure.BAD_URL,
                                UpdateCheckFailure.EMPTY_OR_TOO_LARGE,
                                UpdateCheckFailure.MALFORMED -> getString(R.string.update_bad_response)
                            }
                        )
                    }
                }
            }
        }
    }

    private fun showUpdateDialog(info: UpdateInfo) {
        try {
            updateDialog?.dismiss()
        } catch (e: Exception) {
        }
        updateDialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.update_title, info.versionName))
            .setMessage(getString(R.string.update_message, BuildConfig.VERSION_NAME))
            .setPositiveButton(R.string.update_download) { _, _ -> downloadUpdate(info) }
            .setNegativeButton(R.string.update_later, null)
            .setOnDismissListener { updateDialog = null }
            .show()
    }

    /** Downloads the update with the system DownloadManager instead of the
     * browser: it survives the app going to the background, retries on
     * flaky networks, shows progress in the notification shade, and reports
     * a definitive status -- the combination that fixes truncated APKs.
     * Falls back to the browser when DownloadManager is unavailable. */
    private fun downloadUpdate(info: UpdateInfo) {
        if (!isUpdateDownloadUrl(info.url)) return
        val manager = try {
            getSystemService(DownloadManager::class.java)
        } catch (e: Exception) {
            null
        }
        if (manager == null) {
            openLink(info.url)
            return
        }
        // One pending update at a time: a second tap replaces the first, and
        // any stale file is deleted so a short read is never mistaken for done.
        try {
            if (updateDownloadId >= 0) manager.remove(updateDownloadId)
        } catch (e: Exception) {
        }
        val fileName = "neuraos-" + info.versionCode + ".apk"
        try {
            File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName).delete()
        } catch (e: Exception) {
        }
        val request = try {
            DownloadManager.Request(Uri.parse(info.url))
                .setTitle(getString(R.string.update_title, info.versionName))
                .setDescription(getString(R.string.update_downloading, info.versionName))
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setMimeType("application/vnd.android.package-archive")
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false)
                .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName)
        } catch (e: Exception) {
            openLink(info.url)
            return
        }
        updateDownloadInfo = info
        ensureUpdateReceiver()
        val id = try {
            manager.enqueue(request)
        } catch (e: Exception) {
            updateDownloadInfo = null
            openLink(info.url)
            return
        }
        updateDownloadId = id
        toast(getString(R.string.update_downloading, info.versionName))
    }

    private fun ensureUpdateReceiver() {
        if (updateReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                if (id != updateDownloadId) return
                onUpdateDownloadComplete(id)
            }
        }
        updateReceiver = receiver
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                registerReceiver(receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                @SuppressLint("UnspecifiedRegisterReceiverFlag")
                registerReceiver(receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE))
            }
        } catch (e: Exception) {
            updateReceiver = null
        }
    }

    private fun onUpdateDownloadComplete(id: Long) {
        val info = updateDownloadInfo
        updateDownloadId = -1L
        updateDownloadInfo = null
        if (info == null) return
        val manager = try {
            getSystemService(DownloadManager::class.java)
        } catch (e: Exception) {
            null
        }
        val file = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "neuraos-" + info.versionCode + ".apk")
        val success = if (manager == null) {
            false
        } else {
            try {
                manager.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
                    cursor.moveToFirst() &&
                        cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL
                } ?: false
            } catch (e: Exception) {
                false
            }
        }
        if (!success || !file.exists()) {
            try {
                file.delete()
            } catch (e: Exception) {
            }
            if (!isFinishing && !isDestroyed) toast(getString(R.string.update_download_failed))
            return
        }
        // Size + SHA-256 against the manifest (findings: APK validation): a
        // truncated or tampered file is deleted here, never installed.
        val verified = try {
            verifyApkFile(file, info)
        } catch (e: Exception) {
            false
        }
        if (!verified) {
            try {
                file.delete()
            } catch (e: Exception) {
            }
            if (!isFinishing && !isDestroyed) toast(getString(R.string.update_corrupt))
            return
        }
        installUpdate(file)
    }

    private fun installUpdate(file: File) {
        val uri = try {
            FileProvider.getUriForFile(this, packageName + ".files", file)
        } catch (e: Exception) {
            if (!isFinishing && !isDestroyed) toast(getString(R.string.update_no_installer))
            return
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            // The system installer re-verifies the APK signature: an update
            // signed with any other key is refused there, whatever we checked.
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            toast(getString(R.string.update_no_installer))
        } catch (e: SecurityException) {
            // "Install unknown apps" is off for NeuraOS: point at the toggle.
            toast(getString(R.string.update_allow_unknown))
            openUnknownAppSources()
        }
    }

    private fun openUnknownAppSources() {
        try {
            val intent = if (android.os.Build.VERSION.SDK_INT >= 26) {
                Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
            } else {
                Intent(android.provider.Settings.ACTION_SECURITY_SETTINGS)
            }
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            // The toast already said what to do; no settings app is not fatal.
        }
    }

    private fun openLink(url: String) {
        // Double-guard at the call site: only a validated release-download
        // link is ever opened, even though parseUpdateInfo already enforces it.
        if (!isUpdateDownloadUrl(url)) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            toast("No browser can open that link.")
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    // --- Platform ----------------------------------------------------------------------

    override val version: String get() = BuildConfig.VERSION_NAME

    override fun copy(text: String) {
        getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("NeuraOS", text))
        // Android 13+ shows its own clipboard confirmation.
        if (android.os.Build.VERSION.SDK_INT < 33) toast("Copied")
    }

    override fun shareText(subject: String, text: String) {
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_SUBJECT, subject)
            .putExtra(Intent.EXTRA_TEXT, text.take(100_000))
        startActivity(Intent.createChooser(intent, subject))
    }

    override fun saveText(name: String, mime: String, text: String) {
        vm.runOnIo {
            val ok = WebShell.saveToDownloads(this, name, mime, text.toByteArray(Charsets.UTF_8))
            vm.runOnMain { toast(if (ok) getString(R.string.saved_to, name) else getString(R.string.save_failed)) }
        }
    }

    override fun exportPdf(title: String, markdown: String) {
        vm.runOnIo {
            val result = try {
                Exporter.markdownToPdf(title, markdown)
            } catch (e: Exception) {
                null
            }
            vm.runOnMain {
                if (isFinishing || isDestroyed) return@runOnMain
                if (result == null) toast("Could not build the PDF.")
                else {
                    val name = com.neura.os.app.data.safeFileName(title, "pdf")
                    AlertDialog.Builder(this)
                        .setTitle(name)
                        .setItems(arrayOf("Share", "Save to Downloads")) { _, which ->
                            if (which == 0) Exporter.share(this, name, "application/pdf", result)
                            else saveBytes(name, "application/pdf", result)
                        }
                        .show()
                }
            }
        }
    }

    private fun saveBytes(name: String, mime: String, bytes: ByteArray) {
        vm.runOnIo {
            val ok = WebShell.saveToDownloads(this, name, mime, bytes)
            vm.runOnMain { toast(if (ok) getString(R.string.saved_to, name) else getString(R.string.save_failed)) }
        }
    }

    override fun saveImage(name: String, mime: String, bytes: ByteArray) = saveBytes(name, mime, bytes)

    override fun shareImage(name: String, mime: String, bytes: ByteArray) = Exporter.share(this, name, mime, bytes)

    override fun speak(text: String) {
        val clean = text.replace(Regex("```[\\s\\S]*?```"), " (code) ").replace(Regex("[*#`_>]"), "").take(3900)
        val engine = tts
        if (engine != null && ttsReady) {
            engine.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "reply")
            return
        }
        pendingSpeech = clean
        if (engine == null) {
            tts = TextToSpeech(this) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (!ttsReady) {
                    toast("Text-to-speech is not available on this phone.")
                    return@TextToSpeech
                }
                tts?.language = Locale.getDefault()
                pendingSpeech?.let { tts?.speak(it, TextToSpeech.QUEUE_FLUSH, null, "reply") }
                pendingSpeech = null
            }
        }
    }

    override fun stopSpeaking() {
        tts?.stop()
    }

    override fun listen(onText: (String) -> Unit) {
        onSpeech = onText
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak your message")
        try {
            speech.launch(intent)
        } catch (e: ActivityNotFoundException) {
            onSpeech = null
            toast("No speech recognition app on this phone (install Google app).")
        }
    }

    override fun pickPhotos(onPicked: (List<String>) -> Unit) {
        onPhotos = onPicked
        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    override fun pickTextFile(onPicked: (name: String, text: String) -> Unit) {
        onTextFile = onPicked
        try {
            filePicker.launch(arrayOf("text/*", "application/json", "application/xml", "application/javascript", "application/x-yaml"))
        } catch (e: ActivityNotFoundException) {
            onTextFile = null
            toast("No file picker on this phone.")
        }
    }

    override fun checkUpdates() = checkForUpdate(manual = true)

    override fun deviceControlEnabled(): Boolean = DeviceControlService.instance != null

    override fun openAccessibilitySettings() {
        try {
            startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
        } catch (e: ActivityNotFoundException) {
            toast("No accessibility settings on this phone.")
        }
    }

    override fun openAppInfoSettings() {
        try {
            startActivity(
                Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.fromParts("package", packageName, null)),
            )
        } catch (e: ActivityNotFoundException) {
            toast("No app info screen on this phone.")
        }
    }

    override fun appLockOn(): Boolean = vm.store.appLock

    override fun setAppLock(on: Boolean, onResult: (Boolean) -> Unit) {
        if (!on) {
            vm.store.appLock = false
            onResult(false)
            return
        }
        if (!AppLock.available(this)) {
            toast(getString(R.string.lock_needs_screen_lock))
            onResult(false)
            return
        }
        AppLock.prompt(this, onUnlocked = {
            vm.store.appLock = true
            AppLock.unlocked = true
            onResult(true)
        }, onFailed = { reason ->
            toast(reason)
            onResult(false)
        })
    }

    override fun viewImage(id: String, bytes: ByteArray, mime: String) {
        viewer = Triple(id, bytes, mime)
    }

    override fun selectText(text: String) {
        selecting = text
    }

    private fun ext(mime: String) = if (mime.contains("png")) ".png" else if (mime.contains("webp")) ".webp" else ".jpg"

    override fun startVoice() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        if (!voice.available()) {
            toast("No speech recognition on this phone.")
            return
        }
        voice.start()
    }

    /** Runs a phone action the assistant proposed, after the user tapped it.
     * Every one opens another app's own screen; nothing is sent or saved
     * without the user finishing it there. */
    override fun runAction(action: PhoneAction) {
        val intent: Intent? = when (action.kind) {
            "alarm" -> Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, action.hour)
                .putExtra(AlarmClock.EXTRA_MINUTES, action.minute.coerceAtLeast(0))
                .putExtra(AlarmClock.EXTRA_MESSAGE, action.title)
            "timer" -> Intent(AlarmClock.ACTION_SET_TIMER)
                .putExtra(AlarmClock.EXTRA_LENGTH, action.seconds)
                .putExtra(AlarmClock.EXTRA_MESSAGE, action.title)
                .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
            "event" -> {
                val begin = parseLocalDateTime(action.start)
                val end = parseLocalDateTime(action.end) ?: begin?.plus(60 * 60 * 1000L)
                Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.Events.TITLE, action.title)
                    .putExtra(CalendarContract.Events.EVENT_LOCATION, action.location)
                    .putExtra(CalendarContract.Events.DESCRIPTION, action.text)
                    .apply {
                        if (begin != null) putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
                        if (end != null) putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
                    }
            }
            "map" -> Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(action.query)))
            "dial" -> Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(action.number)))
            "email" -> Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + Uri.encode(action.email)))
                .putExtra(Intent.EXTRA_SUBJECT, action.title)
                .putExtra(Intent.EXTRA_TEXT, action.text)
            "open_url" -> if (action.url.startsWith("https://")) Intent(Intent.ACTION_VIEW, Uri.parse(action.url)) else null
            "share" -> Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, action.text), action.title.ifEmpty { "Share" })
            "copy" -> {
                copy(action.text)
                null
            }
            "tap_text", "scroll_until" -> {
                runDeviceAction(action)
                null
            }
            else -> null
        }
        if (intent == null) return
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            toast("No app on this phone can do that.")
        } catch (e: SecurityException) {
            toast("Android blocked that action.")
        }
    }

    /** tap_text/scroll_until act on whatever app has focus when they run --
     * and the instant this button is tapped, that's NeuraOS itself, not
     * whatever app the action is meant to reach. moveTaskToBack gives the
     * OS a moment to restore the app that was open before the user
     * switched here to tap Approve, and the delay before acting gives that
     * transition time to finish; both are best-effort, since Android
     * doesn't guarantee either one lands before the tap tries to run. Runs
     * on a background thread -- scroll_until also pauses between attempts
     * -- so none of this blocks the UI. A null instance means the person
     * has not turned Device control on in Settings, or turned it off. */
    private fun runDeviceAction(action: PhoneAction) {
        val service = DeviceControlService.instance
        if (service == null) {
            toast("Turn on Device control in Settings to use this.")
            return
        }
        moveTaskToBack(true)
        Thread {
            Thread.sleep(500)
            val result = if (action.kind == "tap_text") service.tapText(action.targetLabel) else service.scrollUntil(action.targetLabel, action.maxScrolls)
            result.exceptionOrNull()?.message?.let { message -> runOnUiThread { toast(message) } }
        }.start()
    }

    /** A reply that finished while the app was in the background. */
    private fun notifyReply(chatId: String, text: String) {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_REPLIES, "Replies", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            this, chatId.hashCode(),
            Intent(this, NativeActivity::class.java).setAction(ACTION_OPEN_CHAT).putExtra(EXTRA_CHAT_ID, chatId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val preview = text.replace(Regex("[*#`_>]"), "").replace(Regex("\\s+"), " ").take(220)
        val notification = NotificationCompat.Builder(this, CHANNEL_REPLIES)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle(vm.conversation(chatId)?.title ?: "Reply ready")
            .setContentText(preview)
            .setStyle(NotificationCompat.BigTextStyle().bigText(preview))
            .setContentIntent(open)
            .setAutoCancel(true)
            // Chat text stays hidden on the lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        manager.notify(chatId.hashCode(), notification)
    }

    /** Records this version as seen; true when the app was just updated from an
     * older one (a fresh install has nothing new to announce). */
    private fun markVersionSeen(): Boolean {
        val prefs = getSharedPreferences("app_state", MODE_PRIVATE)
        val seen = prefs.getInt("seen_version_code", 0)
        if (seen == BuildConfig.VERSION_CODE) return false
        prefs.edit().putInt("seen_version_code", BuildConfig.VERSION_CODE).apply()
        return seen in 1 until BuildConfig.VERSION_CODE
    }

    /** One attempt per launch to hand the current FCM token to the server, so
     * a token minted before this account ever signed in (or before a session
     * existed to register it against) still reaches the server eventually
     * rather than only on the next token rotation. Safe to call unconditionally:
     * a device with no session yet just fails registerPush quietly, the same
     * way FcmService.onNewToken already does. */
    private fun registerForPush() {
        if (!BuildConfig.FCM_CONFIGURED) return
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token -> vm.registerPushToken(token) }
        } catch (e: Exception) {
            // No Play services, or Firebase not ready -- push just stays off.
        }
    }

    /** A build is waiting for an approval or an answer while the app is in the
     * background. One notification per build, replaced by the next question, so
     * a long build does not stack a pile of them (deepseek-harness-mobile keys
     * its notifications the same way). */
    private fun notifyBuild(buildId: String, requestId: String, text: String, approval: Boolean = false) {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_BUILDS, "Builds waiting for you", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(
            this, buildId.hashCode(),
            Intent(this, NativeActivity::class.java).setAction(ACTION_OPEN_BUILD).putExtra(EXTRA_BUILD_ID, buildId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_BUILDS)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle("Build needs your approval")
            .setContentText(text.take(160))
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.take(400)))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setSortKey(requestId)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            // A change to approve can be approved from here, once the phone is
            // unlocked (BuildApprovalReceiver); a question only opens the build.
            .apply { if (approval && isApprovalTarget(buildId, requestId)) addAction(BuildApprovalReceiver.action(this@NativeActivity, buildId, requestId)) }
            .build()
        manager.notify(("build:" + buildId).hashCode(), notification)
    }

    /** A running build, followed on the build screen, as an Android 16 Live
     * Update while the app is out of sight (master plan v2, V7 gap): its
     * repository, the step it is on, and a bar of steps done. Gone when the
     * app is back on screen or the build ends. Older Androids show it as an
     * ordinary quiet progress notification. */
    private fun updateBuildLive() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val session = vm.builds.current
        val live = if (resumed) null else buildLive(session)
        if (live == null || session == null) {
            manager.cancel(BUILD_LIVE_ID)
            return
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_BUILD_PROGRESS, "Builds in progress", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, ("live:" + session.id).hashCode(),
            Intent(this, NativeActivity::class.java).setAction(ACTION_OPEN_BUILD).putExtra(EXTRA_BUILD_ID, session.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val progress = NotificationCompat.ProgressStyle()
        if (live.total > 0) {
            progress.addProgressSegment(NotificationCompat.ProgressStyle.Segment(live.total)).setProgress(live.done)
        } else {
            progress.setProgressIndeterminate(true)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_BUILD_PROGRESS)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle(live.title)
            .setContentText(live.text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setStyle(progress)
            .setRequestPromotedOngoing(true)
            .build()
        manager.notify(BUILD_LIVE_ID, notification)
    }

    override fun copyCrashLog(): Boolean {
        val log = CrashLog.read(this) ?: return false
        getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("NeuraOS crash log", log))
        CrashLog.clear(this)
        toast(getString(R.string.crash_copied))
        return true
    }

    companion object {
        const val ACTION_NEW_CHAT = "com.neura.os.app.NEW_CHAT"
        const val ACTION_SETTINGS = "com.neura.os.app.SETTINGS"
        const val ACTION_OPEN_CHAT = "com.neura.os.app.OPEN_CHAT"
        const val EXTRA_CHAT_ID = "chat_id"
        const val ACTION_OPEN_BUILD = "com.neura.os.app.OPEN_BUILD"
        const val EXTRA_BUILD_ID = "build_id"
        const val ACTION_RUN_RECIPE = "com.neura.os.app.RUN_RECIPE"
        private const val CHANNEL_REPLIES = "replies"
        // Not private: FcmService posts to the same channel for a build that
        // needs approval after Android has already killed this process.
        const val CHANNEL_BUILDS = "builds"
        private const val CHANNEL_BUILD_PROGRESS = "build_progress"
        private const val BUILD_LIVE_ID = 43
        private val WHATS_NEW = listOf(
            "🚀 Welcome to NeuraOS — your AI agent platform.",
            "🔍 Universal Vision: send any image to any model — even text-only models get a detailed description.",
            "📄 File Generation: the agent produces downloadable files — code, markdown, PDF, JSON, CSV.",
            "🤖 Device Automation: automate phone apps with natural language — scroll, tap, read, schedule.",
            "• Build remotely with plan-and-approve workflow.",
            "• Type-safe Navigation 3 routes for faster, more reliable screen transitions.",
        ).joinToString("\n\n")
        private const val MAX_PHOTO_EDGE = 1280
        private const val MAX_TEXT_FILE_BYTES = 1024 * 1024
        /** Automatic update checks run at most once per cold start window;
         * manual "Check for updates" always runs (findings: network use). */
        private const val UPDATE_CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000L
    }
}

private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(16384)
    var total = 0
    while (total < limit) {
        val read = read(buffer, 0, minOf(buffer.size, limit - total))
        if (read < 0) break
        out.write(buffer, 0, read)
        total += read
    }
    return out.toByteArray()
}
