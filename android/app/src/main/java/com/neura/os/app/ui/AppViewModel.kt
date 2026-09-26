package com.neura.os.app.ui

import androidx.lifecycle.viewModelScope
import com.neura.os.app.data.NoticeQueue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import android.app.Application
import com.neura.os.app.data.ImageIntelligence
import com.neura.os.app.data.FileGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import com.neura.os.app.ApiException
import com.neura.os.app.BaseUrlResult
import com.neura.os.app.ChatApi
import com.neura.os.app.SecureStore
import com.neura.os.app.WebShell
import com.neura.os.app.data.BUILT_IN_PERSONAS
import com.neura.os.app.data.ChatEvent
import com.neura.os.app.data.ChatMessage
import com.neura.os.app.data.Conversation
import com.neura.os.app.data.DEFAULT_PERSONA_ID
import com.neura.os.app.data.GeneratedImage
import com.neura.os.app.data.ImageSize
import com.neura.os.app.data.Library
import com.neura.os.app.data.Limits
import com.neura.os.app.data.COMPACT_HISTORY_MESSAGES
import com.neura.os.app.data.MAX_HISTORY_MESSAGES
import com.neura.os.app.data.CompareTarget
import com.neura.os.app.data.compareTargetsValid
import com.neura.os.app.data.defaultCompareTarget
import com.neura.os.app.data.AutomationEntry
import com.neura.os.app.data.recordAutomation
import com.neura.os.app.data.RecipeSchedule
import com.neura.os.app.data.SCHEDULE_MAX
import com.neura.os.app.data.upsertSchedule
import com.neura.os.app.data.validateSchedule
import com.neura.os.app.RecipeAlarms
import com.neura.os.app.data.Skill
import com.neura.os.app.data.SlashMatch
import com.neura.os.app.data.renderCommandsHelp
import com.neura.os.app.data.resolveSlash
import com.neura.os.app.data.imageModelsFor
import com.neura.os.app.data.imageRatio
import com.neura.os.app.data.ModelInfo
import com.neura.os.app.data.NativeApi
import com.neura.os.app.data.Outbox
import com.neura.os.app.data.FailureRing
import com.neura.os.app.data.ResponseCache
import com.neura.os.app.data.PullDetail
import com.neura.os.app.data.PullSummary
import com.neura.os.app.data.ReviewEvent
import com.neura.os.app.data.responseCacheKey
import com.neura.os.app.data.Persona
import com.neura.os.app.data.PromptTemplate
import com.neura.os.app.data.PhoneAction
import com.neura.os.app.data.sealAction
import com.neura.os.app.data.PUTER_PROVIDER
import com.neura.os.app.data.ProviderInfo
import com.neura.os.app.data.Repository
import com.neura.os.app.data.SessionManager
import com.neura.os.app.data.approvalFor
import com.neura.os.app.data.buildChatBody
import com.neura.os.app.data.MAX_TOOL_ROUNDS
import com.neura.os.app.data.MAX_TOOL_STEPS_PER_TURN
import com.neura.os.app.data.ToolApproval
import com.neura.os.app.data.ToolCall
import com.neura.os.app.data.ToolCallCollector
import com.neura.os.app.data.looksLikeToolsUnsupported
import com.neura.os.app.data.modeLabel
import com.neura.os.app.data.parseArguments
import com.neura.os.app.data.parsePhoneAction
import com.neura.os.app.data.runLocalTool
import com.neura.os.app.data.sealAction
import com.neura.os.app.data.systemPrompt
import com.neura.os.app.data.toolBudget
import com.neura.os.app.data.toolsForMode
import com.neura.os.app.data.deriveTitle
import com.neura.os.app.data.keepEarlierReply
import com.neura.os.app.data.personaFor
import com.neura.os.app.ReplyService
import com.neura.os.app.normalizeBaseUrl
import java.util.UUID
import java.util.concurrent.Executors

private const val UI_STATE_KEY = "ui_state"
private const val DRAFT_SAVE_BUDGET = 50_000
/** How often a streaming reply's draft is written to disk, so a process kill
 * part-way through does not lose the whole turn. */
private const val STREAM_PERSIST_MS = 2_000L

/** All app state for the native screens. Network and disk work runs on a
 * small pool; every state change is posted back to the main thread, which
 * is the only thread Compose state is written from.
 *
 * @Stable because the compiler cannot infer it. The class holds an Executor,
 * a Handler and a Context, so it reads as unstable, and roughly 30
 * composables take one. Unstable meant every one of them was non-skippable
 * AND any lambda capturing it was rebuilt rather than memoised, so each
 * streaming state write recomposed the whole screen instead of just the turn
 * that changed. Identity still does not change; the fields the screens read
 * are still observable state, which is what makes the writes work. */
@Stable
class AppViewModel(app: Application, private val saved: SavedStateHandle) : AndroidViewModel(app) {
    val store = SecureStore(app)
    private val repo = Repository(app)
    private val session = SessionManager(store)
    private val api = NativeApi(session)
    // Every IO block runs through this guard: an exception on a pool thread
    // would otherwise end the process (a full disk on save, a Keystore fault),
    // and a block posted after the pool is shut down would throw on main.
    private val pool = Executors.newFixedThreadPool(3)
    // Background work has an owner (docs/android-master-plan.md, V3): every
    // io block is a child job of viewModelScope on this pool, so clearing the
    // view model cancels what is still queued, and a failure lands in
    // [ioFailures] -- the same failure ring and notice the old executor
    // guard produced -- instead of ending the process.
    private val ioDispatcher = pool.asCoroutineDispatcher()
    private val ioFailures = CoroutineExceptionHandler { _, e ->
        val reason = e.message ?: e.javaClass.simpleName
        recordFailure("app", reason)
        showNotice("Something went wrong: $reason")
    }

    /** Runs [block] off the main thread as a job this view model owns: a
     * save or a delete nobody waits for. */
    private fun launchIo(block: () -> Unit): Job = viewModelScope.launch(ioDispatcher + ioFailures) { block() }

    /** Starts work this view model owns, on the main thread, where Compose
     * state is written; its blocking calls go through [onIo]. Clearing the
     * view model cancels it. */
    private fun work(block: suspend CoroutineScope.() -> Unit): Job = viewModelScope.launch(ioFailures, block = block)

    /** A blocking call (network, disk) on the pool; the caller suspends until
     * it returns and carries on on its own thread. */
    private suspend fun <T> onIo(block: () -> T): T = withContext(ioDispatcher) { block() }

    /** For blocking code already on the pool (the reply loop, drawing) that
     * must write Compose state: posted to the main thread. */
    private val main = Handler(Looper.getMainLooper())
    private val context = app.applicationContext

    // Decided in [init] on the pool, not here. Reading store.session or
    // store.password opens the Keystore, and doing that in a property
    // initializer meant two keystore round-trips on the main thread during
    // onCreate, before the first frame. The UI already renders a loading
    // state until `loaded` flips, so it is correct for this to arrive with
    // the rest of the disk state.
    var signedIn by mutableStateOf(false)
        private set
    var signInBusy by mutableStateOf(false)
        private set
    var signInError by mutableStateOf<String?>(null)
        private set

    var nav by mutableStateOf(NavState())
        private set
    val screen: Route? get() = nav.screen
    val currentTab: Tab get() = nav.currentTab
    val canGoBack: Boolean get() = nav.screen != null
    /** The chat on screen. A fresh one exists from the moment it is opened but
     * is only saved and listed once it has a message. */
    var currentChatId by mutableStateOf<String?>(null)
        private set

    val conversations = mutableStateListOf<Conversation>()
    var library by mutableStateOf(Library())
        private set
    var loaded by mutableStateOf(false)
        private set

    var providers by mutableStateOf<List<ProviderInfo>>(emptyList())
        private set
    val models = mutableStateMapOf<String, List<ModelInfo>>()
    var catalogueError by mutableStateOf<String?>(null)
        private set
    var catalogueBusy by mutableStateOf(false)
        private set
    /** What the server reports about its own timeouts and retries. */
    var limits by mutableStateOf<Limits?>(null)
        private set

    /** The installed skill catalogue from GET /api/skills. */
    var skills by mutableStateOf<List<Skill>>(emptyList())
        private set
    /** The Automate tab's history of runs, persisted on device. */
    var automations by mutableStateOf<List<AutomationEntry>>(emptyList())
        private set
    /** Scheduled recipes (data/Schedules.kt), armed as alarms. */
    var schedules by mutableStateOf<List<RecipeSchedule>>(emptyList())
        private set
    /** SKILL.md text by name, fetched once per skill for the chats that pin it. */
    private val skillBodies = java.util.concurrent.ConcurrentHashMap<String, String>()
    /** A long client-side answer to a slash command (/help, /doctor), shown in
     * a sheet. Command replies never enter the transcript, so a model is never
     * sent "Commands: ..." as if it had said it. */
    var commandInfo by mutableStateOf<String?>(null)

    var streamingId by mutableStateOf<String?>(null)

    /** When the current reply started, so a second tap on Send does not land on Stop. */
    @Volatile var streamStartedAt = 0L
        private set
    /** Text waiting in a chat's composer, per chat. */
    val drafts = mutableStateMapOf<String, String>()
    /** Photos shared into the app, waiting in a chat's composer. */
    val pendingPhotos = mutableStateMapOf<String, List<String>>()

    var imageBusy by mutableStateOf(false)
        private set
    var imageError by mutableStateOf<String?>(null)
        private set

    /** One-shot messages for a snackbar. */
    private val noticeQueue = NoticeQueue()

    /** One-shot snackbar messages, shown once each, in order, by the app
     * root's NoticeHost -- whatever page is on screen (data/Notices.kt). */
    val notices: Flow<String> get() = noticeQueue.notices

    /** Queues a snackbar message. Safe from any thread. */
    fun showNotice(text: String?) {
        noticeQueue.post(text)
    }

    /** The failures this run has shown, newest first, for Settings -> "Copy
     * diagnostics" (see data/Diagnostics.kt). Memory only: redacted and
     * clipped on the way in, never written to disk, gone on restart. */
    var failures by mutableStateOf(FailureRing())
        private set

    /** Safe from any thread: the ring is Compose state, so the write is
     * always posted to the main thread. */
    fun recordFailure(where: String, reason: String?) {
        val at = System.currentTimeMillis()
        main.post { failures = failures.record(at, where, reason) }
    }

    /** Bumped from NativeActivity.onResume, so a composable can key a
     * LaunchedEffect on it to re-check something Android controls outside
     * the app -- like whether Device control's accessibility service is on
     * -- the moment the person comes back from Settings. */
    var resumeTick by mutableStateOf(0)

