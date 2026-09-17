package com.freeai4u.app.ui

import android.app.Application
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import com.freeai4u.app.ApiException
import com.freeai4u.app.BaseUrlResult
import com.freeai4u.app.ChatApi
import com.freeai4u.app.SecureStore
import com.freeai4u.app.WebShell
import com.freeai4u.app.data.BUILT_IN_PERSONAS
import com.freeai4u.app.data.ChatEvent
import com.freeai4u.app.data.ChatMessage
import com.freeai4u.app.data.Conversation
import com.freeai4u.app.data.DEFAULT_PERSONA_ID
import com.freeai4u.app.data.GeneratedImage
import com.freeai4u.app.data.Library
import com.freeai4u.app.data.ModelInfo
import com.freeai4u.app.data.NativeApi
import com.freeai4u.app.data.Persona
import com.freeai4u.app.data.PromptTemplate
import com.freeai4u.app.data.ProviderInfo
import com.freeai4u.app.data.Repository
import com.freeai4u.app.data.SessionManager
import com.freeai4u.app.data.buildChatBody
import com.freeai4u.app.data.MAX_TOOL_ROUNDS
import com.freeai4u.app.data.ToolCall
import com.freeai4u.app.data.ToolCallCollector
import com.freeai4u.app.data.looksLikeToolsUnsupported
import com.freeai4u.app.data.modeLabel
import com.freeai4u.app.data.parseArguments
import com.freeai4u.app.data.parsePhoneAction
import com.freeai4u.app.data.runLocalTool
import com.freeai4u.app.data.systemPrompt
import com.freeai4u.app.data.toolAllowed
import com.freeai4u.app.data.toolsForMode
import com.freeai4u.app.data.deriveTitle
import com.freeai4u.app.data.personaFor
import com.freeai4u.app.normalizeBaseUrl
import java.net.HttpURLConnection
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/** Pages that open over the chat, ChatGPT-style: the chat is always the base. */
sealed interface Screen {
    data object Images : Screen
    data object Tools : Screen
    data object Settings : Screen
    data object Personas : Screen
    data object Prompts : Screen
}

/** All app state for the native screens. Network and disk work runs on a
 * small pool; every state change is posted back to the main thread, which
 * is the only thread Compose state is written from. */
class AppViewModel(app: Application) : AndroidViewModel(app) {
    val store = SecureStore(app)
    private val repo = Repository(app)
    private val session = SessionManager(store)
    private val api = NativeApi(session)
    private val io = Executors.newFixedThreadPool(3)
    private val main = Handler(Looper.getMainLooper())
    private val activeStream = AtomicReference<HttpURLConnection?>(null)

    var signedIn by mutableStateOf(store.server != null && (store.session != null || store.password != null))
        private set
    var signInBusy by mutableStateOf(false)
        private set
    var signInError by mutableStateOf<String?>(null)
        private set

    val backStack = mutableStateListOf<Screen>()
    val screen: Screen? get() = backStack.lastOrNull()
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

    var streamingId by mutableStateOf<String?>(null)
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

    init {
        io.execute {
            val chats = repo.loadConversations()
            val lib = repo.loadLibrary()
            main.post {
                conversations.clear()
                conversations.addAll(chats)
                library = lib
                loaded = true
            }
        }
        if (signedIn) refreshCatalogue()
    }

    override fun onCleared() {
        activeStream.getAndSet(null)?.disconnect()
        io.shutdownNow()
        super.onCleared()
    }

    // --- Navigation --------------------------------------------------------

    fun push(screen: Screen) {
        if (backStack.lastOrNull() != screen) backStack.add(screen)
    }

    /** Returns false when there was nothing to go back to. */
    fun back(): Boolean {
        if (backStack.isEmpty()) return false
        backStack.removeAt(backStack.lastIndex)
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
                    WebShell.setSessionCookie(server, cookie)
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
        WebShell.setSessionCookie(server, null)
        if (erase) {
            conversations.clear()
            library = Library()
        }
        backStack.clear()
        providers = emptyList()
        models.clear()
        signedIn = false
    }

    val serverUrl: String get() = store.server ?: ""
    val username: String get() = store.username ?: ""

    // --- Providers and models ---------------------------------------------------

