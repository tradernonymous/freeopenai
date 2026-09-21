package com.neura.os.app

import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertTrue
import org.junit.Assert.fail

/**
 * The manifest must name classes that exist.
 *
 * A component's android:name is resolved at *runtime* against the Gradle
 * namespace: ".NativeActivity" means <namespace> + ".NativeActivity". After
 * the namespace moved to com.neura.os while the sources stayed in
 * com.neura.os.app, the launcher pointed at a class that did not exist —
 * every build stayed green, every install flashed black and quit. The JVM
 * unit tests could not see it because nothing here reads the manifest.
 * This test does: every relative or app-prefixed component name must map to
 * a real Kotlin/Java source file, and the launcher activity in particular
 * must resolve.
 */
class ManifestWiringTest {

    private val moduleDir: File = File(System.getProperty("user.dir"))

    private fun manifest(): File {
        val file = File(moduleDir, "src/main/AndroidManifest.xml")
        assertTrue("manifest not found at ${file.absolutePath}", file.isFile)
        return file
    }

    /** The Gradle namespace: what a relative android:name is resolved against. */
    private fun namespace(): String {
        val text = File(moduleDir, "build.gradle.kts").readText()
        val match = Regex("namespace\\s*=\\s*\"([^\"]+)\"").find(text)
        if (match == null) throw IllegalStateException("namespace not found in build.gradle.kts")
        return match.groupValues[1]
    }

    private fun componentNames(): List<Pair<String, String>> {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(manifest())
        val tags = listOf("activity", "activity-alias", "service", "receiver", "provider")
        val out = mutableListOf<Pair<String, String>>()
        for (tag in tags) {
            val nodes = doc.getElementsByTagName(tag)
            for (i in 0 until nodes.length) {
                val el = nodes.item(i) as org.w3c.dom.Element
                val name = el.getAttribute("android:name")
                if (name.isNotEmpty()) out.add(tag to name)
            }
        }
        return out
    }

    /** Fully-qualified class name a component's android:name resolves to. */
    private fun resolvedClass(raw: String, namespace: String): String = when {
        raw.startsWith(".") -> namespace + raw
        raw.startsWith(namespace) -> raw
        // A foreign class (androidx, com.google.*) comes from a library; the
        // sources do not carry it, so it is out of this test's reach.
        else -> ""
    }

    private fun sourceFor(fqcn: String): File? {
        val path = "src/main/java/" + fqcn.replace('.', '/') + ".kt"
        val kt = File(moduleDir, path)
        if (kt.isFile) return kt
        val java = File(moduleDir, path.removeSuffix(".kt") + ".java")
        return if (java.isFile) java else null
    }

    @Test
    fun `every manifest component names a class the sources contain`() {
        val namespace = namespace()
        val checked = mutableListOf<String>()
        for ((tag, raw) in componentNames()) {
            val fqcn = resolvedClass(raw, namespace)
            if (fqcn.isEmpty()) continue
            val source = sourceFor(fqcn)
            if (source == null) {
                fail("$tag \"$raw\" resolves to $fqcn, but no such source exists under src/main/java — " +
                    "Android would look it up at runtime and the app would die at launch with a black screen.")
            }
            checked.add(fqcn)
        }
        assertTrue("no app components were checked", checked.isNotEmpty())
    }

    @Test
    fun `the launcher activity resolves to a real class`() {
        val namespace = namespace()
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(manifest())
        val activities = doc.getElementsByTagName("activity")
        for (i in 0 until activities.length) {
            val el = activities.item(i) as org.w3c.dom.Element
            val intentFilters = el.getElementsByTagName("intent-filter")
            for (j in 0 until intentFilters.length) {
                val filter = intentFilters.item(j) as org.w3c.dom.Element
                // MAIN is an <action>; LAUNCHER is a <category>. Checking one
                // list for both is how this check once matched nothing.
                val actions = filter.getElementsByTagName("action")
                val categories = filter.getElementsByTagName("category")
                var isMain = false
                var isLauncher = false
                for (k in 0 until actions.length) {
                    if ((actions.item(k) as org.w3c.dom.Element).getAttribute("android:name") == "android.intent.action.MAIN") isMain = true
                }
                for (k in 0 until categories.length) {
                    if ((categories.item(k) as org.w3c.dom.Element).getAttribute("android:name") == "android.intent.category.LAUNCHER") isLauncher = true
                }
                if (!(isMain && isLauncher)) continue
                val raw = el.getAttribute("android:name")
                val fqcn = resolvedClass(raw, namespace)
                assertTrue("launcher activity name is empty", fqcn.isNotEmpty())
                val source = sourceFor(fqcn)
                if (source == null) {
                    fail("the LAUNCHER activity \"$raw\" resolves to $fqcn, which has no source file — " +
                        "this exact gap is the black-screen-on-open bug: a green build whose app cannot start.")
                }
                return // found the launcher and it resolves
            }
        }
        fail("no MAIN/LAUNCHER intent-filter found in the manifest")
    }
}
