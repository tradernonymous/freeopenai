package com.neura.os.app
import com.neura.os.R

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.neura.os.app.data.NativeApi
import com.neura.os.app.data.SessionManager
import com.neura.os.app.data.isApprovalTarget

/** "Approve" on a build's notification (docs/android-master-plan.md, V7).
 * Not exported: only this app's own immutable, explicit PendingIntent
 * reaches it, and the action that carries it is marked
 * setAuthenticationRequired, so Android asks for the device unlock before
 * the tap arrives here. It approves exactly the change the notification
 * showed -- that request id, on that build -- and replaces the notification
 * with what happened. Questions are never answered from here: they need
 * words, so their notification only opens the build. */
class BuildApprovalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_APPROVE) return
        val buildId = intent.getStringExtra(EXTRA_BUILD_ID)
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
        if (!isApprovalTarget(buildId, requestId)) return
        val app = context.applicationContext
        val pending = goAsync()
        Thread {
            val outcome = try {
                // A background broadcast gets about 10 seconds before the
                // system kills the process for exceeding it. answerBuild uses
                // the session manager's 30s read timeout, so a stalled network
                // could run past the deadline and turn a slow approval into a
                // broadcast-timeout ANR. Bounded well inside the budget.
                val watchdog = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
                try {
                    watchdog.schedule({ pending.finish() }, APPROVAL_BUDGET_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
                    NativeApi(SessionManager(SecureStore(app))).answerBuild(buildId!!, requestId!!, "approve", "")
                } finally {
                    watchdog.shutdownNow()
                }
                "Approved. The build carries on."
            } catch (e: Exception) {
                "Could not approve: " + (e.message ?: "the server did not answer") + ". Open the build to try again."
            }
            try {
                showOutcome(app, buildId!!, outcome)
            } catch (e: Exception) {
                // The result is already known; failing to post it must not
                // leave the broadcast un-finished and get the process killed.
            } finally {
                pending.finish()
            }
        }.start()
    }

    private fun showOutcome(context: Context, buildId: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val open = PendingIntent.getActivity(
            context, buildId.hashCode(),
            Intent(context, NativeActivity::class.java).setAction(NativeActivity.ACTION_OPEN_BUILD).putExtra(NativeActivity.EXTRA_BUILD_ID, buildId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, NativeActivity.CHANNEL_BUILDS)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle("Build")
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        manager.notify(("build:" + buildId).hashCode(), notification)
    }

    companion object {
        const val ACTION_APPROVE = "com.neura.os.app.APPROVE_BUILD_CHANGE"
        const val EXTRA_BUILD_ID = "build_id"
        const val EXTRA_REQUEST_ID = "request_id"
        /** Comfortably inside the ~10s a background broadcast is allowed
         * before the system kills the process for exceeding it. */
        const val APPROVAL_BUDGET_MS = 6_000L

        /** The Approve action for a build's notification: explicit, immutable,
         * and only usable once the phone is unlocked. */
        fun action(context: Context, buildId: String, requestId: String): NotificationCompat.Action {
            val intent = Intent(context, BuildApprovalReceiver::class.java)
                .setAction(ACTION_APPROVE)
                .putExtra(EXTRA_BUILD_ID, buildId)
                .putExtra(EXTRA_REQUEST_ID, requestId)
            val pending = PendingIntent.getBroadcast(
                context, ("approve:" + buildId + requestId).hashCode(), intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return NotificationCompat.Action.Builder(R.drawable.ic_app, "Approve", pending)
                .setAuthenticationRequired(true)
                .build()
        }
    }
}
