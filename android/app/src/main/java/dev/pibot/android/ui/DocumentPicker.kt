package dev.pibot.android.ui

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import dev.pibot.android.data.PiBotRepository
import kotlinx.coroutines.*
import java.util.UUID

private data class PendingDocument(val uri: Uri, val id: String = UUID.randomUUID().toString(), val name: String = "文件", val progress: Int = 0, val error: String? = null)

@Composable
internal fun DocumentPicker(botId: String, repository: PiBotRepository, ids: List<String>, onIds: (List<String>) -> Unit, onBusy: (Boolean) -> Unit, enabled: Boolean, content: @Composable (Boolean, () -> Unit) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var names by rememberSaveable(botId) { mutableStateOf(hashMapOf<String, String>()) }
    var pending by remember(botId) { mutableStateOf(emptyList<PendingDocument>()) }
    var error by remember(botId) { mutableStateOf<String?>(null) }
    var available by remember { mutableStateOf(false) }
    val currentIds by rememberUpdatedState(ids)
    val currentBot by rememberUpdatedState(botId)
    var pickingFor by rememberSaveable { mutableStateOf<String?>(null) }
    val jobs = remember(botId) { mutableMapOf<String, Job>() }
    LaunchedEffect(repository, botId) { available = runCatching { repository.documentCapabilities(); true }.getOrDefault(false) }
    LaunchedEffect(pending.isNotEmpty()) { onBusy(pending.isNotEmpty()) }
    DisposableEffect(botId) { onDispose { jobs.values.forEach { it.cancel() }; onBusy(false) } }
    fun start(item: PendingDocument) {
        pending = pending.filter { it.id != item.id } + item.copy(error = null)
        jobs[item.id] = scope.launch {
            try {
                val source = withContext(Dispatchers.IO) {
                    val name = context.contentResolver.query(item.uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "file"
                    val bytes = context.contentResolver.openInputStream(item.uri)?.use { input ->
                        val out = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while(true) { val count = input.read(buffer); if(count < 0) break; require(out.size()+count <= 10*1024*1024) { "每份文件最多 10 MiB" }; out.write(buffer,0,count) }
                        out.toByteArray() } ?: throw IllegalStateException("无法读取文件")
                    require(bytes.isNotEmpty() && bytes.size <= 10 * 1024 * 1024) { "每份文件最多 10 MiB" }
                    ensureActive()
                    name to bytes
                }
                pending = pending.map { if (it.id == item.id) it.copy(name = source.first) else it }
                val artifact = repository.uploadDocument(botId, source.first, source.second, item.id) { progress ->
                    scope.launch { pending = pending.map { if (it.id == item.id) it.copy(progress = progress) else it } }
                }
                ensureActive()
                if (currentBot != botId) return@launch
                if (artifact.id !in currentIds) { names = HashMap(names).apply { put(artifact.id, artifact.name) }; onIds(currentIds + artifact.id) }
                pending = pending.filter { it.id != item.id }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { pending = pending.map { if (it.id == item.id) it.copy(error = errorText(e)) else it } }
            finally { jobs.remove(item.id) }
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val target = pickingFor
        pickingFor = null
        if (target != botId || !enabled) return@rememberLauncherForActivityResult
        if (ids.size + pending.size + uris.size > 4) error = "每条消息最多 4 个文件"
        else uris.forEach { start(PendingDocument(it)) }
    }
    Column {
        ids.forEach { id -> Row {
            Text(names[id] ?: "已上传文件", modifier = androidx.compose.ui.Modifier.weight(1f))
            TextButton(enabled = enabled, onClick = { onIds(ids.filter { it != id }); names = HashMap(names).apply { remove(id) } }) { Text("移除") }
        } }
        pending.forEach { item -> Column {
            Text("${item.name} · ${item.progress}% ${item.error ?: ""}")
            Row {
                if (item.error != null) TextButton(onClick = { start(item) }) { Text("重试") }
                TextButton(onClick = { jobs.remove(item.id)?.cancel(); pending = pending.filter { it.id != item.id }; scope.launch { runCatching { repository.cancelDocumentUpload(item.id) } } }) { Text("取消上传") }
            }
        } }
        error?.let { Text(it, color = Danger) }
        content(enabled && available && ids.size + pending.size < 4) {
            pickingFor = botId
            picker.launch(arrayOf("*/*"))
        }
    }
}
