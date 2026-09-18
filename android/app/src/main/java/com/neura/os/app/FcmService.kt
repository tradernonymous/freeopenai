package com.neura.os.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.neura.os.app.data.NativeApi
import com.neura.os.app.data.SessionManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** The Android half of instant build-approval push: registers this device's
 * token with the server, and turns a push into the exact notification
 * NativeActivity.notifyBuild already shows while the app is alive in the
 * background, so the two paths look identical to the user. Declared in the
 * manifest unconditionally -- Firebase never delivers anything here without a
 * real project behind google-services.json, so this is inert rather than
 * risky on a build that never set one up. Every entry point still checks
 * BuildConfig.FCM_CONFIGURED and swallows its own failures: a push is a
 * convenience layered on top of the SSE stream that already reaches an open
 * app instantly, never something the rest of the app can depend on. */
class FcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        if (!BuildConfig.FCM_CONFIGURED) return
        try {
            val store = SecureStore(applicationContext)
            if (store.server.isNullOrEmpty() || store.username.isNullOrEmpty()) return
            NativeApi(SessionManager(store)).registerPush(token)
        } catch (e: Exception) {
            // No instant push until the next token refresh or app launch
            // retries this -- not worth surfacing to a user who is not looking.
        }
    }

    // Deliberately reads only message.data (see fcm-push.js: the server never
    // sends a top-level "notification" field), because that field would make
    // Android auto-display a generic system notification and skip this method
    // entirely whenever the app is backgrounded -- exactly the app state this
    // feature exists for.
    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.data["title"]?.takeIf { it.isNotBlank() } ?: return
        val body = message.data["body"] ?: ""
        val buildId = message.data["buildId"]?.takeIf { it.matches(Regex("^[a-f0-9]{16,64}$")) }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(NativeActivity.CHANNEL_BUILDS, "Builds waiting for you", NotificationManager.IMPORTANCE_HIGH))
        val openIntent = Intent(this, NativeActivity::class.java).setAction(NativeActivity.ACTION_OPEN_BUILD)
        if (buildId != null) openIntent.putExtra(NativeActivity.EXTRA_BUILD_ID, buildId)
        val key = buildId ?: "push"
        val open = PendingIntent.getActivity(
            this, key.hashCode(), openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, NativeActivity.CHANNEL_BUILDS)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle(title)
            .setContentText(body.take(160))
            .setStyle(NotificationCompat.BigTextStyle().bigText(body.take(400)))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        manager.notify(("build:" + key).hashCode(), notification)
    }
}
