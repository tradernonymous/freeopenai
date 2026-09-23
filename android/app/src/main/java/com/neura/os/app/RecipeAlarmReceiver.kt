package com.neura.os.app
import com.neura.os.R

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.neura.os.app.data.RecipeSchedule
import com.neura.os.app.data.Repository
import com.neura.os.app.data.isScheduleId
import com.neura.os.app.data.nextFireAt
import com.neura.os.app.data.scheduleLabel
import java.time.ZoneId

/** A scheduled recipe came due (data/Schedules.kt). Not exported: only this
 * app's own alarm, an explicit immutable PendingIntent, reaches it. It shows a
 * notification that opens a chat with the prompt typed in -- it never sends
 * anything -- and arms the next occurrence. */
class RecipeAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != RecipeAlarms.ACTION_DUE) return
        val id = intent.getStringExtra(RecipeAlarms.EXTRA_SCHEDULE_ID)?.takeIf { isScheduleId(it) } ?: return
        val app = context.applicationContext
        val pending = goAsync()
        Thread {
            try {
                // Read from disk, not from the intent: a schedule edited or
                // deleted since the alarm was set wins.
                val schedule = Repository(app).loadSchedules().firstOrNull { it.id == id && it.enabled }
                if (schedule != null) {
                    RecipeAlarms.notifyDue(app, schedule)
                    RecipeAlarms.arm(app, schedule)
                }
            } catch (e: Exception) {
                // A Keystore or disk fault: this occurrence is missed, and the
                // next app start re-arms every schedule.
            } finally {
                pending.finish()
            }
        }.start()
    }
}

/** Arming, cancelling and announcing scheduled recipes. Alarms are inexact
 * (a 15-minute window), so no exact-alarm permission is needed and the phone
 * can batch the wake-up with others. */
object RecipeAlarms {
    const val ACTION_DUE = "com.neura.os.app.RECIPE_DUE"
    const val EXTRA_SCHEDULE_ID = "schedule_id"
    private const val CHANNEL = "recipes"
    private const val WINDOW_MS = 15 * 60 * 1000L

    fun arm(context: Context, schedule: RecipeSchedule) {
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        val at = nextFireAt(schedule, System.currentTimeMillis(), ZoneId.systemDefault())
        if (at == null) {
            alarms.cancel(alarmIntent(context, schedule.id))
            return
        }
        alarms.setWindow(AlarmManager.RTC_WAKEUP, at, WINDOW_MS, alarmIntent(context, schedule.id))
    }

    fun cancel(context: Context, id: String) {
        context.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(context, id))
        context.getSystemService(NotificationManager::class.java)?.cancel(notificationId(id))
    }

    /** Every stored schedule, armed or cancelled to match; called on app start
     * and after a reboot, which clears all alarms. */
    fun armAll(context: Context, schedules: List<RecipeSchedule>) {
        schedules.forEach { if (it.enabled) arm(context, it) else cancel(context, it.id) }
    }

    private fun alarmIntent(context: Context, id: String): PendingIntent = PendingIntent.getBroadcast(
        context, id.hashCode(),
        Intent(context, RecipeAlarmReceiver::class.java).setAction(ACTION_DUE).putExtra(EXTRA_SCHEDULE_ID, id),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notificationId(id: String): Int = ("recipe:" + id).hashCode()

    fun notifyDue(context: Context, schedule: RecipeSchedule) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Scheduled recipes", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            context, notificationId(schedule.id),
            Intent(context, NativeActivity::class.java)
                .setAction(NativeActivity.ACTION_RUN_RECIPE)
                .putExtra(EXTRA_SCHEDULE_ID, schedule.id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val preview = schedule.prompt.replace(Regex("\\s+"), " ").take(160)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_app)
            .setContentTitle("Scheduled: " + scheduleLabel(schedule))
            .setContentText("Tap to review and send: $preview")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Tap to review and send:\n$preview"))
            .setContentIntent(open)
            .setAutoCancel(true)
            // The prompt stays hidden on the lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        manager.notify(notificationId(schedule.id), notification)
    }
}
