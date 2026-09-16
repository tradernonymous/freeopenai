package com.freeai4u.app

import android.content.Context
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val PREFS = "freeai4u"
private const val KEY_BASE_URL = "base_url"
private const val KEY_SESSION = "session_cookie"

// Testing build for the owner's own phone: the window is flagged secure so
// screenshots, screen recordings and the recents thumbnail all come out
// blank. Nothing here is worth scraping, but what is not capturable cannot
// leak through a gallery sync or a shoulder-surfed screenshot.
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                ChatScreen()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen() {
    val context = LocalContext.current
    val prefs = remember {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }
    // A private scope on IO: network and parsing never touch the main thread,
    // and every UI write below goes through runOnUiThread explicitly, so this
    // screen never depends on Dispatchers.Main being present.
    val activity = context as ComponentActivity
    val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
    DisposableEffect(Unit) {
        onDispose { scope.cancel() }
    }

    var editingServer by rememberSaveable { mutableStateOf(prefs.getString(KEY_BASE_URL, "").isNullOrEmpty()) }
    var baseUrl by rememberSaveable { mutableStateOf(prefs.getString(KEY_BASE_URL, "") ?: "") }
    var urlError by remember { mutableStateOf<String?>(null) }
    var providers by remember { mutableStateOf(emptyList<ProviderInfo>()) }
    var providerId by rememberSaveable { mutableStateOf<String?>(null) }
    var models by remember { mutableStateOf(emptyList<ModelInfo>()) }
    var modelId by rememberSaveable { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var input by rememberSaveable { mutableStateOf("") }
    // The fo_auth session this deployment issued after a username/password
    // login. App-private, never backed up, wiped on sign-out; a 401 anywhere
    // reopens the login card instead of failing silently.
    var sessionCookie by rememberSaveable { mutableStateOf(prefs.getString(KEY_SESSION, null)) }
    var showLogin by remember { mutableStateOf(false) }
    var loginUser by rememberSaveable { mutableStateOf("") }
    var loginPass by rememberSaveable { mutableStateOf("") }
    var loginError by remember { mutableStateOf<String?>(null) }
    var signingIn by remember { mutableStateOf(false) }
    val messages = remember { mutableStateListOf<ChatMessage>() }
    val listState = rememberLazyListState()

    fun apiOrNull(): ChatApi? {
        return when (val checked = normalizeBaseUrl(baseUrl)) {
            is BaseUrlResult.Ok -> ChatApi(checked.url).also { it.sessionCookie = sessionCookie }
            is BaseUrlResult.Problem -> {
                activity.runOnUiThread { urlError = checked.message }
                null
            }
        }
    }

    fun refreshAll() {
        val api = apiOrNull() ?: return
        loading = true
        error = null
        scope.launch {
            try {
                val found = withContext(Dispatchers.IO) { api.providers() }
                val configured = found.filter { it.configured }
                val firstProvider = configured.firstOrNull()?.id
                val listed = if (firstProvider == null) {
                    emptyList()
                } else {
                    withContext(Dispatchers.IO) { api.models(firstProvider) }
                }
                activity.runOnUiThread {
                    providers = configured
                    if (configured.isEmpty()) {
                        error = "No configured providers on this server. Set a provider key or endpoint on the server first."
                    }
                    if (providerId == null || configured.none { it.id == providerId }) {
                        providerId = firstProvider
                    }
                    models = listed
                    if (modelId == null || listed.none { it.id == modelId }) {
                        modelId = listed.firstOrNull()?.id
                    }
                }
            } catch (e: ApiException) {
                activity.runOnUiThread {
                    error = e.message
                    if (e.authRequired) showLogin = true
                }
            } finally {
                activity.runOnUiThread { loading = false }
            }
        }
    }

    fun reloadModels() {
        val api = apiOrNull() ?: return
        val current = providerId ?: return
        loading = true
        scope.launch {
            try {
                val listed = withContext(Dispatchers.IO) { api.models(current) }
                activity.runOnUiThread {
                    models = listed
                    if (listed.none { it.id == modelId }) modelId = listed.firstOrNull()?.id
                }
            } catch (e: ApiException) {
                activity.runOnUiThread {
                    error = e.message
                    if (e.authRequired) showLogin = true
                }
            } finally {
                activity.runOnUiThread { loading = false }
            }
        }
    }

    fun send() {
        val text = input.trim()
        val pid = providerId
        val mid = modelId
        if (text.isEmpty() || sending || pid == null || mid == null) return
        val api = apiOrNull() ?: return
        input = ""
        error = null
        messages.add(ChatMessage("user", text))
        messages.add(ChatMessage("assistant", ""))
        sending = true
        val history = messages.toList()
        scope.launch {
            val full = StringBuilder()
            try {
                withContext(Dispatchers.IO) {
                    api.streamChat(pid, mid, history, object : ChatListener {
                        override fun onDelta(part: String) {
                            full.append(part)
                            val snapshot = full.toString()
                            activity.runOnUiThread {
                                val last = messages.lastIndex
                                if (last >= 0) messages[last] = messages[last].copy(content = snapshot)
                            }
                        }

                        override fun onDone(fullText: String) {
                            activity.runOnUiThread {
                                val last = messages.lastIndex
                                if (last >= 0 && fullText.isNotEmpty()) {
                                    messages[last] = messages[last].copy(content = fullText)
                                } else if (last >= 0) {
                                    messages[last] = messages[last].copy(content = "(empty reply)")
                                }
                                sending = false
                            }
                        }

                        override fun onError(message: String, authRequired: Boolean) {
                            activity.runOnUiThread {
                                error = message
                                if (authRequired) showLogin = true
                                val last = messages.lastIndex
                                if (last >= 0 && messages[last].content.isEmpty()) {
                                    messages.removeAt(last)
                                }
                                sending = false
                            }
                        }
                    })
                }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    error = e.message ?: "Send failed."
                    if (e is ApiException && e.authRequired) showLogin = true
                    sending = false
                }
            }
        }
    }

    fun signIn() {
        val user = loginUser.trim()
        if (user.isEmpty() || loginPass.isEmpty() || signingIn) return
        val api = apiOrNull() ?: return
        signingIn = true
        loginError = null
        scope.launch {
            try {
                val cookie = withContext(Dispatchers.IO) { api.login(user, loginPass) }
                activity.runOnUiThread {
                    sessionCookie = cookie
                    prefs.edit().putString(KEY_SESSION, cookie).apply()
                    loginPass = ""
                    loginError = null
                    showLogin = false
                    refreshAll()
                }
            } catch (e: ApiException) {
                activity.runOnUiThread { loginError = e.message }
            } catch (e: Exception) {
                activity.runOnUiThread { loginError = e.message ?: "Sign-in failed." }
            } finally {
                activity.runOnUiThread { signingIn = false }
            }
        }
    }

    fun signOut() {
        val api = apiOrNull()
        sessionCookie = null
        prefs.edit().remove(KEY_SESSION).apply()
        showLogin = false
        if (api != null) {
            scope.launch {
                withContext(Dispatchers.IO) { api.logout() }
            }
        }
    }

    // Follow the transcript down while the reader is already there; a reader
    // who scrolled up to re-read must never be yanked back by a new token.
    LaunchedEffect(messages.size) {
        if (messages.isEmpty()) return@LaunchedEffect
        val last = listState.layoutInfo.totalItemsCount - 1
        val visible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index
        if (visible == null || visible >= last - 2) listState.scrollToItem(messages.size - 1)
    }
    LaunchedEffect(baseUrl) {
        if (baseUrl.isNotEmpty() && !editingServer && providers.isEmpty()) refreshAll()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("FreeAI4U") },
                actions = {
                    IconButton(onClick = {
                        messages.clear()
                        error = null
                    }) {
                        Icon(Icons.Filled.Add, contentDescription = "New chat")
                    }
                    IconButton(onClick = { refreshAll() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Reload models")
                    }
                    IconButton(onClick = { editingServer = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = "Server settings")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(12.dp)
        ) {
            if (editingServer) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("Server address", style = MaterialTheme.typography.titleSmall)
                        Spacer(modifier = Modifier.height(8.dp))
                        OutlinedTextField(
                            value = baseUrl,
                            onValueChange = { baseUrl = it; urlError = null },
                            label = { Text("https://…") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                        if (urlError != null) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(urlError ?: "", color = MaterialTheme.colorScheme.error)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Row {
                            Button(onClick = {
                                when (val checked = normalizeBaseUrl(baseUrl)) {
                                    is BaseUrlResult.Ok -> {
                                        prefs.edit().putString(KEY_BASE_URL, checked.url).apply()
                                        baseUrl = checked.url
                                        providers = emptyList()
                                        providerId = null
                                        models = emptyList()
                                        modelId = null
                                        editingServer = false
                                        refreshAll()
                                    }
                                    is BaseUrlResult.Problem -> urlError = checked.message
                                }
                            }) {
                                Text("Connect")
                            }
                            if (prefs.getString(KEY_BASE_URL, "").isNullOrEmpty().not()) {
                                Spacer(modifier = Modifier.width(8.dp))
                                Button(onClick = { editingServer = false }) {
                                    Text("Cancel")
                                }
                            }
                            if (sessionCookie != null) {
                                Spacer(modifier = Modifier.width(8.dp))
                                Button(onClick = { signOut() }) {
                                    Text("Sign out")
                                }
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
            }

            if (showLogin) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("Sign in", style = MaterialTheme.typography.titleSmall)
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            "This server needs one of its app accounts -- the same username and password its login page takes.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        OutlinedTextField(
                            value = loginUser,
                            onValueChange = { loginUser = it; loginError = null },
                            label = { Text("Username") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        OutlinedTextField(
                            value = loginPass,
                            onValueChange = { loginPass = it; loginError = null },
                            label = { Text("Password") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            modifier = Modifier.fillMaxWidth()
                        )
                        if (loginError != null) {
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(loginError ?: "", color = MaterialTheme.colorScheme.error)
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Row {
                            Button(onClick = { signIn() }, enabled = !signingIn) {
                                Text(if (signingIn) "Signing in…" else "Sign in")
                            }
                            Spacer(modifier = Modifier.width(8.dp))
                            Button(onClick = { showLogin = false; loginError = null }) {
                                Text("Cancel")
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                var providerOpen by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(
                    expanded = providerOpen,
                    onExpandedChange = { providerOpen = it },
                    modifier = Modifier.weight(1f)
                ) {
                    OutlinedTextField(
                        value = providers.find { it.id == providerId }?.label ?: providerId ?: "Provider",
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Provider") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = providerOpen) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = providerOpen,
                        onDismissRequest = { providerOpen = false }
                    ) {
                        providers.forEach { p ->
                            DropdownMenuItem(
                                text = { Text(p.label.ifEmpty { p.id }) },
                                onClick = {
                                    providerId = p.id
                                    modelId = null
                                    providerOpen = false
                                    reloadModels()
                                }
                            )
                        }
                    }
                }
                var modelOpen by remember { mutableStateOf(false) }
                ExposedDropdownMenuBox(
                    expanded = modelOpen,
                    onExpandedChange = { modelOpen = it },
                    modifier = Modifier.weight(1f)
                ) {
                    OutlinedTextField(
                        value = modelLabel(models, modelId),
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Model") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelOpen) },
                        modifier = Modifier.menuAnchor().fillMaxWidth()
                    )
                    ExposedDropdownMenu(
                        expanded = modelOpen,
                        onDismissRequest = { modelOpen = false }
                    ) {
                        models.forEach { m ->
                            DropdownMenuItem(
                                text = { Text(if (m.free) m.id + " · free" else m.id) },
                                onClick = {
                                    modelId = m.id
                                    modelOpen = false
                                }
                            )
                        }
                    }
                }
            }

            if (loading) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    horizontalArrangement = Arrangement.Center
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }

            if (error != null) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
                ) {
                    Text(
                        error ?: "",
                        modifier = Modifier.padding(10.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
            }

            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(messages.size) { index ->
                    val message = messages[index]
                    if (message.role == "user") {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.End
                        ) {
                            Card(
                                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
                                modifier = Modifier.fillMaxWidth(0.92f)
                            ) {
                                Text(message.content, modifier = Modifier.padding(10.dp))
                            }
                        }
                    } else {
                        SelectionContainer {
                            Text(message.content.ifEmpty { "…" }, modifier = Modifier.padding(vertical = 2.dp))
                        }
                    }
                }
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    label = { Text("Ask anything…") },
                    modifier = Modifier.weight(1f)
                )
                Spacer(modifier = Modifier.width(8.dp))
                if (sending) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                } else {
                    IconButton(onClick = { send() }) {
                        Icon(Icons.Filled.Send, contentDescription = "Send")
                    }
                }
            }
        }
    }
}

private fun modelLabel(models: List<ModelInfo>, modelId: String?): String {
    val found = models.find { it.id == modelId } ?: return modelId ?: "Model"
    return if (found.free) found.id + " · free" else found.id
}
