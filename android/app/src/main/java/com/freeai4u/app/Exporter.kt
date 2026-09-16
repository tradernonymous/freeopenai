package com.freeai4u.app

import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File

/** Builds export files and hands them to other apps. Shared files are written
 * to a private cache folder and passed through a FileProvider with a one-time
 * read grant; nothing is written anywhere another app can list. */
object Exporter {
    private const val SHARE_DIR = "shared"

    /** A plain, readable PDF of a Markdown chat: A4 pages, wrapped lines,
     * headings in bold. No fonts, images or links are embedded. */
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
            if (text.isEmpty()) {
                y += lineHeight / 2
                return
            }
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

        drawWrapped(title, heading)
        var inCode = false
        for (line in markdown.lines()) {
            if (line.trimStart().startsWith("```")) {
                inCode = !inCode
                continue
            }
            when {
                inCode -> drawWrapped(line.replace("\t", "    "), mono)
                line.startsWith("#") -> {
                    y += 6
                    drawWrapped(line.trimStart('#').trim(), heading)
                }
                else -> drawWrapped(line.replace("**", ""), body)
            }
        }
        document.finishPage(page)
        val out = ByteArrayOutputStream()
        document.writeTo(out)
        document.close()
        return out.toByteArray()
    }

    fun share(context: Context, name: String, mime: String, bytes: ByteArray) {
        val dir = File(context.cacheDir, SHARE_DIR).apply { mkdirs() }
        // Only the latest shared file is kept; older ones are cleared first.
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, name)
        file.writeBytes(bytes)
        val uri: Uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        val intent = Intent(Intent.ACTION_SEND)
            .setType(mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(intent, name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
