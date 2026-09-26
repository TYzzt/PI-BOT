package dev.tagent.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.tagent.android.data.TagentRepository
import dev.tagent.android.data.db.OutboxEntity
import dev.tagent.android.data.db.ProjectListItem
import dev.tagent.android.domain.ActionException
import dev.tagent.android.domain.availabilityLabel
import dev.tagent.android.domain.presenceLabel
import kotlinx.coroutines.launch

@Composable
fun ProjectListScreen(repository: TagentRepository, onOpen: (String) -> Unit, onLogout: () -> Unit) {
    val projects by repository.observeProjects().collectAsState(initial = emptyList())
    val meta by repository.observeMeta().collectAsState(initial = null)
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("项目", style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = onLogout) { Text("退出") }
        }
        Text("只显示名称和 Mac 是否在线。手机不能填写真实路径。", style = MaterialTheme.typography.bodyMedium)
        meta?.let { Text("最近同步 ${formatEpoch(it.lastSyncAt)}", style = MaterialTheme.typography.labelMedium) }
        TextButton(onClick = { scope.launch { runCatching { repository.catchUp() } } }) { Text("刷新") }
        if (projects.isEmpty()) {
            Text("还没有共享项目。在 Mac 上打开云端显示后刷新。", Modifier.padding(top = 24.dp))
        } else {
            LazyColumn {
                items(projects, key = { it.projectId }) { project ->
                    ProjectRow(project, onClick = { onOpen(project.projectId) })
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun ProjectRow(project: ProjectListItem, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp)) {
        Text(project.displayName, style = MaterialTheme.typography.titleMedium)
        val device = project.label ?: "未知 Mac"
        val revoked = if (project.revokedAt != null) " · 设备已撤销" else ""
        Text("$device · ${presenceLabel(project.presence)} · ${availabilityLabel(project.availability)}$revoked")
    }
}

@Composable
fun NewTaskScreen(repository: TagentRepository, projectId: String, onCreated: (String) -> Unit, onBack: () -> Unit) {
    val model = viewModel(key = projectId) { NewTaskViewModel(repository, projectId) }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("返回") }
        Text("请求计划", style = MaterialTheme.typography.headlineMedium)
        Text("提交后由这台 Mac 上的 Pi 只读规划。离线时需求留在手机上，不会显示成已创建。")
        OutlinedTextField(
            model.text,
            { model.text = it },
            Modifier.fillMaxWidth(),
            label = { Text("需求") },
            minLines = 5,
            enabled = !model.locked,
        )
        model.notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = { model.submit(onCreated) }, enabled = !model.busy && model.text.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            Text(if (model.busy) "正在提交" else "提交计划请求")
        }
        if (model.canDiscard) TextButton(onClick = { model.discard() }) { Text("放弃这条草稿") }
    }
}

class NewTaskViewModel(private val repository: TagentRepository, private val projectId: String) : ViewModel() {
    var text by mutableStateOf("")
    var notice by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var locked by mutableStateOf(false)
    var canDiscard by mutableStateOf(false)
    private var draft: OutboxEntity? = null

    init {
        viewModelScope.launch {
            val box = repository.peekOutbox("create:$projectId")
            draft = box
            if (box?.phase == "confirmed") {
                repository.clearOutbox(box.id)
            } else if (box != null) {
                text = box.body
                locked = box.idempotencyKey != null
                canDiscard = box.idempotencyKey != null
                notice = box.error
            }
        }
    }

    fun submit(onCreated: (String) -> Unit) {
        if (busy) return
        busy = true
        notice = null
        viewModelScope.launch {
            try {
                val taskId = repository.createTask(projectId, text)
                onCreated(taskId)
            } catch (error: ActionException) {
                notice = error.message
                val box = repository.peekOutbox("create:$projectId")
                locked = box?.idempotencyKey != null
                canDiscard = locked
            } finally {
                busy = false
            }
        }
    }

    fun discard() {
        viewModelScope.launch {
            repository.clearOutbox("create:$projectId")
            text = ""
            notice = null
            locked = false
            canDiscard = false
        }
    }

    override fun onCleared() {
        if (!locked) repository.rememberDraft("create:$projectId", "create", projectId, text)
    }
}
