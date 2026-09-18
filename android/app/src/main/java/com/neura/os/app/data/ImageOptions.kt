package com.neura.os.app.data

// The image shapes and models the web app declares. The app never invents a
// size: only the chips in this list can be asked for, and the server's own
// default applies when none is picked. Everything here is pure and unit-tested.

/** A declared image shape, matching the web app's presets. */
data class ImageSize(val id: String, val label: String, val width: Int, val height: Int) {
    /** "WxH", the value the generations/edits routes take. */
    fun body(): String = "${width}x$height"

    /** width / height, for a preview box. */
    val ratio: Float get() = width.toFloat() / height.toFloat()
}

val IMAGE_SIZES = listOf(
    ImageSize("square", "1:1", 1024, 1024),
    ImageSize("landscape", "3:2", 1536, 1024),
    ImageSize("portrait", "2:3", 1024, 1536),
    ImageSize("wide", "16:9", 1536, 864),
    ImageSize("tall", "9:16", 864, 1536),
)

val IMAGE_GENERATE_MODELS = listOf("gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5")
val IMAGE_EDIT_MODELS = listOf("gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2")

fun imageModelsFor(edit: Boolean): List<String> = if (edit) IMAGE_EDIT_MODELS else IMAGE_GENERATE_MODELS

/** The declared size with this id, or null. Never guesses a shape. */
fun imageSizeById(id: String): ImageSize? = IMAGE_SIZES.firstOrNull { it.id == id }

/** Puter's txt2img wants a {w, h} ratio, not pixels: 1024x1024 becomes 1:1. */
fun imageRatio(size: ImageSize?): Pair<Int, Int>? {
    size ?: return null
    val g = gcd(size.width, size.height)
    return (size.width / g) to (size.height / g)
}

private tailrec fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)
