package com.neura.os.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Seals bytes with an AES-256-GCM key that never leaves the Android Keystore.
 * File layout: 12-byte IV, then ciphertext with its 128-bit tag. A file that
 * does not open (tampered, or the key was wiped with the app's data) reads as
 * missing, never as a crash. */
object SecureBox {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "neuraos-data"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12

    // KeyStore.load is an IPC to the keystore daemon plus a full keyset parse,
    // and it is not cached by the platform. It used to run on every seal and
    // every open -- that is once per file, so 50 chats meant 50 loads on
    // startup, all serialised on this monitor, and two of them on the main
    // thread before the first frame. The handle is safe to hold: it is a
    // reference to a key the Keystore keeps, not a copy of it.
    @Volatile
    private var cached: SecretKey? = null

    @Synchronized
    private fun key(): SecretKey {
        cached?.let { return it }
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { cached = it; return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey().also { cached = it }
    }

    fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        return iv + cipher.doFinal(plain)
    }

    fun open(sealed: ByteArray): ByteArray? {
        if (sealed.size <= IV_BYTES) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed.copyOfRange(0, IV_BYTES)))
            cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
        } catch (e: Exception) {
            null
        }
    }
}

/** Chats, the library and generated images, each sealed in app-private
 * storage. Writes go to a temp file and are renamed into place, so a crash
 * mid-write never leaves half a chat behind. */
class Repository(context: Context) {
    private val root = context.filesDir
    private val chatsDir = File(root, "chats").apply { mkdirs() }
    private val imagesDir = File(root, "images").apply { mkdirs() }
    private val libraryFile = File(root, "library.bin")
    private val outboxFile = File(root, "outbox.bin")
    private val automationsFile = File(root, "automations.bin")
    // Opt-in offline answers (ResponseCache.kt): answer text, so sealed
    // like the chats and erased with them.
    private val responseCacheFile = File(root, "responses.bin")
    // Scheduled recipes (Schedules.kt): read by RecipeAlarmReceiver too, when
    // the app itself is not running.
    private val schedulesFile = File(root, "schedules.bin")

    private fun safeId(id: String): String = id.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(64)

    /** A full disk or a Keystore fault is reported back, never thrown across a
     * thread: the copy in memory stands and the next save tries again. */
    private fun writeSealed(file: File, bytes: ByteArray): Boolean {
        val temp = File(file.parentFile, file.name + ".tmp")
        return try {
            // sync() before the rename. A rename is atomic with respect to
            // other readers, but it is not durable: without the flush a power
            // cut can leave a correctly-named, empty file, which then reads
            // back as "no chat here" forever.
            FileOutputStream(temp).use { out ->
                out.write(SecureBox.seal(bytes))
                out.fd.sync()
            }
            // ATOMIC_MOVE replaces the destination in one step, so there is no
            // window in which the old file is gone and the new one has not
            // arrived -- which is exactly what the old
            // delete-then-rename fallback opened up, silently losing the chat
            // if the second rename then failed. And the result is returned
            // rather than discarded: a caller must never be told a save
            // succeeded that did not happen.
            try {
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                true
            } catch (_: Exception) {
                // Some OEM filesystems refuse ATOMIC_MOVE across the two
                // paths. renameTo on the same directory is still atomic.
                temp.renameTo(file)
            }
        } catch (e: Exception) {
            temp.delete()
            false
        }
    }

    private fun readSealed(file: File): ByteArray? = if (file.isFile) SecureBox.open(file.readBytes()) else null

    @Synchronized
    fun loadConversations(): List<Conversation> =
        (chatsDir.listFiles { file -> file.name.endsWith(".bin") } ?: emptyArray())
            .mapNotNull { file -> readSealed(file)?.let { conversationFromJson(String(it, Charsets.UTF_8)) } }

    @Synchronized
    fun saveConversation(conversation: Conversation) {
        writeSealed(File(chatsDir, safeId(conversation.id) + ".bin"), conversation.toJson().toString().toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun deleteConversation(id: String) {
        File(chatsDir, safeId(id) + ".bin").delete()
    }

    @Synchronized
    fun deleteAllConversations() {
        chatsDir.listFiles()?.forEach { it.delete() }
    }

    @Synchronized
    fun loadLibrary(): Library = libraryFromJson(readSealed(libraryFile)?.let { String(it, Charsets.UTF_8) })

    @Synchronized
    fun saveLibrary(library: Library) {
        writeSealed(libraryFile, library.toJson().toString().toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun loadOutbox(): Outbox = outboxFromJson(readSealed(outboxFile)?.let { String(it, Charsets.UTF_8) })

    @Synchronized
    fun saveOutbox(outbox: Outbox) {
        writeSealed(outboxFile, outbox.toJson().toString().toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun loadResponseCache(): ResponseCache = responseCacheFromJson(readSealed(responseCacheFile)?.let { String(it, Charsets.UTF_8) })

    @Synchronized
    fun saveResponseCache(cache: ResponseCache) {
        writeSealed(responseCacheFile, cache.toJson().toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun deleteResponseCache() {
        responseCacheFile.delete()
    }

    @Synchronized
    fun loadAutomations(): List<AutomationEntry> = automationsFromJson(readSealed(automationsFile)?.let { String(it, Charsets.UTF_8) })

    @Synchronized
    fun saveAutomations(entries: List<AutomationEntry>) {
        writeSealed(automationsFile, automationsToJson(entries).toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun loadSchedules(): List<RecipeSchedule> = schedulesFromJson(readSealed(schedulesFile)?.let { String(it, Charsets.UTF_8) })

    @Synchronized
    fun saveSchedules(list: List<RecipeSchedule>) {
        writeSealed(schedulesFile, schedulesToJson(list).toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun saveImage(id: String, bytes: ByteArray) {
        writeSealed(File(imagesDir, safeId(id) + ".bin"), bytes)
    }

    @Synchronized
    fun loadImage(id: String): ByteArray? = readSealed(File(imagesDir, safeId(id) + ".bin"))

    @Synchronized
    fun deleteImage(id: String) {
        File(imagesDir, safeId(id) + ".bin").delete()
    }

    /** Everything this class stores, for "sign out and erase". */
    @Synchronized
    fun eraseEverything() {
        deleteAllConversations()
        imagesDir.listFiles()?.forEach { it.delete() }
        libraryFile.delete()
        outboxFile.delete()
        automationsFile.delete()
        responseCacheFile.delete()
        schedulesFile.delete()
    }
}
