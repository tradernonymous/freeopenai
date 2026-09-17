package com.freeai4u.app

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Bundle
import android.os.Parcelable
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.Modifier
import android.Manifest
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import com.freeai4u.app.data.PhoneAction
import com.freeai4u.app.data.parseLocalDateTime
import com.freeai4u.app.ui.AppViewModel
import com.freeai4u.app.ui.BuildScreen
import com.freeai4u.app.ui.BuildsScreen
import com.freeai4u.app.ui.CommandInfoDialog
import com.freeai4u.app.ui.FreeAITheme
import com.freeai4u.app.ui.KnowledgesScreen
import com.freeai4u.app.ui.SkillsScreen
import com.freeai4u.app.ui.ImageViewer
import com.freeai4u.app.ui.ImageStudioScreen
import com.freeai4u.app.ui.LockScreen
import com.freeai4u.app.ui.MainScreen
import com.freeai4u.app.ui.Page
import com.freeai4u.app.ui.Palette
import com.freeai4u.app.ui.PersonasScreen
import com.freeai4u.app.ui.Platform
import com.freeai4u.app.ui.PromptsScreen
import com.freeai4u.app.ui.Screen
import com.freeai4u.app.ui.SelectTextDialog
import com.freeai4u.app.ui.SettingsScreen
import com.freeai4u.app.ui.SignInScreen
import com.freeai4u.app.ui.ToolsScreen
import java.io.ByteArrayOutputStream
import java.util.Locale