    fun refreshCatalogue() {
        if (catalogueBusy) return
        catalogueBusy = true
        catalogueError = null
        io.execute {
            try {
                val list = api.providers()
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
            val list = api.models(provider)
            main.post { models[provider] = list }
        } catch (e: ApiException) {
            main.post { notice = e.message }
        }
    }

    fun loadModels(provider: String) {
        if (models.containsKey(provider)) return
        io.execute { loadModelsBlocking(provider) }
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
        backStack.clear()
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
        backStack.clear()
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

    fun send(id: String, text: String, images: List<String> = emptyList()) {
        val chat = conversation(id) ?: return
        val trimmed = text.trim()
        if ((trimmed.isEmpty() && images.isEmpty()) || streamingId != null) return
        if (chat.provider.isEmpty() || chat.model.isEmpty()) {
            notice = "Pick a model first (tap the model name at the top)."
            return
        }
        val now = System.currentTimeMillis()
        val withUser = chat.copy(
            title = if (chat.messages.none { it.role == "user" }) deriveTitle(trimmed.ifEmpty { "Photo" }) else chat.title,
            messages = chat.messages + ChatMessage("user", trimmed, createdAt = now, images = images),
            updatedAt = now,
        )
        drafts.remove(id)
        replace(withUser)
        runReply(withUser)
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
    }

    fun setMode(id: String, mode: String) {
        val chat = conversation(id) ?: return
        if (mode !in com.freeai4u.app.data.MODES) return
        replace(chat.copy(mode = mode))
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
        stopRequested = false
        val lib = library
        io.execute {
            var chat = start
            var useTools = true
            var round = 0
            var finalText = ""
            val seenCalls = HashMap<String, Int>()
            while (round <= MAX_TOOL_ROUNDS && !stopRequested) {
                val persona = personaFor(lib, chat.personaId)
                val body = buildChatBody(
                    chat.model,
                    systemPrompt(persona.systemPrompt, lib.instructions, chat.mode),
                    chat.messages,
                    tools = if (useTools) toolsForMode(chat.mode) else null,
                )
                val started = System.currentTimeMillis()
                val content = StringBuilder()
                val reasoning = StringBuilder()
                val collector = ToolCallCollector()
                var failure: String? = null
                var lastPost = 0L
                val base = chat
                fun draft(error: String?): ChatMessage = when {
                    error != null && content.isEmpty() -> ChatMessage("assistant", error, createdAt = started, error = true, model = chat.model)
                    error != null -> ChatMessage("assistant", "$content\n\n⚠️ $error", reasoning.toString(), started, model = chat.model)
                    else -> ChatMessage("assistant", content.toString(), reasoning.toString(), started, model = chat.model)
                }
                publishChat(base.copy(messages = base.messages + draft(null)), persist = false)
                try {
                    api.streamChat(chat.provider, body, activeStream) { event ->
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
                            is ChatEvent.Failure -> failure = event.message
                            is ChatEvent.Partial -> failure = event.notice
                            ChatEvent.Done -> Unit
                        }
                    }
                } catch (e: ApiException) {
                    failure = e.message
                    if (e.authRequired) main.post { signedIn = false }
                } catch (e: Exception) {
                    failure = e.message ?: "The reply failed."
                }
                val calls = collector.calls()
                val error = failure
                if (error != null && useTools && content.isEmpty() && calls.isEmpty() && looksLikeToolsUnsupported(error)) {
                    useTools = false
                    continue
                }
                if (stopRequested && content.isEmpty() && calls.isEmpty()) {
                    chat = base
                    break
                }
                if (error == null && content.isEmpty() && calls.isEmpty()) {
                    chat = base.copy(messages = base.messages + draft("The model sent an empty reply. Try again or pick another model."))
                    break
                }
                val assistant = draft(error).copy(toolCalls = if (error == null) calls else emptyList())
                chat = base.copy(messages = base.messages + assistant)
                finalText = assistant.content
                if (error != null || calls.isEmpty()) break
                publishChat(chat, persist = false)
                for (call in calls) {
                    if (stopRequested) break
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
                    publishChat(chat, persist = false)
                }
                round++
                if (round > MAX_TOOL_ROUNDS) {
                    chat = chat.copy(messages = chat.messages + ChatMessage("assistant", "Stopped after $MAX_TOOL_ROUNDS tool rounds. Say \"continue\" to go on.", createdAt = System.currentTimeMillis(), error = true))
                }
            }
            val done = chat
            val text = finalText
            publishChat(done, persist = true)
            main.post {
                streamingId = null
                finishedReply = Triple(done.id, text, System.currentTimeMillis())
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
        if (!toolAllowed(chat.mode, call.name)) {
            return chat.copy(messages = chat.messages + result("Error: ${call.name} is not available in ${modeLabel(chat.mode)} mode."))
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
                chat.copy(messages = chat.messages + result(message, action = action?.toJson() ?: ""))
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
    var puterDraw: ((prompt: String, done: (Result<Pair<String, ByteArray>>) -> Unit) -> Unit)? = null

    /** Draws on the worker thread: Puter first when switched on, then the
     * server's free image services. Saves the picture and returns its record. */
    private fun drawBlocking(prompt: String): GeneratedImage {
        var provider = ""
        var mime = ""
        var bytes: ByteArray? = null
        val bridge = puterDraw
        if (puterImages && bridge != null) {
            val latch = java.util.concurrent.CountDownLatch(1)
            var outcome: Result<Pair<String, ByteArray>>? = null
            main.post { bridge(prompt) { result -> outcome = result; latch.countDown() } }
            val finished = latch.await(150, java.util.concurrent.TimeUnit.SECONDS)
            val result = outcome
            if (finished && result != null && result.isSuccess) {
                val (type, data) = result.getOrThrow()
                provider = "puter"
                mime = type
                bytes = data
            } else {
                val reason = result?.exceptionOrNull()?.message ?: "timed out"
                main.post {
                    puterImages = false
                    notice = "Puter off: $reason. Using free server images."
                }
            }
        }
        if (bytes == null) {
            val drawn = api.generateImage(prompt)
            provider = drawn.first
            mime = drawn.second
            bytes = drawn.third
        }
        val record = GeneratedImage(UUID.randomUUID().toString(), prompt, provider, mime, System.currentTimeMillis())
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

    fun generateImage(prompt: String) {
        val text = prompt.trim()
        if (text.isEmpty() || imageBusy) return
        imageBusy = true
        imageError = null
        io.execute {
            try {
                drawBlocking(text)
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

    fun runOnIo(block: () -> Unit) = io.execute(block)
    fun runOnMain(block: () -> Unit) = main.post(block)
}
