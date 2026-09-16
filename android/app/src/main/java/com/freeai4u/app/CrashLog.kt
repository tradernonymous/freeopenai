package com.freeai4u.app

import android.content.Context
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/** Keeps the last crash's stack trace in app-private storage so it can be
 * copied from the app's settings and pasted into an issue. Nothing is sent
 * anywhere, and the trace holds code locations only -- no page content, no
 * credentials. The system's own handler still runs afterwards. */
object CrashLog {
    private const val FILE = "last_crash.txt"

    fun install(context: Context) {
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        if (previous is Recorder) return
        Thread.setDefaultUncaughtExceptionHandler(Recorder(app, previous))
    }

    fun read(context: Context): String? {
        val file = File(context.filesDir, FILE)
        return if (file.isFile) file.readText().ifBlank { null } else null
    }

    fun clear(context: Context) {
        File(context.filesDir, FILE).delete()
    }

    private class Recorder(
        private val context: Context,
        private val previous: Thread.UncaughtExceptionHandler?
    ) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(thread: Thread, error: Throwable) {
            try {
                val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
                val header = "FreeAI4U " + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")" +
                    ", Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")" +
                    ", " + Build.MANUFACTURER + " " + Build.MODEL + "\n" +
                    "thread: " + thread.name + "\n\n"
                File(context.filesDir, FILE).writeText((header + trace).take(32000))
            } catch (ignored: Throwable) {
                // Recording must never mask the crash itself.
            }
            previous?.uncaughtException(thread, error)
        }
    }
}