/** The launcher: native chats, images, tools and settings. */
class NativeActivity : ComponentActivity(), Platform {
    private val vm: AppViewModel by viewModels()
    private var locked by mutableStateOf(false)
    private var lockError by mutableStateOf<String?>(null)
    private var prompting = false
    private lateinit var voice: VoiceSession
    private lateinit var puter: PuterImages
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        // The app is always dark, so the status and navigation bar icons are
        // always light; the default follows the system theme and vanishes on
        // a light-themed phone.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        CrashLog.install(this)
        publishShortcuts()
        if (savedInstanceState == null) takeIntent(intent)
        lockIfDue()
        voice = VoiceSession(this) { heard ->
            val chat = vm.currentOrNew()
            if (Regex("^(stop|cancel|that's all|bye|goodbye)[.!]*$", RegexOption.IGNORE_CASE).matches(heard.trim())) {
                voice.release()
            } else {
                vm.send(chat.id, heard)
            }
        }
        puter = PuterImages(this) { vm.serverUrl }
        vm.puterDraw = { prompt, model, ratio, source, done -> puter.draw(prompt, model, ratio, source, done) }
        setContent {
            FreeAITheme {
                LaunchedEffect(vm.finishedReply) {
                    val (chatId, text, _) = vm.finishedReply ?: return@LaunchedEffect
                    if (voice.state != VoiceSession.State.IDLE) voice.speak(text)
                    else if (!resumed && text.isNotBlank()) notifyReply(chatId, text)
                }
                LaunchedEffect(vm.builds.attention) {
                    val attention = vm.builds.attention ?: return@LaunchedEffect
                    if (!resumed) notifyBuild(attention.buildId, attention.requestId, attention.text)
                }
                @OptIn(ExperimentalComposeUiApi::class)
                Box(Modifier.fillMaxSize().background(Palette.background).safeDrawingPadding().semantics { testTagsAsResourceId = true }) {
                    when {
                        locked -> LockScreen(lockError) { unlock() }
                        !vm.signedIn -> SignInScreen(vm)
                        else -> {
                            BackHandler(enabled = vm.backStack.isNotEmpty()) { vm.back() }
                            MainScreen(vm, this@NativeActivity, voice)
                            AnimatedContent(
                                vm.screen,
                                transitionSpec = {
                                    (slideInHorizontally { it / 3 } + fadeIn()) togetherWith (slideOutHorizontally { it / 3 } + fadeOut())
                                },
                                label = "page",
                            ) { screen ->
                                when (screen) {
                                    null -> Unit
                                    Screen.Images -> Page("Images", vm) { ImageStudioScreen(vm, this@NativeActivity) }
                                    Screen.Tools -> Page("Tools", vm) { ToolsScreen(vm) }
                                    Screen.Settings -> Page("Settings", vm) { SettingsScreen(vm, this@NativeActivity) }
                                    Screen.Personas -> PersonasScreen(vm)
                                    Screen.Prompts -> PromptsScreen(vm)
                                    Screen.Skills -> SkillsScreen(vm)
                                    Screen.Knowledges -> Page("Knowledges", vm) { KnowledgesScreen(vm) }
                                    Screen.Builds -> Page("Builds", vm) { BuildsScreen(vm) }
                                    Screen.Build -> BuildScreen(vm)
                                }
                            }
                        }
                    }
                    viewer?.let { (id, bytes, mime) ->
                        ImageViewer(bytes, onClose = { viewer = null }, onSave = { saveImage("freeai4u-" + id.take(8) + ext(mime), mime, bytes) }, onShare = { shareImage("freeai4u-" + id.take(8) + ext(mime), mime, bytes) })
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
    }

    override fun onPause() {
        resumed = false
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
        if (::voice.isInitialized) voice.release()
        if (::puter.isInitialized) puter.close()
        vm.puterDraw = null
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }

    // --- Intents ---------------------------------------------------------------

    private fun takeIntent(intent: Intent?) {
        when (intent?.action) {
            ACTION_NEW_CHAT -> vm.newChat()
            ACTION_SETTINGS -> {
                vm.backStack.clear()
                vm.push(Screen.Settings)
            }
            ACTION_OPEN_CHAT -> intent.getStringExtra(EXTRA_CHAT_ID)?.let { id -> if (vm.conversation(id) != null) vm.openChat(id) }
            ACTION_OPEN_BUILD -> intent.getStringExtra(EXTRA_BUILD_ID)
                ?.takeIf { it.matches(Regex("^[a-f0-9]{16,64}$")) }
                ?.let { id -> vm.openBuild(id) }
            Intent.ACTION_PROCESS_TEXT -> {
                val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.take(MAX_SHARED_TEXT_CHARS)
                if (!text.isNullOrBlank()) vm.newChat(draft = "\"$text\"\n\nExplain this: ")
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
        if (url.isEmpty()) {
            if (manual) toast(getString(R.string.update_unavailable))
            return
        }
        val now = System.currentTimeMillis()
        if (!manual && now - vm.store.lastUpdateCheck < 24 * 60 * 60 * 1000L) return
        vm.store.lastUpdateCheck = now
        vm.runOnIo {
            val info = fetchUpdateInfo(url)
            vm.runOnMain {
                if (isFinishing || isDestroyed) return@runOnMain
                when {
                    info != null && updateAvailable(info, BuildConfig.VERSION_CODE) ->
                        AlertDialog.Builder(this)
                            .setTitle(getString(R.string.update_title, info.versionName))
                            .setMessage(getString(R.string.update_message, BuildConfig.VERSION_NAME))
                            .setPositiveButton(R.string.update_download) { _, _ -> openLink(info.url) }
                            .setNegativeButton(R.string.update_later, null)
                            .show()
                    manual && info == null -> toast(getString(R.string.update_failed))
                    manual -> toast(getString(R.string.update_current, BuildConfig.VERSION_NAME))
                }
            }
        }
    }

    private fun openLink(url: String) {
        if (!url.startsWith("https://")) return
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
        getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("FreeAI4U", text))
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
                    val name = com.freeai4u.app.data.safeFileName(title, "pdf")
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

    /** A build is waiting for an approval or an answer while the app is in the
     * background. One notification per build, replaced by the next question, so
     * a long build does not stack a pile of them (deepseek-harness-mobile keys
     * its notifications the same way). */
    private fun notifyBuild(buildId: String, requestId: String, text: String) {
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
            .build()
        manager.notify(("build:" + buildId).hashCode(), notification)
    }

    override fun copyCrashLog(): Boolean {
        val log = CrashLog.read(this) ?: return false
        getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("FreeAI4U crash log", log))
        CrashLog.clear(this)
        toast(getString(R.string.crash_copied))
        return true
    }

    companion object {
        const val ACTION_NEW_CHAT = "com.freeai4u.app.NEW_CHAT"
        const val ACTION_SETTINGS = "com.freeai4u.app.SETTINGS"
        const val ACTION_OPEN_CHAT = "com.freeai4u.app.OPEN_CHAT"
        const val EXTRA_CHAT_ID = "chat_id"
        const val ACTION_OPEN_BUILD = "com.freeai4u.app.OPEN_BUILD"
        const val EXTRA_BUILD_ID = "build_id"
        private const val CHANNEL_REPLIES = "replies"
        private const val CHANNEL_BUILDS = "builds"
        private val WHATS_NEW = listOf(
            "• Build remotely: ask for a plan in Plan mode, then tap \"Build remotely\" under the reply. Your server carries it out.",
            "• You approve every file change and command from the phone, with a preview of exactly what changes.",
            "• Builds screen (drawer or Tools) with live steps, and a notification when a build needs you.",
            "• Smoother scrolling past pictures, bigger touch targets, and a clear message when your session expires.",
        ).joinToString("\n\n")
        private const val MAX_PHOTO_EDGE = 1280
        private const val MAX_TEXT_FILE_BYTES = 1024 * 1024
    }
}

/** InputStream.readNBytes is API 33; this reads at most [limit] bytes on any. */
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
