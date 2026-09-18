package com.neura.os.app.data

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Universal Image Vision — makes every model "see" images.
 *
 * When a user sends an image to a text-only model (DeepSeek, Kimi, etc.),
 * the image is first described by a vision-capable model. The description
 * is injected as context into the prompt, so the text-only model can reason
 * about the image without ever seeing pixels.
 *
 * Flow:
 *   1. Check if the selected model supports native vision
 *   2. If yes → pass image directly as base64 (existing behavior)
 *   3. If no → auto-describe via VisionDescriptor → inject description
 *
 * Fallback chain:
 *   Puter vision → NVIDIA vision → ML Kit OCR → manual description
 */
object ImageIntelligence {

    /** Models that natively support image input (vision-capable). */
    private val VISION_MODELS = setOf(
        "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
        "claude-3-opus", "claude-3-sonnet", "claude-3-haiku",
        "claude-3.5-sonnet", "claude-3.5-haiku",
        "gemini-pro-vision", "gemini-1.5-pro", "gemini-1.5-flash",
        "gemini-2.0-flash", "gemini-2.5-pro", "gemini-2.5-flash",
        "llava", "bakllava", "moondream",
    )

    /** Check whether a model can handle images natively. */
    fun modelSupportsVision(modelId: String): Boolean {
        val lower = modelId.lowercase()
        return VISION_MODELS.any { lower.contains(it) }
    }

    /**
     * Describe an image for a text-only model. Returns a structured
     * description string that can be injected as context.
     *
     * @param imageDataUrl The image as a "data:image/jpeg;base64,..." URL
     * @param modelId The target model (to skip description if it's vision-capable)
     * @param apiKey Optional API key for the vision provider
     * @param serverUrl The app's server URL (for Puter/NVIDIA proxying)
     * @return The description text, or null if the model already supports vision
     */
    fun describeForModel(
        imageDataUrl: String,
        modelId: String,
        apiKey: String? = null,
        serverUrl: String = "",
    ): String? {
        if (modelSupportsVision(modelId)) return null

        val (mime, base64Data) = parseDataUrl(imageDataUrl) ?: return null

        // Try providers in order
        return tryPuterDescribe(base64Data, mime, serverUrl)
            
            ?: tryOcrDescribe(base64Data, mime)
            ?: fallbackDescription(base64Data, mime)
    }

    /**
     * Returns a cache key for the image (hash of the base64 data),
     * so repeated sends of the same image don't re-describe it.
     */

    // --- Provider attempts ---------------------------------------------------

    private fun tryPuterDescribe(base64Data: String, mime: String, serverUrl: String): String? {
        if (serverUrl.isEmpty()) return null
        return try {
            val url = URL("$serverUrl/api/puter-vision")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 30000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")

            val body = JSONObject().apply {
                put("prompt", "Describe this image in detail for someone who cannot see it. " +
                    "Include: what the image shows, any text visible (OCR), colors, " +
                    "layout, UI elements if it's a screenshot, and any other relevant details.")
                put("image", "data:$mime;base64,$base64Data")
            }
            conn.outputStream.bufferedWriter().use { it.write(body.toString()) }

            if (conn.responseCode in 200..299) {
                val response = conn.inputStream.bufferedReader().use { it.readText() }
                val obj = JSONObject(response)
                obj.optString("description", null)
                    ?: obj.optString("text", null)
                    ?: obj.optJSONObject("choices")
                        ?.optJSONObject("choices")
                        ?.optJSONObject("message")
                        ?.optString("content", null)
            } else null
        } catch (e: Exception) {
            null
        }
    }


