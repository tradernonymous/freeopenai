package com.neura.os.app.data

import android.content.Context
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

    /** Scan agent text and extract the one detectable file worth offering as a
     * download (a code block, JSON payload, or CSV table).
     *
     * This used to also list every candidate found -- often several code
     * blocks in one reply, plus the entire reply again as "response.md"
     * whenever it merely had a heading and was over 200 chars, which fired on
     * nearly every substantive answer. That buried the one file someone
     * actually asked for under a stack of chips (and quietly wrote a copy of
     * every long reply to Downloads/NeuraOS whether anyone wanted it or not).
     * Without a reliable signal for "this is the file I meant" (that would
     * need the request that preceded it, which this scanner never sees), the
     * last candidate is the best single guess: in an agent's response the
     * final block is the one most likely to be the finished deliverable
     * rather than an earlier illustrative snippet. */
    fun detectFiles(agentOutput: String): List<GeneratedFile> {
        val files = mutableListOf<GeneratedFile>()
        files.addAll(extractCodeBlocks(agentOutput))
        files.addAll(extractJsonBlocks(agentOutput))
        files.addAll(extractCsvTables(agentOutput))
        return listOfNotNull(files.lastOrNull())
    }

    /** Save to Downloads/NeuraOS/, through MediaStore. Returns null on failure.
     *
     * This used to write with `File(Environment.getExternalStoragePublicDirectory(...))`
     * and swallow the exception. Under scoped storage that throws on every
     * supported Android version (minSdk 29, and the app holds no storage
     * permission by design), so saving an agent-generated file silently did
     * nothing at all and the user got no message either. The same save is
     * already implemented correctly in WebShell.saveToDownloads; this calls
     * it rather than keeping a second, broken copy. */
    fun saveToDownloads(context: Context, file: GeneratedFile): String? {
        val ts = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val base = file.name.substringBeforeLast('.')
        val name = "${base}_$ts.${file.extension}"
        return if (com.neura.os.app.WebShell.saveToDownloads(context, name, file.mimeType, file.content)) {
            "Downloads/NeuraOS/$name"
        } else {
            null
        }
    }

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