    /** Chats owed a reply that a connectivity failure kept from arriving.
     * Drained by [drainOutbox], which NativeActivity calls from its own
     * ConnectivityManager callback when the network comes back, and again
     * from onResume as a safety net for a process that was killed outright. */
    var outbox by mutableStateOf(Outbox())
        private set

    init {
        // Covers an account signed in before this existed: without this, the
        // hidden Puter WebView stays 401'd on puter-bridge.html until the
        // next fresh sign-in or silent re-auth happens to run. Every other
        // caller (signIn, silentSignIn, signOut) keeps WebView's cookie jar
        // in step with store.session from here on; this is the one-time
        // catch-up for whatever store.session already held when the app
        // launched. A no-op when nobody is signed in yet.
        store.server?.let { server -> WebShell.syncSessionCookie(server, store.session) }
        work {
            val disk = onIo {
                val savedSchedules = repo.loadSchedules()
                // Alarms do not survive a reboot or an update; every start re-arms
                // them, so a boot broadcast that never came costs nothing.
                RecipeAlarms.armAll(getApplication<Application>(), savedSchedules)
                if (store.offlineAnswers) responseCache = repo.loadResponseCache()
                OnDisk(repo.loadConversations(), repo.loadLibrary(), repo.loadOutbox(), repo.loadAutomations(), savedSchedules)
            }
            // Read here rather than in a property initializer: opening the
            // Keystore costs 5-30ms and this runs on the pool.
            signedIn = store.server != null && (store.session != null || store.password != null)
            // A chat started before the disk was read (a shared photo, a
            // notification tap) is kept rather than replaced by the load.
            val fresh = conversations.filter { open -> disk.chats.none { it.id == open.id } }
            conversations.clear()
            conversationIndex.clear()
            conversations.addAll(fresh + disk.chats)
            conversationIndex.clear()
            conversations.forEachIndexed { i, c -> conversationIndex[c.id] = i }
            currentChatId?.let { id -> currentChat = conversation(id) }
            library = disk.library
            outbox = disk.outbox
            automations = disk.automations
            schedules = disk.schedules
            loaded = true
            // Inside the block, not after it: `work` launches, so signedIn is
            // still false on this line.
            if (signedIn) refreshCatalogue()
        }
    }

    private fun updateOutbox(next: Outbox) {
        outbox = next
        launchIo { repo.saveOutbox(next) }
    }

    /** Retries the oldest chat whose backoff has elapsed. Only one reply ever
     * streams at a time (runReply's own constraint), so a chat already
     * streaming -- including one this same call just started -- means
     * nothing else here can go yet; the rest stay queued for the next call. */
    fun drainOutbox() {
        val now = System.currentTimeMillis()
        for (entry in outbox.due(now)) {
            if (streamingId != null) break
            updateOutbox(outbox.attempted(entry.chatId, now))
            regenerate(entry.chatId)
        }
    }

    /** "Retry now" on a queued chat's banner: this chat, at once, whatever
     * its backoff says -- a person asking is not a flapping connection. */
    fun retryQueued(chatId: String) {
        if (streamingId != null || outbox.entries.none { it.chatId == chatId }) return
        updateOutbox(outbox.attempted(chatId, System.currentTimeMillis()))
        regenerate(chatId)
    }

    /** Process start to the first frame, in ms, measured once per process by
     * NativeActivity (master plan Phase 3); "Copy diagnostics" reports it
     * against the 2 s target. Null until measured. */
    var startupMs by mutableStateOf<Long?>(null)

    /** Opt-in offline answers (data/ResponseCache.kt). Read and written on
     * the io pool -- only one reply runs at a time -- so volatile is enough. */
    @Volatile private var responseCache = ResponseCache()

    /** Settings -> "Offline answers". Turning it off also deletes what was
     * kept, so the switch means what it says. */
    /** Settings -> App -> Theme; NativeActivity.applyTheme() turns it into
     * Palette.isDark and the system bar icons. */
    var themeMode by mutableStateOf(store.themeMode)
        private set

    fun setTheme(mode: String) {
        store.themeMode = mode
        themeMode = store.themeMode
    }

    var offlineAnswers by mutableStateOf(store.offlineAnswers)
        private set

    fun setOfflineAnswersOn(on: Boolean) {
        store.offlineAnswers = on
        offlineAnswers = on
        if (!on) {
            responseCache = ResponseCache()
            launchIo { repo.deleteResponseCache() }
        }
    }

    override fun onCleared() {
        // viewModelScope is cancelled by now: the reply, the build stream and
        // every load have stopped, and their connections are closed.
        pool.shutdownNow()
        // Stop the foreground service here too. runReply starts it and then
        // stops it in a `finally`, but that finally never runs if
        // viewModelScope was already cancelled on the line after start --
        // and a foreground service keeps the process alive, so a skipped stop
        // leaves a permanent "Replying..." notification until the user
        // force-stops the app.
        ReplyService.stop(getApplication())
        super.onCleared()
    }

    // --- Remote builds -------------------------------------------------------
    // The phone plans; the server builds. State and streaming live in
    // RemoteBuilds; these are the entry points the screens use.

    val builds = RemoteBuilds(api, viewModelScope, ioDispatcher)

    // --- Restore after Android closes the app in the background ------------------
    // Chats are already on disk; what would be lost is where you were. The
    // provider is read only when Android saves, so it always has the latest.

    init {
        saved.get<Bundle>(UI_STATE_KEY)?.let { restoreUiState(it) }
        saved.setSavedStateProvider(UI_STATE_KEY) { saveUiState() }
    }

    private fun saveUiState(): Bundle = Bundle().apply {
        putString("chat", currentChatId)
        putString("tab", nav.currentTab.name)
        val entries = ArrayList<String>()
        Tab.entries.forEach { tab -> nav.stacks[tab].orEmpty().forEach { entries.add(tab.name + "|" + it.screenKey()) } }
        putStringArrayList("nav", entries)
        builds.current?.id?.let { putString("build", it) }
        // Drafts are capped so a long paste cannot overflow the saved-state limit.
        val kept = Bundle()
        var budget = DRAFT_SAVE_BUDGET
        drafts.forEach { (chatId, text) ->
            if (text.isNotEmpty() && text.length <= budget) {
                kept.putString(chatId, text)
                budget -= text.length
            }
        }
        putBundle("drafts", kept)
    }

    private fun restoreUiState(state: Bundle) {
        currentChatId = state.getString("chat")
        state.getBundle("drafts")?.let { kept -> kept.keySet().forEach { id -> kept.getString(id)?.let { drafts[id] = it } } }
        val buildId = state.getString("build")
        var restored = NavState()
        state.getStringArrayList("nav").orEmpty().forEach { entry ->
            val parts = entry.split("|", limit = 2)
            if (parts.size != 2) return@forEach
            val tab = Tab.entries.firstOrNull { it.name == parts[0] } ?: return@forEach
            val screen = screenFromKey(parts[1]) ?: return@forEach
            if (screen == Route.Build) {
                if (buildId == null || !signedIn) return@forEach
                builds.open(buildId)
            }
            restored = restored.copy(stacks = restored.stacks + (tab to (restored.stacks[tab].orEmpty() + screen)))
        }
        val savedTab = state.getString("tab")?.let { name -> Tab.entries.firstOrNull { it.name == name } }
        nav = if (savedTab != null) restored.copy(currentTab = savedTab) else restored
    }

    fun openBuild(id: String) {
        builds.open(id)
        nav = nav.pushed(Route.Activity).pushed(Route.Build)
    }

    /** Hands [plan] (a Plan-mode reply) to the server and opens the build. */
    fun startRemoteBuild(plan: String) {
        if (builds.actionBusy) return
        showNotice("Starting the build on the server…")
        builds.start(
            currentChatId ?: "",
            plan,
            onStarted = { push(Route.Build) },
            onFailed = { message ->
                recordFailure("build", message)
                showNotice("Build not started: $message")
            },
        )
    }

    // --- Navigation --------------------------------------------------------

    fun push(target: Route) { nav = nav.pushed(target) }

    /** Builds live in the Activity space: open it there, whichever space is showing. */
    fun openBuilds() { nav = nav.pushed(Route.Activity).pushed(Route.Builds) }

    /** The Go anywhere sheet (ui/GoAnywhere.kt) is open. */
    var goAnywhereOpen by mutableStateOf(false)

    fun selectTab(tab: Tab) { nav = nav.selectedTab(tab) }

    /** Returns to the chat home from any page, leaving the current chat as is. */
    fun goToChat() { nav = nav.switchedToChat() }

    /** Jumps straight to a tab's root, discarding anything drilled into it --
     * for entry points (a launcher shortcut) that mean "show me X". */
    fun resetTab(tab: Tab) { nav = nav.reset(tab) }

    /** Returns false when there was nothing to go back to. */
    fun back(): Boolean {
        val next = nav.poppedOrNull() ?: return false
        nav = next
        return true
    }

    // --- Sign-in -------------------------------------------------------------

    fun signIn(serverText: String, username: String, password: String) {
        val checked = normalizeBaseUrl(serverText)
        if (checked is BaseUrlResult.Problem) {
            signInError = checked.message
            return
        }
        val server = (checked as BaseUrlResult.Ok).url
        if (username.isBlank() || password.isEmpty()) {
            signInError = "Enter the username and the password."
            return
        }
        signInBusy = true
        signInError = null
        work {
            try {
                val cookie = onIo { ChatApi(server).login(username.trim(), password) }
                if (store.server != server) store.clearSession()
                store.server = server
                store.username = username.trim()
                store.password = password
                store.session = cookie
                WebShell.syncSessionCookie(server, cookie)
                signedIn = true
                refreshCatalogue()
            } catch (e: ApiException) {
                signInError = e.message
            } finally {
                signInBusy = false
            }
        }
    }

