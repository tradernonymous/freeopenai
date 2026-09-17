package com.freeai4u.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/** Holds the process open while a reply streams, so a long answer or a run of
 * tool steps finishes even when the phone is in the user's pocket. The
 * notification names the chat and opens it; the service stops itself the
 * moment the turn ends. Every entry point swallows failure, because losing a
 * reply to a refused start would be worse than not having the guard. */
class ReplyService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    // Android 15 gives a dataSync service six hours a day and then calls this;
    // a service that does not stop itself here is killed with the whole app.
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf()
    }

    override fun onTimeout(startId: Int) {
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val chatId = intent?.getStringExtra(EXTRA_CHAT_ID) ?: ""
        val title = intent?.getStringExtra(EXTRA_TITLE)?.ifBlank { "FreeAI4U" } ?: "FreeAI4U"
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(
            NotificationChannel(CHANNEL, "Replying", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
        )
        val open = PendingIntent.getActivity(
            this, chatId.hashCode(),
            Intent(this, NativeActivity::class.java).setAction(NativeActivity.ACTION_OPEN_CHAT).putExtra(NativeActivity.EXTRA_CHAT_ID, chatId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle(title)
            .setContentText("Replying…")
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    companion object {
        const val ACTION_STOP = "com.freeai4u.app.REPLY_DONE"
        const val EXTRA_CHAT_ID = "chat_id"
        const val EXTRA_TITLE = "title"
        private const val CHANNEL = "replying"
        private const val NOTIFICATION_ID = 41

        /** Starts the guard; never throws. */
        fun start(context: Context, chatId: String, title: String) {
            try {
                val intent = Intent(context, ReplyService::class.java)
                    .putExtra(EXTRA_CHAT_ID, chatId)
                    .putExtra(EXTRA_TITLE, title)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
            } catch (e: Exception) {
                // A refused start must not touch the reply that is already running.
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, ReplyService::class.java))
            } catch (e: Exception) {
                // Already gone.
            }
        }
    }
}
