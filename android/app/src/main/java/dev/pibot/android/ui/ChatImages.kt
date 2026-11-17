package dev.pibot.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dev.pibot.android.data.ChatImage
import dev.pibot.android.data.MessageImage
import dev.pibot.android.data.PiBotRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

const val IMAGE_LIMIT_HINT = "最多 4 张图片，单张不超过 2 MB，合计不超过 4 MB；支持 JPEG、PNG、WebP、GIF"
private const val MAX_IMAGE_BYTES = 2 * 1024 * 1024
private const val MAX_TOTAL_BYTES = 4L * 1024 * 1024
private const val MAX_LONG_SIDE = 2048
private val ACCEPTED_TYPES = listOf("image/jpeg", "image/png", "image/webp", "image/gif")

data class ReadImagesResult(
    val images: List<ChatImage>,
    val warnings: List<String>,
)

/**
 * Compress a bitmap so that the longest side is at most [MAX_LONG_SIDE] px
 * and the JPEG output is at most [MAX_IMAGE_BYTES] bytes.
 * Returns the compressed JPEG bytes, or null if even quality 50 is too large.
 */
private fun compressToFit(context: Context, uri: Uri, maxBytes: Int): ByteArray? {
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    if (options.outWidth <= 0 || options.outHeight <= 0) return null
    var sample = 1
    while (maxOf(options.outWidth, options.outHeight) / sample > MAX_LONG_SIDE * 2) sample *= 2
    options.inJustDecodeBounds = false
    options.inSampleSize = sample
    val original = context.contentResolver.openInputStream(uri)?.use {
        BitmapFactory.decodeStream(it, null, options)
    } ?: return null
    var bitmap = original
    try {
        if (maxOf(original.width, original.height) > MAX_LONG_SIDE) {
            val scale = MAX_LONG_SIDE.toFloat() / maxOf(original.width, original.height)
            bitmap = Bitmap.createScaledBitmap(original,
                (original.width * scale).toInt().coerceAtLeast(1),
                (original.height * scale).toInt().coerceAtLeast(1), true)
        }
        for (quality in 80 downTo 50 step 10) {
            val out = ByteArrayOutputStream()
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) return null
            if (out.size() <= maxBytes) return out.toByteArray()
        }
        return null
    } finally {
        if (bitmap !== original) bitmap.recycle()
        original.recycle()
    }
}

suspend fun readChatImages(context: Context, uris: List<Uri>, existing: List<ChatImage>): ReadImagesResult = withContext(Dispatchers.IO) {
    val warnings = mutableListOf<String>()
    val added = mutableListOf<ChatImage>()
    val maxCount = 4

    if (existing.size >= maxCount) {
        warnings.add("已有 ${existing.size} 张图片，无法再添加")
        return@withContext ReadImagesResult(existing, warnings)
    }

    val availableSlots = maxCount - existing.size
    val urisToProcess = if (uris.size > availableSlots) {
        warnings.add("最多 $maxCount 张，已有 ${existing.size} 张，本次只取前 $availableSlots 张")
        uris.take(availableSlots)
    } else {
        uris
    }

    // Calculate existing total bytes
    var totalBytes = existing.sumOf { Base64.decode(it.data, Base64.DEFAULT).size.toLong() }

    for (uri in urisToProcess) {
        try {
            val type = context.contentResolver.getType(uri).orEmpty()
            val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }?.take(255)?.takeIf { it.isNotBlank() } ?: "图片"

            if (type !in ACCEPTED_TYPES) {
                warnings.add("$name 类型不支持（$type），已跳过")
                continue
            }

            val rawBytes = context.contentResolver.openInputStream(uri)?.use { input ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (out.size() <= MAX_IMAGE_BYTES) {
                    val count = input.read(buffer, 0, minOf(buffer.size, MAX_IMAGE_BYTES + 1 - out.size()))
                    if (count < 0) break
                    out.write(buffer, 0, count)
                }
                out.toByteArray()
            }
            if (rawBytes == null || rawBytes.isEmpty()) {
                warnings.add("$name 无法读取，已跳过")
                continue
            }

            var finalBytes = rawBytes
            var finalType = type
            var finalName = name

            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size, bounds)
            val byteBudget = minOf(MAX_IMAGE_BYTES, (MAX_TOTAL_BYTES - totalBytes).coerceAtLeast(0).toInt())
            if (byteBudget == 0) {
                warnings.add("$name 超过合计 4MB 限制，已跳过")
                continue
            }
            if (rawBytes.size > byteBudget || maxOf(bounds.outWidth, bounds.outHeight) > MAX_LONG_SIDE) {
                // Try to compress
                val compressed = compressToFit(context, uri, byteBudget)
                if (compressed != null) {
                    finalBytes = compressed
                    finalType = "image/jpeg"
                    finalName = name.substringBeforeLast(".", name).take(250) + ".jpg"
                    warnings.add("$name 已压缩为 JPEG（${compressed.size / 1024}KB）")
                } else {
                    warnings.add("$name 无法压缩至图片大小限制，已跳过")
                    continue
                }
            }

            // Check total size
            if (totalBytes + finalBytes.size > MAX_TOTAL_BYTES) {
                warnings.add("$name 加入后超过合计 4MB 限制，已跳过")
                continue
            }

            totalBytes += finalBytes.size
            added.add(ChatImage(finalName, finalType, Base64.encodeToString(finalBytes, Base64.NO_WRAP)))
        } catch (e: java.io.IOException) {
            warnings.add("图片读取失败，已跳过")
        } catch (e: SecurityException) {
            warnings.add("没有图片读取权限，已跳过")
        }
    }

    ReadImagesResult(existing + added, warnings)
}

/** Decode a bounded preview off the UI thread, even for high resolution uploads. */
private suspend fun preview(image: ChatImage): ImageBitmap = withContext(Dispatchers.Default) {
    val bytes = Base64.decode(image.data, Base64.DEFAULT)
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true; inSampleSize = 1 }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    while (options.outWidth / options.inSampleSize > 1600 || options.outHeight / options.inSampleSize > 1600) options.inSampleSize *= 2
    options.inJustDecodeBounds = false
    (BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("图片无法解码")).asImageBitmap()
}

@Composable
fun ChatPicture(image: ChatImage? = null, remote: MessageImage? = null, botId: String = "", messageId: String = "", repository: PiBotRepository? = null, modifier: Modifier = Modifier) {
    var bitmap by remember(image, remote?.id) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(image, remote?.id) { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(image, remote?.id, attempt) {
        failed = false
        runCatching { preview(image ?: repository!!.image(botId, messageId, remote!!.id)) }
            .onSuccess { bitmap = it }.onFailure { failed = true }
    }
    val current = bitmap
    Box(modifier.clickable { if (current != null) expanded = true else if (failed) attempt++ }) {
        if (current != null) Image(current, image?.name ?: remote?.name, Modifier.fillMaxWidth().heightIn(max = 220.dp), contentScale = ContentScale.Fit)
        else Text(if (failed) "图片加载失败，点击重试" else "图片加载中…", color = Muted, modifier = Modifier.padding(8.dp))
    }
    if (expanded && current != null) Dialog(onDismissRequest = { expanded = false }) {
        Image(current, image?.name ?: remote?.name, Modifier.fillMaxWidth().clickable { expanded = false }, contentScale = ContentScale.Fit)
    }
}