    /** Signs out on the server and forgets the password. [erase] also deletes
     * every chat, image and custom persona stored on the phone. */
    fun signOut(erase: Boolean) {
        val server = store.server ?: ""
        val cookie = store.session
        if (server.isNotEmpty()) WebShell.syncSessionCookie(server, null)
        launchIo {
            if (server.isNotEmpty()) {
                val client = ChatApi(server)
                client.sessionCookie = cookie
                client.logout()
            }
            if (erase) repo.eraseEverything()
        }
        store.clearSecrets()
        // Not inside `if (erase)`. Both of these are per-account state:
        // leaving the outbox queued means the next drainOutbox -- which
        // onResume calls -- replays this account's unsent message after a
        // different account has signed in, using that account's session.
        // The offline cache is keyed on model+questions, not on who asked,
        // so without this the next person to sign in on this phone is shown
        // the previous person's cached answers.
        updateOutbox(Outbox())
        responseCache = ResponseCache()
        if (erase) {
            schedules.forEach { RecipeAlarms.cancel(getApplication<Application>(), it.id) }
            schedules = emptyList()
            conversations.clear()
            conversationIndex.clear()
            currentChat = null
            library = Library()
            // The plaintext crash log is the one file this app writes outside
            // the sealed store, and it was the one thing "erase everything"
            // left on disk.
            launchIo { repo.deleteCrashLog(getApplication()) }
        }
        nav = NavState()
        providers = emptyList()
        models.clear()
        signedIn = false
    }

    /** Re-signs in with the password the app already holds when the server's
     * session lapses, so a turn in flight finishes instead of dumping the user
     * at the sign-in screen. False means the password is gone or was refused. */
    private fun silentSignIn(): Boolean {
        val server = store.server ?: return false
        val username = store.username ?: return false
        val password = store.password ?: return false
        return try {
            val cookie = ChatApi(server).login(username, password)
            store.session = cookie
            WebShell.syncSessionCookie(server, cookie)
            true
        } catch (e: Exception) {
            false
        }
    }

    val serverUrl: String get() = store.server ?: ""
    val username: String get() = store.username ?: ""

    // --- Providers and models ---------------------------------------------------

    /** Runs a read, re-signing in once if the server says the session lapsed. */
    private fun <T> reauthing(block: () -> T): T = try {
        block()
    } catch (e: ApiException) {
        if (e.authRequired && silentSignIn()) block() else throw e
    }

    fun refreshCatalogue() {
        if (catalogueBusy) return
        catalogueBusy = true
        catalogueError = null
        work {
            try {
                val served = onIo { reauthing { api.providers() } }
                // Puter answers in the browser on the user's own allowance, so
                // the server has no row for it; the app adds one because the
                // app is what can reach it.
                val list = if (puterChat != null) served + ProviderInfo(PUTER_PROVIDER, "Puter (your account)", true, "chat") else served
                providers = list
                catalogueBusy = false
                if (list.isEmpty()) catalogueError = "The server has no chat provider configured."
                // Warm the default provider's models so a new chat can start at once.
                val preferred = library.defaultProvider.takeIf { id -> list.any { it.id == id } } ?: list.firstOrNull()?.id
                if (preferred != null) fetchModels(preferred)
            } catch (e: ApiException) {
                recordFailure("providers", e.message)
                catalogueBusy = false
                catalogueError = e.message
                if (e.authRequired) signedIn = false
            }
        }
    }

    private suspend fun fetchModels(provider: String) {
        try {
            models[provider] = onIo { reauthing { if (provider == PUTER_PROVIDER) api.puterModels() else api.models(provider) } }
        } catch (e: ApiException) {
            showNotice(e.message)
        }
    }

    fun loadModels(provider: String) {
        if (models.containsKey(provider)) return
        work { fetchModels(provider) }
    }

    /** Reads the server's timeouts and retry budget for the Settings screen. */
    fun loadLimits() {
        work {
            onIo { try { api.limits() } catch (e: Exception) { null } }?.let { limits = it }
        }
    }

    /** Fills the Skills screen from the server's installed catalogue. */
    fun loadSkills(force: Boolean = false) {
        if (!force && skills.isNotEmpty()) return
        work {
            onIo { try { api.skills() } catch (e: Exception) { null } }?.let { skills = it }
        }
    }

    // --- Automations ------------------------------------------------------------

    /** Records an automation run and persists it. */
    fun recordAutomationRun(prompt: String) {
        val next = recordAutomation(automations, prompt, System.currentTimeMillis())
        automations = next
        launchIo { repo.saveAutomations(next) }
    }

    /** Kicks off an automation prompt through the ordinary agent pipeline:
     * a fresh chat sends it, and any phone action it proposes waits for the
     * user's tap, exactly as in a hand-typed chat. */
    fun runAutomation(prompt: String) {
        val text = prompt.trim()
        if (text.isEmpty()) return
        val chatId = newChat()
        recordAutomationRun(text)
        send(chatId, text)
    }

    // --- Scheduled recipes ------------------------------------------------------

    /** Saves a new schedule, or changes the one with [id]; the reason it was
     * refused otherwise. It only ever reminds: see RecipeAlarmReceiver. */
    fun saveSchedule(id: String?, prompt: String, hour: Int, minute: Int, days: Set<Int>): String? {
        validateSchedule(prompt, hour, minute, days)?.let { return it }
        val schedule = RecipeSchedule(
            id = id ?: UUID.randomUUID().toString().replace("-", "").take(16),
            prompt = prompt.trim(),
            hour = hour,
            minute = minute,
            days = days,
        )
        if (schedules.none { it.id == schedule.id } && schedules.size >= SCHEDULE_MAX) {
            return "At most $SCHEDULE_MAX schedules. Delete one first."
        }
        storeSchedules(upsertSchedule(schedules, schedule))
        RecipeAlarms.arm(getApplication<Application>(), schedule)
        return null
    }

    fun setScheduleEnabled(id: String, on: Boolean) {
        val schedule = schedules.firstOrNull { it.id == id } ?: return
        val changed = schedule.copy(enabled = on)
        storeSchedules(upsertSchedule(schedules, changed))
        if (on) RecipeAlarms.arm(getApplication<Application>(), changed) else RecipeAlarms.cancel(getApplication<Application>(), id)
    }

    fun deleteSchedule(id: String) {
        storeSchedules(schedules.filter { it.id != id })
        RecipeAlarms.cancel(getApplication<Application>(), id)
    }

    private fun storeSchedules(next: List<RecipeSchedule>) {
        schedules = next
        launchIo { repo.saveSchedules(next) }
    }

    /** A scheduled recipe's notification was tapped: a new chat with the
     * prompt typed in, waiting for Send. Read from disk, since a cold start
     * may not have loaded the list yet. */
    fun openScheduledRecipe(id: String) {
        work {
            val schedule = onIo { repo.loadSchedules().firstOrNull { it.id == id } }
            if (schedule != null) newChat(draft = schedule.prompt)
        }
    }

    /** The SKILL.md shown in the Skills detail sheet, keyed by skill name. */
    var skillDetail by mutableStateOf<Pair<String, String>?>(null)
        private set

    /** Fetches a skill's SKILL.md for the detail sheet off the main thread. */
    fun loadSkillInstructions(name: String) {
        work {
            val body = onIo { skillBody(name) } ?: ""
            skillDetail = name to body
        }
    }

    /** One skill's SKILL.md, cached for the chats that pin it. */
    private fun skillBody(name: String): String? {
        skillBodies[name]?.let { return it }
        val body = try { api.skillContent(name).body } catch (e: Exception) { null } ?: return null
        skillBodies[name] = body
        return body
    }

    /** The provider and model a new chat starts on. */
    private fun startingModel(): Pair<String, String> {
        val provider = library.defaultProvider.takeIf { id -> providers.any { it.id == id } } ?: providers.firstOrNull()?.id ?: ""
        val model = if (provider == library.defaultProvider && library.defaultModel.isNotEmpty()) library.defaultModel
        else models[provider]?.firstOrNull()?.id ?: ""
        return provider to model
    }

    // --- Chats -----------------------------------------------------------------

    /** The chat on screen, as its own observable.
     *
     * The screens used to reach it with `vm.conversation(currentChatId)`,
     * which does a `firstOrNull` over [conversations] -- a SnapshotStateList.
     * Reading a list like that registers the reader against the *whole* list,
     * so every `conversations[i] = ...` invalidated every screen: each of the
     * ~17 streaming publishes a second recomposed the whole chat screen,
     * top bar and composer included, no matter what actually changed. This
     * field is written in exactly the places that change the open chat, so a
     * screen reading it invalidates only when the open chat's identity moves. */
    var currentChat: Conversation? by mutableStateOf(null)
        private set

    fun conversation(id: String): Conversation? = conversations.firstOrNull { it.id == id }

    fun openChat(id: String) {
        pruneEmptyConversations(keep = id)
        currentChatId = id
        currentChat = conversation(id)
        nav = nav.switchedToChat()
    }

    /** Drops chats that never got a message. [conversationIndex] is rebuilt
     * rather than patched, because removeAll shifts everything after the
     * first removal. */
    private fun pruneEmptyConversations(keep: String) {
        val before = conversations.size
        conversations.removeAll { it.messages.isEmpty() && it.id != keep && it.id != streamingId }
        if (conversations.size == before) return
        conversationIndex.clear()
        conversations.forEachIndexed { i, c -> conversationIndex[c.id] = i }
    }

    /** The chat on screen, creating a fresh one when there is none. */
    fun currentOrNew(): Conversation {
        currentChatId?.let { id -> conversation(id)?.let { return it } }
        return conversation(newChat())!!
    }

    /** Keeps [currentChat] in step with [currentChatId] for the paths that
     * change one without the other. */
    fun syncCurrentChat() {
        currentChat = currentChatId?.let { conversation(it) }
    }

    fun newChat(personaId: String = DEFAULT_PERSONA_ID, draft: String = "", mode: String = "chat"): String {
        val now = System.currentTimeMillis()
        val (provider, model) = startingModel()
        // An untouched empty chat is replaced rather than stacked up.
        conversations.removeAll { it.messages.isEmpty() && it.id != streamingId }
        val chat = Conversation(UUID.randomUUID().toString(), "New chat", personaId, provider, model, emptyList(), now, now, mode = mode)
        conversations.add(chat)
        conversationIndex[chat.id] = conversations.lastIndex
        if (chat.id == currentChatId) currentChat = chat
        if (draft.isNotEmpty()) drafts[chat.id] = draft
        nav = nav.switchedToChat()
        currentChatId = chat.id
        currentChat = chat
        return chat.id
    }

    private fun replace(updated: Conversation, persist: Boolean = true) {
        val index = conversationIndex[updated.id] ?: -1
        if (index >= 0) conversations[index] = updated else {
            conversations.add(updated)
            conversationIndex[updated.id] = conversations.lastIndex
        }
        if (updated.id == currentChatId) currentChat = updated
        if (persist && updated.messages.isNotEmpty()) launchIo { repo.saveConversation(updated) }
    }

