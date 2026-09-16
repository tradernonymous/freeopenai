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
import com.freeai4u.app.data.deriveTitle
import com.freeai4u.app.data.personaFor
import com.freeai4u.app.normalizeBaseUrl
import java.net.HttpURLConnection
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

enum class Tab { CHATS, IMAGES, TOOLS, SETTINGS }

sealed interface Screen {
    data object Home : Screen
    data class Chat(val id: String) : Screen
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

    var tab by mutableStateOf(Tab.CHATS)
    val backStack = mutableStateListOf<Screen>()
    val screen: Screen get() = backStack.lastOrNull() ?: Screen.Home

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
        backStack.add(screen)
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

    fun newChat(personaId: String = DEFAULT_PERSONA_ID, draft: String = ""): String {
        val now = System.currentTimeMillis()
        val (provider, model) = startingModel()
        val chat = Conversation(UUID.randomUUID().toString(), "New chat", personaId, provider, model, emptyList(), now, now)
        conversations.add(chat)
        if (draft.isNotEmpty()) drafts[chat.id] = draft
        backStack.clear()
        tab = Tab.CHATS
        push(Screen.Chat(chat.id))
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
        backStack.removeAll { it is Screen.Chat && it.id == id }
        io.execute { repo.deleteConversation(id) }
    }

    fun deleteAllChats() {
        stop()
        conversations.clear()
        drafts.clear()
        backStack.removeAll { it is Screen.Chat }
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
            backStack.removeAll { it is Screen.Chat && it.id == id }
            push(Screen.Chat(target.id))
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
        push(Screen.Chat(copy.id))
    }

    fun stop() {
        activeStream.getAndSet(null)?.let { connection -> io.execute { connection.disconnect() } }
    }

    private fun runReply(chat: Conversation) {
        val persona = personaFor(library, chat.personaId)
        val body = buildChatBody(chat.model, persona.systemPrompt, chat.messages)
        val started = System.currentTimeMillis()
        val placeholder = ChatMessage("assistant", "", createdAt = started, model = chat.model)
        replace(chat.copy(messages = chat.messages + placeholder), persist = false)
        streamingId = chat.id
        io.execute {
            val content = StringBuilder()
            val reasoning = StringBuilder()
            var failure: String? = null
            var lastPost = 0L
            fun publish(final: Boolean) {
                val text = content.toString()
                val thought = reasoning.toString()
                val error = failure
                main.post {
                    val current = conversation(chat.id) ?: return@post
                    val messages = current.messages.toMutableList()
                    if (messages.isEmpty() || messages.last().role != "assistant" || messages.last().createdAt != started) return@post
                    messages[messages.lastIndex] = when {
                        error != null && text.isEmpty() -> placeholder.copy(content = error, error = true)
                        error != null -> placeholder.copy(content = "$text\n\n⚠️ $error", reasoning = thought)
                        else -> placeholder.copy(content = text, reasoning = thought)
                    }
                    val updated = current.copy(messages = messages, updatedAt = System.currentTimeMillis())
                    replace(updated, persist = final)
                    if (final) streamingId = null
                }
            }
            try {
                api.streamChat(chat.provider, body, activeStream) { event ->
                    when (event) {
                        is ChatEvent.Delta -> {
                            content.append(event.content)
                            reasoning.append(event.reasoning)
                            val now = System.currentTimeMillis()
                            if (now - lastPost > 60) {
                                lastPost = now
                                publish(false)
                            }
                        }
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
            if (content.isEmpty() && failure == null) failure = "The model sent an empty reply. Try again or pick another model."
            publish(true)
        }
    }

    // --- Library -------------------------------------------------------------

    private fun updateLibrary(updated: Library) {
        library = updated
        io.execute { repo.saveLibrary(updated) }
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

    fun generateImage(prompt: String) {
        val text = prompt.trim()
        if (text.isEmpty() || imageBusy) return
        imageBusy = true
        imageError = null
        io.execute {
            try {
                val (provider, mime, bytes) = api.generateImage(text)
                val record = GeneratedImage(UUID.randomUUID().toString(), text, provider, mime, System.currentTimeMillis())
                repo.saveImage(record.id, bytes)
                main.post {
                    imageBusy = false
                    updateLibrary(library.copy(images = listOf(record) + library.images))
                }
            } catch (e: ApiException) {
                main.post {
                    imageBusy = false
                    imageError = e.message
                    if (e.authRequired) signedIn = false
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
