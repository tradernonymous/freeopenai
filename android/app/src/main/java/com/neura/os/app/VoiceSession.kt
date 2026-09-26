package com.neura.os.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

/** Hands-free voice chat: listen, send what was heard, read the reply aloud,
 * listen again. Uses the phone's own speech recognizer and text-to-speech, so
 * it needs no key; the microphone permission is asked for when voice mode is
 * first opened, never at install.
 *
 * @Stable for the same reason as Platform: it holds a Context and a plain
 * var, so the compiler infers unstable, and composables that take it could
 * never be skipped. */
@Stable
class VoiceSession(private val context: Context, private val onHeard: (String) -> Unit) {
    enum class State { IDLE, LISTENING, THINKING, SPEAKING }

    var state by mutableStateOf(State.IDLE)
        private set
    var level by mutableFloatStateOf(0f)
        private set
    var partial by mutableStateOf("")
        private set
    var error by mutableStateOf<String?>(null)
        private set

    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var active = false

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    fun start() {
        active = true
        error = null
        if (tts == null) {
            tts = TextToSpeech(context) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                tts?.language = Locale.getDefault()
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {}
                    override fun onDone(utteranceId: String?) {
                        android.os.Handler(context.mainLooper).post { if (active) listen() }
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        android.os.Handler(context.mainLooper).post { if (active) listen() }
                    }
                })
            }
        }
        listen()
    }

    fun stop() {
        active = false
        recognizer?.cancel()
        tts?.stop()
        state = State.IDLE
        level = 0f
        partial = ""
    }

    fun release() {
        stop()
        recognizer?.destroy()
        recognizer = null
        tts?.shutdown()
        tts = null
    }

    /** The reply arrived: read it aloud, then listen again. */
    fun speak(text: String) {
        if (!active) return
        val clean = text.replace(Regex("```[\\s\\S]*?```"), " code block ").replace(Regex("[*#`_>|]"), "").take(3900)
        val engine = tts
        if (engine == null || !ttsReady || clean.isBlank()) {
            listen()
            return
        }
        state = State.SPEAKING
        engine.speak(clean, TextToSpeech.QUEUE_FLUSH, null, "voice-reply")
    }

    /** Back to listening after a turn that never started -- a refused message
     * would otherwise leave voice mode thinking with nothing on the way. */
    fun listenAgain() {
        if (active) listen()
    }

    private fun listen() {
        if (!active) return
        val speech = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { created ->
            created.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { state = State.LISTENING }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) { level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) }
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { level = 0f }
                override fun onError(code: Int) {
                    level = 0f
                    if (!active) return
                    if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        listen()
                    } else {
                        error = "Mic error $code"
                        state = State.IDLE
                    }
                }
                override fun onResults(results: Bundle?) {
                    val heard = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    partial = ""
                    if (heard.isBlank()) {
                        listen()
                    } else {
                        state = State.THINKING
                        onHeard(heard)
                    }
                }
                override fun onPartialResults(partialResults: Bundle?) {
                    partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                }
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            recognizer = created
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        state = State.LISTENING
        speech.startListening(intent)
    }
}