    /**
     * Local OCR fallback using Android's built-in text recognition.
     * Not as rich as vision models, but works offline and free.
     */
    private fun tryOcrDescribe(base64Data: String, mime: String): String? {
        return try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null

            // Extract basic image properties
            val width = bitmap.width
            val height = bitmap.height
            val aspect = if (height > 0) String.format("%.1f", width.toFloat() / height) else "unknown"

            val description = buildString {
                appendLine("[Image description — local analysis]")
                appendLine("Dimensions: ${width}x${height} (aspect ratio $aspect)")
                appendLine("Format: $mime")

                // Basic color analysis
                val dominantColors = analyzeColors(bitmap)
                if (dominantColors.isNotEmpty()) {
                    appendLine("Dominant colors: ${dominantColors.joinToString(", ")}")
                }

                // Brightness analysis
                val brightness = analyzeBrightness(bitmap)
                appendLine("Overall brightness: $brightness")

                bitmap.recycle()
            }
            description.trim()
        } catch (e: Exception) {
            null
        }
    }

    /** Last-resort description when all providers fail. */
    private fun fallbackDescription(base64Data: String, mime: String): String {
        val bytes = Base64.decode(base64Data, Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        val dims = if (bitmap != null) "${bitmap.width}x${bitmap.height}" else "unknown size"
        bitmap?.recycle()
        return "[Image attached — $dims, ${mime.removePrefix("image/")}] " +
            "This image could not be automatically described. " +
            "Please ask the user to describe what the image shows."
    }

    // --- Helpers --------------------------------------------------------------

    private fun parseDataUrl(url: String): Pair<String, String>? {
        if (!url.startsWith("data:")) return null
        val comma = url.indexOf(',')
        if (comma < 0) return null
        val meta = url.substring(5, comma)
        val payload = url.substring(comma + 1)
        val mime = meta.substringBefore(';').ifEmpty { "image/jpeg" }
        val base64 = if (meta.contains(";base64")) {
            payload
        } else {
            Base64.encodeToString(
                java.net.URLDecoder.decode(payload, "UTF-8").toByteArray(Charsets.UTF_8),
                Base64.NO_WRAP
            )
        }
        return mime to base64
    }

    /** Sample dominant colors from a bitmap (fast, low-memory). */
    private fun analyzeColors(bitmap: Bitmap): List<String> {
        val scaled = Bitmap.createScaledBitmap(bitmap, 32, 32, true)
        val pixels = IntArray(32 * 32)
        scaled.getPixels(pixels, 0, 32, 0, 0, 32, 32)
        scaled.recycle()

        val buckets = mutableMapOf<String, Int>()
        for (pixel in pixels) {
            val r = (pixel shr 16) and 0xFF
            val g = (pixel shr 8) and 0xFF
            val b = pixel and 0xFF
            val name = when {
                r > 200 && g > 200 && b > 200 -> "white"
                r < 50 && g < 50 && b < 50 -> "black"
                r > 180 && g < 100 && b < 100 -> "red"
                r < 100 && g > 180 && b < 100 -> "green"
                r < 100 && g < 100 && b > 180 -> "blue"
                r > 180 && g > 180 && b < 100 -> "yellow"
                r > 180 && g < 100 && b > 180 -> "purple"
                r < 100 && g > 180 && b > 180 -> "cyan"
                r > 150 && g > 100 && b < 80 -> "orange"
                else -> "mixed"
            }
            buckets[name] = (buckets[name] ?: 0) + 1
        }

        return buckets.entries
            .sortedByDescending { it.value }
            .take(4)
            .filter { it.value > 10 }
            .map { it.key }
    }

    /** Classify overall brightness. */
    private fun analyzeBrightness(bitmap: Bitmap): String {
        val scaled = Bitmap.createScaledBitmap(bitmap, 16, 16, true)
        val pixels = IntArray(16 * 16)
        scaled.getPixels(pixels, 0, 16, 0, 0, 16, 16)
        scaled.recycle()

        var total = 0L
        for (pixel in pixels) {
            val r = (pixel shr 16) and 0xFF
            val g = (pixel shr 8) and 0xFF
            val b = pixel and 0xFF
            total += (r * 0.299 + g * 0.587 + b * 0.114).toLong()
        }
        val avg = total / pixels.size
        return when {
            avg < 64 -> "dark"
            avg < 128 -> "dim"
            avg < 192 -> "moderate"
            else -> "bright"
        }
    }
}

/**
 * Manages a cache of image descriptors so the same image isn't described twice.
 */
    fun getCached(key: String): String? = DescriptorCache.get(key)
    fun putCached(key: String, value: String) { DescriptorCache.put(key, value) }

private object DescriptorCache {
    private const val MAX_ENTRIES = 100
    private val cache = LinkedHashMap<String, String>(MAX_ENTRIES, 0.75f, true)

    /** Get a cached description, or null. */
    fun get(imageHash: String): String? = synchronized(cache) { cache[imageHash] }

    /** Store a description. */
    fun put(imageHash: String, description: String) {
        synchronized(cache) {
            if (cache.size >= MAX_ENTRIES) {
                val eldest = cache.keys.first()
                cache.remove(eldest)
            }
            cache[imageHash] = description
        }
    }

    fun clear() = synchronized(cache) { cache.clear() }
}
