package com.neura.os.app.data

import android.content.Context
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.os.Environment
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Universal File Generation — detects agent output that should be files
 * and provides download/share capabilities.
 *
 * When the agent produces:
 *   - Fenced code blocks → offer as downloadable .kt/.py/.js/etc
 *   - Markdown with headers → offer as .md and/or .pdf
 *   - Generated images → offer download + share
 *   - JSON/XML/YAML → offer as file
 *   - Table data → offer as .csv
 *
 * Every file is saved to Downloads/NeuraOS/ with a timestamp suffix
 * and shown with a download button in the chat.
 */
object FileGenerator {

    /** Represents a file the agent produced. */
    data class GeneratedFile(
        val name: String,
        val extension: String,
        val mimeType: String,
        val content: ByteArray,
        val displayName: String = name,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is GeneratedFile) return false
            return name == other.name && content.contentEquals(other.content)
        }
        override fun hashCode(): Int = name.hashCode() * 31 + content.contentHashCode()
    }

    // --- Detection -----------------------------------------------------------

    /**
     * Analyze agent text output and extract any files it contains.
     * Returns a list of GeneratedFile objects, possibly empty.
     */
    fun detectFiles(agentOutput: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()

        // 1. Fenced code blocks → code files
        files.addAll(extractCodeBlocks(agentOutput))

        // 2. Standalone JSON → .json file
        files.addAll(extractJsonBlocks(agentOutput))

        // 3. Standalone XML → .xml file
        files.addAll(extractXmlBlocks(agentOutput))

        // 4. Markdown documents (when the whole output is structured md) → .md
        if (agentOutput.contains(Regex("^#{1,3}\\s+.+", RegexOption.MULTILINE)) &&
            agentOutput.length > 200) {
            files.add(extractMarkdownDocument(agentOutput))
        }

        // 5. CSV-like table data → .csv
        files.addAll(extractCsvData(agentOutput))

        return files
    }

    // --- Extraction ----------------------------------------------------------

    private fun extractCodeBlocks(text: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        val pattern = Regex("```(\\w+)?\\n([\\s\\S]*?)```", RegexOption.MULTILINE)

        var matchIndex = 0
        for (match in pattern.findAll(text)) {
            val lang = match.groupValues[1].lowercase()
            val code = match.groupValues[2].trimEnd()

            if (code.isBlank()) continue
            if (code.lines().size < 3) continue // Skip trivial snippets

            val (ext, mime) = languageToExtension(lang)
            val name = "agent_code_${matchIndex++}_$lang$ext"

            files.add(GeneratedFile(
                name = name,
                extension = ext.removePrefix("."),
                mimeType = mime,
                content = code.toByteArray(Charsets.UTF_8),
                displayName = "Code: $lang ($ext)",
            ))
        }
        return files
    }

    private fun extractJsonBlocks(text: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        // Match standalone JSON objects or arrays (not inside code fences)
        val noFences = text.replace(Regex("```[\\s\\S]*?```"), "")
        val pattern = Regex("(\\{[\\s\\S]{50,}\\}|\\[[\\s\\S]{50,}\\])")

        var matchIndex = 0
        for (match in pattern.findAll(noFences)) {
            val json = match.groupValues[1].trim()
            try {
                org.json.JSONObject(json) // Validate
                files.add(GeneratedFile(
                    name = "agent_output_${matchIndex++}.json",
                    extension = "json",
                    mimeType = "application/json",
                    content = json.toByteArray(Charsets.UTF_8),
                    displayName = "JSON output",
                ))
            } catch (_: Exception) {
                try {
                    org.json.JSONArray(json) // Try array
                    files.add(GeneratedFile(
                        name = "agent_output_${matchIndex++}.json",
                        extension = "json",
                        mimeType = "application/json",
                        content = json.toByteArray(Charsets.UTF_8),
                        displayName = "JSON output",
                    ))
                } catch (_: Exception) { }
            }
        }
        return files
    }

    private fun extractXmlBlocks(text: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        val noFences = text.replace(Regex("```[\\s\\S]*?```"), "")
        val pattern = Regex("(<\\?xml[\\s\\S]{100,}\\?>)")

        var matchIndex = 0
        for (match in pattern.findAll(noFences)) {
            val xml = match.groupValues[1].trim()
            files.add(GeneratedFile(
                name = "agent_output_${matchIndex++}.xml",
                extension = "xml",
                mimeType = "application/xml",
                content = xml.toByteArray(Charsets.UTF_8),
                displayName = "XML output",
            ))
        }
        return files
    }

    private fun extractMarkdownDocument(text: String): GeneratedFile {
        return GeneratedFile(
            name = "neura_response_${timestamp()}.md",
            extension = "md",
            mimeType = "text/markdown",
            content = text.toByteArray(Charsets.UTF_8),
            displayName = "Markdown document",
        )
    }

    private fun extractCsvData(text: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        // Look for markdown tables
        val tablePattern = Regex("\\|(.+)\\|\\n\\|[-| :]+\\|\\n((?:\\|.+\\|\\n?)+)", RegexOption.MULTILINE)

        var matchIndex = 0
        for (match in tablePattern.findAll(text)) {
            val headers = match.groupValues[1].split("|").map { it.trim() }
            val rows = match.groupValues[2].trim().lines().map { line ->
                line.split("|").map { it.trim() }
            }

            val csv = buildString {
                appendLine(headers.joinToString(","))
                for (row in rows) {
                    appendLine(row.joinToString(",") { "\"${it.replace("\"", "\"\"")}\"" })
                }
            }

            files.add(GeneratedFile(
                name = "agent_table_${matchIndex++}.csv",
                extension = "csv",
                mimeType = "text/csv",
                content = csv.toByteArray(Charsets.UTF_8),
                displayName = "Table data (${rows.size} rows)",
            ))
        }
        return files
    }

    // --- PDF Generation ------------------------------------------------------

    /**
     * Generate a styled PDF from markdown content.
     * Uses Android's built-in PdfDocument — no external dependencies.
     */
    fun markdownToPdf(title: String, markdown: String): ByteArray {
        val pageWidth = 595
        val pageHeight = 842
        val margin = 48f
        val body = Paint().apply { textSize = 11f; isAntiAlias = true }
        val heading = Paint().apply { textSize = 14f; isAntiAlias = true; typeface = Typeface.DEFAULT_BOLD }
        val mono = Paint().apply { textSize = 10f; isAntiAlias = true; typeface = Typeface.MONOSPACE }

        val document = PdfDocument()
        var pageNumber = 1
        var page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create())
        var y = margin
        val maxWidth = pageWidth - margin * 2

        fun newPage() {
            document.finishPage(page)
            pageNumber++
            page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create())
            y = margin
        }

        fun drawWrapped(text: String, paint: Paint) {
            val lineHeight = paint.textSize * 1.4f
            if (text.isEmpty()) { y += lineHeight / 2; return }
            var rest = text
            while (rest.isNotEmpty()) {
                var count = paint.breakText(rest, true, maxWidth, null)
                if (count <= 0) count = 1
                if (count < rest.length) {
                    val space = rest.lastIndexOf(' ', count)
                    if (space > 0) count = space + 1
                }
                if (y + lineHeight > pageHeight - margin) newPage()
                page.canvas.drawText(rest.substring(0, count).trimEnd(), margin, y + paint.textSize, paint)
                y += lineHeight
                rest = rest.substring(count)
            }
        }

        // Title
        drawWrapped(title, heading)
        var inCode = false
        for (line in markdown.lines()) {
            if (line.trimStart().startsWith("```")) { inCode = !inCode; continue }
            when {
                inCode -> drawWrapped(line.replace("\t", "    "), mono)
                line.startsWith("#") -> { y += 6; drawWrapped(line.trimStart('#').trim(), heading) }
                else -> drawWrapped(line.replace("**", ""), body)
            }
        }
        document.finishPage(page)

        val out = ByteArrayOutputStream()
        document.writeTo(out)
        document.close()
        return out.toByteArray()
    }

    // --- File Saving ---------------------------------------------------------

    /**
     * Save a GeneratedFile to Downloads/NeuraOS/ on the device.
     * Returns the saved file path or null on failure.
     */
    fun saveToDownloads(context: Context, file: GeneratedFile): String? {
        return try {
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "NeuraOS"
            ).apply { mkdirs() }

            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
            val saveFile = File(dir, "${file.nameWithoutExtension()}_$timestamp.${file.extension}")
            saveFile.writeBytes(file.content)
            saveFile.absolutePath
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Save a GeneratedFile to app-private cache for sharing.
     * Returns the cache file path.
     */
    fun saveToCache(context: Context, file: GeneratedFile): String? {
        return try {
            val dir = File(context.cacheDir, "generated_files").apply { mkdirs() }
            val saveFile = File(dir, file.name)
            saveFile.writeBytes(file.content)
            saveFile.absolutePath
        } catch (e: Exception) {
            null
        }
    }

    // --- Helpers --------------------------------------------------------------

    private fun languageToExtension(lang: String): Pair<String, String> = when (lang) {
        "kotlin", "kt" -> ".kt" to "text/x-kotlin"
        "java" -> ".java" to "text/x-java"
        "python", "py" -> ".py" to "text/x-python"
        "javascript", "js", "typescript", "ts" -> ".js" to "text/javascript"
        "html", "htm" -> ".html" to "text/html"
        "css" -> ".css" to "text/css"
        "json" -> ".json" to "application/json"
        "xml" -> ".xml" to "application/xml"
        "yaml", "yml" -> ".yaml" to "text/yaml"
        "sh", "bash" -> ".sh" to "text/x-shellscript"
        "go" -> ".go" to "text/x-go"
        "rust", "rs" -> ".rs" to "text/x-rust"
        "c" -> ".c" to "text/x-c"
        "cpp", "c++" -> ".cpp" to "text/x-c++"
        "swift" -> ".swift" to "text/x-swift"
        "sql" -> ".sql" to "text/x-sql"
        "ruby", "rb" -> ".rb" to "text/x-ruby"
        "php" -> ".php" to "text/x-php"
        else -> ".txt" to "text/plain"
    }

    private fun GeneratedFile.nameWithoutExtension(): String {
        val dot = name.lastIndexOf('.')
        return if (dot > 0) name.substring(0, dot) else name
    }

    private fun timestamp(): String =
        SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
}
