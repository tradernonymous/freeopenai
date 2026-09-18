package com.neura.os.app.data

import org.json.JSONObject
import java.io.File

/**
 * NeuraOS Skill Ecosystem — SKILL.md-based plugin architecture.
 *
 * Skills are markdown files (SKILL.md) that provide:
 *   - System prompt extensions for the agent
 *   - Tool definitions the agent can use
 *   - Reference files the agent can consult
 *
 * Pattern follows aldefy/compose-skill:
 *   skills/<name>/
 *   ├── SKILL.md          # Main workflow + checklists
 *   └── references/       # Optional reference files
 *       ├── guide1.md
 *       └── guide2.md
 *
 * Skills can be:
 *   - Built-in (shipped with the app)
 *   - User-installed (from a URL or file)
 *   - Community-shared (via a marketplace)
 */
object SkillEcosystem {

    /** A loaded skill with its metadata and content. */
    data class Skill(
        val id: String,
        val name: String,
        val description: String,
        val version: String,
        val author: String,
        val skillMd: String,
        val references: Map<String, String> = emptyMap(),
        val isBuiltIn: Boolean = false,
        val tags: List<String> = emptyList(),
    )

    /** Skill registry entry for the marketplace. */
    data class SkillEntry(
        val id: String,
        val name: String,
        val description: String,
        val author: String,
        val version: String,
        val downloadUrl: String,
        val tags: List<String> = emptyList(),
        val downloads: Int = 0,
        val rating: Float = 0f,
    )

    // --- Built-in Skills -----------------------------------------------------

    /** Built-in skills shipped with NeuraOS. */
    val builtInSkills = listOf(
        Skill(
            id = "neuraos-core",
            name = "NeuraOS Core",
            description = "Core agent capabilities for NeuraOS",
            version = "1.0.0",
            author = "NeuraOS",
            isBuiltIn = true,
            tags = listOf("core", "essential"),
            skillMd = """
                # NeuraOS Agent Core

                You are the NeuraOS AI agent. You help users with software engineering,
                device automation, image generation, and file creation.

                ## Capabilities
                - Chat and reasoning
                - Web search and summarization
                - Code generation and analysis
                - Image generation (via providers)
                - Device automation (via accessibility)
                - File generation (PDF, markdown, code, CSV)

                ## Rules
                - Always explain what you're doing before doing it
                - Ask for confirmation before destructive actions
                - Use tools when the user's request requires them
                - Keep responses concise and actionable
            """.trimIndent(),
        ),
        Skill(
            id = "code-expert",
            name = "Code Expert",
            description = "Advanced coding assistance with best practices",
            version = "1.0.0",
            author = "NeuraOS",
            isBuiltIn = true,
            tags = listOf("coding", "development"),
            skillMd = """
                # Code Expert Skill

                You are an expert software engineer. Follow these principles:

                ## Code Quality
                - Write clean, readable, well-documented code
                - Follow language idioms and conventions
                - Handle errors gracefully
                - Write tests for critical paths

                ## Architecture
                - Prefer composition over inheritance
                - Keep functions small and focused
                - Separate concerns clearly
                - Use dependency injection

                ## When Generating Code
                - Include error handling
                - Add meaningful comments
                - Use consistent naming conventions
                - Consider edge cases
            """.trimIndent(),
        ),
        Skill(
            id = "automation",
            name = "Device Automation",
            description = "PhoneClaw-style device automation with accessibility",
            version = "1.0.0",
            author = "NeuraOS",
            isBuiltIn = true,
            tags = listOf("automation", "accessibility"),
            skillMd = """
                # Device Automation Skill

                You can automate phone tasks using the accessibility service.

                ## Available Actions
                - tap_text(label): Tap an element by its text label
                - scroll_until(label, maxScrolls): Scroll until an element is visible
                - snapshot(): Read what's currently on screen

                ## Rules
                - Always ask for user approval before running actions
                - Describe what you're about to do before doing it
                - Use specific, unique labels to avoid ambiguity
                - Start with a snapshot to understand the current state
            """.trimIndent(),
        ),
    )

    // --- Skill Management ----------------------------------------------------

    /** All loaded skills (built-in + user-installed). */
    private val loadedSkills = mutableMapOf<String, Skill>()
    private val installedIds = mutableSetOf<String>()

