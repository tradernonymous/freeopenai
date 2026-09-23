package com.neura.os.app.data

// Voice transcript actions (docs/android-master-plan.md, Phase 4): Summarise
// and Translate on a conversation -- a voice session's included, since voice
// mode writes an ordinary chat. They are sent as ordinary, visible messages
// through the normal chat path, so nothing new runs unseen. Speaker
// diarization stays out of scope: not doable on-device, not worth a cloud
// dependency.

fun summarisePrompt(): String =
    "Summarise this conversation so far: the key points, any decisions made, and any open questions. Short bullets."

/** A language name: letters (any script), spaces and hyphens, at most 40
 * characters. Anything else -- a sentence, punctuation -- is refused, so the
 * field cannot smuggle a different instruction into the prompt. */
fun isLanguageName(text: String): Boolean {
    val name = text.trim()
    return name.isNotEmpty() && name.length <= 40 && name.all { it.isLetter() || it == ' ' || it == '-' }
}

fun translatePrompt(language: String): String =
    "Translate this conversation so far into ${language.trim()}, keeping who said what. Reply with the translation only."
