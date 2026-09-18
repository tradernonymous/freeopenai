package com.neura.os.app.data

import android.content.Context
import android.os.Environment
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Detects agent output that should be files and saves them to Downloads/NeuraOS/.
 * PDF generation lives in Exporter — this file handles detection and persistence only.
 */
object FileGenerator {

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

    /** Scan agent text and extract detectable files (code blocks, JSON, markdown, CSV). */
    fun detectFiles(agentOutput: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        files.addAll(extractCodeBlocks(agentOutput))
        files.addAll(extractJsonBlocks(agentOutput))
        files.addAll(extractCsvTables(agentOutput))
        if (agentOutput.contains(Regex("^#{1,3}\\s+.+", RegexOption.MULTILINE)) && agentOutput.length > 200) {
            files.add(GeneratedFile("response.md", "md", "text/markdown", agentOutput.toByteArray(Charsets.UTF_8), "Markdown document"))
        }
        return files
    }

    /** Save to Downloads/NeuraOS/. Returns the path or null. */
    fun saveToDownloads(context: Context, file: GeneratedFile): String? = try {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "NeuraOS").apply { mkdirs() }
        val ts = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val base = file.name.substringBeforeLast('.')
        val saveFile = File(dir, "${base}_$ts.${file.extension}")
        saveFile.writeBytes(file.content)
        saveFile.absolutePath
    } catch (_: Exception) { null }

    // --- Extraction helpers --------------------------------------------------

    private fun extractCodeBlocks(text: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        var idx = 0
        for (match in Regex("```(\\w+)?\\n([\\s\\S]*?)```", RegexOption.MULTILINE).findAll(text)) {
            val lang = match.groupValues[1].lowercase()
            val code = match.groupValues[2].trimEnd()
            if (code.lines().size < 3) continue
            val (ext, mime) = langToExt(lang)
            files.add(GeneratedFile("code_${idx++}_$lang$ext", ext.removePrefix("."), mime, code.toByteArray(Charsets.UTF_8), "Code: $lang"))
        }
        return files
    }

    private fun extractJsonBlocks(text: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        val noFences = text.replace(Regex("```[\\s\\S]*?```"), "")
        var idx = 0
        for (match in Regex("(\\{[\\s\\S]{50,}\\}|\\[[\\s\\S]{50,}\\])").findAll(noFences)) {
            val json = match.groupValues[1].trim()
            val valid = try { org.json.JSONObject(json); true } catch (_: Exception) {
                try { org.json.JSONArray(json); true } catch (_: Exception) { false }
            }
            if (valid) files.add(GeneratedFile("output_${idx++}.json", "json", "application/json", json.toByteArray(Charsets.UTF_8), "JSON output"))
        }
        return files
    }

    private fun extractCsvTables(text: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        var idx = 0
        for (match in Regex("\\|(.+)\\|\\n\\|[-| :]+\\|\\n((?:\\|.+\\|\\n?)+)", RegexOption.MULTILINE).findAll(text)) {
            val headers = match.groupValues[1].split("|").map { it.trim() }
            val rows = match.groupValues[2].trim().lines().map { it.split("|").map { c -> c.trim() } }
            val csv = buildString {
                appendLine(headers.joinToString(","))
                rows.forEach { row -> appendLine(row.joinToString(",") { "\"${it.replace("\"", "\"\"")}\"" }) }
            }
            files.add(GeneratedFile("table_${idx++}.csv", "csv", "text/csv", csv.toByteArray(Charsets.UTF_8), "Table (${rows.size} rows)"))
        }
        return files
    }

    private fun langToExt(lang: String) = when (lang) {
        "kotlin", "kt" -> ".kt" to "text/x-kotlin"
        "java" -> ".java" to "text/x-java"
        "python", "py" -> ".py" to "text/x-python"
        "javascript", "js", "typescript", "ts" -> ".js" to "text/javascript"
        "html" -> ".html" to "text/html"
        "css" -> ".css" to "text/css"
        "json" -> ".json" to "application/json"
        "xml" -> ".xml" to "application/xml"
        "yaml", "yml" -> ".yaml" to "text/yaml"
        "sh", "bash" -> ".sh" to "text/x-shellscript"
        "go" -> ".go" to "text/x-go"
        "rust", "rs" -> ".rs" to "text/x-rust"
        "sql" -> ".sql" to "text/x-sql"
        else -> ".txt" to "text/plain"
    }
}
