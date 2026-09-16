package com.freeai4u.app.data

import org.json.JSONArray
import org.json.JSONObject

// The app's own records and their JSON form. Everything here is pure (org.json
// only), so the round trips are unit-tested on the JVM. The JSON is what gets
// sealed on disk by SecureBox; nothing in it ever leaves the phone except
// through an export the user asks for.

data class ChatMessage(
    val role: String,
    val content: String,
    val reasoning: String = "",
    val createdAt: Long = 0L,
    /** Set when the reply failed; the text says why, and it is never sent
     * back to a model as history. */
    val error: Boolean = false,
    /** Which model produced an assistant message. */
    val model: String = "",
    /** Photos attached to a user message, as downscaled JPEG data URLs. */
    val images: List<String> = emptyList(),
)

data class Conversation(
    val id: String,
    val title: String,
    val personaId: String,
    val provider: String,
    val model: String,
    val messages: List<ChatMessage>,
    val createdAt: Long,
    val updatedAt: Long,
    val pinned: Boolean = false,
)

data class Persona(
    val id: String,
    val name: String,
    val emoji: String,
    val systemPrompt: String,
    val builtIn: Boolean = false,
)

data class PromptTemplate(
    val id: String,
    val title: String,
    val text: String,
    val builtIn: Boolean = false,
)

data class GeneratedImage(
    val id: String,
    val prompt: String,
    val provider: String,
    val mime: String,
    val createdAt: Long,
)

fun ChatMessage.toJson(): JSONObject = JSONObject()
    .put("role", role)
    .put("content", content)
    .put("reasoning", reasoning)
    .put("createdAt", createdAt)
    .put("error", error)
    .put("model", model)
    .put("images", JSONArray(images))

fun chatMessageFromJson(obj: JSONObject): ChatMessage = ChatMessage(
    role = obj.optString("role", "user"),
    content = obj.optString("content", ""),
    reasoning = obj.optString("reasoning", ""),
    createdAt = obj.optLong("createdAt", 0L),
    error = obj.optBoolean("error", false),
    model = obj.optString("model", ""),
    images = obj.optJSONArray("images")?.let { list -> (0 until list.length()).map { list.optString(it, "") }.filter { it.startsWith("data:image/") } } ?: emptyList(),
)

fun Conversation.toJson(): JSONObject {
    val list = JSONArray()
    messages.forEach { list.put(it.toJson()) }
    return JSONObject()
        .put("v", 1)
        .put("id", id)
        .put("title", title)
        .put("personaId", personaId)
        .put("provider", provider)
        .put("model", model)
        .put("messages", list)
        .put("createdAt", createdAt)
        .put("updatedAt", updatedAt)
        .put("pinned", pinned)
}

fun conversationFromJson(text: String): Conversation? = try {
    val obj = JSONObject(text)
    val list = obj.optJSONArray("messages") ?: JSONArray()
    val messages = (0 until list.length()).mapNotNull { index -> list.optJSONObject(index)?.let(::chatMessageFromJson) }
    val id = obj.optString("id", "")
    if (id.isEmpty()) null else Conversation(
        id = id,
        title = obj.optString("title", ""),
        personaId = obj.optString("personaId", ""),
        provider = obj.optString("provider", ""),
        model = obj.optString("model", ""),
        messages = messages,
        createdAt = obj.optLong("createdAt", 0L),
        updatedAt = obj.optLong("updatedAt", 0L),
        pinned = obj.optBoolean("pinned", false),
    )
} catch (e: Exception) {
    null
}

fun Persona.toJson(): JSONObject = JSONObject()
    .put("id", id).put("name", name).put("emoji", emoji).put("systemPrompt", systemPrompt)

fun PromptTemplate.toJson(): JSONObject = JSONObject()
    .put("id", id).put("title", title).put("text", text)

fun GeneratedImage.toJson(): JSONObject = JSONObject()
    .put("id", id).put("prompt", prompt).put("provider", provider).put("mime", mime).put("createdAt", createdAt)

/** The user's own personas, prompts and image index, in one sealed file. */
data class Library(
    val personas: List<Persona> = emptyList(),
    val prompts: List<PromptTemplate> = emptyList(),
    val images: List<GeneratedImage> = emptyList(),
    val defaultProvider: String = "",
    val defaultModel: String = "",
)

fun Library.toJson(): JSONObject {
    val personaList = JSONArray().also { array -> personas.forEach { array.put(it.toJson()) } }
    val promptList = JSONArray().also { array -> prompts.forEach { array.put(it.toJson()) } }
    val imageList = JSONArray().also { array -> images.forEach { array.put(it.toJson()) } }
    return JSONObject()
        .put("v", 1)
        .put("personas", personaList)
        .put("prompts", promptList)
        .put("images", imageList)
        .put("defaultProvider", defaultProvider)
        .put("defaultModel", defaultModel)
}

fun libraryFromJson(text: String?): Library {
    if (text.isNullOrBlank()) return Library()
    return try {
        val obj = JSONObject(text)
        val personas = obj.optJSONArray("personas") ?: JSONArray()
        val prompts = obj.optJSONArray("prompts") ?: JSONArray()
        val images = obj.optJSONArray("images") ?: JSONArray()
        Library(
            personas = (0 until personas.length()).mapNotNull { i ->
                personas.optJSONObject(i)?.let {
                    val id = it.optString("id", "")
                    if (id.isEmpty()) null else Persona(id, it.optString("name", "Persona"), it.optString("emoji", "🙂"), it.optString("systemPrompt", ""))
                }
            },
            prompts = (0 until prompts.length()).mapNotNull { i ->
                prompts.optJSONObject(i)?.let {
                    val id = it.optString("id", "")
                    if (id.isEmpty()) null else PromptTemplate(id, it.optString("title", "Prompt"), it.optString("text", ""))
                }
            },
            images = (0 until images.length()).mapNotNull { i ->
                images.optJSONObject(i)?.let {
                    val id = it.optString("id", "")
                    if (id.isEmpty()) null else GeneratedImage(id, it.optString("prompt", ""), it.optString("provider", ""), it.optString("mime", "image/png"), it.optLong("createdAt", 0L))
                }
            },
            defaultProvider = obj.optString("defaultProvider", ""),
            defaultModel = obj.optString("defaultModel", ""),
        )
    } catch (e: Exception) {
        Library()
    }
}