    init {
        builtInSkills.forEach { loadedSkills[it.id] = it }
    }

    /** Get a skill by ID. */
    fun getSkill(id: String): Skill? = loadedSkills[id]

    /** Get all loaded skills. */
    fun getAllSkills(): List<Skill> = loadedSkills.values.toList()

    /** Get skills matching a set of tags. */
    fun getSkillsByTag(tag: String): List<Skill> =
        loadedSkills.values.filter { tag in it.tags }

    /** Install a skill from a SKILL.md content string. */
    fun installSkill(id: String, skillMd: String, references: Map<String, String> = emptyMap()): Skill {
        val parsed = parseSkillMetadata(skillMd)
        val skill = Skill(
            id = id,
            name = parsed["name"] ?: id,
            description = parsed["description"] ?: "",
            version = parsed["version"] ?: "1.0.0",
            author = parsed["author"] ?: "Unknown",
            skillMd = skillMd,
            references = references,
            isBuiltIn = false,
            tags = parsed["tags"]?.split(",")?.map { it.trim() } ?: emptyList(),
        )
        loadedSkills[id] = skill
        installedIds.add(id)
        return skill
    }

    /** Uninstall a user-installed skill. */
    fun uninstallSkill(id: String): Boolean {
        if (id in builtInSkills.map { it.id }) return false // Can't uninstall built-in
        loadedSkills.remove(id)
        installedIds.remove(id)
        return true
    }

    /** Check if a skill is installed. */
    fun isInstalled(id: String): Boolean = id in loadedSkills

    /** Get the system prompt text for all active skills. */
    fun buildSkillPrompt(activeSkillIds: List<String>): String {
        return activeSkillIds.mapNotNull { loadedSkills[it] }
            .joinToString("\n\n---\n\n") { it.skillMd }
    }

    // --- Marketplace ---------------------------------------------------------

    /** Placeholder marketplace entries. In production, these come from an API. */
    fun searchMarketplace(query: String): List<SkillEntry> {
        // In a real implementation, this would call a marketplace API
        return emptyList()
    }

    // --- Helpers --------------------------------------------------------------

    /** Parse SKILL.md frontmatter-style metadata. */
    private fun parseSkillMetadata(skillMd: String): Map<String, String> {
        val metadata = mutableMapOf<String, String>()
        val lines = skillMd.lines()

        // Look for YAML-like metadata at the start
        for (line in lines.take(20)) {
            val trimmed = line.trim()
            if (trimmed.startsWith("#")) continue // Title
            if (trimmed.isEmpty()) continue
            if (trimmed.contains(":")) {
                val (key, value) = trimmed.split(":", limit = 2).map { it.trim() }
                if (key.lowercase() in setOf("name", "description", "version", "author", "tags")) {
                    metadata[key.lowercase()] = value.removeSurrounding("\"")
                }
            }
        }

        // Fallback: extract title from first heading
        if ("name" !in metadata) {
            val title = lines.firstOrNull { it.startsWith("# ") }?.removePrefix("# ")?.trim()
            if (title != null) metadata["name"] = title
        }

        return metadata
    }
}

/**
 * Skill loader that reads SKILL.md files from the filesystem.
 */
object SkillLoader {

    /** Load a skill from a directory containing SKILL.md. */
    fun loadFromDirectory(dir: File): SkillEcosystem.Skill? {
        val skillMd = File(dir, "SKILL.md").takeIf { it.exists() }?.readText() ?: return null
        val references = mutableMapOf<String, String>()
        val refDir = File(dir, "references")
        if (refDir.isDirectory) {
            refDir.listFiles()?.filter { it.extension == "md" }?.forEach { file ->
                references[file.nameWithoutExtension] = file.readText()
            }
        }
        return SkillEcosystem.installSkill(dir.name, skillMd, references)
    }

    /** Load all skills from a base directory. */
    fun loadAll(baseDir: File): List<SkillEcosystem.Skill> {
        if (!baseDir.isDirectory) return emptyList()
        return baseDir.listFiles()
            ?.filter { it.isDirectory && File(it, "SKILL.md").exists() }
            ?.mapNotNull { loadFromDirectory(it) }
            ?: emptyList()
    }
}
