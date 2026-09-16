package com.freeai4u.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
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
    private const val ALIAS = "freeai4u-data"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12

    @Synchronized
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
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

    private fun safeId(id: String): String = id.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(64)

    private fun writeSealed(file: File, bytes: ByteArray) {
        val temp = File(file.parentFile, file.name + ".tmp")
        temp.writeBytes(SecureBox.seal(bytes))
        if (!temp.renameTo(file)) {
            file.delete()
            temp.renameTo(file)
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
    }
}
