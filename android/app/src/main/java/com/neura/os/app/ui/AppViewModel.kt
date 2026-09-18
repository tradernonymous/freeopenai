package com.neura.os.app.ui

import android.app.Application
import com.neura.os.app.data.ImageIntelligence
import com.neura.os.app.data.DescriptorCache
import com.neura.os.app.data.FileGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import com.neura.os.app.data.Skill
import com.neura.os.app.data.SlashMatch
import com.neura.os.app.data.renderCommandsHelp
import com.neura.os.app.data.resolveSlash
import com.neura.os.app.data.imageModelsFor
import com.neura.os.app.data.imageRatio
import com.neura.os.app.data.ModelInfo
import com.neura.os.app.data.NativeApi
import com.neura.os.app.data.Outbox
import com.neura.os.app.data.Persona
import com.neura.os.app.data.PromptTemplate
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
import com.neura.os.app.data.personaFor
import com.neura.os.app.ReplyService
import com.neura.os.app.normalizeBaseUrl
import java.net.HttpURLConnection
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicReference

/** All app state for the native screens. Network and disk work runs on a
 * small pool; every state change is posted back to the main thread, which
 * is the only thread Compose state is written from. */
private const val UI_STATE_KEY = "ui_state"
private const val DRAFT_SAVE_BUDGET = 50_000

class AppViewModel(app: Application, private val saved: SavedStateHandle) : AndroidViewModel(app) {
    val store = SecureStore(app)
    private val repo = Repository(app)
    private val session = SessionManager(store)
    private val api = NativeApi(session)
    // Every IO block runs through this guard: an exception on a pool thread
    // would otherwise end the process (a full disk on save, a Keystore fault),
    // and a block posted after the pool is shut down would throw on main.
    private val pool = Executors.newFixedThreadPool(3)
    private val io = Executor { block ->
        try {
            pool.execute {
                try {
                    block.run()
                } catch (e: Exception) {
                    main.post { notice = "Something went wrong: " + (e.message ?: e.javaClass.simpleName) }
                }
            }
        } catch (e: RejectedExecutionException) {
            // The screen is gone; there is nobody to do this for.
        }
    }
    private val main = Handler(Looper.getMainLooper())
    private val activeStream = AtomicReference<HttpURLConnection?>(null)
    private val context = app.applicationContext

    var signedIn by mutableStateOf(store.server != null && (store.session != null || store.password != null))
        private set
    var signInBusy by mutableStateOf(false)
        private set
    var signInError by mutableStateOf<String?>(null)
        private set