    /** chat id -> position in [conversations]. replace() ran an
     * indexOfFirst over the whole list on every write, i.e. once per
     * streaming publish, so this was O(chats) each time. */
    private val conversationIndex = HashMap<String, Int>()

    fun setModel(id: String, provider: String, model: String, makeDefault: Boolean) {
        val chat = conversation(id) ?: return
        replace(chat.copy(provider = provider, model = model))
        if (makeDefault) updateLibrary(library.copy(defaultProvider = provider, defaultModel = model))
    }

    fun setPersona(id: String, personaId: String) {
        val chat = conversation(id) ?: return
        replace(chat.copy(personaId = personaId))
    }

    fun rename(id: String, title: String) {
        val chat = conversation(id) ?: return
        replace(chat.copy(title = title.trim().ifEmpty { chat.title }))
    }

    fun togglePin(id: String) {
        val chat = conversation(id) ?: return
        replace(chat.copy(pinned = !chat.pinned))
    }

    /** Hides a chat from the drawer's dated sections without deleting it --
     * it stays in Archived and in search, and can be brought back the same
     * way it was put away. */
    fun toggleArchive(id: String) {
        val chat = conversation(id) ?: return
        replace(chat.copy(archived = !chat.archived))
    }

    fun delete(id: String) {
        if (streamingId == id) stop()
        conversations.removeAll { it.id == id }
        conversationIndex.remove(id)
        drafts.remove(id)
        if (currentChatId == id) {
            currentChatId = null
            currentChat = null
        }
        // The outbox entry too: leaving it queued means the next drainOutbox
        // finds a chat that is no longer on disk, and -- worse -- after a
        // sign-out and a different sign-in it would replay this account's
        // message under the next one's session.
        updateOutbox(outbox.acked(id))
        launchIo { repo.deleteConversation(id) }
    }

    /** Which schedule the Automate screen's editor is open on; null when it is
     * closed. This lives here rather than in the composable because the two
     * app-bar actions that open it are rendered by NativeActivity's Page, not
     * by AutomationScreen -- which is exactly why AutomationScreen used to
     * carry a second TopAppBar, stacking a duplicate "Automate" title above
     * the real one. */
    var editingSchedule by mutableStateOf<RecipeSchedule?>(null)
        private set

    /** Whether the "Build Automation" dialog is open. Same reason as
     * [editingSchedule]. */
    var automationBuilderOpen by mutableStateOf(false)
        private set

    fun newSchedule() {
        editingSchedule = com.neura.os.app.data.RecipeSchedule("", "", 8, 0, com.neura.os.app.data.WEEKDAYS)
    }

    fun editSchedule(schedule: RecipeSchedule) {
        editingSchedule = schedule
    }

    fun closeSchedule() {
        editingSchedule = null
    }

    fun newAutomation() {
        automationBuilderOpen = true
    }

    fun closeAutomationBuilder() {
        automationBuilderOpen = false
    }

    /** Appends one message to a chat and saves it. Used by an approved device
     * read: the labelled elements have to land in the conversation, because
     * the model can only see them on a later turn and the user has to be able
     * to see what the app read on their behalf. */
    fun appendUserMessage(chatId: String, text: String) {
        val existing = conversation(chatId) ?: return
        publishChat(
            existing.copy(messages = existing.messages + ChatMessage("user", text, createdAt = System.currentTimeMillis())),
            persist = true,
        )
    }

    /** A human name for a package, for an approval button that has to say
     * which app it will act on. Null when the package cannot be resolved. */
    fun appLabel(pkg: String): String? = try {
        val info = getApplication<Application>().packageManager.getApplicationInfo(pkg, 0)
        getApplication<Application>().packageManager.getApplicationLabel(info)?.toString()
    } catch (e: Exception) {
        null
    }

    fun deleteAllChats() {
        stop()
        conversations.clear()
        conversationIndex.clear()
        drafts.clear()
        currentChatId = null
        currentChat = null
        responseCache = ResponseCache()
        launchIo {
            repo.deleteAllConversations()
            repo.deleteResponseCache()
        }
    }

    /** True when the message was accepted, so the composer can let go of the
     * photos it was holding; false leaves them attached for another try. */
    // --- Compare -------------------------------------------------------------------

    /** The composer's Compare toggle: while on, the next send asks a second
     * provider/model the same question and shows both replies side by side,
     * instead of the usual single reply. */
    var compareArmed by mutableStateOf(false)

    /** The second target Compare will use, or null when there is nothing to
     * compare [chat] against yet (catalogue still loading, or only one
     * chat-capable provider/model configured). Recompute whenever Compare is
     * armed or the chat's own provider/model or the catalogue changes -- a
     * stale target left over from a different chat would silently compare
     * against the wrong pair. */
    var compareTarget by mutableStateOf<CompareTarget?>(null)
        private set

    fun refreshCompareTarget(chat: Conversation) {
        compareTarget = if (!compareArmed || chat.provider.isEmpty() || chat.model.isEmpty() || chat.provider == PUTER_PROVIDER) {
            null
        } else {
            defaultCompareTarget(CompareTarget(chat.provider, chat.model), providers.filter { it.id != PUTER_PROVIDER }, models)
        }
    }

    fun send(id: String, text: String, images: List<String> = emptyList()): Boolean {
        val chat = conversation(id) ?: return false
        val trimmed = text.trim()
        if ((trimmed.isEmpty() && images.isEmpty()) || streamingId != null) return false
        if (images.isEmpty() && handleCommand(id, trimmed)) return true
        if (chat.provider.isEmpty() || chat.model.isEmpty()) {
            showNotice("Pick a model first (tap the model name at the top).")
            return false
        }
        val now = System.currentTimeMillis()
        val withUser = chat.copy(
            title = if (chat.messages.none { it.role == "user" }) deriveTitle(trimmed.ifEmpty { "Photo" }) else chat.title,
            messages = chat.messages + ChatMessage("user", trimmed, createdAt = now, images = images),
            updatedAt = now,
        )
        drafts.remove(id)
        replace(withUser)
        val primary = CompareTarget(chat.provider, chat.model)
        val compare = compareTarget
        if (compareArmed && compare != null && compareTargetsValid(primary, compare)) {
            runCompareReply(withUser, primary, compare)
        } else {
            runReply(withUser)
        }
        return true
    }

    /** Asks again for the last reply: drops it and streams a new one. */
    fun regenerate(id: String) {
        val chat = conversation(id) ?: return
        if (streamingId != null) return
        val lastUser = chat.messages.indexOfLast { it.role == "user" }
        if (lastUser < 0) return
        // The answer being replaced stays as an earlier version the canvas
        // can show (data/Anatomy.kt keepEarlierReply); it is never re-sent.
        val trimmed = chat.copy(messages = keepEarlierReply(chat.messages, lastUser), updatedAt = System.currentTimeMillis())
        replace(trimmed)
        runReply(trimmed)
    }

    /** Edits the user message at [index] and asks again from there. With
     * [branch] the original chat is left untouched and the edit continues in
     * a new chat; otherwise everything after the edit is replaced. */
    fun editMessage(id: String, index: Int, text: String, branch: Boolean) {
        val chat = conversation(id) ?: return
        val original = chat.messages.getOrNull(index) ?: return
        if (original.role != "user" || text.isBlank() || streamingId != null) return
        val now = System.currentTimeMillis()
        val kept = chat.messages.subList(0, index) + original.copy(content = text.trim(), createdAt = now)
        val target = if (branch) {
            chat.copy(id = UUID.randomUUID().toString(), title = chat.title + " (branch)", messages = kept, createdAt = now, updatedAt = now, pinned = false)
        } else {
            chat.copy(messages = kept, updatedAt = now)
        }
        replace(target)
        if (branch) {
            currentChatId = target.id
            currentChat = target
        }
        runReply(target)
    }

    /** A copy of the chat up to and including message [index]. */
    fun forkAt(id: String, index: Int) {
        val chat = conversation(id) ?: return
        val now = System.currentTimeMillis()
        val copy = chat.copy(
            id = UUID.randomUUID().toString(),
            title = chat.title + " (branch)",
            messages = chat.messages.take(index + 1).filter { !it.error },
            createdAt = now, updatedAt = now, pinned = false,
        )
        replace(copy)
        currentChatId = copy.id
        currentChat = copy
    }

    /** The reply streaming now (runReply or runCompareReply). Stop cancels
     * it: the stream's collector goes away, which closes the connection
     * (data/Streams.kt), and the loop checks [replyStopped] between steps. */
    @Volatile private var replyJob: Job? = null
    /** Set by the Puter draw bridge so stop() can unblock a draw parked in
     * drawBlocking. See stop(). */
    @Volatile var puterDrawRelease: (() -> Unit)? = null

    private fun replyStopped(): Boolean = replyJob?.isCancelled == true

    /** Runs a reply loop on the pool (it is full of blocking steps: tools,
     * skills, disk) as a job this view model owns. */
    private fun launchReply(block: suspend CoroutineScope.() -> Unit): Job =
        viewModelScope.launch(ioDispatcher + ioFailures, block = block)

    fun stop() {
        replyJob?.cancel()
        ReplyService.stop(context)
        // Puter draws are driven by the WebView bridge on the main thread and
        // parked in drawBlocking on a pool thread, so cancelling the reply job
        // does not reach them. Releasing the bridge is what unblocks the
        // await; without this the Send/Stop button left a 150-second Puter
        // draw running and the user could not stop it.
        puterDrawRelease?.invoke()
    }

    fun setMode(id: String, mode: String) {
        val chat = conversation(id) ?: return
        if (mode !in com.neura.os.app.data.MODES) return
        replace(chat.copy(mode = mode))
    }

    /** The one moment a staged Build-mode write becomes real: [approvedPaths]
     * merge into the chat's files, everything else pending is dropped. */
    fun commitPendingWrites(id: String, approvedPaths: Set<String>) {
        val chat = conversation(id) ?: return
        replace(com.neura.os.app.data.commitWrites(chat, approvedPaths))
    }

    // --- Slash commands ---------------------------------------------------

    /** Runs a slash command locally. Returns true when [text] was a command and
     * must not be sent to the model. */
    fun handleCommand(id: String, text: String): Boolean {
        val chat = conversation(id) ?: return false
        val match = resolveSlash(text, skills.map { it.name }) ?: return false
        drafts.remove(id)
        when (match) {
            is SlashMatch.Skill -> {
                pinSkills(chat, listOf(match.name))
                showNotice("Using ${match.name} for this chat.")
            }
            is SlashMatch.Chain -> {
                pinSkills(chat, match.names)
                showNotice("Using " + match.names.joinToString(", ") + ".")
            }
            is SlashMatch.Known -> runKnownCommand(chat, match.name, match.args)
        }
        return true
    }

