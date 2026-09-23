package com.neura.os.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.neura.os.app.data.Repository

/** A reboot (or an app update) clears every alarm; this re-arms the scheduled
 * recipes. Exported only because Android delivers BOOT_COMPLETED and
 * MY_PACKAGE_REPLACED that way: both are protected broadcasts only the system
 * can send, anything else is ignored, and all it does is re-arm what the
 * person already saved. */
class RecipeBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext
        val pending = goAsync()
        Thread {
            try {
                RecipeAlarms.armAll(app, Repository(app).loadSchedules())
            } catch (e: Exception) {
                // Re-armed on the next app start instead.
            } finally {
                pending.finish()
            }
        }.start()
    }
}