    var nav by mutableStateOf(NavState())
        private set
    val screen: Screen? get() = nav.screen
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
    var notice by mutableStateOf<String?>(null)

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
        io.execute {
            val chats = repo.loadConversations()
            val lib = repo.loadLibrary()
            val savedOutbox = repo.loadOutbox()
            main.post {
                // A chat started before the disk was read (a shared photo, a
                // notification tap) is kept rather than replaced by the load.
                val fresh = conversations.filter { open -> chats.none { it.id == open.id } }
                conversations.clear()
                conversations.addAll(fresh + chats)
                library = lib
                outbox = savedOutbox
                loaded = true
            }
        }
        if (signedIn) refreshCatalogue()
    }

    private fun updateOutbox(next: Outbox) {
        outbox = next
        io.execute { repo.saveOutbox(next) }
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

    override fun onCleared() {
        activeStream.getAndSet(null)?.disconnect()
        pool.shutdownNow()
        builds.shutdown()
        super.onCleared()
    }

    // --- Remote builds -------------------------------------------------------
    // The phone plans; the server builds. State and streaming live in
    // RemoteBuilds; these are the entry points the screens use.

    val builds = RemoteBuilds(api) { block -> main.post(block) }

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
            if (screen == Screen.Build) {
                if (buildId == null || !signedIn) return@forEach
                builds.open(buildId)
            }
            restored = restored.copy(stacks = restored.stacks + (tab to (restored.stacks[tab].orEmpty() + screen)))
        }
        val savedTab = state.getString("tab")?.let { name -> Tab.entries.firstOrNull { it.name == name } }
        nav = if (savedTab != null) restored.copy(currentTab = savedTab) else restored
    }

    fun openBuilds() = push(Route.Builds)

    fun openBuild(id: String) {
        builds.open(id)
        push(Screen.Build)
    }

    /** Hands [plan] (a Plan-mode reply) to the server and opens the build. */
    fun startRemoteBuild(plan: String) {
        if (builds.actionBusy) return
        notice = "Starting the build on the server…"
        builds.start(
            currentChatId ?: "",
            plan,
            onStarted = { push(Screen.Build) },
            onFailed = { message -> notice = "Build not started: $message" },
        )
    }

    // --- Navigation --------------------------------------------------------

    fun push(screen: Screen) { nav = nav.pushed(screen) }

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
        io.execute {
            try {
                val cookie = ChatApi(server).login(username.trim(), password)
                if (store.server != server) store.clearSession()
                store.server = server
                store.username = username.trim()
                store.password = password
                store.session = cookie
                main.post {
                    signInBusy = false
                    signedIn = true
                    refreshCatalogue()
                }
            } catch (e: ApiException) {
                main.post {
                    signInBusy = false
                    signInError = e.message
                }
            }
        }
    }

    /** Signs out on the server and forgets the password. [erase] also deletes
     * every chat, image and custom persona stored on the phone. */
    fun signOut(erase: Boolean) {
        val server = store.server ?: ""
        val cookie = store.session
        io.execute {
            if (server.isNotEmpty()) {
                val client = ChatApi(server)
                client.sessionCookie = cookie
                client.logout()
            }
            if (erase) repo.eraseEverything()
        }
        store.clearSecrets()
        if (erase) {
            conversations.clear()
            library = Library()
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
            store.session = ChatApi(server).login(username, password)
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
        io.execute {
            try {
                val served = reauthing { api.providers() }
                // Puter answers in the browser on the user's own allowance, so
                // the server has no row for it; the app adds one because the
                // app is what can reach it.
                val list = if (puterChat != null) served + ProviderInfo(PUTER_PROVIDER, "Puter (your account)", true, "chat") else served
                main.post {
                    providers = list
                    catalogueBusy = false
                    if (list.isEmpty()) catalogueError = "The server has no chat provider configured."
                }
                // Warm the default provider's models so a new chat can start at once.
                val preferred = library.defaultProvider.takeIf { id -> list.any { it.id == id } } ?: list.firstOrNull()?.id
                if (preferred != null) loadModelsBlocking(preferred)
            } catch (e: ApiException) {
                main.post {
                    catalogueBusy = false
                    catalogueError = e.message
                    if (e.authRequired) signedIn = false
                }
            }
        }
    }

    private fun loadModelsBlocking(provider: String) {
        try {
            val list = reauthing { if (provider == PUTER_PROVIDER) api.puterModels() else api.models(provider) }
            main.post { models[provider] = list }
        } catch (e: ApiException) {
            main.post { notice = e.message }
        }
    }

    fun loadModels(provider: String) {
        if (models.containsKey(provider)) return
        io.execute { loadModelsBlocking(provider) }
    }

    /** Reads the server's timeouts and retry budget for the Settings screen. */
    fun loadLimits() {
        io.execute {
            val result = try { api.limits() } catch (e: Exception) { null }
            main.post { result?.let { limits = it } }
        }
    }

    /** Fills the Skills screen from the server's installed catalogue. */
    fun loadSkills(force: Boolean = false) {
        if (!force && skills.isNotEmpty()) return
        io.execute {
            val result = try { api.skills() } catch (e: Exception) { null }
            if (result != null) main.post { skills = result }
        }
    }

    /** The SKILL.md shown in the Skills detail sheet, keyed by skill name. */
    var skillDetail by mutableStateOf<Pair<String, String>?>(null)
        private set

    /** Fetches a skill's SKILL.md for the detail sheet off the main thread. */
    fun loadSkillInstructions(name: String) {
        io.execute {
            val body = skillBody(name) ?: ""
            main.post { skillDetail = name to body }
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

    fun conversation(id: String): Conversation? = conversations.firstOrNull { it.id == id }

    fun openChat(id: String) {
        conversations.removeAll { it.messages.isEmpty() && it.id != id && it.id != streamingId }
        currentChatId = id
        nav = nav.switchedToChat()
    }

    /** The chat on screen, creating a fresh one when there is none. */
    fun currentOrNew(): Conversation {
        currentChatId?.let { id -> conversation(id)?.let { return it } }
        return conversation(newChat())!!
    }

    fun newChat(personaId: String = DEFAULT_PERSONA_ID, draft: String = "", mode: String = "chat"): String {
        val now = System.currentTimeMillis()
        val (provider, model) = startingModel()
        // An untouched empty chat is replaced rather than stacked up.
        conversations.removeAll { it.messages.isEmpty() && it.id != streamingId }
        val chat = Conversation(UUID.randomUUID().toString(), "New chat", personaId, provider, model, emptyList(), now, now, mode = mode)
        conversations.add(chat)
        if (draft.isNotEmpty()) drafts[chat.id] = draft
        nav = nav.switchedToChat()
        currentChatId = chat.id
        return chat.id
    }

    private fun replace(updated: Conversation, persist: Boolean = true) {
        val index = conversations.indexOfFirst { it.id == updated.id }
        if (index >= 0) conversations[index] = updated else conversations.add(updated)
        if (persist && updated.messages.isNotEmpty()) io.execute { repo.saveConversation(updated) }
    }

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
        drafts.remove(id)
        if (currentChatId == id) currentChatId = null
        io.execute { repo.deleteConversation(id) }
    }

    fun deleteAllChats() {
        stop()
        conversations.clear()
        drafts.clear()
        currentChatId = null
        io.execute { repo.deleteAllConversations() }
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
            notice = "Pick a model first (tap the model name at the top)."
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
        val trimmed = chat.copy(messages = chat.messages.subList(0, lastUser + 1), updatedAt = System.currentTimeMillis())
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
    }

    @Volatile private var stopRequested = false

    fun stop() {
        stopRequested = true
        activeStream.getAndSet(null)?.let { connection -> io.execute { connection.disconnect() } }
        ReplyService.stop(context)
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
                notice = "Using ${match.name} for this chat."
            }
            is SlashMatch.Chain -> {
                pinSkills(chat, match.names)
                notice = "Using " + match.names.joinToString(", ") + "."
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
        notice = "Pinned $name to this chat."
    }

    /** Pin skills to a chat, fetching each SKILL.md once for its prompt. */
    private fun pinSkills(chat: Conversation, names: List<String>) {
        val added = names.map { it.lowercase() }.distinct().filter { it !in chat.skills }
        if (added.isNotEmpty()) replace(chat.copy(skills = chat.skills + added, updatedAt = System.currentTimeMillis()))
        added.forEach { name -> io.execute { skillBody(name) } }
    }

    /** Stops using a skill in this chat. The composer's chips call it, and so
     * does `/skill off <name>`, so both go through one path. */
    fun unpinSkill(id: String, name: String) {
        val chat = conversation(id) ?: return
        val skill = name.lowercase()
        if (skill !in chat.skills) return
        replace(chat.copy(skills = chat.skills - skill, updatedAt = System.currentTimeMillis()))
        notice = "Stopped using $skill."
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
                        notice = "Stopped using $skill."
                    }
                    else -> {
                        val skill = arg.split(Regex("\\s+")).first().lowercase()
                        pinSkills(chat, listOf(skill))
                        notice = "Using $skill for this chat."
                    }
                }
            }
            "mode" -> when (args.lowercase()) {
                "chat" -> { setMode(chat.id, "chat"); notice = "Chat mode." }
                "plan" -> { setMode(chat.id, "plan"); notice = "Plan mode." }
                "build" -> { setMode(chat.id, "build"); notice = "Build mode: light edits to this chat's own files. Ask for a plan and tap \"Build remotely\" for anything bigger." }
                else -> notice = "Usage: /mode chat | plan | build"
            }
            "clear" -> {
                newChat()
                notice = "New chat started."
            }
            "compact" -> when (args.lowercase()) {
                "on" -> { replace(chat.copy(compact = true)); notice = "Sending a shorter history." }
                "off" -> { replace(chat.copy(compact = false)); notice = "Sending the full history." }
                else -> notice = if (chat.compact) "Compact is on." else "Compact is off."
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
        main.post {
            val current = conversation(worker.id) ?: return@post
            replace(
                current.copy(messages = worker.messages, tasks = worker.tasks, files = worker.files, updatedAt = System.currentTimeMillis()),
                persist = persist,
            )
        }
    }

    /** The agent loop: stream a reply, run the tools it asks for, send the
     * results back, and repeat until the model answers in plain text. A model
     * that refuses tools is asked once more without them. */
    private fun runReply(start: Conversation) {
        streamingId = start.id
        streamStartedAt = System.currentTimeMillis()
        stopRequested = false
        // Any earlier connectivity failure for this chat is superseded by
        // this attempt, whether it came from the user or from drainOutbox
        // itself -- it will be re-queued below if this attempt fails too.
        if (outbox.entries.any { it.chatId == start.id }) updateOutbox(outbox.acked(start.id))
        val lib = library
        ReplyService.start(context, start.id, start.title)
        io.execute {
          try {
            var chat = start
            var useTools = true
            var round = 0
            var stepsTaken = 0
            var finalText = ""
            var authRetried = false
            var queueForRetry = false
            val seenCalls = HashMap<String, Int>()
            while (round <= MAX_TOOL_ROUNDS && !stopRequested) {
                val persona = personaFor(lib, chat.personaId)
                val skillTexts = chat.skills.mapNotNull { skillBodies[it] ?: skillBody(it) }
                // A pinned skill whose text the server has not got is a skill
                // that is not applying, which is invisible from the chip alone.
                if (skillTexts.size < chat.skills.size && round == 0) {
                    main.post { notice = "Some pinned skills could not be loaded, so they are not applying." }
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
                val base = chat
                fun draft(rawError: String?): ChatMessage = when {
                    rawError == null -> ChatMessage("assistant", content.toString(), reasoning.toString(), started, model = chat.model)
                    content.isEmpty() -> ChatMessage("assistant", maskSecrets(rawError), createdAt = started, error = true, model = chat.model)
                    else -> ChatMessage("assistant", "$content\n\n⚠️ ${maskSecrets(rawError)}", reasoning.toString(), started, model = chat.model)
                }
                publishChat(base.copy(messages = base.messages + draft(null)), persist = false)
                try {
                    if (chat.provider == PUTER_PROVIDER) {
                        val bridge = puterChat ?: throw ApiException("Puter is only available in the app's own window.")
                        val finished = java.util.concurrent.CountDownLatch(1)
                        val reason = java.util.concurrent.atomic.AtomicReference<String?>(null)
                        main.post {
                            bridge(body, { piece ->
                                content.append(piece)
                                val now = System.currentTimeMillis()
                                if (now - lastPost > 60) {
                                    lastPost = now
                                    publishChat(base.copy(messages = base.messages + draft(null)), persist = false)
                                }
                            }, { error ->
                                reason.set(error)
                                finished.countDown()
                            })
                        }
                        finished.await()
                        reason.get()?.let { failure = it }
                    } else api.streamChat(chat.provider, body, activeStream) { event ->
                        when (event) {
                            is ChatEvent.Delta -> {
                                content.append(event.content)
                                reasoning.append(event.reasoning)
                                val now = System.currentTimeMillis()
                                if (now - lastPost > 60) {
                                    lastPost = now
                                    publishChat(base.copy(messages = base.messages + draft(null)), persist = false)
                                }
                            }
                            is ChatEvent.ToolDelta -> collector.add(event)
                            is ChatEvent.ToolDeltas -> event.deltas.forEach { collector.add(it) }
                            is ChatEvent.Failure -> { failure = event.message; connectivityFailure = event.connectivity }
                            is ChatEvent.Partial -> failure = event.notice
                            ChatEvent.Done -> Unit
                        }
                    }
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
                if (stopRequested && content.isEmpty() && calls.isEmpty()) {
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
                val assistant = draft(error).copy(toolCalls = if (error == null) calls else emptyList())
                chat = base.copy(messages = base.messages + assistant)
                finalText = assistant.content
                if (error != null || calls.isEmpty()) break
                publishChat(chat, persist = false)
                for (call in calls) {
                    if (stopRequested) break
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
     * would need more than the single activeStream/streamingId this app
     * tracks for an in-flight reply. */
    private fun runCompareReply(start: Conversation, primary: CompareTarget, secondary: CompareTarget) {
        streamingId = start.id
        streamStartedAt = System.currentTimeMillis()
        stopRequested = false
        val lib = library
        ReplyService.start(context, start.id, start.title)
        io.execute {
          try {
            val groupId = UUID.randomUUID().toString()
            val persona = personaFor(lib, start.personaId)
            val prompt = systemPrompt(persona.systemPrompt, lib.instructions, "chat")
            var chat = start
            for ((sideIndex, target) in listOf(primary, secondary).withIndex()) {
                if (stopRequested) break
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
                    api.streamChat(target.provider, body, activeStream) { event ->
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
            "device_snapshot" -> chat.copy(
                messages = chat.messages + result(
                    com.neura.os.app.DeviceControlService.instance?.snapshot()
                        ?: "Error: Device control is off. Ask the user to turn it on in Settings.",
                ),
            )
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
        io.execute { repo.saveLibrary(updated) }
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

    /** Opens Puter's own sign-in window. Set by the activity, same as above. */
    var puterSignIn: ((done: (Result<Unit>) -> Unit) -> Unit)? = null
    /** True while that window is open, so the row can say so instead of
     * looking like the tap did nothing. */
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
            notice = if (result.isSuccess) "Signed in to Puter." else "Puter sign-in: " + (result.exceptionOrNull()?.message ?: "failed")
        }
    }

    /** Hands a device's FCM token to the server, once per app launch after a
     * session is confirmed -- see NativeActivity.registerForPush and
     * FcmService.onNewToken, the two callers. Silent either way: a push is a
     * convenience on top of the SSE stream that already reaches an open app,
     * never something worth interrupting the user to report on. */
    fun registerPushToken(token: String) {
        runOnIo {
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
            var lastReason = "timed out"
            for (candidate in candidates) {
                val latch = java.util.concurrent.CountDownLatch(1)
                var outcome: Result<Pair<String, ByteArray>>? = null
                main.post { bridge(prompt, candidate, ratio, editSource) { result -> outcome = result; latch.countDown() } }
                val finished = latch.await(150, java.util.concurrent.TimeUnit.SECONDS)
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
                    lastReason = "timed out"
                    break
                }
                lastReason = result?.exceptionOrNull()?.message ?: lastReason
            }
            if (bytes == null) {
                main.post {
                    puterImages = false
                    notice = "Puter off: $lastReason. Using free server images."
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
        io.execute {
            val result = try {
                val record = drawBlocking(text)
                ChatMessage("tool", "The image is shown to the user (by ${record.provider}).", createdAt = now + 2, toolCallId = call.id, toolName = call.name, imageIds = listOf(record.id))
            } catch (e: Exception) {
                ChatMessage("tool", "Error: " + (e.message ?: "image failed"), createdAt = now + 2, toolCallId = call.id, toolName = call.name)
            }
            val failed = result.content.startsWith("Error")
            val finished = start.copy(
                messages = start.messages + result + ChatMessage(
                    "assistant", if (failed) result.content.removePrefix("Error: ") else "", createdAt = now + 3, error = failed,
                ),
            )
            publishChat(finished, persist = true)
            main.post { streamingId = null }
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
        io.execute {
            try {
                drawBlocking(text, size, model, provider, editSource)
                main.post { imageBusy = false }
            } catch (e: Exception) {
                main.post {
                    imageBusy = false
                    imageError = e.message ?: "Image failed."
                    if (e is ApiException && e.authRequired) signedIn = false
                }
            }
        }
    }

    /** Reads a stored picture off the main thread. */
    fun loadImage(id: String, onLoaded: (ByteArray?) -> Unit) {
        io.execute {
            val bytes = repo.loadImage(id)
            main.post { onLoaded(bytes) }
        }
    }

    /** Reads and decodes a stored picture off the main thread: decoding a full
     * JPEG in the main-thread callback stuttered every scroll past an image. */
    fun loadBitmap(id: String, onLoaded: (ByteArray?, androidx.compose.ui.graphics.ImageBitmap?) -> Unit) {
        io.execute {
            val bytes = repo.loadImage(id)
            val bitmap = try {
                bytes?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) }
            } catch (e: OutOfMemoryError) {
                null
            }
            val image = bitmap?.asImageBitmap()
            main.post { onLoaded(bytes, image) }
        }
    }

    fun deleteImage(id: String) {
        updateLibrary(library.copy(images = library.images.filter { it.id != id }))
        io.execute { repo.deleteImage(id) }
    }

    // --- Status ------------------------------------------------------------------

    var healthText by mutableStateOf<String?>(null)
        private set
    /** Per "provider/model": the last probe's result line. */
    val probes = mutableStateMapOf<String, String>()

    fun refreshHealth() {
        healthText = "Checking…"
        io.execute {
            val text = try {
                val obj = org.json.JSONObject(api.health())
                val up = obj.optLong("uptimeSeconds", 0L)
                "Online · v" + obj.optString("version", "?") + " · commit " + obj.optString("commit", "").take(7).ifEmpty { "local" } +
                    " · up " + (up / 3600) + "h " + (up % 3600 / 60) + "m"
            } catch (e: Exception) {
                "Offline: " + (e.message ?: "no answer")
            }
            main.post { healthText = text }
        }
    }

    /** Sends a one-word prompt to a model and records how long it took. */
    fun probe(provider: String, model: String) {
        val key = "$provider/$model"
        probes[key] = "Testing…"
        io.execute {
            val started = System.currentTimeMillis()
            var failure: String? = null
            var got = false
            try {
                val body = buildChatBody(model, "", listOf(ChatMessage("user", "Reply with the word OK.")))
                api.streamChat(provider, body, AtomicReference(null)) { event ->
                    when (event) {
                        is ChatEvent.Delta -> if (event.content.isNotEmpty()) got = true
                        is ChatEvent.Failure -> failure = event.message
                        is ChatEvent.Partial -> failure = event.notice
                        is ChatEvent.ToolDelta -> Unit
                        is ChatEvent.ToolDeltas -> Unit
                        ChatEvent.Done -> Unit
                    }
                }
            } catch (e: Exception) {
                failure = e.message ?: "failed"
            }
            val ms = System.currentTimeMillis() - started
            val line = when {
                failure != null -> "✗ " + failure
                got -> "✓ answered in ${ms} ms"
                else -> "✗ empty reply after ${ms} ms"
            }
            main.post { probes[key] = line }
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
            val hash = ImageIntelligence.imageHash(imageUrl)
            val cached = DescriptorCache.get(hash)
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
                    apiKey = null,
                    serverUrl = serverUrl,
                )
            } catch (e: Exception) { null }
            if (desc != null) {
                DescriptorCache.put(hash, desc)
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

    fun runOnIo(block: () -> Unit) = io.execute(block)
    fun runOnMain(block: () -> Unit) = main.post(block)
}