    /** Starts a chat with one skill already pinned, from the Skills screen. */
    fun newChatWithSkill(name: String) {
        val id = newChat()
        conversation(id)?.let { pinSkills(it, listOf(name)) }
        skillDetail = null
    }

    /** Pins a skill to the chat on screen -- skills accumulate, with no limit,
     * so more than one can ride along in a single chat. */
    fun pinSkillToCurrentChat(name: String) {
        val chat = currentOrNew()
        pinSkills(chat, listOf(name))
        showNotice("Pinned $name to this chat.")
    }

    /** Pin skills to a chat, fetching each SKILL.md once for its prompt. */
    private fun pinSkills(chat: Conversation, names: List<String>) {
        val added = names.map { it.lowercase() }.distinct().filter { it !in chat.skills }
        if (added.isNotEmpty()) replace(chat.copy(skills = chat.skills + added, updatedAt = System.currentTimeMillis()))
        added.forEach { name -> launchIo { skillBody(name) } }
    }

    /** Stops using a skill in this chat. The composer's chips call it, and so
     * does `/skill off <name>`, so both go through one path. */
    fun unpinSkill(id: String, name: String) {
        val chat = conversation(id) ?: return
        val skill = name.lowercase()
        if (skill !in chat.skills) return
        replace(chat.copy(skills = chat.skills - skill, updatedAt = System.currentTimeMillis()))
        showNotice("Stopped using $skill.")
    }

    private fun runKnownCommand(chat: Conversation, name: String, args: String) {
        when (name) {
            "help" -> commandInfo = renderCommandsHelp()
            "skills" -> commandInfo = if (chat.skills.isEmpty()) {
                "No skills pinned to this chat.\n\nType / and a skill name, or open Library → Skills."
            } else {
                "Pinned to this chat:\n\n" + chat.skills.joinToString("\n") { "- $it" }
            }
            "skill" -> {
                val arg = args.trim()
                when {
                    arg.isEmpty() -> commandInfo = renderCommandsHelp()
                    arg.lowercase().startsWith("off ") -> {
                        val skill = arg.substring(4).trim().lowercase()
                        replace(chat.copy(skills = chat.skills - skill))
                        showNotice("Stopped using $skill.")
                    }
                    else -> {
                        val skill = arg.split(Regex("\\s+")).first().lowercase()
                        pinSkills(chat, listOf(skill))
                        showNotice("Using $skill for this chat.")
                    }
                }
            }
            "mode" -> when (args.lowercase()) {
                "chat" -> { setMode(chat.id, "chat"); showNotice("Chat mode.") }
                "plan" -> { setMode(chat.id, "plan"); showNotice("Plan mode.") }
                "build" -> { setMode(chat.id, "build"); showNotice("Build mode: light edits to this chat's own files. Ask for a plan and tap \"Build remotely\" for anything bigger.") }
                else -> showNotice("Usage: /mode chat | plan | build")
            }
            "clear" -> {
                newChat()
                showNotice("New chat started.")
            }
            "compact" -> when (args.lowercase()) {
                "on" -> { replace(chat.copy(compact = true)); showNotice("Sending a shorter history.") }
                "off" -> { replace(chat.copy(compact = false)); showNotice("Sending the full history.") }
                else -> showNotice(if (chat.compact) "Compact is on." else "Compact is off.")
            }
            "doctor" -> commandInfo = doctorReport(chat)
        }
    }

    /** A local health read-out: what the phone knows without asking a model. */
    private fun doctorReport(chat: Conversation): String = buildString {
        append("**Doctor**\n\n")
        append("- Server: ").append(if (serverUrl.isEmpty()) "not set" else serverUrl).append('\n')
        append("- Session: ").append(if (signedIn) "signed in" else "signed out").append('\n')
        append("- Providers: ").append(providers.size)
        if (providers.isEmpty()) append(" — refresh in Tools → Status")
        append('\n')
        append("- Models loaded: ").append(models.size).append(" provider(s)\n")
        append("- Skills installed: ").append(skills.size)
        if (skills.isEmpty()) append(" — open Library → Skills to load")
        append('\n')
        append("- Mode: ").append(modeLabel(chat.mode)).append('\n')
        append("- Pinned skills: ").append(if (chat.skills.isEmpty()) "none" else chat.skills.joinToString(", ")).append('\n')
        append("- Compact: ").append(if (chat.compact) "on" else "off").append('\n')
        limits?.let { append("- Server budget: ").append(it.summary()).append('\n').append("- Timeouts: ").append(it.detail()).append('\n') }
    }

    /** Set when a reply finishes, so voice mode can read it aloud and listen again. */
    var finishedReply by mutableStateOf<Triple<String, String, Long>?>(null)
        private set

