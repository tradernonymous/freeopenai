package com.neura.os.app.ui
import com.neura.os.BuildConfig
import com.neura.os.BuildConfig

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.neura.os.app.BuildConfig

@Composable
fun SignInScreen(vm: AppViewModel) {
    var server by rememberSaveable { mutableStateOf(vm.serverUrl.ifEmpty { BuildConfig.DEFAULT_SERVER }) }
    var user by rememberSaveable { mutableStateOf(vm.username.ifEmpty { BuildConfig.DEFAULT_USERNAME }) }
    // Never saved into instance state: a password does not belong in a Bundle.
    var pass by androidx.compose.runtime.remember { mutableStateOf("") }
    var showPass by androidx.compose.runtime.remember { mutableStateOf(false) }
    // Taps are ignored while another app draws over this screen (tapjacking),
    // as FirebaseUI does for its sign-in dialogs.
    val view = androidx.compose.ui.platform.LocalView.current
    androidx.compose.runtime.DisposableEffect(Unit) {
        view.filterTouchesWhenObscured = true
        onDispose { view.filterTouchesWhenObscured = false }
    }
    Column(
        Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Spacer(Modifier.height(48.dp))
        Text("NeuraOS", style = MaterialTheme.typography.headlineLarge, color = Palette.green, modifier = Modifier.enterUp())
        Spacer(Modifier.height(6.dp))
        Text("Free AI, one app. Sign in once.", color = Palette.muted, modifier = Modifier.enterUp(80))
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(server, { server = it }, label = { Text("Server") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("login_server"),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next))
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(user, { user = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("login_username"),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next))
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(pass, { pass = it }, label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("login_password"),
            visualTransformation = if (showPass) androidx.compose.ui.text.input.VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                androidx.compose.material3.IconButton({ showPass = !showPass }) {
                    Icon(
                        if (showPass) androidx.compose.material.icons.Icons.Filled.VisibilityOff else androidx.compose.material.icons.Icons.Filled.Visibility,
                        if (showPass) "Hide password" else "Show password",
                    )
                }
            },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { vm.signIn(server, user, pass) }))
        androidx.compose.animation.AnimatedVisibility(vm.signInError != null) {
            Text(vm.signInError ?: "", color = Palette.red, modifier = Modifier.padding(top = 10.dp))
        }
        Spacer(Modifier.height(18.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { vm.signIn(server, user, pass) }, enabled = !vm.signInBusy && user.isNotBlank() && pass.isNotEmpty(), modifier = Modifier.testTag("login_submit").pressScale()) { Text("Sign in") }
            if (vm.signInBusy) {
                Spacer(Modifier.padding(8.dp))
                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            }
        }
        Spacer(Modifier.height(24.dp))
        Text("Password sealed on this phone only.", color = Palette.muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun LockScreen(error: String?, onUnlock: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Filled.Fingerprint, contentDescription = null, tint = Palette.green, modifier = Modifier.size(72.dp))
        Spacer(Modifier.height(16.dp))
        Text("NeuraOS is locked", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Text("Use your fingerprint or screen lock to open your chats.", color = Palette.muted)
        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = Palette.red)
        }
        Spacer(Modifier.height(20.dp))
        Button(onClick = onUnlock) { Text("Unlock") }
    }
}