    /** Puts the worker's copy of a chat on screen without losing what the user
     * changed meanwhile (pin, title, mode). */
    private fun publishChat(worker: Conversation, persist: Boolean) {
        val write: () -> Unit = {
            conversation(worker.id)?.let { current ->
                replace(
                    current.copy(messages = worker.messages, tasks = worker.tasks, files = worker.files, updatedAt = System.currentTimeMillis()),
                    persist = persist,
                )
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) write() else main.post { write() }
    }

    /** The agent loop: stream a reply, run the tools it asks for, send the
     * results back, and repeat until the model answers in plain text. A model
     * that refuses tools is asked once more without them. */
    private fun runReply(start: Conversation) {
        streamingId = start.id
        streamStartedAt = System.currentTimeMillis()
        // Any earlier connectivity failure for this chat is superseded by
        // this attempt, whether it came from the user or from drainOutbox
        // itself -- it will be re-queued below if this attempt fails too.
        if (outbox.entries.any { it.chatId == start.id }) updateOutbox(outbox.acked(start.id))
        val lib = library
        ReplyService.start(context, start.id, start.title)
        replyJob = launchReply {
          try {
            var chat = start
            var useTools = true
            var round = 0
            var stepsTaken = 0
            var finalText = ""
            var authRetried = false
            var queueForRetry = false
            val seenCalls = HashMap<String, Int>()
            while (round <= MAX_TOOL_ROUNDS && !replyStopped()) {
                val persona = personaFor(lib, chat.personaId)
                val skillTexts = chat.skills.mapNotNull { skillBodies[it] ?: skillBody(it) }
                // A pinned skill whose text the server has not got is a skill
                // that is not applying, which is invisible from the chip alone.
                if (skillTexts.size < chat.skills.size && round == 0) {
                    main.post { showNotice("Some pinned skills could not be loaded, so they are not applying.") }
                }
                // Universal Image Vision: auto-describe images for text-only models
                if (round == 0) {
                    chat = autoDescribeImages(chat)
                }
                val body = buildChatBody(
                    chat.model,
                    systemPrompt(persona.systemPrompt, lib.instructions, chat.mode, skills = skillTexts),
                    chat.messages,
                    maxHistory = if (chat.compact) COMPACT_HISTORY_MESSAGES else MAX_HISTORY_MESSAGES,
                    tools = if (useTools && chat.provider != PUTER_PROVIDER) toolsForMode(chat.mode) else null,
                )
                val started = System.currentTimeMillis()
                val content = StringBuilder()
                val reasoning = StringBuilder()
                val collector = ToolCallCollector()
                var failure: String? = null
                var connectivityFailure = false
                var lastPost = 0L
                // When the first word of answer arrived after some reasoning:
                // "Thought for 12 s" (data/Anatomy.kt).
                var thoughtEnd = 0L
                val base = chat
                fun thoughtMs(): Long = if (thoughtEnd > 0L) thoughtEnd - started else 0L
                fun draft(rawError: String?): ChatMessage = when {
                    rawError == null -> ChatMessage("assistant", content.toString(), reasoning.toString(), started, model = chat.model, thoughtMs = thoughtMs())
                    content.isEmpty() -> ChatMessage("assistant", maskSecrets(rawError), createdAt = started, error = true, model = chat.model)
                    else -> ChatMessage("assistant", "$content\n\n⚠️ ${maskSecrets(rawError)}", reasoning.toString(), started, model = chat.model)
                }
                publishChat(base.copy(messages = base.messages + draft(null)), persist = false)
                // A process kill mid-reply used to lose every word of it. The
                // draft was only written at the end of the turn, and the
                // outbox only covers connectivity failures, so an OOM kill or
                // a battery-saver kill left the user's message on disk with no
                // reply and no error -- a turn that looked silently lost.
                // Write the draft through every STREAM_PERSIST_MS instead; the
                // 60ms cadence below is for the screen, not for the disk.
                var lastPersist = 0L
                fun postDraft() {
                    val now = System.currentTimeMillis()
                    val persist = now - lastPersist > STREAM_PERSIST_MS
                    if (persist) lastPersist = now
                    publishChat(base.copy(messages = base.messages + draft(null)), persist = persist)
                }
                try {
                    if (chat.provider == PUTER_PROVIDER) {
                        val bridge = puterChat ?: throw ApiException("Puter is only available in the app's own window.")
                        // Waits for Puter's answer without holding a thread, and
                        // stops waiting (and stops taking pieces) on Stop.
                        val reason = suspendCancellableCoroutine<String?> { waiting ->
                            main.post {
                                bridge(body, { piece ->
                                    if (waiting.isActive) {
                                        content.append(piece)
                                        val now = System.currentTimeMillis()
                                        if (now - lastPost > 60) {
                                            lastPost = now
                                            postDraft()
                                        }
                                    }
                                }, { error ->
                                    if (waiting.isActive) waiting.resume(error)
                                })
                            }
                        }
                        reason?.let { failure = it }
                    } else api.chatEvents(chat.provider, body).collect { event ->
                        when (event) {
                            is ChatEvent.Delta -> {
                                content.append(event.content)
                                reasoning.append(event.reasoning)
                                if (thoughtEnd == 0L && reasoning.isNotEmpty() && event.content.isNotEmpty()) thoughtEnd = System.currentTimeMillis()
                                val now = System.currentTimeMillis()
                                if (now - lastPost > 60) {
                                    lastPost = now
                                    postDraft()
                                }
                            }
                            is ChatEvent.ToolDelta -> collector.add(event)
                            is ChatEvent.ToolDeltas -> event.deltas.forEach { collector.add(it) }
                            is ChatEvent.Failure -> { failure = event.message; connectivityFailure = event.connectivity }
                            is ChatEvent.Partial -> failure = event.notice
                            ChatEvent.Done -> Unit
                        }
                    }
                } catch (e: CancellationException) {
                    // Stop: what arrived so far is kept, as below. Anything else
                    // cancelling this job (the view model going away) passes on.
                    if (!replyStopped()) throw e
                } catch (e: ApiException) {
                    failure = e.message
                    if (e.authRequired && !authRetried && silentSignIn()) {
                        authRetried = true
                        continue
                    }
                    if (e.authRequired) {
                        main.post {
                            // Say why the sign-in screen appeared instead of leaving
                            // the user to guess (the chat's error is only visible later).
                            signInError = "Your session expired. Sign in again to continue."
                            signedIn = false
                        }
                    }
                } catch (e: Exception) {
                    failure = e.message ?: "The reply failed."
                    connectivityFailure = e is java.io.IOException
                }
                val calls = collector.calls()
                val error = failure
                queueForRetry = error != null && connectivityFailure && content.isEmpty()
                if (error != null && useTools && content.isEmpty() && calls.isEmpty() && looksLikeToolsUnsupported(error)) {
                    useTools = false
                    continue
                }
                if (replyStopped() && content.isEmpty() && calls.isEmpty()) {
                    chat = base
                    break
                }
                if (error == null && content.isEmpty() && calls.isEmpty()) {
                    // A reply that is all thinking and no answer keeps its thinking
                    // on screen, and says what happened instead of "empty".
                    val why = if (reasoning.isNotEmpty()) "The model thought but did not write an answer (its output limit may be too small). Say \"continue\" to ask again." else "The model sent an empty reply. Try again or pick another model."
                    chat = base.copy(messages = base.messages + ChatMessage("assistant", why, reasoning.toString(), started, error = true, model = chat.model))
                    break
                }
                if (error != null) recordFailure("chat", chat.provider + "/" + chat.model + ": " + error)
                // Offline answers: a turn lost to the connection itself shows the
                // answer kept from the same questions before, marked cached, and
                // stays queued so a fresh reply replaces it once back online.
                val offline = if (queueForRetry && store.offlineAnswers) {
                    responseCacheKey(start.model, start.mode, start.messages)?.let { responseCache.lookup(it) }
                } else null
                if (offline != null) {
                    chat = base.copy(messages = base.messages + ChatMessage("assistant", offline.content, createdAt = started, model = offline.model, cached = true))
                    finalText = offline.content
                    break
                }
                val assistant = draft(error).copy(toolCalls = if (error == null) calls else emptyList())
                chat = base.copy(messages = base.messages + assistant)
                finalText = assistant.content
                if (error != null || calls.isEmpty()) break
                publishChat(chat, persist = false)
                for (call in calls) {
                    if (replyStopped()) break
                    // Per-turn budget: a model that keeps calling tools is cut
                    // off here rather than spending the whole allowance.
                    if (toolBudget(stepsTaken) == 0) {
                        chat = chat.copy(messages = chat.messages + ChatMessage("assistant", "Stopped after $MAX_TOOL_STEPS_PER_TURN tool steps this turn. Say \"continue\" to go on.", createdAt = System.currentTimeMillis(), error = true))
                        break
                    }
                    // Loop guard (from Artemis): the same call twice gets a hint
                    // instead of a third identical result.
                    val key = call.name + "|" + call.arguments.filterNot { it.isWhitespace() }
                    val repeats = (seenCalls[key] ?: 0) + 1
                    seenCalls[key] = repeats
                    chat = if (repeats > 2) {
                        chat.copy(messages = chat.messages + ChatMessage("tool", "Error: this exact call already ran twice. Hint: use the earlier result, change the arguments, or answer now.", createdAt = System.currentTimeMillis(), toolCallId = call.id, toolName = call.name))
                    } else {
                        runTool(chat, call)
                    }
                    stepsTaken++
                    publishChat(chat, persist = false)
                }
                // A call the loop never reached (stopped, or out of steps) still
                // needs an answer in the history, or every later turn is refused
                // by the provider for a tool_call without its result.
                val answered = chat.messages.filter { it.role == "tool" }.map { it.toolCallId }.toSet()
                calls.filter { it.id !in answered }.forEach { call ->
                    chat = chat.copy(messages = chat.messages + ChatMessage("tool", "Skipped: the turn was stopped before this call ran.", createdAt = System.currentTimeMillis(), toolCallId = call.id, toolName = call.name))
                }
                round++
                if (stepsTaken >= MAX_TOOL_STEPS_PER_TURN) break
                if (round > MAX_TOOL_ROUNDS) {
                    chat = chat.copy(messages = chat.messages + ChatMessage("assistant", "Stopped after $MAX_TOOL_ROUNDS tool rounds. Say \"continue\" to go on.", createdAt = System.currentTimeMillis(), error = true))
                }
            }
            val done = chat
            val text = finalText
            val retry = queueForRetry
            val lastReply = done.messages.lastOrNull()
            if (!retry && store.offlineAnswers && lastReply != null && lastReply.role == "assistant" && !lastReply.error && !lastReply.cached && text.isNotBlank()) {
                responseCacheKey(start.model, start.mode, start.messages)?.let { key ->
                    val next = responseCache.stored(key, text, done.model, System.currentTimeMillis())
                    responseCache = next
                    repo.saveResponseCache(next)
                }
            }
            publishChat(done, persist = true)
            main.post {
                streamingId = null
                finishedReply = Triple(done.id, text, System.currentTimeMillis())
                if (retry) updateOutbox(outbox.enqueued(done.id))
            }
          } finally {
            ReplyService.stop(context)
          }
        }
    }

    /** Compare's own reply loop: two sequential, tool-free calls, one to
     * [primary] and one to [secondary], each appended as its own ChatMessage
     * tagged with the same compareGroup so buildTurns renders them together
     * (see ui/Messages.kt) instead of merging into one assistant turn.
     * Deliberately does not reuse runReply's tool loop, tools-unsupported
     * retry, or outbox queuing -- Compare is a quick side-by-side reading of
     * two models, not a full agent turn, and running two tool loops at once
     * would need more than the single replyJob/streamingId this app
     * tracks for an in-flight reply. */
    private fun runCompareReply(start: Conversation, primary: CompareTarget, secondary: CompareTarget) {
        streamingId = start.id
        streamStartedAt = System.currentTimeMillis()
        val lib = library
        ReplyService.start(context, start.id, start.title)
        replyJob = launchReply {
          try {
            val groupId = UUID.randomUUID().toString()
            val persona = personaFor(lib, start.personaId)
            val prompt = systemPrompt(persona.systemPrompt, lib.instructions, "chat")
            var chat = start
            for ((sideIndex, target) in listOf(primary, secondary).withIndex()) {
                if (replyStopped()) break
                val body = buildChatBody(target.model, prompt, start.messages)
                val started = System.currentTimeMillis()
                val content = StringBuilder()
                var lastPost = 0L
                val base = chat
                fun draft(rawError: String?): ChatMessage = if (rawError == null) {
                    ChatMessage("assistant", content.toString(), createdAt = started, model = target.model, compareGroup = groupId)
                } else {
                    ChatMessage("assistant", maskSecrets(rawError), createdAt = started, error = true, model = target.model, compareGroup = groupId)
                }
                publishChat(base.copy(messages = base.messages + draft(null)), persist = false)
                var failure: String? = null
                try {
                    api.chatEvents(target.provider, body).collect { event ->
                        when (event) {
                            is ChatEvent.Delta -> {
                                content.append(event.content)
                                val now = System.currentTimeMillis()
                                if (now - lastPost > 60) {
                                    lastPost = now
                                    publishChat(base.copy(messages = base.messages + draft(null)), persist = false)
                                }
                            }
                            is ChatEvent.Failure -> failure = event.message
                            is ChatEvent.Partial -> failure = event.notice
                            else -> Unit
                        }
                    }
                } catch (e: CancellationException) {
                    if (!replyStopped()) throw e
                } catch (e: ApiException) {
                    failure = e.message
                } catch (e: Exception) {
                    failure = e.message ?: "The reply failed."
                }
                chat = base.copy(messages = base.messages + draft(failure))
                publishChat(chat, persist = sideIndex == 1)
            }
            val done = chat
            main.post {
                streamingId = null
                finishedReply = Triple(done.id, done.messages.lastOrNull()?.content ?: "", System.currentTimeMillis())
            }
          } finally {
            ReplyService.stop(context)
          }
        }
    }

    /** Runs one tool call on the worker thread and appends its result. */
    private fun runTool(chat: Conversation, call: ToolCall): Conversation {
        val now = System.currentTimeMillis()
        fun result(output: String, imageIds: List<String> = emptyList(), action: String = "") =
            ChatMessage("tool", output.take(12_000), createdAt = now, toolCallId = call.id, toolName = call.name, imageIds = imageIds, action = action)
        runLocalTool(chat, call)?.let { local ->
            return local.conversation.copy(messages = local.conversation.messages + result(local.output))
        }
        when (approvalFor(chat.mode, call.name)) {
            ToolApproval.DENY ->
                return chat.copy(messages = chat.messages + result("Error: ${call.name} is not available in ${modeLabel(chat.mode)} mode."))
            // CONFIRM is the phone-action button: it is offered, never run here.
            ToolApproval.CONFIRM, ToolApproval.AUTO -> Unit
        }
        val args = parseArguments(call.arguments)
        return when (call.name) {
            "web_search" -> chat.copy(messages = chat.messages + result(safely { api.webSearch(args.optString("query", "")) }))
            "web_fetch" -> chat.copy(messages = chat.messages + result(safely { api.webFetch(args.optString("url", "")) }))
            "generate_image" -> {
                val prompt = args.optString("prompt", "").trim()
                if (prompt.isEmpty()) return chat.copy(messages = chat.messages + result("Error: prompt is required."))
                try {
                    val record = drawBlocking(prompt)
                    chat.copy(messages = chat.messages + result("The image is shown to the user (by ${record.provider}). Describe it briefly; do not paste a link.", listOf(record.id)))
                } catch (e: Exception) {
                    chat.copy(messages = chat.messages + result("Error: " + (e.message ?: "image failed")))
                }
            }
            "phone_action" -> {
                val (action, message) = parsePhoneAction(call.arguments)
                val ticket = action?.let { sealAction(it, now) }
                chat.copy(messages = chat.messages + result(message, action = ticket?.toJson() ?: ""))
            }
            "device_snapshot" -> {
                // Never reads here. approvalFor makes this CONFIRM, so the
                // screen is only read after the user taps the button this
                // writes -- which is what stops a prompt-injected model
                // pulling another app's contents off the device. The result
                // lands in the chat as a user message (see
                // NativeActivity.readDeviceScreen), so the model sees it on
                // the next turn and the user can see exactly what was read.
                val ticket = sealAction(PhoneAction("read_screen"), now)
                chat.copy(messages = chat.messages + result(
                    "Shown to the user as a button: \"Read the screen as labelled elements\". Nothing is read " +
                        "until they tap it; if they do, the labelled elements arrive in their next message.",
                    action = ticket.toJson(),
                ))
            }
            else -> chat.copy(messages = chat.messages + result("Error: unknown tool ${call.name}."))
        }
    }

    private fun safely(block: () -> String): String = try {
        block()
    } catch (e: Exception) {
        "Error: " + (e.message ?: "failed")
    }

    // --- Library -------------------------------------------------------------

    private fun updateLibrary(updated: Library) {
        library = updated
        launchIo { repo.saveLibrary(updated) }
    }

    fun saveInstructions(text: String) {
        updateLibrary(library.copy(instructions = text.take(4000)))
    }

    fun savePersona(persona: Persona) {
        if (BUILT_IN_PERSONAS.any { it.id == persona.id }) return
        val list = library.personas.filter { it.id != persona.id } + persona.copy(builtIn = false)
        updateLibrary(library.copy(personas = list))
    }

    fun deletePersona(id: String) {
        updateLibrary(library.copy(personas = library.personas.filter { it.id != id }))
    }

    fun savePrompt(prompt: PromptTemplate) {
        val list = library.prompts.filter { it.id != prompt.id } + prompt.copy(builtIn = false)
        updateLibrary(library.copy(prompts = list))
    }

    fun deletePrompt(id: String) {
        updateLibrary(library.copy(prompts = library.prompts.filter { it.id != id }))
    }

    // --- Images ----------------------------------------------------------------

    /** Puter draws with the user's own Puter account through a hidden WebView
     * the activity owns. Off by default, never saved, and it switches itself
     * off after the first failure, so a spent allowance never blocks drawing. */
    var puterImages by mutableStateOf(false)
    /** The composer's "Image" tool is armed: the next send draws. */
    var imageArmed by mutableStateOf(false)
    var puterDraw: ((prompt: String, model: String, ratio: Pair<Int, Int>?, source: String?, done: (Result<Pair<String, ByteArray>>) -> Unit) -> Unit)? = null

    /** Chats on the user's own Puter account through the same hidden WebView.
     * Set by the activity, so the view model stays free of Android views. */
    var puterChat: ((body: String, onDelta: (String) -> Unit, done: (String?) -> Unit) -> Unit)? = null

    /** Opens Puter's sign-in page in the phone's browser. Set by the
     * activity, same as above. */
    var puterSignIn: ((done: (Result<Unit>) -> Unit) -> Unit)? = null
    /** True while a sign-in is waiting for the browser; tapping again reopens
     * the page (the earlier wait is retired, so only one answer arrives). */
    var puterSigningIn by mutableStateOf(false)

    /** The Puter switch's row calls this directly: chat and drawing never open
     * a sign-in window on their own (see puterDraw/puterChat), so this is the
     * only path to one, and it answers through the same [notice] a failed
     * draw already uses. */
    fun signInToPuter() {
        val start = puterSignIn ?: return
        puterSigningIn = true
        start { result ->
            puterSigningIn = false
            if (result.isFailure) recordFailure("puter", result.exceptionOrNull()?.message)
            showNotice(if (result.isSuccess) "Signed in to Puter." else "Puter sign-in: " + (result.exceptionOrNull()?.message ?: "failed"))
        }
    }

    // --- Pull request review (master plan Phase 4) -------------------------------
    // Supervision from the phone: read what changed, then approve, comment or
    // ask for changes. The server does the GitHub calls (githubListPulls,
    // githubGetPull, githubReviewPull); a failure lands in the failure ring.

    var reviewRepos by mutableStateOf<List<String>>(emptyList())
        private set
    var reviewPulls by mutableStateOf<List<PullSummary>>(emptyList())
        private set
    var reviewPull by mutableStateOf<PullDetail?>(null)
        private set
    var reviewBusy by mutableStateOf(false)
        private set
    var reviewError by mutableStateOf<String?>(null)
        private set

    private fun reviewFailed(e: ApiException) {
        recordFailure("github", e.message)
        reviewBusy = false
        reviewError = e.message
        if (e.authRequired) signedIn = false
    }

    fun loadReviewRepos() {
        work {
            try {
                reviewRepos = onIo { api.githubRepoNames() }
            } catch (e: ApiException) {
                reviewFailed(e)
            }
        }
    }

    fun loadPulls(repo: String) {
        reviewBusy = true
        reviewError = null
        reviewPull = null
        work {
            try {
                reviewPulls = onIo { api.pulls(repo) }
                reviewBusy = false
            } catch (e: ApiException) {
                reviewPulls = emptyList()
                reviewFailed(e)
            }
        }
    }

    fun openPull(repo: String, number: Int) {
        reviewBusy = true
        reviewError = null
        work {
            try {
                reviewPull = onIo { api.pull(repo, number) }
                reviewBusy = false
            } catch (e: ApiException) {
                reviewFailed(e)
            }
        }
    }

    fun closePull() {
        reviewPull = null
        reviewError = null
    }

    fun submitReview(repo: String, number: Int, event: ReviewEvent, text: String, onSent: () -> Unit) {
        if (reviewBusy || !event.canSend(text)) return
        reviewBusy = true
        reviewError = null
        work {
            try {
                val state = onIo { api.review(repo, number, event, text) }
                reviewBusy = false
                showNotice("Review sent to #$number" + (if (state.isEmpty()) "." else ": " + state.lowercase().replace('_', ' ') + "."))
                onSent()
            } catch (e: ApiException) {
                reviewFailed(e)
            }
        }
    }

    // --- GitHub connect (Custom Tab + pickup code) ------------------------------

    val githubConnected: Boolean get() = store.githubSession != null
    var githubConnecting by mutableStateOf(false)
    /** The connected logins, for Settings to show and to decide whether the
     * button reads "Connect" or "Add another account". Fetched on demand
     * (see Settings' LaunchedEffect); empty until then or when nothing is
     * connected. */
    var githubLogins by mutableStateOf<List<String>>(emptyList())

    fun refreshGithubLogins() {
        if (!githubConnected) { githubLogins = emptyList(); return }
        work { githubLogins = onIo { api.githubLogins() } }
    }

    /** Proves this session's identity over its own connection (a handoff
     * code, never the session itself -- see NativeApi.githubHandoff), builds
     * the Custom Tab URL from it, and hands that to [launch] on the main
     * thread. [adding] forces GitHub's account picker instead of reusing
     * whoever it finds already signed in there. The Settings row opens a
     * Custom Tab with it. */
    fun startGithubConnect(adding: Boolean = false, launch: (String) -> Unit) {
        githubConnecting = true
        work {
            val url = onIo { runCatching { api.githubAuthorizeUrl(api.githubHandoff(), adding) } }.getOrElse { e ->
                recordFailure("github", e.message)
                githubConnecting = false
                showNotice("GitHub connect: " + (e.message ?: "failed"))
                return@work
            }
            launch(url)
        }
    }

    /** Redeems the pickup code the neuraos://github-connected deep link
     * carried. Called from NativeActivity's intent handling, not from any
     * UI action directly -- the tap already happened, in the Custom Tab. */
    fun connectGithub(code: String, login: String) {
        work {
            val logins = onIo {
                runCatching {
                    store.githubSession = api.githubPickup(code)
                    api.githubLogins()
                }
            }.getOrElse { e ->
                recordFailure("github", e.message)
                githubConnecting = false
                showNotice("GitHub connect: " + (e.message ?: "failed"))
                return@work
            }
            githubConnecting = false
            githubLogins = logins
            showNotice("Connected to GitHub as " + login.ifEmpty { "your account" } + ".")
        }
    }

    /** Hands a device's FCM token to the server, once per app launch after a
     * session is confirmed -- see NativeActivity.registerForPush and
     * FcmService.onNewToken, the two callers. Silent either way: a push is a
     * convenience on top of the SSE stream that already reaches an open app,
     * never something worth interrupting the user to report on. */
    fun registerPushToken(token: String) {
        launchIo {
            try {
                api.registerPush(token)
            } catch (e: Exception) {
                // Retried on the next launch or token refresh.
            }
        }
    }

    /** Draws on the worker thread: Puter first when switched on, then the
     * server's free image services. [editSource] is a data URL to edit rather
     * than draw fresh. Saves the picture and returns its record. */
    private fun drawBlocking(
        prompt: String,
        size: ImageSize? = null,
        model: String = "",
        provider: String = "",
        editSource: String? = null,
    ): GeneratedImage {
        var drawnProvider = ""
        var mime = ""
        var bytes: ByteArray? = null
        val bridge = puterDraw
        if (puterImages && bridge != null) {
            // The picked chip is a preference, not the only name Puter will take:
            // a model absent from this account's catalogue refuses instantly, so
            // every candidate for this job is tried before giving up on Puter,
            // same order the web app's txt2img loop uses.
            val candidates = (listOf(model) + imageModelsFor(editSource != null)).distinct().filter { it.isNotEmpty() }
            val ratio = imageRatio(size)
            var lastReason = "no picture from Puter within 150 s"
            for (candidate in candidates) {
                val latch = java.util.concurrent.CountDownLatch(1)
                var outcome: Result<Pair<String, ByteArray>>? = null
                main.post { bridge(prompt, candidate, ratio, editSource) { result -> outcome = result; latch.countDown() } }
                // stop() releases the latch, so a cancelled draw returns at
                // once instead of parking a pool thread for 150s.
                puterDrawRelease = { latch.countDown() }
                // runInterruptible, not a bare await. onCleared shuts the pool
                // down with shutdownNow(), which interrupts this thread; a plain
                // await then throws InterruptedException, and the catch below
                // turned that into a chat message rather than unwinding -- the
                // one place in the app where a shutdown read as a user-visible
                // error. It also means one stuck draw holds a pool thread for
                // the full 150s, and three concurrent draws hold all three.
                var interrupted = false
                val finished = try {
                    latch.await(150, java.util.concurrent.TimeUnit.SECONDS)
                } catch (e: InterruptedException) {
                    // Preserve the flag so the executor can see it was cancelled.
                    // A flag rather than a break: Kotlin forbids break/continue
                    // inside a catch block.
                    Thread.currentThread().interrupt()
                    interrupted = true
                    false
                }
                if (interrupted) {
                    lastReason = "the draw was cancelled"
                    break
                }
                val result = outcome
                if (finished && result != null && result.isSuccess) {
                    val (type, data) = result.getOrThrow()
                    drawnProvider = "puter"
                    mime = type
                    bytes = data
                    break
                }
                // A timeout means the bridge itself is stuck, not that this one
                // model was refused -- retrying it per candidate would multiply a
                // 150s stall by the candidate count. Only a prompt refusal (a
                // definite result within the window) is worth trying past.
                if (!finished) {
                    lastReason = "no picture from Puter within 150 s"
                    break
                }
                lastReason = result?.exceptionOrNull()?.message ?: lastReason
            }
            // Only while this loop owns the bridge; a later draw sets its own.
            puterDrawRelease = null
            if (bytes == null) {
                recordFailure("puter", "image: $lastReason")
                main.post {
                    puterImages = false
                    showNotice("Puter off: $lastReason. Using free server images.")
                }
            }
        }
        if (bytes == null) {
            val drawn = if (editSource != null) api.editImage(prompt, editSource, size?.body() ?: "", model, provider)
            else api.generateImage(prompt, size?.body() ?: "", model, provider)
            drawnProvider = drawn.first
            mime = drawn.second
            bytes = drawn.third
        }
        val record = GeneratedImage(UUID.randomUUID().toString(), prompt, drawnProvider, mime, System.currentTimeMillis())
        repo.saveImage(record.id, bytes!!)
        main.post { updateLibrary(library.copy(images = listOf(record) + library.images)) }
        return record
    }

    /** "Create image" from the composer: the prompt and the picture land in
     * the chat as a generate_image call and its result, so the chat history
     * stays valid for the next model turn. */
    fun drawInChat(id: String, prompt: String) {
        val chat = conversation(id) ?: return
        val text = prompt.trim()
        if (text.isEmpty() || streamingId != null) return
        val now = System.currentTimeMillis()
        val call = ToolCall("img_$now", "generate_image", org.json.JSONObject().put("prompt", text).toString())
        val start = chat.copy(
            title = if (chat.messages.none { it.role == "user" }) deriveTitle(text) else chat.title,
            messages = chat.messages + ChatMessage("user", text, createdAt = now) +
                ChatMessage("assistant", "", createdAt = now + 1, toolCalls = listOf(call)),
            updatedAt = now,
        )
        drafts.remove(id)
        replace(start)
        streamingId = id
        work {
            val result = onIo {
              try {
                val record = drawBlocking(text)
                ChatMessage("tool", "The image is shown to the user (by ${record.provider}).", createdAt = now + 2, toolCallId = call.id, toolName = call.name, imageIds = listOf(record.id))
              } catch (e: Exception) {
                ChatMessage("tool", "Error: " + (e.message ?: "image failed"), createdAt = now + 2, toolCallId = call.id, toolName = call.name)
              }
            }
            val failed = result.content.startsWith("Error")
            val finished = start.copy(
                messages = start.messages + result + ChatMessage(
                    "assistant", if (failed) result.content.removePrefix("Error: ") else "", createdAt = now + 3, error = failed,
                ),
            )
            publishChat(finished, persist = true)
            streamingId = null
        }
    }

    fun generateImage(
        prompt: String,
        size: ImageSize? = null,
        model: String = "",
        provider: String = "",
        editSource: String? = null,
    ) {
        val text = prompt.trim()
        if (text.isEmpty() || imageBusy) return
        imageBusy = true
        imageError = null
        work {
            val failure = onIo { runCatching { drawBlocking(text, size, model, provider, editSource) } }.exceptionOrNull()
            imageBusy = false
            if (failure != null) {
                recordFailure("image", failure.message ?: "Image failed.")
                imageError = failure.message ?: "Image failed."
                if (failure is ApiException && failure.authRequired) signedIn = false
            }
        }
    }

    /** Reads a stored picture off the main thread. */
    fun loadImage(id: String, onLoaded: (ByteArray?) -> Unit) {
        work { onLoaded(onIo { repo.loadImage(id) }) }
    }

    /** Reads and decodes a stored picture off the main thread: decoding a full
     * JPEG in the main-thread callback stuttered every scroll past an image. */
    /** [maxEdge] is the longest side the caller actually needs. Decoding a
     * stored image at its full resolution is how a two-column gallery grid
     * ends up holding a dozen 4MB bitmaps at once: there was no bounds probe
     * and no inSampleSize here, so every cell decoded the source pixels and
     * the only guard was catching OutOfMemoryError, which drops the image
     * rather than showing it. The full-screen viewer already sampled to 2048
     * (see ui/Viewers.kt); this does the same, with the caller picking the
     * size, and halves the decode further for thumbnails. */
    fun loadBitmap(id: String, maxEdge: Int = 2048, onLoaded: (ByteArray?, androidx.compose.ui.graphics.ImageBitmap?) -> Unit) {
        work {
            val (bytes, image) = onIo {
                val bytes = repo.loadImage(id)
                val bitmap = try {
                    bytes?.let { decodeSampled(it, maxEdge) }
                } catch (e: OutOfMemoryError) {
                    null
                }
                bytes to bitmap?.asImageBitmap()
            }
            onLoaded(bytes, image)
        }
    }

    /** Decodes [bytes] no larger than [maxEdge] on its longest side.
     *
     * A bounds-only pass first (no pixel memory), then a real decode at
     * inSampleSize, which must be a power of two. 1 means "no subsampling". */
    private fun decodeSampled(bytes: ByteArray, maxEdge: Int): android.graphics.Bitmap? {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > maxEdge || bounds.outHeight / sample > maxEdge) sample *= 2
        return android.graphics.BitmapFactory.decodeByteArray(
            bytes, 0, bytes.size,
            android.graphics.BitmapFactory.Options().apply {
                inSampleSize = sample
                // Thumbnails never need an alpha channel; this halves their
                // footprint again.
                if (maxEdge <= 512) inPreferredConfig = android.graphics.Bitmap.Config.RGB_565
            },
        )
    }

    fun deleteImage(id: String) {
        updateLibrary(library.copy(images = library.images.filter { it.id != id }))
        launchIo { repo.deleteImage(id) }
    }

    // --- Status ------------------------------------------------------------------

    var healthText by mutableStateOf<String?>(null)
        private set
    /** Per "provider/model": the last probe's result line. */
    val probes = mutableStateMapOf<String, String>()

    fun refreshHealth() {
        healthText = "Checking…"
        work {
            healthText = onIo {
                try {
                    val obj = org.json.JSONObject(api.health())
                    val up = obj.optLong("uptimeSeconds", 0L)
                    "Online · v" + obj.optString("version", "?") + " · commit " + obj.optString("commit", "").take(7).ifEmpty { "local" } +
                        " · up " + (up / 3600) + "h " + (up % 3600 / 60) + "m"
                } catch (e: Exception) {
                    "Offline: " + (e.message ?: "no answer")
                }
            }
        }
    }

    /** Sends a one-word prompt to a model and records how long it took. */
    fun probe(provider: String, model: String) {
        val key = "$provider/$model"
        probes[key] = "Testing…"
        work {
            val started = System.currentTimeMillis()
            var failure: String? = null
            var got = false
            try {
                val body = buildChatBody(model, "", listOf(ChatMessage("user", "Reply with the word OK.")))
                api.chatEvents(provider, body).collect { event ->
                    when (event) {
                        is ChatEvent.Delta -> if (event.content.isNotEmpty()) got = true
                        is ChatEvent.Failure -> failure = event.message
                        is ChatEvent.Partial -> failure = event.notice
                        is ChatEvent.ToolDelta -> Unit
                        is ChatEvent.ToolDeltas -> Unit
                        ChatEvent.Done -> Unit
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.message ?: "failed"
            }
            val ms = System.currentTimeMillis() - started
            probes[key] = when {
                failure != null -> "✗ " + failure
                got -> "✓ answered in ${ms} ms"
                else -> "✗ empty reply after ${ms} ms"
            }
        }
    }

    /**
     * Universal Image Vision: for messages with images sent to a text-only model,
     * auto-describe each image and inject the description as context.
     * 
     * Returns the conversation with images replaced by descriptions when the
     * model doesn't support vision natively.
     */
    private fun autoDescribeImages(chat: Conversation): Conversation {
        if (chat.messages.isEmpty()) return chat
        val lastUserIdx = chat.messages.indexOfLast { it.role == "user" }
        if (lastUserIdx < 0) return chat
        val lastUser = chat.messages[lastUserIdx]
        if (lastUser.images.isEmpty()) return chat
        if (ImageIntelligence.modelSupportsVision(chat.model)) return chat

        // Auto-describe each image for text-only models
        val describedImages = mutableListOf<String>()
        val descriptions = mutableListOf<String>()
        for (imageUrl in lastUser.images) {
            val hash = imageUrl.hashCode().toString(16)
            val cached = ImageIntelligence.getCached(hash)
            if (cached != null) {
                descriptions.add(cached)
                describedImages.add(imageUrl)
                continue
            }
            // Try to describe via available providers
            val desc = try {
                ImageIntelligence.describeForModel(
                    imageDataUrl = imageUrl,
                    modelId = chat.model,
                    serverUrl = serverUrl,
                )
            } catch (e: Exception) { null }
            if (desc != null) {
                ImageIntelligence.putCached(hash, desc)
                descriptions.add(desc)
            }
            describedImages.add(imageUrl)
        }

        if (descriptions.isEmpty()) return chat

        // Inject image descriptions into the message content
        val imageContext = descriptions.joinToString("\n\n")
        val enhancedContent = buildString {
            append(lastUser.content)
            if (lastUser.content.isNotBlank()) append("\n\n")
            append("[Image descriptions — auto-generated for this model]\n")
            append(imageContext)
        }

        val enhancedUser = lastUser.copy(
            content = enhancedContent,
            images = emptyList(), // Clear images since they're now described
        )

        val newMessages = chat.messages.toMutableList()
        newMessages[lastUserIdx] = enhancedUser
        return chat.copy(messages = newMessages)
    }

    fun runOnIo(block: () -> Unit) { launchIo(block) }
    fun runOnMain(block: () -> Unit) = main.post(block)
}

/** What the view model reads from disk at start. */
private data class OnDisk(
    val chats: List<Conversation>,
    val library: Library,
    val outbox: Outbox,
    val automations: List<AutomationEntry>,
    val schedules: List<RecipeSchedule>,
)
